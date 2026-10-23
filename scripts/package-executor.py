"""Package only an explicit, secret-free allowlist for installation on other machines."""
import hashlib
import shutil
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

root = Path(__file__).resolve().parents[1]
source = root / "executor"
files = ["agent.py", "requirements.txt", "requirements-pot.txt", "Dockerfile", "compose.yaml", "README.md", ".env.example"]
example = (source / ".env.example").read_text(encoding="utf-8")
settings = dict(line.split("=", 1) for line in example.splitlines() if line.strip() and not line.lstrip().startswith("#"))
url = urlsplit(settings.get("YOUTAST_URL", ""))
if set(settings) != {"YOUTAST_URL", "YOUTAST_TOKEN"} or settings["YOUTAST_TOKEN"] != "replace-with-executor-token" or url.scheme != "https" or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
    raise SystemExit("Refusing to package an environment example with an unexpected token value")
output = root / "dist" / "youtast-executor-0.1.0.zip"
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        path = source / name
        if path.is_symlink() or path.resolve().parent != source.resolve():
            raise SystemExit("Unexpected package source path")
        archive.write(path, "youtast-executor/" + name)
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert sorted(archive.namelist()) == sorted("youtast-executor/" + name for name in files)
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(".zip.sha256").write_text(checksum + "  " + output.name + "\n", encoding="utf-8")
downloads = root / "public" / "downloads"
downloads.mkdir(parents=True, exist_ok=True)
shutil.copyfile(output, downloads / output.name)
shutil.copyfile(output.with_suffix(".zip.sha256"), downloads / (output.name + ".sha256"))
print(f"Packaged {len(files)} allowlisted files: {output}")
print(f"SHA-256: {checksum}")
