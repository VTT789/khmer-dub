"""Export pipeline: download the video, build a Khmer voice track, mux an MKV.

Everything runs server-side with the bundled ffmpeg (imageio-ffmpeg), so the
user gets real files: video.mp4, khmer.srt, dub.m4a and dubbed.mkv.
"""
from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import threading
import time
import uuid

import yt_dlp

import asr
import tts
import translate
import yt
from segments import merge_cues

_MUSIC_RE = re.compile(r"\[[^\]]*\]|\([^)]*\)|♪|♫")
_ANY_LETTER = re.compile(
    r"[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF"
    r"\u0900-\u097F\u0E00-\u0E7F\u1000-\u109F\u1780-\u17FF\u3040-\u30FF"
    r"\u4E00-\u9FFF\uAC00-\uD7AF]"
)


def is_music_only(text: str) -> bool:
    spoken = _MUSIC_RE.sub(" ", text or "").strip()
    return not spoken or not _ANY_LETTER.search(spoken)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(ROOT, "data", "exports")
SR = 24000

_jobs: dict[str, "ExportJob"] = {}
_jobs_lock = threading.Lock()


# --------------------------------------------------------------------------
# ffmpeg helpers
# --------------------------------------------------------------------------
def ffmpeg() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg") or ""


def _run(cmd: list[str]) -> None:
    """Run a command with output discarded (no pipes: sandbox friendly)."""
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def write_wav(path: str, pcm: bytes, rate: int = SR, channels: int = 1) -> None:
    data_size = len(pcm)
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + data_size)
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * channels * 2, channels * 2, 16)
        + b"data"
        + struct.pack("<I", data_size)
    )
    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(pcm)


def srt_time(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    return f"{ms // 3600000:02d}:{ms % 3600000 // 60000:02d}:{ms % 60000 // 1000:02d},{ms % 1000:03d}"


def make_srt(segments: list[dict], bilingual: bool = False) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        text = (seg.get("text") or seg.get("orig") or "").strip()
        if bilingual and seg.get("orig"):
            text = f"{text}\n{seg['orig']}"
        lines.append(f"{i}\n{srt_time(seg['start'])} --> {srt_time(seg['end'])}\n{text}\n")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Dub track
# --------------------------------------------------------------------------
def build_dub_audio(
    segments: list[dict],
    voice: str,
    out_m4a: str,
    workdir: str,
    progress=None,
    total_seconds: float | None = None,
) -> None:
    ff = ffmpeg()
    last_end = (segments[-1]["end"] + 1.0) if segments else 1.0
    total_seconds = max(5.0, min(last_end, total_seconds) if total_seconds else last_end)
    buf = bytearray(int(round(total_seconds * SR)) * 2)  # s16 mono

    for i, seg in enumerate(segments):
        text = (seg.get("text") or "").strip()
        if not text or is_music_only(text):
            continue
        spoken = _MUSIC_RE.sub(" ", text).strip() or text
        dur = max(0.35, seg["end"] - seg["start"])
        meta = tts.synthesize_for_segment(spoken, voice, target_seconds=dur)
        src = os.path.join(tts.AUDIO_DIR, meta["key"] + ".mp3")
        if not os.path.isfile(src):
            continue

        rate = meta["duration"] / dur
        raw = os.path.join(workdir, f"seg_{i}.raw")
        cmd = [ff, "-y", "-v", "error", "-i", src]
        if abs(rate - 1.0) > 0.04:
            factor = max(0.5, min(2.0, rate))
            cmd += ["-filter:a", f"atempo={factor:.4f}"]
        cmd += ["-f", "s16le", "-ac", "1", "-ar", str(SR), raw]
        try:
            _run(cmd)
        except Exception:
            continue

        with open(raw, "rb") as fh:
            data = fh.read()
        pos = int(round(seg["start"] * SR)) * 2
        if pos >= len(buf):
            continue
        end = min(len(buf), pos + len(data))
        buf[pos:end] = data[: end - pos]

        if progress:
            progress(i + 1, len(segments))

    wav = os.path.join(workdir, "dub.wav")
    write_wav(wav, bytes(buf))
    _run([ff, "-y", "-v", "error", "-i", wav, "-c:a", "aac", "-b:a", "128k", out_m4a])

    for name in os.listdir(workdir):
        if name.endswith(".raw") or name == "dub.wav":
            try:
                os.remove(os.path.join(workdir, name))
            except OSError:
                pass


# --------------------------------------------------------------------------
# Video download + mux
# --------------------------------------------------------------------------
def download_video(video_id: str, out_dir: str, progress=None) -> str:
    ff = ffmpeg()

    def hook(status):
        if progress and status.get("status") == "downloading":
            total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
            done = status.get("downloaded_bytes") or 0
            if total:
                progress(min(99, int(done * 100 / total)))

    target = f"https://www.youtube.com/watch?v={video_id}"
    attempts = [
        {
            "format": "bv*[vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
            "merge_output_format": "mp4",
        },
        {"format": "b[ext=mp4]/b"},
    ]
    last_error: Exception | None = None
    for extra in attempts:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "outtmpl": os.path.join(out_dir, "video.%(ext)s"),
            "ffmpeg_location": ff,
            "socket_timeout": 30,
            "progress_hooks": [hook],
        }
        opts.update(extra)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.extract_info(target, download=True)
            for ext in ("mp4", "mkv", "webm"):
                candidate = os.path.join(out_dir, f"video.{ext}")
                if os.path.isfile(candidate):
                    return candidate
        except Exception as exc:  # try the next strategy
            last_error = exc
    raise RuntimeError(f"Video download failed: {last_error}")


def mux(video_path: str, srt_path: str, out_mkv: str, dub_m4a: str | None = None) -> None:
    ff = ffmpeg()
    inputs = ["-i", video_path]
    if dub_m4a:
        inputs += ["-i", dub_m4a]
    inputs += ["-i", srt_path]

    cmd = [ff, "-y", "-v", "error"] + inputs + ["-map", "0:v:0", "-map", "0:a?"]
    if dub_m4a:
        cmd += ["-map", "1:a:0"]
    cmd += ["-map", "2:s:0" if dub_m4a else "1:s:0"]
    cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-c:s", "srt"]

    if dub_m4a:
        # Make the Khmer dub the default audio track so players pick it first.
        preferred = cmd + ["-disposition:a:0", "0", "-disposition:a:1", "default", out_mkv]
        try:
            _run(preferred)
            return
        except Exception:
            pass  # original may have no audio track; fall back below
    _run(cmd + [out_mkv])


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------
class ExportJob:
    def __init__(self, job_id: str, video_id: str, target: str, voice: str, mode: str, bilingual: bool):
        self.id = job_id
        self.video_id = video_id
        self.target = target
        self.voice = voice
        self.mode = mode  # "audio" | "video"
        self.bilingual = bilingual
        self.state = "queued"
        self.progress = 0
        self.message = "Queued"
        self.files: dict[str, str] = {}
        self.error: str | None = None
        self.lock = threading.Lock()

    def update(self, progress: int | None = None, message: str | None = None) -> None:
        with self.lock:
            if progress is not None:
                self.progress = max(0, min(100, int(progress)))
            if message is not None:
                self.message = message

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "job": self.id,
                "state": self.state,
                "progress": self.progress,
                "message": self.message,
                "files": [{"name": name, "url": f"/api/export/file?job={self.id}&name={name}"} for name in self.files],
                "error": self.error,
            }

    def run(self) -> None:
        workdir = os.path.join(EXPORT_DIR, self.id)
        os.makedirs(workdir, exist_ok=True)
        try:
            with self.lock:
                self.state = "running"

            self.update(2, "Reading video info…")
            info = yt.get_info(self.video_id)
            if info["tracks"]:
                track = yt.choose_track(info["tracks"], "auto")
                self.update(5, "Downloading subtitles…")
                cues = yt.get_transcript(self.video_id, track)
            else:
                cached = asr.load_cached(self.video_id)
                if not cached:
                    raise RuntimeError(
                        "this video has no captions — run “Transcribe with AI” in the app first"
                    )
                cues = cached["cues"]
            segments = merge_cues(cues)
            if not segments:
                raise RuntimeError("this video has no subtitles to export")

            self.update(8, f"Translating {len(segments)} segments…")
            translated = translate.translate_texts([s["orig"] for s in segments], self.target)
            for seg, text in zip(segments, translated):
                seg["text"] = (text or "").strip() or seg["orig"]

            srt_path = os.path.join(workdir, "khmer.srt")
            with open(srt_path, "w", encoding="utf-8") as fh:
                fh.write(make_srt(segments, bilingual=self.bilingual))
            self.files["khmer.srt"] = srt_path

            dub_path = None
            if self.mode != "video_sub":
                self.update(12, f"Building Khmer voice ({len(segments)} segments)…")

                def voice_progress(done: int, total: int) -> None:
                    self.update(12 + int(done * 48 / max(1, total)), f"Khmer voice {done}/{total}")

                dub_path = os.path.join(workdir, "dub.m4a")
                build_dub_audio(
                    segments,
                    self.voice,
                    dub_path,
                    workdir,
                    progress=voice_progress,
                    total_seconds=float(info.get("duration") or 0) or None,
                )
                self.files["dub.m4a"] = dub_path

            if self.mode in ("video", "video_sub"):
                start = 62 if dub_path else 20
                self.update(start, "Downloading video…")

                def video_progress(pct: int) -> None:
                    self.update(start + int(pct * 26 / 100), f"Downloading video… {pct}%")

                video_path = download_video(self.video_id, workdir, progress=video_progress)
                self.files[os.path.basename(video_path)] = video_path

                self.update(90, "Muxing video + subtitles…")
                if dub_path:
                    out_name, out_path = "dubbed.mkv", os.path.join(workdir, "dubbed.mkv")
                    try:
                        mux(video_path, srt_path, out_path, dub_m4a=dub_path)
                        self.files[out_name] = out_path
                    except Exception as exc:
                        self.update(94, f"Mux failed (video and tracks still available): {exc}")
                else:
                    out_name, out_path = "subtitled.mkv", os.path.join(workdir, "subtitled.mkv")
                    try:
                        mux(video_path, srt_path, out_path)
                        self.files[out_name] = out_path
                    except Exception as exc:
                        self.update(94, f"Mux failed (video and subtitles still available): {exc}")

            self.update(100, "Done")
            with self.lock:
                self.state = "done"
        except Exception as exc:
            with self.lock:
                self.state = "error"
                self.error = str(exc)
                self.message = str(exc)


def start_export(video_id: str, target: str, voice: str, mode: str, bilingual: bool = False) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = ExportJob(job_id, video_id, target, voice, mode, bilingual)
    with _jobs_lock:
        _jobs[job_id] = job
    threading.Thread(target=job.run, daemon=True).start()
    return job.snapshot()


def get_job(job_id: str) -> ExportJob | None:
    with _jobs_lock:
        return _jobs.get(job_id)


def file_for(job_id: str, name: str) -> str | None:
    job = get_job(job_id)
    if not job:
        return None
    path = job.files.get(name)
    if path and os.path.isfile(path):
        return path
    return None
