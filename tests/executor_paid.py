"""Members-only and paid videos are skipped before media download."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from yt_dlp import YoutubeDL
from yt_dlp.utils import match_filter_func

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'executor'))
import agent


class PaidVideoTest(unittest.TestCase):
    def test_scans_exclude_identified_paid_entries(self):
        calls = []
        rows = [{'id': 'video000001', 'availability': 'subscriber_only'},
                {'id': 'video000002', 'availability': 'premium_only'},
                {'id': 'video000003', 'availability': 'public'},
                {'id': 'video000004'}]
        class API:
            def post(self, path, data=None, **kwargs):
                calls.append((path, data))
                return {'selected': []}
        agent.playlist_batch(API(), '/job', 'lease', {'entries': rows}, rows)
        self.assertEqual([x['id'] for x in calls[-1][1]['items']], ['video000003', 'video000004'])
        def run(args, cwd, lost, output):
            (cwd / output).write_text(json.dumps({'entries': rows}), encoding='utf-8')
        with patch.dict(os.environ, {}, clear=True), patch.object(agent, 'run_command', run):
            agent.process_job(API(), {'id': 'scan', 'kind': 'scan', 'leaseToken': 'lease',
                                      'source': {'kind': 'author', 'url': 'https://www.youtube.com/@creator/videos'}, 'options': {}})
        self.assertEqual([x['video_id'] for x in calls[-1][1]['entries']], ['video000003', 'video000004'])

    def test_both_audio_paths_filter_and_report_paid_without_retry(self):
        for profile in ('m4a:64:source', 'mp3'):
            for availability in agent.PAID_AVAILABILITY:
                with self.subTest(profile=profile, availability=availability):
                    calls, commands = [], []
                    class API:
                        def post(self, path, data=None, **kwargs): calls.append((path, data))
                    def run(args, cwd, lost, output):
                        commands.append(args)
                        (cwd / 'availability.txt').write_text(availability, encoding='utf-8')
                    with patch.dict(os.environ, {}, clear=True), patch.object(agent, 'run_command', run):
                        agent.process_job(API(), {'id': 'audio', 'kind': 'transcode', 'leaseToken': 'lease',
                                                  'episode': {'video_id': 'video000001'}, 'options': {'encoding_profile': profile}})
                    expression = commands[0][commands[0].index('--match-filters') + 1]
                    match = match_filter_func(expression)
                    for status in agent.PAID_AVAILABILITY:
                        self.assertIsNotNone(match({'duration': 30, 'is_live': False, 'availability': status}, incomplete=False))
                    for status in ('public', 'unlisted', None):
                        self.assertIsNone(match({'duration': 30, 'is_live': False, 'availability': status}, incomplete=False))
                    self.assertEqual(calls, [('/api/executor/jobs/audio/fail', {'skip_paid': True})])

    def test_ytdlp_exposes_availability_before_filter_without_downloading(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'availability.txt'
            opts = {'quiet': True, 'print_to_file': {'pre_process': [('%(availability)s', str(state))]},
                    'match_filter': match_filter_func('availability !=? subscriber_only & availability !=? premium_only')}
            with YoutubeDL(opts) as ydl, patch.object(ydl, 'urlopen', side_effect=AssertionError('Must not download media')):
                ydl.process_ie_result({'id': 'video000001', 'title': 'Members', 'availability': 'subscriber_only',
                                       'formats': [{'format_id': 'aac', 'url': 'https://example.com/audio', 'ext': 'm4a', 'vcodec': 'none', 'acodec': 'aac'}]}, download=True)
            self.assertEqual(state.read_text().strip(), 'subscriber_only')


if __name__ == '__main__': unittest.main()
