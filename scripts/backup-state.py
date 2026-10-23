"""Private D1 + referenced R2 backup; restore only into a new local state."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'node_modules/wrangler/bin/wrangler.js'


class BackupError(ValueError):
    pass


def wrangler(*args):
    result = subprocess.run(['node', str(CLI), *map(str, args)], cwd=ROOT,
                            capture_output=True, encoding='utf-8', errors='replace',
                            timeout=300, env={**os.environ, 'WRANGLER_SEND_METRICS': 'false'})
    if result.returncode:
        raise BackupError('Wrangler operation failed; private partial backup retained')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def private_directory(path):
    path = Path(path).resolve()
    if not path.is_relative_to((ROOT / '.secrets').resolve()) or path == (ROOT / '.secrets').resolve():
        raise BackupError('Backup must be inside .secrets')
    return path


def local_db(state):
    candidates = []
    for path in (state / 'v3/d1').rglob('*.sqlite'):
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            if db.execute("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('users','episodes','object_gc')").fetchone()[0] == 3:
                candidates.append(path)
    if len(candidates) != 1:
        raise BackupError('Expected exactly one YouTast D1 database in source state')
    return candidates[0]


def export_sql(args, target):
    if args.remote:
        wrangler('d1', 'export', 'DB', '--remote', '--output', target, '--skip-confirmation')
    else:
        with closing(sqlite3.connect(local_db(Path(args.state).resolve()).as_uri() + '?mode=ro', uri=True)) as source:
            # SQLite online backup includes WAL commits and gives one DB snapshot.
            with closing(sqlite3.connect(':memory:')) as snapshot:
                source.backup(snapshot)
                snapshot.execute('DROP TABLE IF EXISTS _cf_METADATA')
                dump = [line for line in snapshot.iterdump() if line not in ('BEGIN TRANSACTION;', 'COMMIT;')]
                # D1 enforces foreign keys: referenced tables must already exist.
                dump = [line for line in dump if line.startswith('CREATE TABLE ')] + [line for line in dump if not line.startswith('CREATE TABLE ')]
                target.write_text('PRAGMA defer_foreign_keys=ON;\n' + '\n'.join(dump) + '\n', encoding='utf-8')


def inspect_sql(path):
    db = sqlite3.connect(':memory:')
    try:
        db.executescript(path.read_text(encoding='utf-8'))
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
            raise BackupError('Database integrity check failed')
        if db.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]:
            raise BackupError('Backup requires no running jobs')
        objects = {}
        for key, size in db.execute('SELECT object_key,size FROM episodes WHERE object_key IS NOT NULL UNION ALL SELECT object_key,size FROM object_gc'):
            if not isinstance(key, str) or not key or len(key) > 1024 or type(size) is not int or size < 0:
                raise BackupError('Invalid object reference')
            if key in objects and objects[key] != size:
                raise BackupError('Conflicting object sizes')
            objects[key] = size
        return objects
    finally:
        db.close()


def backup(args):
    if not args.quiescent:
        raise BackupError('Stop writes, uploads and GC first, then acknowledge --quiescent')
    target = private_directory(args.output)
    target.mkdir(parents=True, exist_ok=False, mode=0o700)
    (target / 'objects').mkdir(mode=0o700)
    sql = target / 'database.sql'
    export_sql(args, sql)
    objects = inspect_sql(sql)
    if sum(objects.values()) > args.max_bytes:
        raise BackupError('Referenced audio exceeds --max-bytes; backup not complete')
    scope = ['--remote'] if args.remote else ['--local', '--persist-to', str(Path(args.state).resolve())]
    records = []
    for key, size in sorted(objects.items()):
        filename = hashlib.sha256(key.encode()).hexdigest()
        path = target / 'objects' / filename
        wrangler('r2', 'object', 'get', args.bucket + '/' + key, '--file', path, *scope)
        if path.stat().st_size != size:
            raise BackupError('Object size mismatch; backup not complete')
        records.append({'key': key, 'file': filename, 'size': size, 'sha256': digest(path)})
    second = target / 'confirmation.sql'
    export_sql(args, second)
    if inspect_sql(second) != objects:
        raise BackupError('Object references changed during backup; backup not complete')
    second.unlink()
    manifest = {'version': 1, 'complete': True, 'created_at': int(time.time()),
                'source': 'remote' if args.remote else 'local', 'bucket': args.bucket,
                'scope': 'D1 snapshot and all episode/object_gc references; excludes unindexed R2 objects',
                'consistency': 'operator-guaranteed quiescence; references checked twice',
                'sql_sha256': digest(sql), 'objects': records}
    (target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'complete', 'objects': len(records), 'bytes': sum(objects.values())}))


def validate_backup(source):
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    sql = source / 'database.sql'
    if manifest.get('version') != 1 or manifest.get('complete') is not True or digest(sql) != manifest.get('sql_sha256'):
        raise BackupError('Backup manifest or SQL checksum invalid')
    refs = inspect_sql(sql)
    found = {}
    for item in manifest['objects']:
        name = item['file']
        if not re.fullmatch('[a-f0-9]{64}', name) or name != hashlib.sha256(item['key'].encode()).hexdigest():
            raise BackupError('Invalid backup object path')
        path = source / 'objects' / name
        if path.is_symlink() or path.stat().st_size != item['size'] or digest(path) != item['sha256'] or item['key'] in found:
            raise BackupError('Backup object checksum or size invalid')
        found[item['key']] = item['size']
    if refs != found:
        raise BackupError('Backup object coverage incomplete')
    return manifest


def restore(args):
    source = private_directory(args.backup)
    manifest = validate_backup(source)  # All checks precede target creation/import.
    target = Path(args.state).resolve()
    parent = (ROOT / '.wrangler').resolve()
    if not target.is_relative_to(parent) or target == parent or target.exists():
        raise BackupError('Restore target must be a NEW directory inside .wrangler')
    target.mkdir(parents=True, mode=0o700)
    # Never allow remote restore. Retain a failed target for inspection.
    scope = ['--local', '--persist-to', str(target)]
    for item in manifest['objects']:
        kind = 'audio/mp4' if item['key'].endswith('.m4a') else 'audio/mpeg'
        wrangler('r2', 'object', 'put', args.bucket + '/' + item['key'], '--file', source / 'objects' / item['file'], '--content-type', kind, *scope)
    with tempfile.TemporaryDirectory(dir=ROOT / '.wrangler', prefix='restore-sql-') as temp:
        sql = Path(temp) / 'restore.sql'
        sql.write_text((source / 'database.sql').read_text(encoding='utf-8') + '''
DELETE FROM sessions;
UPDATE executors SET token_hash=lower(hex(randomblob(32))),last_seen=NULL;
INSERT OR IGNORE INTO execution_policy(user_id) SELECT id FROM users;
UPDATE execution_policy SET paused=1;
DELETE FROM storage_cleanup_locks;
''', encoding='utf-8')
        wrangler('d1', 'execute', 'DB', '--file', sql, '--yes', *scope)
    with closing(sqlite3.connect(local_db(target))) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
            raise BackupError('Restored database integrity check failed')
    # Read every restored object through R2, not the copied source files.
    with tempfile.TemporaryDirectory(dir=ROOT / '.wrangler', prefix='restore-read-') as temp:
        for item in manifest['objects']:
            file = Path(temp) / item['file']
            wrangler('r2', 'object', 'get', args.bucket + '/' + item['key'], '--file', file, *scope)
            if digest(file) != item['sha256']:
                raise BackupError('Restored R2 verification failed')
    print(json.dumps({'status': 'restored_local', 'objects': len(manifest['objects']), 'sessions_revoked': True, 'executors_revoked': True, 'execution_paused': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    save = sub.add_parser('backup')
    scope = save.add_mutually_exclusive_group(required=True)
    scope.add_argument('--remote', action='store_true')
    scope.add_argument('--state', help='Local persistence directory')
    save.add_argument('--output', required=True, help='New directory inside .secrets')
    save.add_argument('--quiescent', action='store_true')
    save.add_argument('--max-bytes', type=int, default=100_000_000)
    load = sub.add_parser('restore-local')
    load.add_argument('--backup', required=True)
    load.add_argument('--state', required=True, help='New directory inside .wrangler')
    for p in (save, load):
        p.add_argument('--bucket', default='youtast-audio')
    args = parser.parse_args()
    try:
        if args.action == 'backup':
            backup(args)
        else:
            restore(args)
        return 0
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError) as error:
        # Raw SQL/CLI/JSON diagnostics can include credentials and private keys.
        print(json.dumps({'status': 'failed', 'issue': str(error) if isinstance(error, BackupError) else 'operation_not_confirmed', 'action': args.action}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
