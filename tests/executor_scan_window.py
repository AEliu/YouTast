import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'executor'))
import agent


class ScanWindowTest(unittest.TestCase):
    def test_custom_limit_and_flat_publication_dates_without_audio_download(self):
        commands,calls=[],[]
        class API:
            def post(self,path,data=None,**kwargs):calls.append((path,data))
        def run(arguments,cwd,lost,output):
            commands.append(arguments)
            (cwd/output).write_text(json.dumps({'entries':[{'id':'abcdefghijk','title':'Recent','timestamp':1700000000}]}),encoding='utf-8')
        with patch.dict(os.environ,{},clear=True),patch.object(agent,'run_command',run):
            agent.process_job(API(),{'id':'scan','kind':'scan','leaseToken':'lease','source':{'kind':'author','url':'https://www.youtube.com/@creator/videos'},'options':{'scan_limit':7,'latest_limit':3}})
        self.assertEqual(commands[0][commands[0].index('--playlist-end')+1],'7')
        self.assertIn('youtubetab:approximate_date',commands[0])
        self.assertIn('--skip-download',commands[0])
        self.assertNotIn('--extract-audio',commands[0])
        self.assertEqual(calls[0][1]['entries'][0]['published_at'],1700000000)


if __name__=='__main__':unittest.main()
