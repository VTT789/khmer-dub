"""Edge TTS engine: synthesize speech, cache MP3 files, measure duration.

Uses Microsoft Edge's free "read aloud" voices via the `edge-tts` package
(Khmer: km-KH-PisethNeural male, km-KH-SreymomNeural female).
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import subprocess
import threading
import time

import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, "data", "audio")
META_DIR = os.path.join(ROOT, "data", "voices")

_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}
_voice_cache: dict = {"at": 0.0, "items": []}
_voice_lock = threading.Lock()


def ensure_dirs() -> None:
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(META_DIR, exist_ok=True)


def cache_key(text: str, voice: str, rate: str, pitch: str, volume: str) -> str:
    raw = "\x1f".join([voice, rate, pitch, volume, text])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


async def _stream_synthesis(text: str, voice: str, rate: str, pitch: str, volume: str) -> bytes:
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    chunks: list[bytes] = []
    async for chunk in comm.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            chunks.append(chunk["data"])
    return b"".join(chunks)


def _synthesize_with_retry(text: str, voice: str, rate: str, pitch: str, volume: str) -> bytes:
    """Edge occasionally drops a connection and yields no audio; retry briefly."""
    last: Exception | None = None
    for attempt in range(3):
        try:
            data = asyncio.run(_stream_synthesis(text, voice, rate, pitch, volume))
            if data:
                return data
            last = RuntimeError("edge-tts returned no audio")
        except Exception as exc:  # NoAudioReceived, ConnectionError, timeout
            last = exc
        time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"Speech synthesis failed: {last}")


# --------------------------------------------------------------------------
# MP3 duration
# --------------------------------------------------------------------------
_BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
_BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
_SAMPLE_RATE = {
    3: [44100, 48000, 32000],   # MPEG 1
    2: [22050, 24000, 16000],   # MPEG 2
    0: [11025, 12000, 8000],    # MPEG 2.5
}


def _mp3_duration_frames(data: bytes) -> float:
    """Count MPEG frames (robust, no dependencies)."""
    i = 0
    if data[:3] == b"ID3" and len(data) > 10:
        size = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F)
        i = 10 + size
    total = 0.0
    n = len(data)
    while i + 4 <= n:
        b1 = data[i + 1]
        if data[i] != 0xFF or (b1 & 0xE0) != 0xE0:
            i += 1
            continue
        ver = (b1 >> 3) & 0x03
        layer = (b1 >> 1) & 0x03
        b2 = data[i + 2]
        br_idx = (b2 >> 4) & 0x0F
        sr_idx = (b2 >> 2) & 0x03
        pad = (b2 >> 1) & 0x01
        if layer != 1 or br_idx in (0, 15) or sr_idx == 3 or ver not in _SAMPLE_RATE:
            i += 1
            continue
        table = _BITRATE_V1_L3 if ver == 3 else _BITRATE_V2_L3
        bitrate = table[br_idx] * 1000
        sample_rate = _SAMPLE_RATE[ver][sr_idx]
        samples = 1152 if ver == 3 else 576
        frame_len = int(samples / 8 * bitrate / sample_rate) + pad
        if frame_len <= 0:
            i += 1
            continue
        total += samples / sample_rate
        i += frame_len
    return total


def mp3_duration(data: bytes) -> float:
    try:
        from mutagen.mp3 import MP3  # yt-dlp dependency, usually present

        return float(MP3(io.BytesIO(data)).info.length)
    except Exception:
        return _mp3_duration_frames(data)


# --------------------------------------------------------------------------
# Synthesis + disk cache
# --------------------------------------------------------------------------
def synthesize(
    text: str,
    voice: str,
    rate: str = "+0%",
    pitch: str = "+0Hz",
    volume: str = "+0%",
) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
    ensure_dirs()
    key = cache_key(text, voice, rate, pitch, volume)
    mp3_path = os.path.join(AUDIO_DIR, key + ".mp3")
    meta_path = os.path.join(META_DIR, key + ".json")

    if os.path.exists(mp3_path) and os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
            meta["cached"] = True
            return meta
        except Exception:
            pass

    with _lock:
        key_lock = _key_locks.setdefault(key, threading.Lock())
    with key_lock:
        # another thread may have finished while we waited
        if os.path.exists(mp3_path) and os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
            meta["cached"] = True
            return meta

        data = _synthesize_with_retry(text, voice, rate, pitch, volume)
        duration = mp3_duration(data)

        tmp = mp3_path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, mp3_path)

        meta = {
            "key": key,
            "voice": voice,
            "rate": rate,
            "pitch": pitch,
            "volume": volume,
            "duration": round(duration, 3),
            "chars": len(text),
        }
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False)
        return meta


def _ffmpeg() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        import shutil

        return shutil.which("ffmpeg") or ""


LAST_FIT_ERROR = None


def fit_audio(meta: dict, target: float) -> dict:
    """Time-stretch a clip (pitch preserved) so it lasts exactly `target` seconds.

    This is what makes the Khmer voice land on the subtitle cue: the browser then
    only needs a tiny playbackRate correction instead of a big speed change.
    """
    global LAST_FIT_ERROR
    target = max(0.35, float(target or 0))
    duration = float(meta.get("duration") or 0)
    if not duration or abs(duration - target) <= max(0.09, target * 0.04):
        return meta

    src = os.path.join(AUDIO_DIR, meta["key"] + ".mp3")
    if not os.path.isfile(src):
        LAST_FIT_ERROR = f"missing source {src}"
        return meta

    factor = duration / target
    if factor < 0.5 or factor > 2.0:
        factor = max(0.5, min(2.0, factor))

    out_key = f"{meta['key']}.fit{int(round(target * 1000))}"
    out_path = os.path.join(AUDIO_DIR, out_key + ".mp3")
    out_meta_path = os.path.join(META_DIR, out_key + ".json")

    if os.path.isfile(out_path) and os.path.isfile(out_meta_path):
        try:
            with open(out_meta_path, "r", encoding="utf-8") as fh:
                cached = json.load(fh)
            cached["cached"] = True
            return cached
        except Exception:
            pass

    ff = _ffmpeg()
    if not ff:
        LAST_FIT_ERROR = "ffmpeg not found"
        return meta
    try:
        subprocess.run(
            [ff, "-y", "-v", "error", "-i", src, "-filter:a", f"atempo={factor:.4f}", out_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
    except Exception as exc:
        LAST_FIT_ERROR = f"ffmpeg failed: {exc}"
        return meta
    if not os.path.isfile(out_path):
        LAST_FIT_ERROR = "ffmpeg wrote no file"
        return meta

    with open(out_path, "rb") as fh:
        data = fh.read()
    fitted = dict(meta)
    fitted["key"] = out_key
    fitted["duration"] = round(mp3_duration(data), 3)
    fitted["fitted"] = round(factor, 3)
    try:
        with open(out_meta_path, "w", encoding="utf-8") as fh:
            json.dump(fitted, fh, ensure_ascii=False)
    except OSError:
        pass
    return fitted


def synthesize_for_segment(
    text: str,
    voice: str,
    target_seconds: float | None = None,
    max_rate: int = 80,
    pitch: str = "+0Hz",
) -> dict:
    """Synthesize speech that roughly fills `target_seconds`.

    Khmer needs ~1.6x more time than the English caption it replaces, so asking
    Edge TTS to speak faster is much cleaner than time-stretching audio in the
    browser. One estimate + at most one correction pass; the browser then only
    needs a small playbackRate nudge to land exactly on the cue.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")
    target = float(target_seconds or 0)
    if target <= 0.2 or not voice.lower().startswith("km"):
        return synthesize(text, voice, pitch=pitch)

    # Khmer natural speech is about 12 characters per second.
    estimate = (len(text) / 12.0) / target - 1.0
    rate_pct = int(max(0, min(max_rate, estimate * 100.0)) // 5 * 5)
    meta = synthesize(text, voice, rate=f"+{rate_pct}%", pitch=pitch)

    if abs(meta["duration"] - target) > target * 0.12 + 0.15:
        needed = (meta["duration"] / target - 1.0) * 100.0
        correction = int(max(-10, min(max_rate, rate_pct + needed)) // 5 * 5)
        if correction != rate_pct:
            try:
                trial = synthesize(text, voice, rate=f"{correction:+d}%", pitch=pitch)
                if abs(trial["duration"] - target) < abs(meta["duration"] - target):
                    meta = trial
            except Exception:
                pass  # keep the estimate pass; browser still fits the cue
    return fit_audio(meta, target)


# --------------------------------------------------------------------------
# Voices
# --------------------------------------------------------------------------
def list_voices(prefix: str = "", refresh: bool = False) -> list[dict]:
    now = time.time()
    with _voice_lock:
        if refresh or not _voice_cache["items"] or now - float(_voice_cache["at"]) > 3600:
            raw = asyncio.run(edge_tts.list_voices())
            items = []
            for v in raw:
                items.append(
                    {
                        "shortName": v.get("ShortName"),
                        "name": v.get("FriendlyName") or v.get("ShortName"),
                        "gender": v.get("Gender"),
                        "locale": v.get("Locale"),
                    }
                )
            _voice_cache["items"] = items
            _voice_cache["at"] = now
        items = list(_voice_cache["items"])
    p = (prefix or "").lower()
    return [v for v in items if not p or (v.get("locale") or "").lower().startswith(p)]


def khmer_voices() -> list[dict]:
    return list_voices("km-KH")
