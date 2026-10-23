"""Headless Windows entrypoint with a single-instance lock and bounded local logs."""
import argparse
import json
import logging
import os
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "executor"))
import agent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / ".secrets" / "windows-executor.env")
    args = parser.parse_args()
    state_dir = ROOT / ".wrangler" / "windows-executor"
    state_dir.mkdir(parents=True, exist_ok=True)
    lock = (state_dir / "agent.lock").open("a+b")
    if lock.tell() == 0:
        lock.write(b"0")
        lock.flush()
    lock.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        return  # An existing instance is already responsible for this configuration.
    values = {}
    for line in args.config.read_text(encoding="utf-8-sig").splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    for key in ("YOUTAST_URL", "YOUTAST_TOKEN"):
        if not values.get(key):
            raise RuntimeError("Executor environment file is incomplete")
        os.environ[key] = values[key]
    # Optional trusted proxy settings stay in the private file/environment, never in arguments.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "YOUTAST_COOKIES_FILE", "YOUTAST_POT_PROVIDER_HOME"):
        if values.get(key):
            os.environ[key] = values[key]
    if values.get("YOUTAST_POT_PROVIDER_HOME"):
        os.environ.setdefault("XDG_CACHE_HOME", str(state_dir / "cache"))
    # pythonw keeps the scheduled runner invisible; downloader subprocesses use python.exe.
    if os.name == "nt" and Path(sys.executable).name.lower() == "pythonw.exe":
        sys.executable = str(Path(sys.executable).with_name("python.exe"))
    log = RotatingFileHandler(state_dir / "executor.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=[log], force=True)
    state = {"pid": os.getpid(), "started_at": int(time.time()), "config": str(args.config.resolve()), "status": "running"}
    state_file = state_dir / "process.json"
    state_file.write_text(json.dumps(state), encoding="utf-8")
    try:
        agent.main()
    except BaseException:
        logging.exception("Executor exited")
        raise
    finally:
        state["status"] = "stopped"
        state["stopped_at"] = int(time.time())
        state_file.write_text(json.dumps(state), encoding="utf-8")
        log.close()
        lock.close()


if __name__ == "__main__":
    main()
