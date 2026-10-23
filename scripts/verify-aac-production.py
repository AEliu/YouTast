"""Operator real-YouTube AAC validation; secrets stay in local files.

Uses a disposable channel/key under the saved administrator account, honors its
normal pacing, and removes only those resources afterward. Existing feeds and
audio are untouched. No private capability URL or credential is printed.
"""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'executor'))
import agent

def config(name):
    return dict(line.split('=',1) for line in (ROOT/'.secrets'/name).read_text(encoding='utf-8-sig').splitlines() if line and not line.startswith('#') and '=' in line)

def main():
    account=config('admin-account.env');machine=config('windows-executor.env')
    origin=account['YOUTAST_URL']
    assert origin==machine['YOUTAST_URL'] and origin.startswith('https://')
    for k in ('YOUTAST_COOKIES_FILE','YOUTAST_POT_PROVIDER_HOME'):
        if machine.get(k):os.environ[k]=machine[k]
    cookie_opener=urllib.request.build_opener(agent.NoRedirect(),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def web(path,data=None,method=None):
        req=urllib.request.Request(origin+path,data=json.dumps(data).encode() if data is not None else None,
            headers={'Origin':origin,'Content-Type':'application/json','User-Agent':'YouTast-Setup/0.1'},method=method)
        with cookie_opener.open(req,timeout=45) as r:return json.load(r)
    web('/api/auth/login',{'username':account['YOUTAST_USERNAME'],'password':account['YOUTAST_PASSWORD']})
    d=web('/api/dashboard')
    assert not any(j['status'] in ('queued','running') for j in d['jobs']), 'Validation account already has work'
    channel=None;executor=None;result={'status':'failed'}
    state=ROOT/'.wrangler/aac-production';state.mkdir(exist_ok=True)
    output=state/'prepared.m4a'
    preparation={}
    original_prepare=agent.prepare_m4a
    def packets(path):
        data=subprocess.check_output(['ffmpeg','-nostdin','-v','error','-i',str(path),'-map','0:a:0','-c:a','copy','-f','adts','-'],stderr=subprocess.PIPE)
        return hashlib.sha256(data).hexdigest()
    def observe(source,cwd,lost,bitrate,mode,meta):
        audio,duration=original_prepare(source,cwd,lost,bitrate,mode,meta)
        codec=json.loads((cwd/'probe.json').read_text())['streams'][0]['codec_name']
        preparation.update({'source_codec':codec,'aac_packets_identical':codec=='aac' and packets(source)==packets(audio)})
        shutil.copyfile(audio,output)
        return audio,duration
    agent.prepare_m4a=observe
    try:
        channel=web('/api/channels',{'title':'Temporary AAC validation '+uuid.uuid4().hex[:8]})['id']
        executor=web('/api/executors',{'name':'Temporary AAC verification'})
        api=agent.API(origin,executor['token'])
        web(f'/api/channels/{channel}/sources',{'urls':['https://www.youtube.com/watch?v=jNQXAC9IVRw']})
        print('Queued real AAC validation; using normal YouTube pacing.',flush=True)
        deadline=time.monotonic()+600
        while time.monotonic()<deadline:
            response=api.post('/api/executor/claim');job=response.get('job')
            if job:
                assert job['kind']=='scan' or job['episode']['video_id']=='jNQXAC9IVRw'
                agent.process_job(api,job)
            d=web('/api/dashboard')
            jobs=[j for j in d['jobs'] if j.get('channel_title','').startswith('Temporary AAC validation ')]
            if any(j['status']=='failed' for j in jobs):raise RuntimeError('Real source conversion failed; private details retained in application')
            episode=next((e for e in d['episodes'] if e['channel_id']==channel and e.get('object_key')),None)
            if episode:break
            if not job:time.sleep(min(30,max(5,response.get('retryAfter',60))))
        else:raise RuntimeError('Timed out waiting for real AAC audio')
        c=next(c for c in d['channels'] if c['id']==channel)
        public=urllib.request.build_opener(agent.NoRedirect())
        def read(url,method='GET',headers=None):
            return public.open(urllib.request.Request(url,method=method,headers={'User-Agent':'YouTast-RSS-Reader/0.1',**(headers or {})}),timeout=45)
        with read(origin+'/feed/'+c['feed_token']+'.xml') as r:feed=ET.fromstring(r.read(2_000_000))
        item=next(i for i in feed.findall('channel/item') if i.findtext('guid')==episode['id'])
        enclosure=item.find('enclosure');url=enclosure.get('url')
        assert url.endswith('.m4a') and enclosure.get('type')=='audio/mp4'
        with read(url,'HEAD') as r:assert int(r.headers['Content-Length'])==episode['size'] and r.headers['Content-Type']=='audio/mp4'
        with read(url,headers={'Range':'bytes=0-1023'}) as r:assert r.status==206 and r.read()==output.read_bytes()[:1024]
        with read(url) as r:data=r.read(5_000_001);assert len(data)==episode['size'] and data==output.read_bytes()
        decoded=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(output),'-f','null','-'],capture_output=True,timeout=45)
        assert decoded.returncode==0 and not decoded.stderr
        assert preparation.get('aac_packets_identical'), 'AAC passthrough not demonstrated by this source'
        result={'status':'passed','video_id':'jNQXAC9IVRw','audio_bytes':len(data),'duration_seconds':episode['duration'],**preparation,'rss':'passed','head':'passed','range':'passed','full_decode':'passed'}
        print(json.dumps(result),flush=True)
    finally:
        agent.prepare_m4a=original_prepare
        if executor:web('/api/executors/'+executor['id'],method='DELETE')
        if channel:web('/api/channels/'+channel,method='DELETE')
        web('/api/auth/logout',{})
        (ROOT/'test-results/aac-production.json').write_text(json.dumps(result,indent=2),encoding='utf-8')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('AAC production validation failed: '+type(error).__name__,flush=True)
        sys.exit(1)
