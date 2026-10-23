"""Read-only executor/API health summary. Never claims work or prints secrets."""
import argparse
import json
import time
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check(config_path, max_age=400, allow_local=False):
    result = {"status": "error", "checked_at": int(time.time()), "scope": "api_auth_db_and_executor_heartbeat"}
    try:
        values = {}
        for line in Path(config_path).read_text(encoding="utf-8-sig").splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        return {**result, "issue": "config_unavailable"}
    origin, token = values.get("YOUTAST_URL", "").rstrip("/"), values.get("YOUTAST_TOKEN", "")
    try:
        parsed = urlsplit(origin)
        local = allow_local and parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
        parsed.port
    except ValueError:
        return {**result, "issue": "invalid_origin"}
    if (parsed.scheme != "https" and not local) or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return {**result, "issue": "invalid_origin"}
    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        return {**result, "issue": "invalid_credential_format"}
    request = urllib.request.Request(origin + "/api/executor/status", data=b"{}", headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "YouTast-Health/0.1"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            data = response.read(65537)
        if len(data) > 65536:
            return {**result, "issue": "invalid_response"}
        raw = json.loads(data)
    except urllib.error.HTTPError as error:
        return {**result, "issue": "http_rejection", "http_status": error.code}
    except (ValueError, TypeError):
        return {**result, "issue": "invalid_response"}
    except (OSError, urllib.error.URLError):
        return {**result, "issue": "transport_failure"}
    if not isinstance(raw, dict) or type(raw.get("activeJobs")) is not int or not 0 <= raw["activeJobs"] <= 1000:
        return {**result, "issue": "invalid_response"}
    last_seen = raw.get("lastSeen")
    if last_seen is not None and (type(last_seen) is not int or last_seen < 0):
        return {**result, "issue": "invalid_response"}
    age = None if not last_seen else int(time.time()) - last_seen
    capabilities = {name: type(raw.get(field)) is int and raw[field] == 1 for name, field in (("rate", "rateControlVersion"), ("window", "windowControlVersion"), ("audio", "audioControlVersion"), ("replay", "replayControlVersion"))}
    issues = []
    if age is None:
        issues.append("executor_not_seen")
    elif age > max_age:
        issues.append("executor_heartbeat_stale")
    elif age < -60:
        issues.append("clock_skew")
    if not all(capabilities.values()):
        issues.append("executor_upgrade_required")
    protocol = raw.get("minimumProtocol", 1)
    if type(protocol) is not int or protocol > 2 or protocol < 1:
        issues.append("unsupported_protocol")
    return {**result, "status": "degraded" if issues else "healthy", "reachable": True, "active_jobs": raw["activeJobs"], "heartbeat_age_seconds": age, "max_age_seconds": max_age, "capabilities": capabilities, "issues": issues}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=".secrets/windows-executor.env")
    parser.add_argument("--max-age", type=int, default=400)
    parser.add_argument("--allow-local", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args()
    if not 60 <= args.max_age <= 3600:
        parser.error("max-age must be 60–3600 seconds")
    result = check(args.config, args.max_age, args.allow_local)
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0 if result["status"] == "healthy" else 1 if result["status"] == "degraded" else 2


if __name__ == "__main__":
    raise SystemExit(main())
