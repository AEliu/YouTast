"""Quota-aware retry behavior must not repeatedly call an exhausted Worker."""
import io
import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "executor"))
from agent import claim_retry_delay


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


if __name__ == "__main__":
    unittest.main()
