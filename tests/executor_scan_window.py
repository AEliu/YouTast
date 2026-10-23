import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'executor'))
import agent


class ScanWindowTest(unittest.TestCase):
    def test_playlist_complete_inventory_selects_middle_and_tail_without_history_download(self):
        commands,calls=[],[]
        records=[{'id':'video'+str(i).zfill(6),'title':str(i),'duration':10} for i in range(150)]
        class API:
            def post(self,path,data=None,**kwargs):
                calls.append((path,data))
                if path.endswith('/inventory'):
                    return {'selected':[{'id':records[70]['id'],'position':71},{'id':records[-1]['id'],'position':150}]}
        def run(arguments,cwd,lost,output):
            commands.append(arguments)
            (cwd/output).write_text(json.dumps({'entries':records,'playlist_count':150}),encoding='utf-8')
        with patch.dict(os.environ,{},clear=True),patch.object(agent,'run_command',run):
            agent.process_job(API(),{'id':'scan','kind':'scan','leaseToken':'lease','source':{'kind':'playlist','url':'https://www.youtube.com/playlist?list=PLfixture'},'options':{'scan_limit':7}})
        self.assertEqual(commands[0][commands[0].index('--playlist-end')+1],'10001')
        self.assertEqual(len(calls[0][1]['items']),150)
        self.assertEqual([item['position'] for item in calls[1][1]['entries']],[71,150])
        self.assertEqual(len(commands),1,'Only flat metadata, no per-video metadata/audio preflight')
        self.assertIn('--flat-playlist',commands[0])

    def test_incomplete_or_oversize_snapshot_never_advances_baseline(self):
        class API:
            def post(self,*args,**kwargs):raise AssertionError('Must not commit a partial inventory')
        for metadata in ({'entries':[],'playlist_count':50},{'entries':[],'playlist_count':10001},{}):
            with self.subTest(metadata=metadata),self.assertRaises(ValueError):
                agent.playlist_batch(API(),'/scan','lease',metadata,metadata.get('entries',[]))

    def test_empty_list_duplicate_and_live_items_have_explicit_inventory_semantics(self):
        calls=[]
        class API:
            def post(self,path,data=None,**kwargs):calls.append(data);return {'selected':[]}
        entries=[{'id':'video000001'},{'id':'video000001'},{'id':'video000002','live_status':'is_live'},{'id':'video000003','availability':'private'},None]
        self.assertEqual(agent.playlist_batch(API(),'/scan','lease',{'entries':entries},entries),[])
        self.assertEqual(calls,[{'items':[{'id':'video000001','position':1}]}])
        agent.playlist_batch(API(),'/scan','lease',{'entries':[]},[])
        self.assertEqual(calls[-1],{'items':[]})

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
