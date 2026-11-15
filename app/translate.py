"""Subtitle translation via Google's public translate endpoint (with fallbacks).

Results are cached in memory and on disk so re-running a video is instant.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_PATH = os.path.join(ROOT, "data", "translations.json")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_cache: dict[str, str] = {}
_lock = threading.Lock()
_dirty = False
_MAX_ENTRIES = 50000


def _key(target: str, text: str) -> str:
    return f"{target}\x1f{text}"


def _load() -> None:
    global _cache
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            _cache = {k: v for k, v in loaded.items() if isinstance(v, str)}
    except Exception:
        _cache = {}


def _save() -> None:
    global _dirty
    with _lock:
        if not _dirty:
            return
        _dirty = False
        items = list(_cache.items())
        if len(items) > _MAX_ENTRIES:
            items = items[-_MAX_ENTRIES:]
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(dict(items), fh, ensure_ascii=False)
        os.replace(tmp, CACHE_PATH)


_load()


# --------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------
def _gtx(text: str, target: str, source: str = "auto") -> str:
    qs = urllib.parse.urlencode(
        {"client": "gtx", "sl": source, "tl": target, "dt": "t", "ie": "UTF-8", "oe": "UTF-8", "q": text}
    )
    req = urllib.request.Request(
        "https://translate.googleapis.com/translate_a/single?" + qs,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read().decode("utf-8", "replace")
    data = json.loads(raw)
    return _unpack(data)


def _unpack(data) -> str:
    if isinstance(data, list) and data and isinstance(data[0], list):
        parts = []
        for seg in data[0]:
            if isinstance(seg, list) and seg and isinstance(seg[0], str):
                parts.append(seg[0])
        return "".join(parts)
    if isinstance(data, dict):
        sentences = data.get("sentences")
        if isinstance(sentences, list):
            return "".join(str(s.get("trans") or "") for s in sentences)
        if isinstance(data.get("translation"), str):
            return data["translation"]
    raise RuntimeError("Unexpected translation response")


def _mymemory(text: str, target: str, source: str = "en") -> str:
    qs = urllib.parse.urlencode({"q": text, "langpair": f"{source}|{target}"})
    req = urllib.request.Request(
        "https://api.mymemory.translated.net/get?" + qs,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    translated = ((data.get("responseData") or {}).get("translatedText") or "").strip()
    if not translated:
        raise RuntimeError("MyMemory returned nothing")
    return translated


def _translate_one(text: str, target: str) -> str:
    last: Exception | None = None
    for attempt in range(3):
        try:
            return _gtx(text, target)
        except Exception as exc:  # network hiccup / throttling
            last = exc
            time.sleep(0.5 * (attempt + 1))
    try:
        return _mymemory(text, target)
    except Exception as exc:
        last = exc
    raise RuntimeError(f"Translation failed ({target}): {last}")


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------
def translate_texts(texts: list[str], target: str = "km") -> list[str]:
    results: list[str] = [""] * len(texts)
    missing: list[int] = []
    with _lock:
        for i, text in enumerate(texts):
            if not (text or "").strip():
                results[i] = ""
                continue
            cached = _cache.get(_key(target, text))
            if cached is not None:
                results[i] = cached
            else:
                missing.append(i)

    if missing:
        workers = max(1, min(6, len(missing)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_translate_one, texts[i], target): i for i in missing}
            for fut, idx in futures.items():
                try:
                    results[idx] = fut.result()
                except Exception:
                    results[idx] = texts[idx]  # degrade gracefully: keep source text
        with _lock:
            global _dirty
            for i in missing:
                if results[i] and results[i] != texts[i]:
                    _cache[_key(target, texts[i])] = results[i]
                    _dirty = True
        _save()
    return results


def available_targets() -> list[dict]:
    return [
        {"code": "km", "label": "Khmer (ខ្មែរ)"},
        {"code": "en", "label": "English"},
        {"code": "th", "label": "Thai"},
        {"code": "vi", "label": "Vietnamese"},
        {"code": "zh-CN", "label": "Chinese (Simplified)"},
        {"code": "ja", "label": "Japanese"},
        {"code": "ko", "label": "Korean"},
        {"code": "id", "label": "Indonesian"},
        {"code": "my", "label": "Burmese"},
        {"code": "lo", "label": "Lao"},
        {"code": "es", "label": "Spanish"},
        {"code": "fr", "label": "French"},
    ]
