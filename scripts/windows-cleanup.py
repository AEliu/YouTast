"""Conservative cleanup for the Windows executor's disposable files."""
import logging
import os
import shutil
import sys
import time
from pathlib import Path

CACHE_LIMIT = 256 * 1024 * 1024
CACHE_AGE = 7 * 86400
SAFE_AGE = 86400


def clean(state, now=None):
    now = time.time() if now is None else now
    cache = state / 'cache'
    entries = []
    if cache.is_dir() and not cache.is_symlink():
        for root, dirs, files in os.walk(cache, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(root) / d).is_symlink()]
            for name in files:
                p = Path(root) / name
                try:
                    if p.is_symlink():
                        continue
                    stat = p.stat()
                    entries.append((stat.st_mtime, stat.st_size, p))
                except OSError:
                    logging.warning('Cannot inspect cached file')
    total = sum(size for _, size, _ in entries)
    for mtime, size, p in sorted(entries):
        age = now - mtime
        if age < SAFE_AGE or (age < CACHE_AGE and total <= CACHE_LIMIT):
            continue
        try:
            p.unlink()
            total -= size
        except OSError:
            logging.warning('Cannot remove cached file')
    # Each session holds its lock for its entire lifetime. Never follow links.
    sessions = state / 'temp'
    if not sessions.is_dir() or sessions.is_symlink():
        return
    for session in sessions.iterdir():
        if not session.name.startswith('session-') or session.is_symlink() or not session.is_dir():
            continue
        lock_path = session / '.lock'
        try:
            if lock_path.is_symlink() or not lock_path.is_file() or now - session.stat().st_mtime < SAFE_AGE:
                continue
            with lock_path.open('r+b') as lock:
                if os.name == 'nt':
                    import msvcrt
                    try:
                        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    except OSError:
                        continue
                    # Windows cannot remove an open lock file; hold the lock while
                    # removing only the children, and leave the small session shell.
                    for child in session.iterdir():
                        if child.name == '.lock' or child.is_symlink():
                            continue
                        if child.is_dir():
                            shutil.rmtree(child)
                        else:
                            child.unlink()
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    try:
                        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except OSError:
                        continue
                    for child in session.iterdir():
                        if child.name == '.lock' or child.is_symlink():
                            continue
                        if child.is_dir():
                            shutil.rmtree(child)
                        else:
                            child.unlink()
        except OSError:
            logging.warning('Cannot clean temporary session')


if __name__ == '__main__':
    clean(Path(__file__).resolve().parents[1] / '.wrangler' / 'windows-executor')
