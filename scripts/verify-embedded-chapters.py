import os
"""Independent private RSS/media check; no session cookies or executor token."""
import importlib.util
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('repair', Path(__file__).with_name('repair-embedded-chapters.py'))
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
rows = repair.db("SELECT e.id,e.size,c.feed_token FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE e.object_key LIKE '%-chapters-v1.mp3'")
origin = os.environ["YOUTAST_URL"]
# Wrangler uses the configured proxy; artifact reads use the normal direct route.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch(path, method='GET', headers=None):
    return opener.open(urllib.request.Request(origin+path, method=method,
                       headers={'User-Agent':'YouTast-RSS-Reader/0.1', **(headers or {})}), timeout=60)


for row in rows:
    with fetch('/feed/'+row['feed_token']+'.xml') as response:
        feed = ET.fromstring(response.read())
    item = next(item for item in feed.findall('channel/item') if item.findtext('guid') == row['id'])
    enclosure = item.find('enclosure')
    media = enclosure.get('url')[len(origin):]
    with fetch(media, 'HEAD') as response:
        assert int(response.headers['Content-Length']) == row['size']
    with fetch(media, headers={'Range':'bytes=0-65535'}) as response:
        assert response.status == 206
        assert response.read() == (repair.STATE/row['id']/'chapters.mp3').read_bytes()[:65536]
    chapter_url = item.find('{https://podcastindex.org/namespace/1.0}chapters').get('url')
    with fetch(chapter_url[len(origin):]) as response:
        assert response.headers['Content-Type'].startswith('application/json+chapters')
        chapters = json.load(response)['chapters']
    expected = json.loads((repair.STATE/row['id']/'before.json').read_text(encoding='utf-8'))
    assert chapters == json.loads(expected['metadata'])['chapters']
    assert item.findtext('description').startswith('00:00:00 ')
    assert int(enclosure.get('length')) == row['size']
    result = {'rss':'passed','private_chapter_json':'passed','chapters':len(chapters),
              'media_head':'passed','range_matches_repaired_audio':'passed','no_login_cookie_required':True}
    (repair.STATE/row['id']/'production-verification.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
assert rows, 'No repaired production chapters to check'
