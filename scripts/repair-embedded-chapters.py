"""Operator repair: add native chapters to existing R2 MP3s without YouTube downloads.

Copies compressed audio, verifies chapters and decoded audio, uploads a fresh
object, then switches all existing references. D1 triggers retain old objects
until normal GC; private feed tokens and metadata are never printed.
"""
import json
import os
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.wrangler/chapter-repair'
STATE.mkdir(parents=True, exist_ok=True)


def run(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=300,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}); private output withheld')
    return result.stdout


def db(sql, write=False):
    args = ['npx.cmd' if os.name == 'nt' else 'npx', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--json']
    if write:
        path = STATE / 'update.sql'
        path.write_text(sql, encoding='utf-8')
        try:
            run([*args, '--file', str(path)])
        finally:
            path.unlink(missing_ok=True)
        return
    output = run([*args, '--command', sql])
    return json.loads(output[output.index('['):])[0]['results']


def quote(value):
    return "'" + value.replace("'", "''") + "'"


def audio_hash(path):
    # Decode both files to compare sound, independently of container tags.
    return run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path), '-map', '0:a:0',
                '-f', 'hash', '-hash', 'sha256', '-']).strip()


def main():
    rows = db("SELECT id,object_key,size,duration,metadata FROM episodes WHERE object_key IS NOT NULL AND json_array_length(json_extract(metadata,'$.chapters'))>0")
    seen = set()
    repaired = 0
    for row in rows:
        old = row['object_key']
        if old in seen or old.endswith('-chapters-v1.mp3'):
            continue
        seen.add(old)
        chapters = json.loads(row['metadata'])['chapters']
        folder = STATE / row['id']
        folder.mkdir(exist_ok=True)
        original, tagged = folder/'original.mp3', folder/'chapters.mp3'
        (folder/'before.json').write_text(json.dumps(row, ensure_ascii=False), encoding='utf-8')
        cli = ['npx.cmd' if os.name == 'nt' else 'npx', 'wrangler', 'r2', 'object']
        run([*cli, 'get', 'youtast-audio/'+old, '--remote', '--file', str(original)])
        assert original.stat().st_size == row['size'], 'Stored audio size changed; leaving it untouched'
        def escape(value):
            return ''.join(('\\'+c if c in '\\=;#\n' else c) for c in value)
        content = ';FFMETADATA1\n'
        for i, chapter in enumerate(chapters):
            start = round(chapter['startTime']*1000)
            end = round((chapters[i+1]['startTime'] if i+1<len(chapters) else row['duration'])*1000)
            assert 0 <= start < end, 'Invalid chapter boundary'
            content += f'[CHAPTER]\nTIMEBASE=1/1000\nSTART={start}\nEND={end}\ntitle={escape(chapter["title"])}\n'
        metadata = folder/'chapters.ffmetadata'
        metadata.write_text(content, encoding='utf-8')
        run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(original), '-i', str(metadata),
             '-map', '0:a:0', '-map_metadata', '0', '-map_chapters', '1', '-c:a', 'copy',
             '-id3v2_version', '3', str(tagged)])
        probe = json.loads(run(['ffprobe', '-v', 'error', '-show_chapters', '-of', 'json', str(tagged)]))
        assert len(probe['chapters']) == len(chapters)
        for expected, actual in zip(chapters, probe['chapters']):
            assert abs(expected['startTime']-float(actual['start_time'])) < .002
            assert expected['title'] == actual['tags']['title']
        assert audio_hash(original) == audio_hash(tagged), 'Decoded sound changed; upload cancelled'
        assert b'CHAP' in tagged.read_bytes()[:1000000] and b'CTOC' in tagged.read_bytes()[:1000000]
        new = old.rsplit('/', 1)[0]+'/'+str(uuid.uuid4())+'-chapters-v1.mp3'
        run([*cli, 'put', 'youtast-audio/'+new, '--remote', '--file', str(tagged), '--content-type', 'audio/mpeg'])
        size = tagged.stat().st_size
        db(f'UPDATE episodes SET object_key={quote(new)},size={size} WHERE object_key={quote(old)} AND size={int(row["size"])};', write=True)
        changed = db(f'SELECT COUNT(*) AS n FROM episodes WHERE object_key={quote(new)} AND size={size}')
        assert changed[0]['n'] > 0, 'No references switched; retain uploaded object for operator recovery'
        result = {'episode_id':row['id'], 'chapters':len(chapters), 'old_bytes':row['size'], 'new_bytes':size,
                  'decoded_audio':'identical', 'references':changed[0]['n']}
        (folder/'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
        repaired += 1
    print(f'Embedded chapter repair complete: {repaired} audio object(s).')


if __name__ == '__main__':
    main()
