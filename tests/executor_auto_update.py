import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('vps_auto_update', Path(__file__).resolve().parents[1] / 'scripts/vps-auto-update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTest(unittest.TestCase):
    def test_verified_package_drains_before_replacing_running_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'config'
            config.write_text('YOUTAST_URL=https://example.com\n', encoding='utf-8')
            old = b'signal.SIGUSR1, lambda *_: DRAIN.set()\n'
            archive_data = io.BytesIO()
            with zipfile.ZipFile(archive_data, 'w') as archive:
                for source, target in updater.FILES.items():
                    dest = root / target
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    current = old if target == 'executor/agent.py' else b'same'
                    dest.write_bytes(current)
                    archive.writestr('youtast-executor/' + source, b'new agent' if target == 'executor/agent.py' else current)
            package = archive_data.getvalue()
            checksum = hashlib.sha256(package).hexdigest().encode() + b'  package\n'
            events = []
            def fetch(url, limit): return checksum if url.endswith('.sha256') else package
            def command(*args, **kwargs):
                if args[1:2] == ('kill',):
                    self.assertEqual((root / 'executor/agent.py').read_bytes(), old)
                events.append(args)
            active = iter([0, 1])
            def run(args, **kwargs): return types.SimpleNamespace(returncode=next(active))
            with patch.object(updater, 'ROOT', root), patch.object(updater, 'CONFIG', config), \
                 patch.object(updater, 'fetch', fetch), patch.object(updater, 'command', command), \
                 patch.object(updater.subprocess, 'run', run), patch.object(updater.os, 'geteuid', return_value=0, create=True):
                updater.main()
            self.assertEqual((root / 'executor/agent.py').read_bytes(), b'new agent')
            self.assertTrue(any(args[1:2] == ('kill',) and '--signal=SIGUSR1' in args for args in events))
            self.assertTrue(any(args[1:2] == ('start',) for args in events))

    def test_corrupt_download_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config'
            config.write_text('YOUTAST_URL=https://example.com\n', encoding='utf-8')
            with patch.object(updater, 'CONFIG', config), patch.object(updater.os, 'geteuid', return_value=0, create=True), \
                 patch.object(updater, 'fetch', side_effect=[b'0' * 64, b'not the archive']):
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    updater.main()


if __name__ == '__main__': unittest.main()
