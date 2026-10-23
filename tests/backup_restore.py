"""Disposable local D1/R2 backup drill, including corrupted-input refusal."""
import hashlib
from contextlib import closing
import importlib.util
import json
import shutil
import sqlite3
import subprocess
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('backup_state', ROOT / 'scripts/backup-state.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class BackupDrill(unittest.TestCase):
    def test_real_local_d1_r2_roundtrip(self):
        suffix = uuid.uuid4().hex
        state = ROOT / '.wrangler' / ('backup-source-' + suffix)
        target = ROOT / '.wrangler' / ('backup-restored-' + suffix)
        archive = ROOT / '.secrets' / ('backup-drill-' + suffix)
        missing = ROOT / '.secrets' / ('backup-missing-' + suffix)
        work = ROOT / '.wrangler' / ('backup-input-' + suffix)
        work.mkdir(parents=True)
        key = 'fixture-owner/preserved.m4a'
        payload = b'local-r2-restoration-contract\x00\xff' * 128
        try:
            sql = work / 'seed.sql'
            schema = '\n'.join(p.read_text(encoding='utf-8') for p in sorted((ROOT / 'migrations').glob('*.sql')))
            sql.write_text(schema + f'''
INSERT INTO users(id,username,salt,password_hash,created_at) VALUES('owner','backup_fixture','salt','hash',1);
INSERT INTO channels(id,user_id,title,feed_token,created_at) VALUES('channel','owner','Restored channel','private-feed',1);
INSERT INTO episodes(id,channel_id,video_id,title,object_key,size,created_at) VALUES('episode','channel','fixture0001','Preserved episode','{key}',{len(payload)},1);
INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('old-session','owner',9999999999);
INSERT INTO executors(id,user_id,name,token_hash,created_at) VALUES('executor','owner','fixture','old-token',1);
INSERT INTO execution_policy(user_id) VALUES('owner');
''', encoding='utf-8')
            ops.wrangler('d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', sql, '--yes')
            blob = work / 'payload'
            blob.write_bytes(payload)
            ops.wrangler('r2', 'object', 'put', 'youtast-audio/' + key, '--local', '--persist-to', state, '--file', blob)
            args = SimpleNamespace(remote=False, state=str(state), output=str(archive), quiescent=True, max_bytes=1000000, bucket='youtast-audio')
            ops.backup(args)
            manifest = ops.validate_backup(archive)
            self.assertEqual(len(manifest['objects']), 1)
            restore = SimpleNamespace(backup=str(archive), state=str(target), bucket='youtast-audio')
            ops.restore(restore)
            with closing(sqlite3.connect(ops.local_db(target))) as db:
                self.assertEqual(db.execute('SELECT title,size,object_key FROM episodes').fetchone(), ('Preserved episode', len(payload), key))
                self.assertEqual(db.execute('SELECT feed_token FROM channels').fetchone()[0], 'private-feed')
                self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
                self.assertNotEqual(db.execute('SELECT token_hash FROM executors').fetchone()[0], 'old-token')
                self.assertEqual(db.execute('SELECT paused FROM execution_policy').fetchone()[0], 1)
            restored = work / 'download'
            ops.wrangler('r2', 'object', 'get', 'youtast-audio/' + key, '--local', '--persist-to', target, '--file', restored)
            self.assertEqual(restored.read_bytes(), payload)
            with self.assertRaises(ValueError):
                ops.restore(restore)  # Never overwrite an existing state.
            safe_target = ROOT / '.wrangler' / ('backup-refused-' + suffix)
            restore.state = str(safe_target)
            file = archive / 'objects' / manifest['objects'][0]['file']
            file.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                ops.restore(restore)
            self.assertFalse(safe_target.exists(), 'Validate all bytes before target creation')
            file.write_bytes(payload)
            sql_backup = archive / 'database.sql'
            original = sql_backup.read_bytes()
            sql_backup.write_bytes(original + b'-- tamper')
            with self.assertRaises(ValueError):
                ops.restore(restore)
            self.assertFalse(safe_target.exists())
            sql_backup.write_bytes(original)
            # Missing referenced audio must never produce a complete manifest.
            ops.wrangler('r2', 'object', 'delete', 'youtast-audio/' + key, '--local', '--persist-to', state)
            args.output = str(missing)
            with self.assertRaises(ValueError):
                ops.backup(args)
            self.assertFalse((missing / 'manifest.json').exists())
        finally:
            for path, parent in ((state, ROOT / '.wrangler'), (target, ROOT / '.wrangler'), (work, ROOT / '.wrangler'), (archive, ROOT / '.secrets'), (missing, ROOT / '.secrets')):
                self.assertTrue(path.resolve().is_relative_to(parent.resolve()))
                if path.exists():
                    shutil.rmtree(path)


if __name__ == '__main__':
    unittest.main()
