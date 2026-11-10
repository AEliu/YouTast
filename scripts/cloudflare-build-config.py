"""Bind the reviewed example configuration to the selected production database."""
import os
import re
from pathlib import Path

database_id = os.environ.get('YOUTAST_D1_ID', '')
if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', database_id) or database_id == '00000000-0000-0000-0000-000000000000':
    raise SystemExit('Set YOUTAST_D1_ID to the production D1 database ID')
config = Path('wrangler.example.jsonc').read_text(encoding='utf-8')
placeholder = '00000000-0000-0000-0000-000000000000'
if config.count(placeholder) != 1:
    raise SystemExit('Expected exactly one database ID placeholder')
Path('wrangler.jsonc').write_text(config.replace(placeholder, database_id), encoding='utf-8')
