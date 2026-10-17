#!/usr/bin/env python3
"""Root-installed forced command for this public repository on Russia only."""

import fcntl
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/home/maxim/projects/infra/network/caddy")
REPOSITORY = "https://github.com/MrAlexandrovOrganization/caddy.git"


def run(*args, capture=False):
    result = subprocess.run(
        args,
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        timeout=300,
    )
    return result.stdout.strip() if capture else ""


def main():
    os.umask(0o077)
    request = os.environ.get("SSH_ORIGINAL_COMMAND", "").split()
    if (
        len(request) != 2
        or request[0] not in {"probe", "deploy"}
        or not re.fullmatch(r"[0-9a-f]{40}", request[1])
    ):
        raise ValueError("Expected probe/deploy and one full SHA")
    if request[0] == "probe":
        print("Caddy deployment access verified")
        return
    state = Path.home() / ".local/state/caddy-deploy"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if run("git", "rev-parse", "--show-toplevel", capture=True) != str(ROOT):
            raise ValueError("Unexpected repository root")
        if run("git", "branch", "--show-current", capture=True) != "main" or run(
            "git", "status", "--porcelain", capture=True
        ):
            raise ValueError("Expected clean main checkout")
        previous = run("git", "rev-parse", "HEAD", capture=True)
        run("git", "fetch", "--quiet", "--no-tags", REPOSITORY, "refs/heads/main")
        sha = request[1]
        if run("git", "rev-parse", "FETCH_HEAD", capture=True) != sha:
            raise ValueError("Stale deployment: main changed")
        run("git", "merge", "--ff-only", "--quiet", sha)
        run("sudo", "-n", "make", "up")
        run("docker", "exec", "caddy", "wget", "-qO-", "http://headscale:8080/health")
        receipt = {
            "sha": sha,
            "previous_sha": previous,
            "host": "hostkey-russia",
            "verified_at": datetime.now(timezone.utc).isoformat(),
        }
        temporary = state / "current.json.new"
        temporary.write_text(json.dumps(receipt) + "\n")
        temporary.replace(state / "current.json")
        print(json.dumps(receipt))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        sys.exit(
            "Caddy deployment failed; inspect checkout and runtime before retrying"
        )
