"""Real FFmpeg checks for AAC stream copy, compact encoding and native chapters."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from yt_dlp import YoutubeDL

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'executor'))
from agent import prepare_m4a

def ff(*args):
    return subprocess.check_output(['ffmpeg','-nostdin','-v','error',*map(str,args)],stderr=subprocess.PIPE)

class AACTest(unittest.TestCase):
    def test_copy_and_compact_preserve_chapters_and_seekable_container(self):
        with tempfile.TemporaryDirectory() as directory:
            cwd=Path(directory);source=cwd/'source.m4a'
            ff('-f','lavfi','-i','sine=frequency=440:duration=12','-ac','2','-c:a','aac','-b:a','128k',source)
            def packets(path):
                return hashlib.sha256(ff('-i',path,'-map','0:a:0','-c:a','copy','-f','adts','-')).hexdigest()
            original=packets(source)
            meta={'title':'AAC example','chapters':[{'start_time':0,'title':'开始 & intro'}, {'start_time':5,'title':'Next = ; #two\nline'}]}
            audio,duration=prepare_m4a(source,cwd,threading.Event(),64,'source',meta)
            self.assertEqual(duration,12)
            self.assertEqual(packets(audio),original,'AAC packets must be identical, not re-encoded')
            probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_chapters','-show_streams','-of','json',str(audio)]))
            self.assertEqual(probe['streams'][0]['codec_name'],'aac')
            self.assertEqual(probe['streams'][0]['channels'],2,'Stream copy preserves original stereo')
            self.assertEqual([c['tags']['title'] for c in probe['chapters']],[c['title'] for c in meta['chapters']])
            self.assertAlmostEqual(float(probe['chapters'][1]['start_time']),5)
            data=audio.read_bytes();self.assertLess(data.index(b'moov'),data.index(b'mdat'))
            ff('-i',audio,'-f','null','-')
            compact,_=prepare_m4a(source,cwd,threading.Event(),64,'compact',meta)
            self.assertNotEqual(packets(compact),original)
            self.assertLess(compact.stat().st_size,source.stat().st_size*.8)
            compact_probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(compact)]))
            self.assertEqual(compact_probe['streams'][0]['channels'],1)
            self.assertEqual(compact_probe['streams'][0]['sample_rate'],'48000')
            ff('-i',compact,'-f','null','-')
            stereo,_=prepare_m4a(source,cwd,threading.Event(),128,'compact',meta)
            stereo_probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(stereo)]))
            self.assertEqual(stereo_probe['streams'][0]['channels'],2)
            self.assertEqual(stereo_probe['streams'][0]['sample_rate'],'48000')

    def test_opus_fallback_encodes_aac(self):
        with tempfile.TemporaryDirectory() as directory:
            cwd=Path(directory);source=cwd/'source.webm'
            ff('-f','lavfi','-i','sine=duration=2','-c:a','libopus',source)
            audio,_=prepare_m4a(source,cwd,threading.Event(),48,'source',{})
            probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(audio)]))
            self.assertEqual(probe['streams'][0]['codec_name'],'aac')
            self.assertEqual(probe['streams'][0]['channels'],1)
            self.assertEqual(probe['streams'][0]['sample_rate'],'24000')
            ff('-i',audio,'-f','null','-')

    def test_codec_preference_never_overrides_track_language_preference(self):
        base={'url':'https://example.com/audio','vcodec':'none','abr':128,'audio_channels':2}
        formats=[{**base,'format_id':'dub-aac','language_preference':-1,'acodec':'mp4a.40.2','ext':'m4a'},
                 {**base,'format_id':'original-opus','language_preference':10,'acodec':'opus','ext':'webm'},
                 {**base,'format_id':'original-aac','language_preference':10,'acodec':'mp4a.40.2','ext':'m4a'}]
        with YoutubeDL({'quiet':True,'format_sort':['lang','acodec:m4a']}) as ydl:
            info={'formats':formats};ydl.sort_formats(info)
            self.assertEqual(info['formats'][-1]['format_id'],'original-aac')
            info={'formats':[f for f in formats if f['format_id']!='original-aac']};ydl.sort_formats(info)
            self.assertEqual(info['formats'][-1]['format_id'],'original-opus')

if __name__=='__main__':unittest.main()
