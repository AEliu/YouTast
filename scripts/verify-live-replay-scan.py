"""Read one public stream list using this machine's normal YouTube configuration.

No audio downloads, cloud jobs, account changes or cookies in output. Live
state transitions and rescheduling are covered by the local lifecycle tests.
"""
from collections import Counter
import json
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'executor'))
import agent

def main():
    config=dict(line.split('=',1) for line in (ROOT/'.secrets/windows-executor.env').read_text(encoding='utf-8-sig').splitlines() if line and not line.startswith('#') and '=' in line)
    for key in ('YOUTAST_COOKIES_FILE','YOUTAST_POT_PROVIDER_HOME','HTTP_PROXY','HTTPS_PROXY','NO_PROXY'):
        if config.get(key):os.environ[key]=config[key]
    calls=[];observed=[]
    class API:
        def post(self,path,data=None,**kw):calls.append((path,data))
    run=agent.run_command
    def observe(args,cwd,lost,output):
        assert '--skip-download' in args and '--extract-audio' not in args
        run(args,cwd,lost,output)
        raw=json.loads((cwd/output).read_text(encoding='utf-8'))
        observed.extend(raw.get('entries',[]))
    agent.run_command=observe
    try:
        agent.process_job(API(),{'id':'real-replay-scan','kind':'scan','leaseToken':'local-only',
            'source':{'kind':'author','url':'https://www.youtube.com/@Google/streams'},
            'options':{'scan_limit':3,'latest_limit':3,'text_language':'zh-CN'}})
    finally:agent.run_command=run
    scan=next((data for path,data in calls if path.endswith('/scan')),None)
    assert scan is not None and scan['entries'], 'No usable archived live video observed'
    assert all(e['duration']>0 for e in scan['entries'])
    assert all(not e.get('is_live') and e.get('live_status') not in ('is_live','is_upcoming','post_live') for e in observed if e and e.get('id') in {x['video_id'] for x in scan['entries']})
    result={'status':'passed','source':'https://www.youtube.com/@Google/streams','candidates':len(observed),
            'observed_states':dict(Counter(e.get('live_status','unknown') for e in observed if e)),
            'accepted_archives':len(scan['entries']),'positive_durations':True,'no_audio_download':True}
    (ROOT/'test-results/live-replay-upstream.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result),flush=True)

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Real replay scan failed: '+type(error).__name__,flush=True)
        sys.exit(1)
