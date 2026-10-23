"""Exercise the executor's actual yt-dlp postprocessor against a real MP3."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from yt_dlp import YoutubeDL
from yt_dlp.postprocessor.ffmpeg import FFmpegMetadataPP


class EmbeddedChaptersTest(unittest.TestCase):
    def test_original_chapters_survive_in_mp3_with_unchanged_audio(self):
        with tempfile.TemporaryDirectory(prefix='youtast-chapters-') as directory:
            path = Path(directory)/'audio.mp3'
            subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i',
                            'sine=frequency=440:duration=12','-b:a','64k',str(path)],check=True,capture_output=True)
            def sound():
                return subprocess.check_output(['ffmpeg','-nostdin','-v','error','-i',str(path),
                                                '-f','hash','-hash','sha256','-'])
            before = sound()
            chapters = [{'start_time':0,'end_time':5,'title':'开始 & intro'},
                        {'start_time':5,'end_time':12,'title':'Next = section; #two'}]
            with YoutubeDL({'quiet':True,'postprocessor_args':{'metadata+ffmpeg_o':['-id3v2_version','3']}}) as ydl:
                FFmpegMetadataPP(ydl, add_metadata=False, add_chapters=True, add_infojson=False).run(
                    {'filepath':str(path),'ext':'mp3','chapters':chapters})
            info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_chapters','-of','json',str(path)]))
            self.assertEqual(len(info['chapters']),2)
            for expected,actual in zip(chapters,info['chapters']):
                self.assertAlmostEqual(float(actual['start_time']),expected['start_time'])
                self.assertEqual(actual['tags']['title'],expected['title'])
            self.assertEqual(path.read_bytes()[:4],b'ID3\x03')
            self.assertIn(b'CHAP',path.read_bytes())
            self.assertIn(b'CTOC',path.read_bytes())
            self.assertEqual(before,sound())


if __name__=='__main__': unittest.main()
