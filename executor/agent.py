"""Outbound-only YouTast worker. Requires FFmpeg and a supported yt-dlp JS runtime."""
import http.client
import datetime
import concurrent.futures
import http.cookiejar
import json
import logging
import os
import random
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from pathlib import Path

LOG = logging.getLogger("youtast")
STOP = threading.Event()
VIDEO_ID = re.compile(r"^[\w-]{11}$", re.ASCII)


def publication_time(metadata):
    """Use original video metadata, never the local download/file time."""
    value = metadata.get('release_timestamp') if metadata.get('was_live') or metadata.get('live_status')=='was_live' else None
    if not isinstance(value,(int,float)) or isinstance(value,bool) or not 0<value<=time.time()+86400:
        value = metadata.get("timestamp")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= time.time() + 86400:
        return int(value)
    date = metadata.get("upload_date")
    if isinstance(date, str) and re.fullmatch(r"\d{8}", date):
        try:
            value = int(datetime.datetime.strptime(date, "%Y%m%d").replace(tzinfo=datetime.timezone.utc).timestamp())
            if 0 < value <= time.time() + 86400:
                return value
        except ValueError:
            pass
    return None


def video_metadata(meta, full=True):
    return {
        'description': str(meta.get('description') or '')[:20000] if full else '',
        'author': str(meta.get('channel') or meta.get('uploader') or '')[:200],
        'thumbnail': str(meta.get('thumbnail') or '')[:1000],
        'language': str(meta.get('language') or '')[:30],
        'chapters': [{'startTime': c.get('start_time'), 'title': str(c.get('title') or '')[:200]} for c in (meta.get('chapters') or [])[:100] if isinstance(c, dict)] if full else [],
    }


def claim_retry_delay(error, now=None):
    """A Workers quota error is account-wide; stop polling until its UTC reset."""
    now = time.time() if now is None else now
    if error.code != 429:
        return None
    try:
        body = error.read(128_000).decode("utf-8", errors="replace")
    except OSError:
        body = ""
    if "1027" in body and "cloudflare" in body.lower():
        if now % 86400 < 120:
            return 60  # Allow for propagation immediately after the quota resets.
        return max(1, 86400 - now % 86400)
    retry_after = error.headers.get("Retry-After", "")
    if retry_after.isdigit():
        return max(60, int(retry_after))
    return 300


def youtube_cookie_file(filename):
    """Accept an explicitly supplied YouTube-only Netscape export, never browser stores."""
    path = Path(filename).expanduser().resolve()
    try:
        if not path.is_file() or not 0 < path.stat().st_size <= 1_000_000:
            raise ValueError("Invalid YouTube cookies file: missing, empty, or too large")
        jar = http.cookiejar.MozillaCookieJar(str(path))
        # MozillaCookieJar can include a malformed input line in its parser warning.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            jar.load(ignore_discard=True, ignore_expires=True)
    except (OSError, http.cookiejar.LoadError):
        raise ValueError("Cannot read YouTube cookies; use a Netscape cookies.txt export") from None
    cookies = list(jar)
    if not cookies or any(
        not (cookie.domain.lstrip(".").lower() == "youtube.com" or cookie.domain.lstrip(".").lower().endswith(".youtube.com"))
        for cookie in cookies
    ):
        raise ValueError("Export only youtube.com cookies; other website sessions are not accepted")
    if not any(cookie.expires is None or cookie.expires > time.time() for cookie in cookies):
        raise ValueError("YouTube cookies have expired; export a fresh session")
    return path


def task_cookie_file(filename, directory):
    """Let yt-dlp update a task-local jar, without overwriting the user's export."""
    source = youtube_cookie_file(filename)
    target = Path(directory) / "youtube-cookies.txt"
    shutil.copyfile(source, target)
    return target


def downloader_failure(diagnostic):
    """Classify locally; return only fixed messages that cannot contain session data."""
    message = diagnostic.lower()
    if "cookies are no longer valid" in message:
        return "YouTube cookies are no longer valid; export a fresh YouTube session on this machine"
    if any(marker in message for marker in ("confirm your age", "age-restricted", "age restricted")):
        return "YouTube requires age verification for this video; confirm account access in the browser"
    if "not a bot" in message:
        return "YouTube requires verification; refresh this machine's YouTube cookies and confirm its network"
    if "ssl" in message or "certificate_verify_failed" in message:
        return "YouTube TLS connection failed; check executor network and certificate configuration"
    if "http error 429" in message or "too many requests" in message:
        return "YouTube is rate limiting this machine; wait before retrying"
    if "http error 403" in message:
        return "YouTube rejected the media download (HTTP 403); check the session and media access"
    if "requested format is not available" in message:
        return "YouTube did not provide a downloadable audio format for this session"
    if "video unavailable" in message or "private video" in message:
        return "This YouTube video is unavailable or private for the configured session"
    return "yt-dlp failed; inspect executor logs and update yt-dlp/JS runtime"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("API redirects are not allowed; verify YOUTAST_URL")


class API:
    def __init__(self, url, token):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
            raise ValueError("YOUTAST_URL must use HTTPS (localhost HTTP is allowed)")
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("YOUTAST_URL must be an origin without credentials or a path")
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            raise ValueError("YOUTAST_TOKEN must be a 64-character executor token")
        self.url, self.token = url.rstrip("/"), token
        self.opener = urllib.request.build_opener(NoRedirect())

    def post(self, path, data=None, lease=None, audio=None, duration=0, published_at=None):
        headers = {"Authorization": "Bearer " + self.token, "User-Agent": "YouTast-Executor/0.1", "Accept": "application/json", "X-Executor-Protocol": "2", "X-Executor-Rate-Control":"1", "X-Executor-Content-Control":"1", "X-Executor-Audio-Control":"1", "X-Executor-Replay-Control":"1", "X-Executor-Discovery-Control":"1"}
        if lease:
            headers["X-Lease-Token"] = lease
        if audio:
            if published_at:
                headers["X-Published-At"] = str(published_at)
            headers.update({"Content-Type": "audio/mp4" if audio.suffix == '.m4a' else "audio/mpeg", "Content-Length": str(audio.stat().st_size), "X-Audio-Duration": str(duration)})
            with audio.open("rb") as stream:
                req = urllib.request.Request(self.url + path, data=stream, headers=headers, method="POST")
                with self.opener.open(req, timeout=300) as response:
                    return json.load(response)
        raw = json.dumps(data or {}).encode()
        headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=raw, headers=headers, method="POST")
        with self.opener.open(req, timeout=30) as response:
            return json.load(response)


def terminate_process(process):
    """Stop our child and its descendants, including FFmpeg and Windows venv launchers."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        # Commands we launch own a process group; never signal our caller's group.
        try:
            group = os.getpgid(process.pid)
            if group == process.pid:
                os.killpg(group, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name != "nt" and os.getpgid(process.pid) == process.pid:
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait()


def run_command(arguments, cwd, lost, stdout_name):
    """Bound runtime and interrupt work if the server revokes the lease."""
    with (cwd / stdout_name).open("wb") as out, (cwd / "errors.log").open("wb") as err:
        environment = {key: value for key, value in os.environ.items() if key != "YOUTAST_TOKEN"}
        process = subprocess.Popen(arguments, cwd=cwd, stdout=out, stderr=err, env=environment, start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + 7200
        try:
            while process.poll() is None:
                if STOP.is_set() or lost.is_set() or time.monotonic() > deadline:
                    raise RuntimeError("Task cancelled, lease lost, or two-hour execution timeout")
                time.sleep(1)
            if process.returncode:
                # Keep raw yt-dlp stderr on the local console, never send cookies or paths to the service.
                diagnostic = (cwd / "errors.log").read_text(encoding="utf-8", errors="replace")
                if arguments[-1].endswith('/streams') and re.search(r'does not have a (?:streams|live) tab',diagnostic,re.I):
                    raise NoReplayTab('No live replay tab yet')
                if "--cookies" in arguments:
                    LOG.warning("Downloader diagnostic: %s", downloader_failure(diagnostic))
                else:
                    LOG.warning("yt-dlp failed; local diagnostic: %s", diagnostic[-1500:])
                raise RuntimeError(downloader_failure(diagnostic))
        finally:
            terminate_process(process)


def prepare_m4a(source, cwd, lost, bitrate, mode, metadata):
    """Copy AAC packets when possible; otherwise encode AAC-LC into seekable MP4."""
    run_command(['ffprobe','-v','error','-select_streams','a:0','-show_entries',
                 'stream=codec_name,channels:format=duration','-of','json',str(source)],cwd,lost,'probe.json')
    probe=json.loads((cwd/'probe.json').read_text(encoding='utf-8'))
    duration=float(probe.get('format',{}).get('duration',0))
    if not 0<duration<=10801 or not probe.get('streams'):
        raise RuntimeError('Invalid audio duration or missing audio stream')
    copy=mode=='source' and probe['streams'][0]['codec_name']=='aac' and source.stat().st_size<=88_000_000
    def escape(value):
        return ''.join(('\\'+c if c in '\\=;#\n' else c) for c in str(value))
    content=';FFMETADATA1\n'+'title='+escape(str(metadata.get('title') or '')[:300])+'\n'
    chapters=sorted([c for c in (metadata.get('chapters') or [])[:100] if isinstance(c,dict) and isinstance(c.get('start_time'),(int,float)) and 0<=c['start_time']<duration],key=lambda c:c['start_time'])
    for i,c in enumerate(chapters):
        start=round(c['start_time']*1000)
        end=round((chapters[i+1]['start_time'] if i+1<len(chapters) else duration)*1000)
        if start>=end:continue
        content+=f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={start}\nEND={end}\ntitle={escape(str(c.get('title') or '')[:200])}\n"
    chapter_file=cwd/'chapters.ffmetadata';chapter_file.write_text(content,encoding='utf-8',newline='\n')
    audio=cwd/'audio.m4a'
    args=['ffmpeg','-nostdin','-v','error','-y','-i',str(source),'-i',str(chapter_file),
          '-map','0:a:0','-map_metadata','1','-map_chapters','1','-vn','-c:a','copy' if copy else 'aac']
    if not copy:
        # Apple's RSS guidance pairs 64–96 kbps speech with mono and reserves
        # 44.1/48 kHz stereo for >=128 kbps. Never alter copied AAC packets.
        channels=1 if bitrate<128 else min(2,max(1,int(probe['streams'][0].get('channels',2))))
        sample_rate=24000 if bitrate<64 else 48000
        args+=['-profile:a','aac_low','-b:a',f'{bitrate}k','-ac',str(channels),'-ar',str(sample_rate)]
    args+=['-movflags','+faststart',str(audio)]
    run_command(args,cwd,lost,'package.log')
    if not audio.is_file() or not 0<audio.stat().st_size<=90_000_000:
        raise RuntimeError('No audio produced or audio exceeds 90 MB')
    LOG.info('M4A audio prepared: %s', 'AAC stream copy' if copy else 'AAC encode')
    return audio,round(duration)


def heartbeat(api, job, finished, lost):
    while not finished.wait(60):
        try:
            api.post(f"/api/executor/jobs/{job['id']}/heartbeat", lease=job["leaseToken"])
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 409):
                lost.set()
                return
            LOG.warning("Heartbeat HTTP %s", exc.code)
        except Exception as exc:
            LOG.warning("Heartbeat unavailable: %s", type(exc).__name__)


class ReplayPending(RuntimeError):
    pass


class NoReplayTab(RuntimeError):
    pass


def run_audio_download(args,cwd,lost):
    # Observe status before yt-dlp's filters/format selection, using the same
    # extraction request. No extra per-video preflight request is required.
    at=args.index('--')
    args[at:at]=['--ignore-no-formats-error','--no-simulate','--print-to-file','pre_process:%(live_status)s','replay-state.txt']
    def pending():
        path=cwd/'replay-state.txt'
        return path.is_file() and any(s.strip() in ('is_live','is_upcoming','post_live') for s in path.read_text(encoding='utf-8').splitlines())
    try:
        run_command(args,cwd,lost,'download.log')
    except RuntimeError:
        if pending():raise ReplayPending('Live replay is not ready')
        raise
    if pending():raise ReplayPending('Live replay is not ready')


def playlist_batch(api, path, lease, metadata, entries):
    """Compare a complete accessible ID inventory, then collect one durable batch."""
    if not isinstance(metadata.get('entries'), list) or not isinstance(entries, list):
        raise ValueError('Playlist inventory is not complete')
    count = metadata.get('playlist_count')
    if len(entries) > 10000 or (type(count) is int and count > 10000):
        raise ValueError('Playlist exceeds the 10000-item discovery limit; split this playlist')
    if type(count) is int and count > len(entries):
        raise ValueError('Playlist inventory is incomplete; retry without advancing its baseline')
    items, available = [], {}
    for position, entry in enumerate(entries, 1):
        if not isinstance(entry, dict):
            continue
        video_id = entry.get('id', '')
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id) or video_id in available or entry.get('is_live') or entry.get('live_status') in ('is_live', 'is_upcoming', 'post_live') or entry.get('availability') == 'private':
            continue
        items.append({'id': video_id, 'position': position})
        available[video_id] = (position, entry)
    reply = api.post(path + '/inventory', {'items': items}, lease=lease)
    selected = reply.get('selected')
    if not isinstance(selected, list) or len(selected) > 100:
        raise ValueError('Invalid playlist discovery response')
    result, seen = [], set()
    for item in selected:
        if not isinstance(item, dict) or item.get('id') not in available or item['id'] in seen or item.get('position') != available[item['id']][0]:
            raise ValueError('Invalid playlist discovery selection')
        seen.add(item['id'])
        result.append(available[item['id']])
    return result


def process_job(api, job):
    finished, lost = threading.Event(), threading.Event()
    thread = threading.Thread(target=heartbeat, args=(api, job, finished, lost), daemon=True)
    thread.start()
    path = f"/api/executor/jobs/{job['id']}"
    try:
        with tempfile.TemporaryDirectory(prefix="youtast-") as temp:
            cwd = Path(temp)
            options = job.get('options', {})
            bitrate = options.get('bitrate', 64)
            text_language = options.get('text_language', 'zh-CN')
            scan_limit = options.get('scan_limit', 30)
            execution = options.get('execution', {})
            request_interval,download_wait = execution.get('request_interval',2),execution.get('download_wait',10)
            if type(request_interval) is not int or not 0<=request_interval<=30 or type(download_wait) is not int or not 0<=download_wait<=60:
                raise ValueError('Unsupported execution request limits')
            if bitrate not in (48, 64, 96, 128) or text_language not in ('original','zh-CN','zh-TW','en','ja','ko','es','fr','de') or type(scan_limit) is not int or not 1<=scan_limit<=100:
                raise ValueError('Unsupported executor settings')
            common = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3", "--js-runtimes", "node", "--js-runtimes", "deno"]
            common += ['--sleep-requests',str(request_interval),'--concurrent-fragments','1','--retry-sleep','5']
            if os.environ.get("YOUTAST_COOKIES_FILE"):
                cookies = task_cookie_file(os.environ["YOUTAST_COOKIES_FILE"], cwd)
                common += ["--cookies", str(cookies)]
            if os.environ.get("YOUTAST_POT_PROVIDER_HOME"):
                provider = Path(os.environ["YOUTAST_POT_PROVIDER_HOME"]).expanduser().resolve()
                if not (provider / "build" / "generate_once.js").is_file():
                    raise ValueError("Local PO Token provider is not installed or built")
                common += ["--extractor-args", "youtube:player_client=mweb", "--extractor-args", "youtubepot-bgutilscript:server_home=" + str(provider)]
            if text_language != "original":
                common += ["--extractor-args", "youtube:lang=" + text_language]
            if job["kind"] == "scan":
                source = job["source"]
                if options.get('latest_limit',0)>0:
                    # YouTube's list renderer often gives relative publication
                    # text only. Approximate dates let inactive creators fall
                    # behind recent uploads without fetching each old video.
                    common += ['--extractor-args','youtubetab:approximate_date']
                # Sources are normalized by the API; validate again before passing any URL to yt-dlp.
                parsed = urllib.parse.urlsplit(source["url"])
                if parsed.scheme != "https" or parsed.hostname != "www.youtube.com" or parsed.username or parsed.password or parsed.port:
                    raise ValueError("Invalid YouTube source")
                args = common + ["--flat-playlist", "--dump-single-json", "--skip-download", "--playlist-end", str(10001 if source["kind"] == "playlist" else scan_limit), "--", source["url"]]
                if source['kind']=='video':
                    args.insert(args.index('--'),'--ignore-no-formats-error')
                try:
                    run_command(args, cwd, lost, "metadata.json")
                except NoReplayTab:
                    (cwd/'metadata.json').write_text('{"entries":[]}',encoding='utf-8')
                metadata_file = cwd / "metadata.json"
                if metadata_file.stat().st_size > (32_000_000 if source["kind"] == "playlist" else 8_000_000):
                    raise RuntimeError("Metadata exceeds size limit")
                metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
                entries = metadata.get("entries", [metadata])
                if source['kind']=='playlist':
                    entries=playlist_batch(api,path,job['leaseToken'],metadata,entries)
                else:
                    entries=[(position,entry) for position,entry in enumerate(entries[:scan_limit],1)]
                results = []
                for position, entry in entries:
                    if not entry or not VIDEO_ID.fullmatch(entry.get("id", "")) or entry.get("is_live") or entry.get("live_status") in ("is_live", "is_upcoming", "post_live"):
                        continue
                    # Flat stream lists may omit status. A finite duration is
                    # required before accepting an archive; recheck next sync.
                    if parsed.path.endswith('/streams') and not (isinstance(entry.get('duration'),(int,float)) and entry['duration']>0):
                        continue
                    results.append({"video_id": entry["id"], "title": str(entry.get("title") or entry["id"])[:300], "duration": max(0, min(86400, int(entry.get("duration") or 0))), "position": position, "published_at": publication_time(entry), 'metadata':{**video_metadata(entry, source['kind']=='video'),'text_language':text_language,'complete':source['kind']=='video'}})
                api.post(path + "/scan", {"entries": results, "recurring": source["kind"] != "video" or not results}, lease=job["leaseToken"])
            else:
                video_id = job["episode"]["video_id"]
                if not VIDEO_ID.fullmatch(video_id):
                    raise ValueError("Invalid video ID")
                selection = 'bestaudio/best'
                m4a = options.get('encoding_profile','').startswith('m4a:')
                mode = options.get('audio_mode','source')
                if mode not in ('source','compact','mp3'):raise ValueError('Unsupported audio mode')
                if options.get('metadata_only'):
                    run_command(common + ['--no-playlist','--dump-single-json','--skip-download','--',f'https://www.youtube.com/watch?v={video_id}'],cwd,lost,'metadata.json')
                    info = cwd / 'metadata.json'
                    if info.stat().st_size > 8_000_000:
                        raise RuntimeError('Metadata exceeds size limit')
                    meta = json.loads(info.read_text(encoding='utf-8'))
                    api.post(path + '/metadata', {'metadata':{**video_metadata(meta),'text_language':text_language,'complete':True},'title':str(meta.get('title') or video_id)[:300],'published_at':publication_time(meta),'complete_job':True},lease=job['leaseToken'])
                    return
                max_duration = min(10800, int(89_000_000 * 8 / (bitrate * 1000)))
                # Embedded ID3 chapters also work for private RSS and older clients
                # which do not consume the external Podcasting 2.0 chapter file.
                if m4a:
                    # Language preference precedes codec preference, so requesting
                    # localized text cannot select a different language audio track.
                    sorting=['--format-sort','lang,acodec:m4a'] if mode=='source' else []
                    args=common+['--no-playlist','--format',selection,*sorting,'--max-filesize','250M',
                        '--match-filters',f'duration <= {max_duration} & !is_live & live_status !=? post_live & live_status !=? is_upcoming','--write-info-json',
                        '--print-to-file','after_move:filepath','download-path.txt','--output','source.%(ext)s',
                        '--sleep-interval',str(download_wait),'--max-sleep-interval',str(download_wait+10 if download_wait else 0),
                        '--',f'https://www.youtube.com/watch?v={video_id}']
                    run_audio_download(args,cwd,lost)
                    source=Path((cwd/'download-path.txt').read_text(encoding='utf-8').strip())
                    if not source.is_absolute():source=cwd/source
                    if source.resolve().parent!=cwd.resolve() or not source.is_file() or source.stat().st_size>250_000_000:
                        raise RuntimeError('Unexpected downloaded audio file')
                    info=cwd/'source.info.json'
                    if info.stat().st_size>8_000_000:raise RuntimeError('Metadata exceeds size limit')
                    meta=json.loads(info.read_text(encoding='utf-8'))
                    audio,actual_duration=prepare_m4a(source,cwd,lost,bitrate,mode,meta)
                else:
                    args = common + ["--no-playlist", "--format", selection, "--extract-audio", "--audio-format", "mp3", "--audio-quality", f"{bitrate}K", "--embed-chapters", "--postprocessor-args", "Metadata+ffmpeg_o:-id3v2_version 3", "--max-filesize", "250M", "--match-filters", f"duration <= {max_duration} & !is_live & live_status !=? post_live & live_status !=? is_upcoming", "--write-info-json", "--output", "audio.%(ext)s", "--", f"https://www.youtube.com/watch?v={video_id}"]
                    args[args.index('--'):args.index('--')] = ['--sleep-interval',str(download_wait),'--max-sleep-interval',str(download_wait+10 if download_wait else 0)]
                    run_audio_download(args,cwd,lost)
                    audio = cwd / "audio.mp3"
                    if not audio.exists() or audio.stat().st_size <= 0 or audio.stat().st_size > 90_000_000:
                        raise RuntimeError("No audio produced or MP3 exceeds 90 MB (videos limited to 3 hours)")
                    meta = json.loads((cwd / "audio.info.json").read_text(encoding="utf-8"))
                    actual_duration=int(meta.get('duration') or 0)
                if lost.is_set():
                    raise RuntimeError("Lease lost before upload")
                api.post(path + '/metadata', {'metadata': {**video_metadata(meta),'text_language':text_language,'complete':True},'title':str(meta.get('title') or video_id)[:300]}, lease=job['leaseToken'])
                api.post(path + "/audio", lease=job["leaseToken"], audio=audio, duration=actual_duration, published_at=publication_time(meta))
    except ReplayPending:
        if not lost.is_set():
            try:
                api.post(path+'/fail',{'defer_replay':True},lease=job['leaseToken'])
                LOG.info('Live replay not ready; deferred until next channel interval')
            except Exception:
                LOG.warning('Could not defer replay; lease expiry will recover the job')
    except Exception as exc:
        # Detailed third-party exception strings may include local secrets; send only controlled messages.
        message = str(exc) if type(exc) in (RuntimeError, ValueError) else f"{type(exc).__name__}: processing or upload failed"
        LOG.warning("Job %s failed: %s", job["id"], message)
        if not lost.is_set():
            try:
                api.post(path + "/fail", {"error": message[:500]}, lease=job["leaseToken"])
            except Exception:
                LOG.warning("Could not report failure; lease expiry will recover the job")
    finally:
        finished.set()
        thread.join(timeout=35)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    url, token = os.environ.get("YOUTAST_URL", ""), os.environ.get("YOUTAST_TOKEN", "")
    if not url or not token:
        raise SystemExit("Set YOUTAST_URL and YOUTAST_TOKEN before starting")
    api = API(url, token)
    for name in ("SIGINT", "SIGTERM"):
        signal.signal(getattr(signal, name), lambda *_: STOP.set())
    idle = 60
    LOG.info("Executor started; waiting for tasks")
    if os.environ.get("YOUTAST_POT_PROVIDER_HOME"):
        LOG.info("Local PO Token provider configured for YouTube downloads")
    running,capacity,next_claim,wake_on_finish=set(),1,0,False
    with concurrent.futures.ThreadPoolExecutor(max_workers=3,thread_name_prefix='youtast-job') as pool:
        while not STOP.is_set():
            previous=len(running)
            running={future for future in running if not future.done()}
            if len(running)<previous and wake_on_finish:next_claim=min(next_claim,time.monotonic())
            remaining=next_claim-time.monotonic()
            if remaining>0 or len(running)>=3:
                STOP.wait(min(1,max(.05,remaining)) if remaining>0 else 1)
                continue
            try:
                result = api.post("/api/executor/claim")
                capacity=max(1,min(3,int(result.get('execution',{}).get('concurrency',1))))
                if result["job"]:
                    idle=60
                    LOG.info("Processing %s job %s",result['job']['kind'],result['job']['id'])
                    running.add(pool.submit(process_job,api,result['job']))
                    wake_on_finish=True
                    next_claim=time.monotonic()+(60 if len(running)>=capacity else 0)
                    continue
                delay=max(15,result.get('retryAfter',60))
                blocked=result.get('execution',{}).get('paused') or result.get('execution',{}).get('cooldown_until',0)>time.time()
                wake_on_finish=not blocked
                if running and len(running)>=capacity:delay=max(60,delay)
                idle=min(60,delay) if blocked or running else min(300,max(idle,delay)*1.4)
            except urllib.error.HTTPError as exc:
                wake_on_finish=False
                LOG.warning("Claim failed: HTTP %s",exc.code)
                if exc.code==401:
                    STOP.set()
                    raise SystemExit("Executor token was rejected or revoked")
                quota_delay=claim_retry_delay(exc)
                idle=quota_delay if quota_delay is not None else min(300,idle*1.5)
                if quota_delay and quota_delay>300:
                    LOG.warning("Cloudflare quota/rate limit: pausing claims for approximately %d seconds",quota_delay)
            except (OSError,ValueError,http.client.HTTPException) as exc:
                wake_on_finish=False
                LOG.warning("Connection failed: %s",type(exc).__name__)
                idle=min(300,idle*1.5)
            next_claim=time.monotonic()+idle+random.uniform(0,5)
    LOG.info("Executor stopped")


if __name__ == "__main__":
    main()
