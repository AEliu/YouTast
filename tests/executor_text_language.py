import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'executor'))
import agent

class FakeAPI:
    def __init__(self): self.calls=[]
    def post(self,path,data=None,**kwargs): self.calls.append((path,data,kwargs))

class TextLanguageTest(unittest.TestCase):
    def run_job(self,metadata_only=False):
        api=FakeAPI();commands=[]
        metadata={'id':'abcdefghijk','title':'Localized title','description':'Localized description','duration':10,'chapters':[{'start_time':0,'title':'Start'}]}
        def run(arguments,cwd,lost,output):
            commands.append(arguments)
            if metadata_only:
                (cwd/output).write_text(json.dumps(metadata),encoding='utf-8')
            else:
                (cwd/'audio.mp3').write_bytes(b'ID3')
                (cwd/'audio.info.json').write_text(json.dumps(metadata),encoding='utf-8')
        with patch.dict(os.environ,{},clear=True),patch.object(agent,'run_command',run):
            agent.process_job(api,{'id':'job','kind':'transcode','leaseToken':'lease','episode':{'video_id':'abcdefghijk'},'options':{'bitrate':128,'text_language':'ja','scan_limit':30,'metadata_only':metadata_only}})
        return commands,api.calls
    def test_text_language_never_selects_audio_track(self):
        commands,calls=self.run_job()
        self.assertEqual(commands[0][commands[0].index('--format')+1],'bestaudio/best')
        self.assertIn('youtube:lang=ja',commands[0])
        self.assertIn('--embed-chapters',commands[0])
        self.assertEqual(commands[0][commands[0].index('--sleep-requests')+1],'2')
        self.assertEqual(commands[0][commands[0].index('--concurrent-fragments')+1],'1')
        self.assertEqual(commands[0][commands[0].index('--sleep-interval')+1],'10')
        self.assertEqual(commands[0][commands[0].index('--max-sleep-interval')+1],'20')
        self.assertEqual(commands[0][commands[0].index('--audio-quality')+1],'128K')
        self.assertEqual(calls[0][1]['metadata']['text_language'],'ja')
        self.assertEqual(calls[0][1]['title'],'Localized title')
        self.assertTrue(calls[1][0].endswith('/audio'))
    def test_language_refresh_only_fetches_metadata(self):
        commands,calls=self.run_job(True)
        self.assertIn('--skip-download',commands[0])
        self.assertNotIn('--extract-audio',commands[0])
        self.assertEqual(len(calls),1)
        self.assertTrue(calls[0][1]['complete_job'])

if __name__=='__main__': unittest.main()
