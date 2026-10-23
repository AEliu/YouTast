"""Read-only diagnostics must not claim jobs, follow redirects or leak errors."""
import http.server
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "a" * 64


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.server.paths.append(self.path)
        if self.path != "/api/executor/status" or self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.send_error(401)
            return
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.send_response(self.server.status)
        if self.server.status == 302:
            self.send_header("Location", "https://example.invalid/feed/" + TOKEN + ".xml")
        self.end_headers()
        self.wfile.write(self.server.payload)


class HealthTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.paths = []
        self.server.status = 200
        self.raw = {"activeJobs": 0, "lastSeen": int(time.time()), "minimumProtocol": 2, "rateControlVersion": 1, "windowControlVersion": 1, "audioControlVersion": 1, "replayControlVersion": 1, "discoveryControlVersion": 1}
        self.server.payload = json.dumps(self.raw).encode()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = Path(self.temp.name) / "executor.env"
        self.config.write_text(f"YOUTAST_URL=http://127.0.0.1:{self.server.server_port}\nYOUTAST_TOKEN={TOKEN}\n", encoding="utf-8")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_check(self, *args):
        command = [sys.executable, str(ROOT / "scripts/health-check.py"), "--config", str(self.config), "--allow-local", *args]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=25)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertTrue(all(path == "/api/executor/status" for path in self.server.paths))
        return result, json.loads(result.stdout)

    def test_healthy_read_only_and_report(self):
        output = Path(self.temp.name) / "health.json"
        result, data = self.run_check("--output", str(output))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), data)
        self.assertEqual(self.server.paths, ["/api/executor/status"])

    def test_stale_and_unsupported_capabilities_are_degraded(self):
        self.raw.update(lastSeen=int(time.time()) - 1000, audioControlVersion=0)
        self.server.payload = json.dumps(self.raw).encode()
        result, data = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("executor_heartbeat_stale", data["issues"])
        self.assertIn("executor_upgrade_required", data["issues"])

    def test_rejection_body_is_not_printed(self):
        self.server.status = 401
        self.server.payload = ("private credential " + TOKEN).encode()
        result, data = self.run_check()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(data["http_status"], 401)

    def test_redirect_is_not_followed(self):
        self.server.status = 302
        result, data = self.run_check()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(data["http_status"], 302)
        self.assertEqual(len(self.server.paths), 1)

    def test_invalid_shape_fails_without_raw_output(self):
        self.server.payload = json.dumps({"activeJobs": "bad", "secret": TOKEN}).encode()
        result, data = self.run_check()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(data["issue"], "invalid_response")

    def test_invalid_origin_does_not_send_credentials(self):
        self.config.write_text(f"YOUTAST_URL=http://127.0.0.1:invalid\nYOUTAST_TOKEN={TOKEN}\n", encoding="utf-8")
        result, data = self.run_check()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(data["issue"], "invalid_origin")
        self.assertEqual(self.server.paths, [])


if __name__ == "__main__":
    unittest.main()
