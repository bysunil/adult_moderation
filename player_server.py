"""
Local Web Server for Adult Moderation Smart Player.

Serves the modern browser-based MP4 player and provides REST APIs to:
1. Load timeline.json and clip_descriptions.json.
2. Stream local MP4 video files with HTTP byte-range seeking support.
3. Automatically launch the default web browser.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
from pathlib import Path
import socketserver
import urllib.parse
import webbrowser

PORT = 8888
BASE_DIR = Path(__file__).parent.resolve()


class SmartPlayerHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/timeline":
            self.send_json_file("timeline.json")
            return
        elif path == "/api/clip_descriptions":
            self.send_json_file("clip_descriptions.json")
            return
        elif path.startswith("/stream_video"):
            query = urllib.parse.parse_qs(parsed.query)
            video_file_param = query.get("file", [None])[0]
            if not video_file_param:
                self.send_error(400, "Missing 'file' parameter")
                return

            video_path = Path(video_file_param)
            if not video_path.is_absolute():
                video_path = (BASE_DIR / video_path).resolve()

            if not video_path.exists():
                self.send_error(404, f"Video not found: {video_path}")
                return

            self.serve_video_range(video_path)
            return

        super().do_GET()

    def send_json_file(self, filename: str):
        target = BASE_DIR / filename
        if not target.exists():
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"[]")
            return

        try:
            with open(target, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(500, f"Error reading {filename}: {e}")

    def serve_video_range(self, file_path: Path):
        """Serves video files supporting HTTP 206 Partial Content (Range requests) for smooth seek."""
        try:
            file_size = os.path.getsize(file_path)
            range_header = self.headers.get("Range")

            if not range_header:
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(file_size))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                with open(file_path, "rb") as f:
                    self.copy_chunks(f, self.wfile, file_size)
                return

            range_val = range_header.strip().lower()
            if not range_val.startswith("bytes="):
                self.send_error(416, "Invalid Range header")
                return

            range_val = range_val[6:]
            parts = range_val.split("-")
            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else file_size - 1

            if start >= file_size or end >= file_size or start > end:
                self.send_error(416, "Requested Range Not Satisfiable")
                return

            content_length = (end - start) + 1

            self.send_response(206)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(content_length))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

            with open(file_path, "rb") as f:
                f.seek(start)
                self.copy_chunks(f, self.wfile, content_length)

        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            self.send_error(500, f"Video stream error: {e}")

    def copy_chunks(self, in_file, out_file, total_bytes):
        chunk_size = 64 * 1024
        remaining = total_bytes
        while remaining > 0:
            read_bytes = min(remaining, chunk_size)
            data = in_file.read(read_bytes)
            if not data:
                break
            out_file.write(data)
            remaining -= len(data)


def start_server(port: int = PORT, open_browser: bool = True):
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), SmartPlayerHandler) as httpd:
        url = f"http://localhost:{port}"
        print(f"\n[Smart Player Server] Server running at: {url}")
        print("Press Ctrl+C to stop the server.\n")
        if open_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Smart Browser Video Player Server")
    parser.add_argument("--port", type=int, default=PORT, help="Port to run web player (default: 8080)")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically launch web browser")
    args = parser.parse_args()

    start_server(port=args.port, open_browser=not args.no_browser)
