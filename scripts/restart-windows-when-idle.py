"""One-shot upgrade after the configured executor's running lease finishes.

Requires minimum_protocol=2 to have been set for this executor in D1 first.
It never revokes the running job and never places credentials in process arguments.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'executor'))
from agent import API

def main():
    values = dict(line.split('=', 1) for line in (ROOT/'.secrets/windows-executor.env').read_text(encoding='utf-8-sig').splitlines() if line and not line.startswith('#'))
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'):
        if values.get(key): os.environ[key] = values[key]
    api = API(values['YOUTAST_URL'], values['YOUTAST_TOKEN'])
    state_file = ROOT/'.wrangler/windows-executor/process.json'
    before = json.loads(state_file.read_text(encoding='utf-8'))
    deadline = time.monotonic()+1800
    waiting = False
    while time.monotonic()<deadline:
        status = api.post('/api/executor/status')
        if status['minimumProtocol'] != 2:
            raise RuntimeError('Executor must be drained before upgrading')
        if status['activeJobs']==0: break
        if not waiting:
            print('Waiting for the current executor job to finish; its lease stays valid.', flush=True)
            waiting = True
        time.sleep(30)
    else: raise RuntimeError('Executor still busy; no process was stopped')
    current = json.loads(state_file.read_text(encoding='utf-8'))
    if current['pid'] != before['pid']:
        print('Executor process already changed; leaving it untouched.', flush=True)
        return
    script = str(ROOT/'scripts/windows-executor.ps1')
    for args in ([script,'-Stop'],[script]):
        result = subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',*args],cwd=ROOT,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode: raise RuntimeError('Executor restart command failed')
    for _ in range(30):
        time.sleep(1)
        state = json.loads(state_file.read_text(encoding='utf-8'))
        if state['pid'] != before['pid'] and state.get('status')=='running':
            print('Upgraded executor started; running PID: '+str(state['pid']), flush=True)
            return
    raise RuntimeError('New executor startup was not confirmed')

if __name__=='__main__':
    try: main()
    except Exception as error:
        print('Idle upgrade did not complete: '+(str(error) if type(error) is RuntimeError else type(error).__name__),flush=True)
        sys.exit(1)
