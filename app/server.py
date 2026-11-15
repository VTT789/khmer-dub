#!/usr/bin/env python3
"""Local web app: browse YouTube, translate subtitles, dub with Edge TTS.

Run:  python app/server.py --port 8765 [--open]
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(APP_DIR)
PUBLIC = os.path.join(ROOT, "public")
DATA = os.path.join(ROOT, "data")
sys.path.insert(0, APP_DIR)

import segments as seg_mod  # noqa: E402
import translate  # noqa: E402
import tts  # noqa: E402
import yt  # noqa: E402
import export as export_mod  # noqa: E402
import asr  # noqa: E402
import tempfix  # noqa: F401,E402

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

MAX_TEXT = 2000
MAX_TRANSLATE_BATCH = 120

# Auto-generated caption tracks exist for ~190 languages on YouTube; the UI only
# needs the popular ones (manual tracks are always listed).
POPULAR_CAPTION_LANGS = {
    "en", "km", "th", "vi", "zh", "zh-CN", "zh-Hans", "zh-Hant", "zh-TW", "ja", "ko",
    "id", "ms", "my", "lo", "es", "fr", "de", "pt", "pt-BR", "ru", "hi", "ar", "tr",
    "it", "fil", "bn", "ur", "ne", "si", "pa", "ta", "te", "ml", "nl", "pl", "uk",
    "fa", "he", "iw", "el", "sv", "da", "no", "fi", "cs", "ro", "hu", "bg", "sk",
}


def qp(qs: dict, name: str, default: str = "") -> str:
    values = qs.get(name)
    return values[0] if values else default


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "YouTubeKhmerDub/1.0"

    # ------------------------------------------------------------- plumbing
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self._cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _cors_headers(self) -> None:
        # Allows the Chrome extension (running on youtube.com) to call this server.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 8_000_000:
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8-sig"))

    # ------------------------------------------------------------ GET routes
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                return self.send_json(
                    {"ok": True, "app": "khmer-dub", "version": "2.0", "python": sys.version.split()[0]}
                )

            if path == "/api/languages":
                return self.send_json({"targets": translate.available_targets()})

            if path == "/api/voices":
                prefix = qp(qs, "prefix", "")
                voices = tts.list_voices(prefix)
                return self.send_json({"voices": voices})

            if path == "/api/search":
                query = qp(qs, "q", "").strip()
                limit = int(qp(qs, "limit", "12") or 12)
                return self.send_json({"results": yt.search(query, limit)})

            if path == "/api/trending":
                limit = int(qp(qs, "limit", "12") or 12)
                return self.send_json({"results": yt.trending(limit)})

            if path == "/api/export/status":
                job = export_mod.get_job(qp(qs, "job", ""))
                if not job:
                    return self.send_error_json(404, "unknown export job")
                return self.send_json(job.snapshot())

            if path == "/api/export/file":
                file_path = export_mod.file_for(qp(qs, "job", ""), qp(qs, "name", ""))
                if not file_path:
                    return self.send_error_json(404, "file not ready")
                self.send_file_download(file_path, qp(qs, "name", "download"))
                return

            if path == "/api/info":
                vid = yt.extract_video_id(qp(qs, "v", ""))
                if not vid:
                    return self.send_error_json(400, "Invalid YouTube URL or id")
                info = yt.get_info(vid)
                seen = set()
                public_tracks = []
                for t in info["tracks"]:
                    if t["kind"] == "auto" and t["lang"] not in POPULAR_CAPTION_LANGS:
                        continue
                    key = (t["lang"], t["kind"])
                    if key in seen:
                        continue
                    seen.add(key)
                    public_tracks.append({"lang": t["lang"], "kind": t["kind"], "name": t["name"]})
                return self.send_json(
                    {
                        "video": {
                            "id": info["id"],
                            "title": info["title"],
                            "author": info["author"],
                            "duration": info["duration"],
                            "thumb": info["thumb"],
                        },
                        "tracks": public_tracks,
                    }
                )

            if path == "/api/transcribe/status":
                job = asr.get_job(qp(qs, "job", ""))
                if not job:
                    return self.send_error_json(404, "unknown transcription job")
                return self.send_json(job)

            if path == "/api/segments":
                vid = yt.extract_video_id(qp(qs, "v", ""))
                if not vid:
                    return self.send_error_json(400, "Invalid YouTube URL or id")
                lang = qp(qs, "lang", "auto")
                limit = int(qp(qs, "limit", "0") or 0)
                info = yt.get_info(vid)
                if info["tracks"]:
                    track = yt.choose_track(info["tracks"], lang)
                    cues = yt.get_transcript(vid, track)
                    track_meta = {"lang": track["lang"], "kind": track["kind"], "name": track["name"]}
                else:
                    cached = asr.load_cached(vid)
                    if not cached:
                        return self.send_error_json(
                            409, "This video has no captions. Use “Transcribe with AI” first."
                        )
                    cues = cached["cues"]
                    track_meta = {
                        "lang": cached.get("language") or "auto",
                        "kind": "asr",
                        "name": f"AI transcript ({cached.get('model', 'whisper')})",
                    }
                segs = seg_mod.merge_cues(cues, limit=limit)
                return self.send_json(
                    {
                        "videoId": vid,
                        "video": {
                            "id": info["id"],
                            "title": info["title"],
                            "author": info["author"],
                            "duration": info["duration"],
                            "thumb": info["thumb"],
                        },
                        "track": track_meta,
                        "cueCount": len(cues),
                        "segments": segs,
                    }
                )

            if path.startswith("/api/audio/"):
                return self.serve_audio(path.rsplit("/", 1)[-1])

            if path == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            return self.serve_static(path)
        except urllib.error.URLError as exc:  # network problem talking to YouTube
            self.send_error_json(502, f"Network error: {exc}")
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(500, str(exc) or exc.__class__.__name__)

    # ----------------------------------------------------------- POST routes
    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            body = self.read_json()

            if path == "/api/translate":
                texts = body.get("texts") or []
                if not isinstance(texts, list) or not texts:
                    return self.send_error_json(400, "texts must be a non-empty array")
                if len(texts) > MAX_TRANSLATE_BATCH:
                    return self.send_error_json(400, f"too many texts (max {MAX_TRANSLATE_BATCH})")
                target = (body.get("target") or "km").strip()
                texts = [str(t)[:MAX_TEXT] for t in texts]
                translated = translate.translate_texts(texts, target)
                return self.send_json({"texts": translated, "target": target})

            if path == "/api/tts":
                text = str(body.get("text") or "").strip()
                if not text:
                    return self.send_error_json(400, "text is required")
                if len(text) > MAX_TEXT:
                    text = text[:MAX_TEXT]
                voice = str(body.get("voice") or "km-KH-SreymomNeural")
                rate = self._normalize_rate(body.get("rate"))
                pitch = str(body.get("pitch") or "+0Hz")
                if not re.fullmatch(r"[+-]\d{1,3}Hz", pitch):
                    pitch = "+0Hz"
                try:
                    target = float(body.get("target") or 0)
                except (TypeError, ValueError):
                    target = 0.0
                if target > 0:
                    meta = tts.synthesize_for_segment(text, voice, target_seconds=target, pitch=pitch)
                else:
                    meta = tts.synthesize(text, voice, rate=rate, pitch=pitch)
                return self.send_json(
                    {
                        "url": f"/api/audio/{meta['key']}.mp3",
                        "duration": meta["duration"],
                        "chars": meta["chars"],
                        "voice": meta["voice"],
                        "rate": meta["rate"],
                        "cached": bool(meta.get("cached")),
                    }
                )

            if path == "/api/transcribe":
                vid = yt.extract_video_id(str(body.get("videoId") or ""))
                if not vid:
                    return self.send_error_json(400, "Invalid video id")
                model_size = str(body.get("model") or asr.DEFAULT_MODEL)
                if model_size not in ("tiny", "base", "small", "medium"):
                    model_size = asr.DEFAULT_MODEL
                return self.send_json(asr.start_transcription(vid, model_size))

            if path == "/api/export":
                vid = yt.extract_video_id(str(body.get("videoId") or ""))
                if not vid:
                    return self.send_error_json(400, "Invalid video id")
                mode = str(body.get("mode") or "audio")
                if mode not in ("audio", "video", "video_sub"):
                    mode = "audio"
                target = str(body.get("target") or "km")
                voice = str(body.get("voice") or "km-KH-SreymomNeural")
                snapshot = export_mod.start_export(vid, target, voice, mode, bool(body.get("bilingual")))
                return self.send_json(snapshot)

            return self.send_error_json(404, "Unknown endpoint")
        except ValueError as exc:
            return self.send_error_json(400, str(exc))
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(500, str(exc) or exc.__class__.__name__)

    @staticmethod
    def _normalize_rate(value) -> str:
        if value is None:
            return "+0%"
        text = str(value).strip()
        if re.fullmatch(r"[+-]?\d{1,3}%", text):
            if not text.startswith(("+", "-")):
                text = "+" + text
            return text
        return "+0%"

    # ---------------------------------------------------------------- assets
    def serve_static(self, path: str) -> None:
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        fs_path = os.path.normpath(os.path.join(PUBLIC, rel))
        if not fs_path.startswith(PUBLIC + os.sep) and fs_path != PUBLIC:
            return self.send_error_json(404, "Not found")
        if not os.path.isfile(fs_path):
            return self.send_error_json(404, "Not found")
        ctype = mimetypes.guess_type(fs_path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(fs_path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file_download(self, path: str, name: str) -> None:
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "download"
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{safe_name}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            with open(path, "rb") as fh:
                while True:
                    chunk = fh.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def serve_audio(self, filename: str) -> None:
        m = re.fullmatch(r"([0-9a-f]{40}(?:\.fit\d+)?)\.mp3", filename)
        if not m:
            return self.send_error_json(400, "Bad audio key")
        path = os.path.join(tts.AUDIO_DIR, filename)
        if not os.path.isfile(path):
            return self.send_error_json(404, "Audio not generated yet")
        size = os.path.getsize(path)
        start, end = 0, size - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header:
            rm = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if rm:
                if rm.group(1):
                    start = int(rm.group(1))
                if rm.group(2):
                    end = min(int(rm.group(2)), size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        with open(path, "rb") as fh:
            fh.seek(start)
            data = fh.read(end - start + 1)
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(data)))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return  # browser closed the tab / seeked away; not an app error
        super().handle_error(request, client_address)


def main() -> None:
    parser = argparse.ArgumentParser(description="YouTube Khmer Dub")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="open the browser on start")
    args = parser.parse_args()

    tts.ensure_dirs()
    os.makedirs(DATA, exist_ok=True)

    httpd = None
    port = args.port
    last_error: Exception | None = None
    for candidate in range(args.port, args.port + 25):
        try:
            httpd = Server((args.host, candidate), Handler)
            port = candidate
            break
        except OSError as exc:
            last_error = exc
    if httpd is None:
        raise SystemExit(f"Could not bind a port: {last_error}")

    url = f"http://{args.host}:{port}"
    print(f"YouTube Khmer Dub is running at {url}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    try:
        with open(os.path.join(DATA, "app_url.txt"), "w", encoding="utf-8") as fh:
            fh.write(url)
    except OSError:
        pass
    if args.open:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping…")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
