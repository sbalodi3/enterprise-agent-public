"""Print the runtime dependency subset and PyPI wheel hashes from the fingerprinted uv.lock."""

import tomllib
from pathlib import Path

packages = {p["name"]: p for p in tomllib.loads(Path("uv.lock").read_text())["package"]}
pending = ["fastapi", "httpx", "uvicorn", "joserfc", "jsonschema", "rfc3339-validator", "cryptography"]
seen = set()
while pending:
    name = pending.pop()
    if name in seen:
        continue
    seen.add(name)
    entry = packages[name]
    pending.extend(item["name"] for item in entry.get("dependencies", []))
    hashes = " ".join("--hash=" + wheel["hash"] for wheel in entry["wheels"])
    print(f"{name}=={entry['version']} {hashes}")
