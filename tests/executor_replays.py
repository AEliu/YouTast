"""Live transitions wait for a finite archive; never record an active stream."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import sqlite3
from contextlib import closing
import unittest
from unittest.mock import patch
from yt_dlp.utils import match_filter_func
from yt_dlp import YoutubeDL
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'executor'))
import agent

class ReplayTest(unittest.TestCase):
    def test_migration_recovers_old_empty_single_scans_without_touching_existing_audio(self):
        with closing(sqlite3.connect(':memory:')) as db:
            db.executescript("CREATE TABLE sources(id TEXT,channel_id TEXT,kind TEXT,url TEXT,next_scan INTEGER);CREATE TABLE executors(id TEXT);CREATE TABLE episodes(channel_id TEXT,video_id TEXT);INSERT INTO sources VALUES('empty','c','video','https://www.youtube.com/watch?v=stream00001',9999999999),('ready','c','video','https://www.youtube.com/watch?v=stream00002',9999999999);INSERT INTO episodes VALUES('c','stream00002');")
            db.executescript((Path(__file__).resolve().parents[1]/'migrations/0015_live_replays.sql').read_text())
            self.assertEqual(db.execute('SELECT id,waiting_replay FROM sources ORDER BY id').fetchall(),[('empty',1),('ready',0)])

    def scan(self,entries,single=False):
        commands,calls=[],[]
        class API:
            def post(self,path,data=None,**kw):calls.append((path,data))
        def run(args,cwd,lost,output):
            commands.append(args)
            (cwd/output).write_text(json.dumps(entries[0] if single else {'entries':entries}),encoding='utf-8')
        with patch.dict(os.environ,{},clear=True),patch.object(agent,'run_command',run):
            agent.process_job(API(),{'id':'scan','kind':'scan','leaseToken':'lease','source':{'kind':'video' if single else 'author','url':'https://www.youtube.com/watch?v=stream00001' if single else 'https://www.youtube.com/@creator/streams'},'options':{'scan_limit':7,'latest_limit':3}})
        self.assertTrue(calls[0][0].endswith('/scan'))
        return calls[0][1],commands

    def test_each_pending_single_live_state_is_recurring_without_audio(self):
        for state in ('is_live','is_upcoming','post_live'):
            with self.subTest(state=state):
                data,commands=self.scan([{'id':'stream00001','live_status':state,'duration':30}],True)
                self.assertEqual(data['entries'],[]);self.assertTrue(data['recurring'])
                self.assertIn('--ignore-no-formats-error',commands[0])
                self.assertIn('--skip-download',commands[0])

    def test_stream_list_excludes_live_unprocessed_and_unknown_duration(self):
        rows=[{'id':f'stream0000{i}','live_status':state,'duration':40} for i,state in enumerate(('is_live','is_upcoming','post_live','was_live'))]
        rows+=[{'id':'stream00004'},{'id':'stream00005','duration':10}]
        data,_=self.scan(rows)
        self.assertEqual([e['video_id'] for e in data['entries']],['stream00003','stream00005'])
        self.assertTrue(data['recurring'])

    def test_processed_single_archive_stops_recurring_and_uses_broadcast_date(self):
        data,_=self.scan([{'id':'stream00001','live_status':'was_live','duration':60,'timestamp':1700000300,'release_timestamp':1700000000}],True)
        self.assertFalse(data['recurring']);self.assertEqual(data['entries'][0]['published_at'],1700000000)

    def test_download_filter_rejects_processing_even_with_known_duration(self):
        f=match_filter_func('duration <= 10800 & !is_live & live_status !=? post_live & live_status !=? is_upcoming')
        for state in ('is_live','is_upcoming','post_live'):
            self.assertIsNotNone(f({'duration':30,'live_status':state,'is_live':state=='is_live'},incomplete=False))
        self.assertIsNone(f({'duration':30,'live_status':'was_live','is_live':False},incomplete=False))

    def test_pre_filter_status_is_available_without_another_network_request(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/'state.txt'
            with YoutubeDL({'quiet':True,'print_to_file':{'pre_process':[('%(live_status)s',str(state))]},'match_filter':match_filter_func('live_status != post_live')}) as ydl:
                ydl.process_ie_result({'id':'stream00001','title':'Processing','live_status':'post_live','duration':20,'formats':[{'format_id':'aac','url':'https://example.com/must-not-download','ext':'m4a','vcodec':'none','acodec':'aac'}]},download=True)
            self.assertEqual(state.read_text().strip(),'post_live')

    def test_not_ready_during_download_defers_instead_of_counting_as_failure(self):
        calls=[]
        class API:
            def post(self,path,data=None,**kw):calls.append((path,data))
        def run(args,cwd,lost,output):
            (cwd/'replay-state.txt').write_text('post_live\n')
        with patch.dict(os.environ,{},clear=True),patch.object(agent,'run_command',run):
            agent.process_job(API(),{'id':'audio','kind':'transcode','leaseToken':'lease','episode':{'video_id':'stream00001'},'options':{'encoding_profile':'m4a:64:source'}})
        self.assertEqual(calls,[('/api/executor/jobs/audio/fail',{'defer_replay':True})])

    def test_author_without_a_streams_tab_stays_empty_and_recurring(self):
        calls=[]
        class API:
            def post(self,path,data=None,**kw):calls.append((path,data))
        with patch.dict(os.environ,{},clear=True),patch.object(agent,'run_command',side_effect=agent.NoReplayTab()):
            agent.process_job(API(),{'id':'scan','kind':'scan','leaseToken':'lease','source':{'kind':'author','url':'https://www.youtube.com/@creator/streams'},'options':{}})
        self.assertEqual(calls,[('/api/executor/jobs/scan/scan',{'entries':[],'recurring':True})])

if __name__=='__main__':unittest.main()
