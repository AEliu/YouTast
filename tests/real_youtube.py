"""Opt-in live smoke test against a localhost Worker; downloads one short public video.

Run with the executor virtualenv, local dev server and TEST_INVITE configured.
All credentials stay in memory. No cookies from your browser are used.
"""
import json
import os
import secrets
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "executor"))
from agent import API, process_job  # noqa: E402

ORIGIN = "http://127.0.0.1:8787"
cookie = ""


def web(path, data=None, method=None):
    headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(ORIGIN + path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
    return urllib.request.urlopen(req, timeout=30)


def main():
    global cookie
    with web("/api/auth/register", {"username": "live_" + secrets.token_hex(4), "password": secrets.token_hex(24), "invite": os.environ.get("TEST_INVITE", "local-integration-invite-only")}) as r:
        cookie = r.headers["Set-Cookie"].split(";")[0]
    with web("/api/channels", {"title": "Live YouTube smoke test"}) as r:
        channel = json.load(r)["id"]
    with web("/api/executors", {"name": "live-smoke"}) as r:
        executor = json.load(r)
    try:
        with web(f"/api/channels/{channel}/sources", {"urls": ["https://www.youtube.com/watch?v=jNQXAC9IVRw"]}):
            pass
        api = API(ORIGIN, executor["token"])
        for expected in ("scan", "transcode"):
            job = api.post("/api/executor/claim")["job"]
            if not job or job["kind"] != expected:
                raise RuntimeError(f"Expected {expected} task; upstream stage failed")
            process_job(api, job)
        with web("/api/dashboard") as r:
            dashboard = json.load(r)
        if dashboard["channels"][0]["episode_count"] != 1:
            raise RuntimeError("Live audio conversion failed; inspect local executor diagnostics")
        print("PASS: real YouTube scan -> FFmpeg MP3 -> R2 -> RSS-ready episode")
    finally:
        with web(f"/api/executors/{executor['id']}", method="DELETE"):
            pass
        with web(f"/api/channels/{channel}", method="DELETE"):
            pass


if __name__ == "__main__":
    main()
