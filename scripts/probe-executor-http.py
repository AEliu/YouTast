"""Diagnose our own API transport without printing credentials or response bodies."""
import json
import re
import sys
import urllib.error
from pathlib import Path
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "executor"))
from agent import API
values = dict(line.split("=", 1) for line in (root / ".secrets/windows-executor.env").read_text().splitlines() if "=" in line)
try:
    result = API(values["YOUTAST_URL"], values["YOUTAST_TOKEN"]).post("/api/executor/claim")
    print("Python API request succeeded; job present:", result.get("job") is not None)
except urllib.error.HTTPError as error:
    print("Python API HTTP status:", error.code)
    content_type = error.headers.get("Content-Type", "")
    print("Response content type:", content_type)
    if "application/json" in content_type:
        print("API error:", json.load(error).get("error", "unknown"))
    else:
        code = re.search(r"error code:\s*\d+", error.read(4096).decode("utf-8", errors="replace"), re.I)
        print("Edge error:", code.group(0) if code else "non-JSON rejection")
