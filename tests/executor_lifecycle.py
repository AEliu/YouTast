"""Regression test: losing a lease stops the command and its descendants."""
import ctypes
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "executor"))
from agent import run_command


def is_running(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        stat = Path(f"/proc/{pid}/stat")
        return not (stat.exists() and stat.read_text().split(")", 1)[1].strip().startswith("Z"))
    except ProcessLookupError:
        return False


class ExecutorLifecycleTest(unittest.TestCase):
    def test_downloader_does_not_receive_executor_credential(self):
        with tempfile.TemporaryDirectory(prefix="youtast-env-test-") as temp:
            cwd = Path(temp)
            with patch.dict(os.environ, {"YOUTAST_TOKEN": "fictional-test-secret"}):
                run_command([sys.executable, "-c", "import os; print('absent' if 'YOUTAST_TOKEN' not in os.environ else 'present')"], cwd, threading.Event(), "environment.log")
            self.assertEqual((cwd / "environment.log").read_text().strip(), "absent")

    def test_lost_lease_terminates_descendant(self):
        with tempfile.TemporaryDirectory(prefix="youtast-cancel-test-") as temp:
            cwd = Path(temp)
            script = cwd / "child.py"
            script.write_text(
                "import subprocess, sys, time\n"
                "from pathlib import Path\n"
                "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
                "Path('child.pid').write_text(str(child.pid))\n"
                "time.sleep(60)\n",
                encoding="utf-8",
            )
            lost = threading.Event()

            def cancel_when_started():
                deadline = time.monotonic() + 10
                while not (cwd / "child.pid").exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                lost.set()

            timer = threading.Thread(target=cancel_when_started, daemon=True)
            timer.start()
            with self.assertRaisesRegex(RuntimeError, "lease lost"):
                run_command([sys.executable, str(script)], cwd, lost, "output.log")
            timer.join(timeout=2)
            pid = int((cwd / "child.pid").read_text())
            deadline = time.monotonic() + 3
            while is_running(pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertFalse(is_running(pid), "Leased task left a running descendant")


if __name__ == "__main__":
    unittest.main()
