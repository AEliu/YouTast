"""Check that cookie setup accepts only an explicit YouTube session, without network requests."""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "executor"))
from agent import youtube_cookie_file, task_cookie_file, downloader_failure


class CookieScopeTest(unittest.TestCase):
    def test_downloader_does_not_overwrite_original_export(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as task:
            source = self.export(directory)
            original = source.read_bytes()
            runtime = task_cookie_file(source, task)
            self.assertEqual(runtime.read_bytes(), original)
            runtime.write_text("downloader updated its jar", encoding="utf-8")
            self.assertEqual(source.read_bytes(), original)

    def test_age_confirmation_is_not_a_bot_error(self):
        self.assertIn("age verification", downloader_failure("ERROR: Sign in to confirm your age"))
        self.assertNotIn("cookies", downloader_failure("ERROR: Sign in to confirm your age"))

    def test_invalid_cookies_warning_is_preserved_as_safe_reason(self):
        diagnostic = "cookies are no longer valid\nSign in to confirm you're not a bot\nPRIVATE_SESSION_VALUE"
        self.assertIn("no longer valid", downloader_failure(diagnostic))
        self.assertNotIn("PRIVATE_SESSION_VALUE", downloader_failure(diagnostic))

    def export(self, directory, domain=".youtube.com", expires=None):
        path = Path(directory) / "cookies.txt"
        expires = int(time.time()) + 3600 if expires is None else expires
        path.write_text(f"# Netscape HTTP Cookie File\n{domain}\tTRUE\t/\tTRUE\t{expires}\tTEST_ONLY\tfictional-test-value\n", encoding="utf-8")
        return path

    def test_youtube_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.export(directory)
            self.assertEqual(youtube_cookie_file(path), path.resolve())

    def test_other_site_session_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for domain in (".google.com", ".example.com", ".youtube.com.example.com"):
                with self.assertRaisesRegex(ValueError, "only youtube.com"):
                    youtube_cookie_file(self.export(directory, domain))

    def test_expired_session_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "expired"):
                youtube_cookie_file(self.export(directory, expires=1))

    def test_invalid_export_does_not_disclose_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cookies.txt"
            path.write_text("private-invalid-test-value", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Netscape") as caught:
                youtube_cookie_file(path)
            self.assertNotIn("private-invalid-test-value", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
