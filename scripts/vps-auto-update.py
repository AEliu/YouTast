#!/usr/bin/env python3
"""Install the deployed executor package after draining the running service.

Run as root from a systemd timer. The only source of packages is the HTTPS
YouTast origin in the existing executor config; credentials never leave VPS.
"""
import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = Path('/opt/youtast')
CONFIG = Path('/etc/youtast/executor.env')
PACKAGE = 'youtast-executor-0.1.0.zip'
FILES = {'agent.py': 'executor/agent.py', 'requirements.txt': 'requirements.txt',
         'requirements-pot.txt': 'requirements-pot.txt',
         'scripts/windows-runner.py': 'scripts/windows-runner.py',
         'scripts/windows-cleanup.py': 'scripts/windows-cleanup.py',
         'scripts/vps-auto-update.py': 'scripts/vps-auto-update.py'}


def command(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def fetch(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent': 'YouTast-Updater/1'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.geturl() != url:
            raise RuntimeError('Unexpected package redirect')
        body = response.read(limit + 1)
        if len(body) > limit:
            raise RuntimeError('Package response exceeds limit')
        return body


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Updater requires root')
    config = dict(line.split('=', 1) for line in CONFIG.read_text(encoding='utf-8-sig').splitlines()
                  if line and not line.startswith('#') and '=' in line)
    origin = config['YOUTAST_URL'].rstrip('/')
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError('Invalid application origin')
    url = origin + '/downloads/' + PACKAGE
    checksum = fetch(url + '.sha256', 512).decode('ascii').split()[0]
    if len(checksum) != 64 or any(c not in '0123456789abcdef' for c in checksum):
        raise RuntimeError('Invalid checksum')
    package = fetch(url, 10_000_000)
    if hashlib.sha256(package).hexdigest() != checksum:
        raise RuntimeError('Package checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        files = {}
        for name, target in FILES.items():
            info = archive.getinfo('youtast-executor/' + name)
            if info.file_size > 2_000_000:
                raise RuntimeError('Package member exceeds limit')
            files[target] = archive.read(info)
    if all((ROOT / name).is_file() and (ROOT / name).read_bytes() == data for name, data in files.items()):
        print('Executor is current')
        return
    old_agent = (ROOT / 'executor/agent.py').read_text(encoding='utf-8')
    if 'signal.SIGUSR1, lambda *_: DRAIN.set()' not in old_agent:
        raise RuntimeError('Current executor lacks drain support; bootstrap it during a confirmed idle period')
    with tempfile.TemporaryDirectory(prefix='.update-', dir=ROOT) as directory:
        stage = Path(directory)
        for name, data in files.items():
            path = stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        command('/opt/youtast/.venv/bin/python', '-m', 'py_compile', str(stage / 'executor/agent.py'), str(stage / 'scripts/windows-runner.py'), str(stage / 'scripts/windows-cleanup.py'), str(stage / 'scripts/vps-auto-update.py'))
        requirements_changed = any(not (ROOT / name).exists() or (ROOT / name).read_bytes() != files[name] for name in ('requirements.txt', 'requirements-pot.txt'))
        if requirements_changed:
            # Build a separate environment while the current executor remains running.
            command('/usr/bin/python3', '-m', 'venv', str(stage / 'venv'))
            command(str(stage / 'venv/bin/python'), '-m', 'pip', 'install', '-r', str(stage / 'requirements.txt'))
            if config.get('YOUTAST_POT_PROVIDER_HOME'):
                command(str(stage / 'venv/bin/python'), '-m', 'pip', 'install', '-r', str(stage / 'requirements-pot.txt'))
        active = subprocess.run(['systemctl', 'is-active', '--quiet', 'youtast-executor.service']).returncode == 0
        backups = {}
        venv_backup = ROOT / '.venv.auto-update-previous'
        if venv_backup.exists():
            raise RuntimeError('Previous environment backup exists; inspect before updating')
        try:
            if active:
                print('Draining executor; waiting for active jobs', flush=True)
                command('systemctl', 'kill', '--kill-whom=main', '--signal=SIGUSR1', 'youtast-executor.service')
                while subprocess.run(['systemctl', 'is-active', '--quiet', 'youtast-executor.service']).returncode == 0:
                    time.sleep(5)
                command('systemctl', 'stop', 'youtast-executor.service')
            for name in files:
                dest = ROOT / name
                backups[name] = dest.read_bytes() if dest.exists() else None
                dest.parent.mkdir(parents=True, exist_ok=True)
                os.replace(stage / name, dest)
                dest.chmod(0o644)
            if requirements_changed:
                os.rename(ROOT / '.venv', venv_backup)
                os.rename(stage / 'venv', ROOT / '.venv')
            if active:
                command('systemctl', 'start', 'youtast-executor.service')
                time.sleep(5)
                command('systemctl', 'is-active', '--quiet', 'youtast-executor.service')
        except BaseException:
            for name, data in backups.items():
                dest = ROOT / name
                if data is None:
                    dest.unlink(missing_ok=True)
                else:
                    dest.write_bytes(data)
            if venv_backup.exists():
                if (ROOT / '.venv').exists():
                    shutil.rmtree(ROOT / '.venv')
                os.rename(venv_backup, ROOT / '.venv')
            if active:
                subprocess.run(['systemctl', 'start', 'youtast-executor.service'], check=False)
            raise
        if venv_backup.exists():
            shutil.rmtree(venv_backup)
    print('Executor updated and restarted' if active else 'Executor updated; service was inactive')


if __name__ == '__main__':
    main()
