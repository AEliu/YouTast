"""Offline yt-dlp CLI fixture, enabled only by the process smoke test's PYTHONPATH.

No network is used. FFmpeg generates real MP3 audio so that the executor's
subprocess handling, file upload, and podcast media are exercised together.
"""
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

video_id = parse_qs(urlsplit(sys.argv[-1]).query)["v"][0]
metadata = {"id": video_id, "title": "Offline audio " + video_id, "duration": 2}
if "--dump-single-json" in sys.argv:
    print(json.dumps(metadata))
elif "--extract-audio" in sys.argv:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi",
         "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-b:a", "64k",
         "-y", "audio.mp3"],
        check=True,
    )
    Path("audio.info.json").write_text(json.dumps(metadata), encoding="utf-8")
else:
    raise SystemExit("Unsupported fixture invocation")
