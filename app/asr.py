"""Speech-to-text fallback for videos that have no captions.

Downloads the audio track, decodes it to 16 kHz mono, and runs faster-whisper
(CPU, int8) to produce timed cues. Results are cached as a transcript so the
normal translate → TTS pipeline can take over.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid

import tempfix  # noqa: F401  (must run before huggingface_hub downloads)
import yt_dlp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASR_DIR = os.path.join(ROOT, "data", "asr")
TRANSCRIPT_DIR = os.path.join(ROOT, "data", "transcripts")
MODEL_DIR = os.path.join(ROOT, "data", "models")

# Keep every HuggingFace cache inside the workspace (and avoid xet side stores).
os.environ.setdefault("HF_HOME", MODEL_DIR)
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_model_lock = threading.Lock()
_models: dict[str, object] = {}
DEFAULT_MODEL = os.environ.get("YTDUB_WHISPER_MODEL", "base")


def ffmpeg() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        import shutil

        return shutil.which("ffmpeg") or ""


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def cached_path(video_id: str) -> str:
    return os.path.join(TRANSCRIPT_DIR, f"{video_id}.asr.json")


def load_cached(video_id: str) -> dict | None:
    path = cached_path(video_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("cues"):
            return data
    except Exception:
        pass
    return None


def _get_model(size: str):
    with _model_lock:
        if size in _models:
            return _models[size]
        from faster_whisper import WhisperModel

        os.makedirs(MODEL_DIR, exist_ok=True)
        model = WhisperModel(size, device="cpu", compute_type="int8", download_root=MODEL_DIR)
        _models[size] = model
        return model


def download_audio(video_id: str, out_dir: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bestaudio/best",
        "outtmpl": os.path.join(out_dir, "audio.%(ext)s"),
        "ffmpeg_location": ffmpeg(),
        "socket_timeout": 30,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
    for name in os.listdir(out_dir):
        if name.startswith("audio."):
            return os.path.join(out_dir, name)
    raise RuntimeError("audio download failed")


def transcribe(video_id: str, model_size: str = DEFAULT_MODEL, progress=None, language: str | None = None) -> dict:
    workdir = os.path.join(ASR_DIR, video_id)
    os.makedirs(workdir, exist_ok=True)
    cached = load_cached(video_id)
    if cached:
        return cached

    if progress:
        progress(5, "Downloading audio…")
    audio = download_audio(video_id, workdir)

    if progress:
        progress(12, "Decoding audio…")
    wav = os.path.join(workdir, "audio16k.wav")
    _run([ffmpeg(), "-y", "-v", "error", "-i", audio, "-vn", "-ac", "1", "-ar", "16000", wav])

    if progress:
        progress(18, "Loading Whisper model…")
    model = _get_model(model_size)

    if progress:
        progress(22, "Transcribing speech…")

    # Decode the WAV ourselves and pass samples to Whisper: recent PyAV versions
    # dropped an argument that faster-whisper's file loader still uses.
    import wave

    import numpy as np

    with wave.open(wav, "rb") as fh:
        frames = fh.readframes(fh.getnframes())
        channels = fh.getnchannels()
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    segments, info = model.transcribe(samples, vad_filter=True, beam_size=1, language=language)

    cues: list[dict] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            cues.append({"start": round(float(seg.start), 3), "end": round(float(seg.end), 3), "text": text})
        if progress and cues and len(cues) % 3 == 0:
            est = 22 + min(70, len(cues) / 60 * 70)
            progress(int(est), f"Transcribing speech… {len(cues)} lines")

    result = {
        "videoId": video_id,
        "language": getattr(info, "language", None) or language or "auto",
        "languageProbability": round(float(getattr(info, "language_probability", 0) or 0), 3),
        "model": model_size,
        "created": time.time(),
        "cues": cues,
    }
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
    tmp = cached_path(video_id) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    os.replace(tmp, cached_path(video_id))

    try:
        os.remove(audio)
        os.remove(wav)
    except OSError:
        pass
    return result


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------
def start_transcription(video_id: str, model_size: str = DEFAULT_MODEL) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job": job_id,
        "videoId": video_id,
        "state": "queued",
        "progress": 0,
        "message": "Queued",
        "cues": 0,
        "language": None,
        "error": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job

    def update(pct=None, msg=None):
        with _jobs_lock:
            if pct is not None:
                job["progress"] = max(0, min(100, int(pct)))
            if msg is not None:
                job["message"] = msg

    def work():
        try:
            with _jobs_lock:
                job["state"] = "running"
            result = transcribe(video_id, model_size=model_size, progress=update)
            with _jobs_lock:
                job["cues"] = len(result["cues"])
                job["language"] = result.get("language")
                job["state"] = "done"
                job["progress"] = 100
                job["message"] = f"Done — {len(result['cues'])} lines"
        except Exception as exc:
            with _jobs_lock:
                job["state"] = "error"
                job["error"] = str(exc)
                job["message"] = str(exc)

    threading.Thread(target=work, daemon=True).start()
    return job


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None
