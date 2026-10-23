import os
"""Read a private validation feed and decode its enclosure, without YouTube cookies."""
import hashlib
import json
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "executor"))
from agent import NoRedirect


def main():
    feed = json.loads((ROOT / ".secrets/windows-validation-feed.json").read_text(encoding="utf-8"))
    origin = os.environ["YOUTAST_URL"]
    for key in ("feed_url", "media_url"):
        url = urlsplit(feed[key])
        if url.scheme != "https" or url.netloc != urlsplit(origin).netloc or url.username or url.password or url.query or url.fragment:
            raise ValueError("Unexpected validation feed origin")
    # This independent reader deliberately has no browser session or executor token.
    opener = urllib.request.build_opener(NoRedirect())

    def request(url, method="GET", headers=None):
        return opener.open(urllib.request.Request(url, method=method, headers={"User-Agent": "YouTast-RSS-Reader/0.1", **(headers or {})}), timeout=60)

    with request(feed["feed_url"]) as response:
        xml = response.read(1_000_001)
        assert response.status == 200 and len(xml) <= 1_000_000
    assert b"<!DOCTYPE" not in xml.upper()
    document = ET.fromstring(xml)
    assert document.tag == "rss"
    items = document.findall("channel/item")
    item = next((item for item in items if item.find("enclosure") is not None and item.find("enclosure").get("url") == feed["media_url"]), None)
    assert item is not None, "RSS is missing the converted episode"
    enclosure = item.find("enclosure")
    declared_length = int(enclosure.get("length", "0"))
    assert enclosure.get("type") == "audio/mpeg" and 0 < declared_length <= 5_000_000
    with request(enclosure.get("url")) as response:
        audio = response.read(5_000_001)
        assert response.status == 200 and len(audio) == declared_length
        assert response.headers.get("Content-Type", "").split(";")[0] == "audio/mpeg"
    with request(enclosure.get("url"), "HEAD") as response:
        assert response.status == 200 and int(response.headers["Content-Length"]) == len(audio)
    with request(enclosure.get("url"), headers={"Range": "bytes=0-1023"}) as response:
        assert response.status == 206 and response.read(2048) == audio[:1024]
    target = ROOT / ".wrangler/windows-executor/rss-enclosure.mp3"
    target.write_bytes(audio)
    decode = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(target), "-f", "null", "-"], capture_output=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    assert decode.returncode == 0 and not decode.stderr, "Audio failed full FFmpeg decode"
    result = {"status": "passed", "rss_items": len(items), "audio_bytes": len(audio), "sha256": hashlib.sha256(audio).hexdigest(), "range": "passed", "full_decode": "passed"}
    (ROOT / ".wrangler/windows-executor/rss-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Raw transport exceptions may include the private feed URL.
        print("RSS verification failed:", type(error).__name__)
        sys.exit(1)
