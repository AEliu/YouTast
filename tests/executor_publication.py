import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'executor'))
from agent import publication_time

class PublicationTest(unittest.TestCase):
    def test_timestamp_preferred(self):
        self.assertEqual(publication_time({'timestamp':1700000123,'upload_date':'20200101'}),1700000123)
    def test_date_is_utc(self):
        self.assertEqual(publication_time({'upload_date':'20200101'}),1577836800)
    def test_missing_and_invalid_never_use_download_time(self):
        for data in [{},{'upload_date':'20200231'},{'timestamp':True},{'timestamp':99999999999},{'upload_date':'99991231'}]:
            self.assertIsNone(publication_time(data))

if __name__ == '__main__': unittest.main()
