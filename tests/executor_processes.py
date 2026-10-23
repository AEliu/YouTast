"""Exercise two production agent processes with offline source fixtures and real MP3.

Requires the local integration server, FFmpeg and FFprobe. Never uses YouTube,
and does not prove real upstream downloads or deployment on separate machines.
"""
import contextlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "executor"))
from agent import terminate_process
ORIGIN = "http://127.0.0.1:8787"
cookie = ""


def web(path, data=None, method=None):
    headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(
        ORIGIN + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers,
        method=method,
    )
    return urllib.request.urlopen(req, timeout=30)


def read_json(path, data=None, method=None):
    with web(path, data, method) as response:
        return json.load(response)


def stop_process(process):
    terminate_process(process)


def main():
    global cookie
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("Install FFmpeg and FFprobe before running this test")
    with web("/api/auth/register", {
        "username": "process_" + secrets.token_hex(4),
        "password": secrets.token_hex(24),
        "invite": os.environ.get("TEST_INVITE", "local-integration-invite-only"),
    }) as response:
        cookie = response.headers["Set-Cookie"].split(";")[0]
    read_json('/api/execution-policy',{'concurrency':3,'start_interval':0,'request_interval':0,'download_wait':0,'cooldown_seconds':60,'paused':False})
    channel = read_json("/api/channels", {"title": "Offline executor process test"})["id"]
    executors, processes, log_handles = [], [], []
    try:
        # Enough separate scan and conversion tasks to exercise both agents.
        ids = [f"fixture{i:04d}" for i in range(6)]
        read_json(f"/api/channels/{channel}/sources", {
            "urls": [f"https://www.youtube.com/watch?v={video_id}" for video_id in ids]
        })
        executors = [read_json("/api/executors", {"name": f"offline-process-{i}"}) for i in range(2)]
        with contextlib.ExitStack() as stack:
            temp = stack.enter_context(tempfile.TemporaryDirectory(prefix="youtast-process-test-"))
            temp_dir = Path(temp)
            for i, executor in enumerate(executors):
                env = os.environ.copy()
                # The fixture exists only in these child processes, never in the service environment.
                env.update({
                    "YOUTAST_URL": ORIGIN,
                    "YOUTAST_TOKEN": executor["token"],
                    "PYTHONPATH": str(ROOT / "tests" / "fixtures"),
                    "PYTHONUNBUFFERED": "1",
                })
                # Fail before any task is claimed if import resolution finds the real downloader.
                subprocess.run(
                    [sys.executable, "-c", "import yt_dlp; assert getattr(yt_dlp, 'YOUTAST_OFFLINE_FIXTURE', False)"],
                    env=env, check=True, stdout=subprocess.DEVNULL,
                )
                log = stack.enter_context((temp_dir / f"agent-{i}.log").open("wb"))
                log_handles.append(log)
                processes.append(subprocess.Popen(
                    [sys.executable, str(ROOT / "executor" / "agent.py")],
                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name != "nt",
                ))
                stack.callback(stop_process, processes[-1])
            deadline = time.monotonic() + 90
            peak_running = 0
            while time.monotonic() < deadline:
                dashboard = read_json("/api/dashboard")
                peak_running=max(peak_running,sum(j['status']=='running' for j in dashboard['jobs']))
                assert peak_running<=3, 'Shared executor concurrency exceeded'
                if dashboard["channels"][0]["episode_count"] == len(ids):
                    break
                if any(p.poll() is not None for p in processes):
                    raise RuntimeError("Executor process exited before finishing")
                errors = [j["error"] for j in dashboard["jobs"] if j["error"]]
                if errors:
                    raise RuntimeError("An executor task failed: " + errors[0])
                time.sleep(0.5)
            else:
                raise RuntimeError("Timed out waiting for six real MP3 episodes")
            assert peak_running>=2, 'Parallel tasks were not observed'
            assert len(dashboard["episodes"]) == len(ids)
            assert all(j["status"] == "done" and j["attempts"] == 1 for j in dashboard["jobs"])
            token = dashboard["channels"][0]["feed_token"]
            with web(f"/feed/{token}.xml") as response:
                feed = ET.fromstring(response.read())
            enclosures = feed.findall("./channel/item/enclosure")
            assert len(enclosures) == len(ids)
            with urllib.request.urlopen(enclosures[0].attrib["url"], timeout=30) as response:
                audio = response.read()
            assert len(audio) == int(enclosures[0].attrib["length"])
            downloaded = temp_dir / "podcast.mp3"
            downloaded.write_bytes(audio)
            result = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name:format=duration",
                 "-of", "json", str(downloaded)],
                capture_output=True, text=True, check=True,
            )
            probe = json.loads(result.stdout)
            assert probe["streams"][0]["codec_name"] == "mp3"
            assert 2 <= float(probe["format"]["duration"]) < 3
            print("PASS: two production executor processes completed 6 scans and 6 conversions exactly once")
            print("PASS: real FFmpeg MP3 -> Python streamed upload -> R2 -> RSS enclosure -> FFprobe decode")
    finally:
        for process in processes:
            stop_process(process)
        for log in log_handles:
            log.close()
        for executor in executors:
            read_json(f"/api/executors/{executor['id']}", method="DELETE")
        read_json(f"/api/channels/{channel}", method="DELETE")


if __name__ == "__main__":
    main()
