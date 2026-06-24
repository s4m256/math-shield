#!/usr/bin/env python3
"""Run MathShield's browser corpus in headless Chrome."""

from __future__ import annotations

import functools
import http.server
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


def find_chrome() -> str:
    candidates = [
        os.environ.get("CHROME_BIN"),
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chrome"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).exists():
            return candidate
    raise SystemExit("Chrome/Chromium not found. Set CHROME_BIN to its executable.")


def main() -> None:
    root = pathlib.Path(__file__).resolve().parents[1]
    handler = functools.partial(QuietHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/tests/automated.html"

    try:
        with tempfile.TemporaryDirectory(prefix="mathshield-test-") as profile:
            result = subprocess.run(
                [
                    find_chrome(),
                    "--headless=new",
                    "--disable-gpu",
                    "--no-first-run",
                    f"--user-data-dir={profile}",
                    "--virtual-time-budget=10000",
                    "--dump-dom",
                    url,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )
    finally:
        server.shutdown()

    marker = 'data-status="passed"'
    start = result.stdout.find('<pre id="result">')
    end = result.stdout.find("</pre>", start)
    report = result.stdout[start + len('<pre id="result">') : end]
    print(report or result.stderr)
    if result.returncode != 0 or marker not in result.stdout:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
