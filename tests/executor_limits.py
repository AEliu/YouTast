"""Quota-aware retry behavior must not repeatedly call an exhausted Worker."""
import io
import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "executor"))
from agent import claim_retry_delay, job_error_message


class QuotaDelayTest(unittest.TestCase):
    def test_reset_propagation_does_not_delay_another_day(self):
        error = HTTPError("https://test.invalid", 429, "limited", {}, io.BytesIO(b"Cloudflare Error 1027"))
        self.assertEqual(claim_retry_delay(error, 10), 60)

    def test_workers_daily_quota_waits_for_utc_reset(self):
        # 23:10 UTC -> 50 minutes until reset, regardless of the Windows timezone.
        now = 23 * 3600 + 10 * 60
        error = HTTPError("https://test.invalid", 429, "limited", {}, io.BytesIO(b"Cloudflare Error 1027"))
        self.assertEqual(claim_retry_delay(error, now), 50 * 60)

    def test_generic_limit_respects_retry_after(self):
        error = HTTPError("https://test.invalid", 429, "limited", {"Retry-After": "900"}, io.BytesIO(b"limited"))
        self.assertEqual(claim_retry_delay(error, 0), 900)

    def test_generic_limit_uses_bounded_backoff(self):
        error = HTTPError("https://test.invalid", 429, "limited", {}, io.BytesIO(b"limited"))
        self.assertEqual(claim_retry_delay(error, 0), 300)

    def test_other_errors_do_not_imply_daily_quota_exhaustion(self):
        error = HTTPError("https://test.invalid", 403, "forbidden", {}, io.BytesIO(b"Cloudflare"))
        self.assertIsNone(claim_retry_delay(error, 0))


class JobErrorMessageTest(unittest.TestCase):
    def test_known_storage_error_is_shown(self):
        import json
        message = "存储空间不足，请清理音频或联系管理员调整用户或站点存储额度后重试"
        error = HTTPError("https://private.invalid/token", 409, "conflict", {}, io.BytesIO(json.dumps({"error": message}).encode()))
        self.assertEqual(job_error_message(error), message)

    def test_untrusted_server_error_is_not_exposed(self):
        error = HTTPError("https://private.invalid/token", 409, "conflict", {}, io.BytesIO(b'{"error":"secret"}'))
        self.assertEqual(job_error_message(error), "服务器请求失败（HTTP 409），请查看执行器和服务端状态")

    def test_malformed_server_message_is_safe(self):
        error = HTTPError("https://private.invalid/token", 409, "conflict", {}, io.BytesIO(b'{"error":[]}'))
        self.assertIn("HTTP 409", job_error_message(error))


if __name__ == "__main__":
    unittest.main()
