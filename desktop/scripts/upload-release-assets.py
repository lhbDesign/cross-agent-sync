#!/usr/bin/env python3
"""Upload desktop/release assets to an existing GitHub Release."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "lhbDesign/cross-agent-sync"
TAG = os.environ.get("RELEASE_TAG", "v1.3.3")
VERSION = TAG[1:] if TAG.startswith("v") else TAG
FILES = [
    f"Agent-Session-Sync-{VERSION}-arm64.dmg",
    f"Agent-Session-Sync-{VERSION}-setup-x64.exe",
    f"Agent-Session-Sync-{VERSION}-win-x64.zip",
]


def git_token() -> str:
    env = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env:
        return env.strip()
    out = subprocess.check_output(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        text=True,
    )
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no github token")


def api(method: str, url: str, token: str, data: bytes | None = None, content_type: str | None = None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "cross-agent-sync-release-upload")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read()
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise SystemExit(f"{method} {url} -> {e.code}: {body}") from e


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    release_dir = root / "release"
    token = git_token()
    status, rel = api("GET", f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}", token)
    rel_id = rel["id"]
    print(f"release {TAG} id={rel_id} {rel.get('html_url')}")

    # map existing assets by name
    _, assets = api("GET", f"https://api.github.com/repos/{REPO}/releases/{rel_id}/assets", token)
    by_name = {a["name"]: a for a in assets}

    for name in FILES:
        path = release_dir / name
        if not path.is_file():
            raise SystemExit(f"missing {path}")
        if name in by_name:
            aid = by_name[name]["id"]
            print(f"delete old {name} ({aid})")
            api("DELETE", f"https://api.github.com/repos/{REPO}/releases/assets/{aid}", token)

        data = path.read_bytes()
        q = urllib.parse.urlencode({"name": name})
        url = f"https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets?{q}"
        print(f"upload {name} ({len(data)} bytes)…")
        _, uploaded = api("POST", url, token, data=data, content_type="application/octet-stream")
        print(" ", uploaded.get("browser_download_url") or uploaded)

    _, final = api("GET", f"https://api.github.com/repos/{REPO}/releases/{rel_id}", token)
    print("assets:", [a["name"] for a in final.get("assets", [])])
    print(final.get("html_url"))


if __name__ == "__main__":
    main()
