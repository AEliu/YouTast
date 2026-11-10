import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).resolve().parents[1] / 'scripts' / 'windows-cleanup.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

class CleanupTest(unittest.TestCase):
    def test_age_and_size_and_active_session(self):
        now = time.time()
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            cache = state / 'cache'
            cache.mkdir()
            for name, age in [('old', 8 * 86400), ('older', 2 * 86400), ('recent', 60)]:
                p = cache / name
                p.write_bytes(b'1234')
                os.utime(p, (now - age, now - age))
            session = state / 'temp' / 'session-active'
            session.mkdir(parents=True)
            (session / 'audio').write_bytes(b'1234')
            lock = (session / '.lock').open('w+b')
            lock.write(b'0')
            lock.flush()
            lock.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.utime(session, (now - 2 * 86400, now - 2 * 86400))
            with patch.object(cleanup, 'CACHE_LIMIT', 4):
                cleanup.clean(state, now)
            self.assertFalse((cache / 'old').exists())
            self.assertFalse((cache / 'older').exists())
            self.assertTrue((cache / 'recent').exists())
            self.assertTrue((session / 'audio').exists())
            lock.close()
            cleanup.clean(state, now)
            self.assertFalse((session / 'audio').exists())

if __name__ == '__main__':
    unittest.main()
