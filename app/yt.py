"""YouTube helpers: video info, caption tracks, transcripts, search.

Primary path uses yt-dlp; a plain-HTTP scraper covers failures.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import yt_dlp
except Exception:  # pragma: no cover - optional at runtime
    yt_dlp = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSCRIPT_DIR = os.path.join(ROOT, "data", "transcripts")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
COOKIE = "CONSENT=YES+1; SOCS=CAI; PREF=hl=en&gl=US"

_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "socket_timeout": 25,
    "retries": 2,
    "extractor_retries": 2,
    "no_color": True,
    "cachedir": False,
}

_info_cache: dict[str, tuple[float, dict]] = {}
_transcript_cache: dict[tuple, tuple[float, list]] = {}
_cache_lock = threading.Lock()
_caption_lock = threading.Lock()
_rate_limited_until = 0.0

_INFO_TTL = 1800
_CUES_TTL = 1800


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def _fetch(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/json,*/*",
            "Cookie": COOKIE,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
            data = gzip.decompress(data)
    return data.decode("utf-8", "replace")


def extract_video_id(value: str) -> str | None:
    value = (value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
        return value
    try:
        parsed = urllib.parse.urlparse(value)
    except Exception:
        return None
    if parsed.netloc in {"youtu.be", "www.youtu.be"}:
        vid = parsed.path.strip("/").split("/")[0]
        return vid if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) else None
    qs = urllib.parse.parse_qs(parsed.query)
    if "v" in qs:
        vid = qs["v"][0]
        return vid if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) else None
    m = re.search(r"/(?:shorts|embed|live)/([A-Za-z0-9_-]{11})", parsed.path)
    return m.group(1) if m else None


# --------------------------------------------------------------------------
# Info
# --------------------------------------------------------------------------
def get_info(video_id: str, force: bool = False) -> dict:
    now = time.time()
    with _cache_lock:
        hit = _info_cache.get(video_id)
        if hit and not force and now - hit[0] < _INFO_TTL:
            return hit[1]
    data = _extract(video_id)
    with _cache_lock:
        _info_cache[video_id] = (now, data)
    return data


def _pick_entry(entries: list[dict]) -> dict | None:
    if not entries:
        return None
    order = {"json3": 0, "srv3": 1, "vtt": 2, "srv1": 3, "srv2": 4, "srt": 5, "ttml": 6}
    return sorted(entries, key=lambda e: order.get((e.get("ext") or "").lower(), 9))[0]


def _pack(d: dict, tracks: list[dict], via: str) -> dict:
    thumbs = d.get("thumbnails") or []
    thumb = d.get("thumbnail")
    if not thumb and thumbs:
        thumb = sorted(thumbs, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))[-1].get("url")
    tracks.sort(key=lambda t: (0 if t["kind"] == "manual" else 1, t["lang"]))
    return {
        "id": d.get("id"),
        "title": d.get("title") or "Untitled",
        "author": d.get("uploader") or d.get("channel") or d.get("channel_id") or "",
        "duration": int(d.get("duration") or 0),
        "thumb": thumb,
        "tracks": tracks,
        "via": via,
    }


def _extract(video_id: str) -> dict:
    if yt_dlp is not None:
        try:
            with yt_dlp.YoutubeDL(_YDL_OPTS) as ydl:
                d = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
            if d:
                if d.get("_type") == "playlist":
                    entries = [e for e in (d.get("entries") or []) if e]
                    if entries:
                        d = entries[0]
                tracks: list[dict] = []
                for kind, mapping in (
                    ("manual", d.get("subtitles") or {}),
                    ("auto", d.get("automatic_captions") or {}),
                ):
                    for lang, entries in mapping.items():
                        entry = _pick_entry(entries or [])
                        if not entry or not entry.get("url"):
                            continue
                        tracks.append(
                            {
                                "lang": lang,
                                "kind": kind,
                                "name": entry.get("name") or lang,
                                "ext": (entry.get("ext") or "json3").lower(),
                                "url": entry["url"],
                            }
                        )
                return _pack(d, tracks, "yt-dlp")
        except Exception:
            pass
    return _scrape(video_id)


def _scrape(video_id: str) -> dict:
    url = f"https://www.youtube.com/watch?v={video_id}&hl=en&gl=US"
    html = _fetch(url)
    data = _json_at(html, "ytInitialPlayerResponse")
    if not data:
        raise RuntimeError("YouTube did not return player data (rate limited or bot check?)")
    status = (data.get("playabilityStatus") or {}).get("status")
    if status and status != "OK":
        reason = (data.get("playabilityStatus") or {}).get("reason") or status
        raise RuntimeError(f"YouTube says: {reason}")
    details = data.get("videoDetails") or {}
    tracks: list[dict] = []
    for tr in (
        ((data.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}).get("captionTracks") or []
    ):
        name = tr.get("name") or {}
        label = name.get("simpleText") or ((name.get("runs") or [{}])[0].get("text")) or tr.get("languageCode")
        tracks.append(
            {
                "lang": tr.get("languageCode") or "?",
                "kind": "auto" if tr.get("kind") == "asr" else "manual",
                "name": label,
                "ext": "json3",
                "url": tr.get("baseUrl") or "",
            }
        )
    packed = {
        "id": video_id,
        "title": details.get("title") or "Untitled",
        "author": details.get("author") or "",
        "duration": int(details.get("lengthSeconds") or 0),
        "thumbnail": (details.get("thumbnail") or {}).get("thumbnails", [{}])[-1].get("url"),
        "thumbnails": (details.get("thumbnail") or {}).get("thumbnails", []),
    }
    return _pack(packed, tracks, "scrape")


def _json_at(html: str, marker: str) -> dict | None:
    idx = html.find(marker)
    if idx < 0:
        return None
    brace = html.find("{", idx)
    if brace < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(html[brace:])
        return obj
    except Exception:
        return None


# --------------------------------------------------------------------------
# Tracks / transcripts
# --------------------------------------------------------------------------
def choose_track(tracks: list[dict], lang: str | None = "auto") -> dict:
    if not tracks:
        raise RuntimeError("This video has no captions to translate")
    lang = (lang or "auto").strip()

    def score(t: dict) -> float:
        s = 0.0
        if lang and lang not in ("auto", "*", ""):
            if t["lang"].lower() == lang.lower():
                s += 100
            elif t["lang"].lower().split("-")[0] == lang.lower().split("-")[0]:
                s += 70
            elif t["lang"].lower().startswith(lang.lower()):
                s += 60
            else:
                s -= 60
        if t["kind"] == "manual":
            s += 20
        if (t["lang"] or "").lower().startswith("en"):
            s += 12
        if t.get("url") and "tlang=" in t["url"]:
            # auto-translated tracks are more likely to be throttled; prefer the
            # video's own language track when no manual captions exist
            s -= 18
        if t["ext"] == "json3":
            s += 5
        return s

    return max(tracks, key=score)


def _disk_path(video_id: str, track: dict) -> str:
    lang = re.sub(r"[^A-Za-z0-9_-]", "_", str(track.get("lang") or "x"))
    kind = re.sub(r"[^A-Za-z0-9_-]", "_", str(track.get("kind") or "x"))
    return os.path.join(TRANSCRIPT_DIR, f"{video_id}.{lang}.{kind}.cues.json")


def get_transcript(video_id: str, track: dict) -> list[dict]:
    key = (video_id, track.get("lang"), track.get("kind"), track.get("ext"))
    now = time.time()
    with _cache_lock:
        hit = _transcript_cache.get(key)
        if hit and now - hit[0] < _CUES_TTL:
            return hit[1]

    path = _disk_path(video_id, track)
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            cues = data.get("cues") or []
            if cues:
                with _cache_lock:
                    _transcript_cache[key] = (now, cues)
                return cues
        except Exception:
            pass

    cues = _download_cues(video_id, track)
    with _cache_lock:
        _transcript_cache[key] = (now, cues)
    try:
        os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(
                {"videoId": video_id, "lang": track.get("lang"), "kind": track.get("kind"), "cues": cues},
                fh,
                ensure_ascii=False,
            )
        os.replace(tmp, path)
    except OSError:
        pass
    return cues


def _download_cues(video_id: str, track: dict) -> list[dict]:
    global _rate_limited_until

    fmt = (track.get("ext") or "json3").lower()
    url = track.get("url") or ""
    if not url:
        raise RuntimeError("Caption track has no URL")

    with _caption_lock:  # serialize caption downloads; avoids self-inflicted 429s
        if time.time() < _rate_limited_until:
            wait = int(_rate_limited_until - time.time()) + 1
            raise RuntimeError(
                f"YouTube is temporarily rate-limiting captions (429). Try again in ~{wait}s, or use “Transcribe with AI”."
            )

        last_error: Exception | None = None
        for attempt in range(2):
            try:
                body = _fetch(_with_fmt(url, fmt))
                cues = _parse(body, fmt)
                if not cues and fmt != "json3":
                    cues = _parse(_fetch(_with_fmt(url, "json3")), "json3")
                if cues:
                    return _normalize(cues)
                last_error = RuntimeError("caption file was empty")
            except Exception as exc:
                last_error = exc
            if isinstance(last_error, urllib.error.HTTPError) and last_error.code == 429:
                _rate_limited_until = time.time() + 45
                break
            time.sleep(1.5 * (attempt + 1))

        # Signed caption URLs expire; refresh the player data once (unless throttled).
        if time.time() >= _rate_limited_until:
            try:
                info = get_info(video_id, force=True)
                if info.get("tracks"):
                    fresh = choose_track(info["tracks"], track.get("lang"))
                    fresh_fmt = (fresh.get("ext") or fmt).lower()
                    body = _fetch(_with_fmt(fresh["url"], fresh_fmt))
                    cues = _parse(body, fresh_fmt)
                    if cues:
                        return _normalize(cues)
            except Exception as exc:
                last_error = exc
                if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
                    _rate_limited_until = time.time() + 45

        if time.time() < _rate_limited_until:
            wait = int(_rate_limited_until - time.time()) + 1
            raise RuntimeError(
                f"YouTube is rate-limiting caption downloads (429). Try again in ~{wait}s, or use “Transcribe with AI”."
            )
        raise RuntimeError(f"Could not download captions: {last_error}")


def _with_fmt(url: str, fmt: str) -> str:
    parts = urllib.parse.urlsplit(url)
    qs = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    qs["fmt"] = [fmt]
    query = urllib.parse.urlencode({k: v[0] for k, v in qs.items()})
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def _parse(body: str, fmt: str) -> list[dict]:
    fmt = (fmt or "").lower()
    if fmt in ("json3", "json"):
        return _parse_json3(body)
    if fmt == "vtt":
        return _parse_vtt(body)
    if fmt in ("srv1", "srv2", "srv3"):
        return _parse_srv3(body)
    if fmt == "srt":
        return _parse_srt(body)
    # last resort: sniff
    head = body.lstrip()[:64]
    if head.startswith("{"):
        return _parse_json3(body)
    if head.startswith("WEBVTT"):
        return _parse_vtt(body)
    return _parse_srv3(body)


def _parse_json3(body: str) -> list[dict]:
    try:
        data = json.loads(body)
    except Exception:
        return []
    cues: list[dict] = []
    pending: dict | None = None
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join((s or {}).get("utf8", "") for s in segs).replace("\n", " ").strip()
        if not text:
            continue
        start = float(ev.get("tStartMs") or 0) / 1000.0
        dur = float(ev.get("dDurationMs") or 0) / 1000.0
        if ev.get("aAppend"):
            if pending is not None:
                pending["text"] = (pending["text"] + " " + text).strip()
                pending["end"] = round(start + dur, 3)
            continue
        if pending is not None:
            cues.append(pending)
        pending = {"start": round(start, 3), "end": round(start + dur, 3), "text": text}
    if pending is not None:
        cues.append(pending)
    return cues


_TS = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})"
)


def _ts_seconds(h, m, s, ms) -> float:
    ms = (ms + "000")[:3]
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _parse_vtt(body: str) -> list[dict]:
    cues: list[dict] = []
    cur: dict | None = None
    for line in body.replace("\r\n", "\n").split("\n"):
        m = _TS.search(line)
        if m:
            if cur:
                cues.append(cur)
            cur = {
                "start": round(_ts_seconds(*m.group(1, 2, 3, 4)), 3),
                "end": round(_ts_seconds(*m.group(5, 6, 7, 8)), 3),
                "text": "",
            }
            continue
        if cur is None:
            continue
        stripped = re.sub(r"<[^>]+>", "", line).strip()
        if stripped:
            cur["text"] = (cur["text"] + " " + stripped).strip()
    if cur:
        cues.append(cur)
    return cues


def _parse_srv3(body: str) -> list[dict]:
    cues: list[dict] = []
    for m in re.finditer(r"<p[^>]*\bt=\"(\d+)\"[^>]*\bd=\"(\d+)\"[^>]*>(.*?)</p>", body, re.S):
        start = int(m.group(1)) / 1000.0
        dur = int(m.group(2)) / 1000.0
        text = re.sub(r"<[^>]+>", "", m.group(3))
        text = (
            text.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&#39;", "'")
        )
        text = " ".join(text.split())
        if text:
            cues.append({"start": round(start, 3), "end": round(start + dur, 3), "text": text})
    return cues


def _parse_srt(body: str) -> list[dict]:
    return _parse_vtt(body)


def _normalize(cues: list[dict]) -> list[dict]:
    cleaned = []
    for c in cues:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        start = float(c.get("start") or 0)
        end = float(c.get("end") or 0)
        if end <= start:
            end = start + 0.8
        cleaned.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    cleaned.sort(key=lambda c: (c["start"], c["end"]))
    out: list[dict] = []
    for c in cleaned:
        if out and c["text"] == out[-1]["text"] and c["start"] - out[-1]["end"] < 0.6:
            out[-1]["end"] = max(out[-1]["end"], c["end"])
            continue
        if out and c["start"] < out[-1]["end"] - 0.25:
            c["start"] = round(out[-1]["end"], 3)
            if c["end"] <= c["start"]:
                c["end"] = round(c["start"] + 0.6, 3)
        out.append(c)
    return out


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------
def search(query: str, limit: int = 12) -> list[dict]:
    query = (query or "").strip()
    if not query:
        return []
    if yt_dlp is not None:
        try:
            opts = dict(_YDL_OPTS)
            opts["extract_flat"] = True
            with yt_dlp.YoutubeDL(opts) as ydl:
                d = ydl.extract_info(f"ytsearch{max(1, min(limit, 25))}:{query}", download=False)
            cards = [_card(e) for e in (d.get("entries") or []) if e and e.get("id")]
            cards = [c for c in cards if c]
            if cards:
                return cards[:limit]
        except Exception:
            pass
    try:
        return _scrape_search(query, limit)
    except Exception:
        return []


def _card(entry: dict) -> dict | None:
    vid = entry.get("id")
    if not vid:
        return None
    thumbs = entry.get("thumbnails") or []
    thumb = entry.get("thumbnail")
    if not thumb and thumbs:
        thumb = sorted(thumbs, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))[-1].get("url")
    return {
        "videoId": vid,
        "title": entry.get("title") or "(untitled)",
        "author": entry.get("uploader") or entry.get("channel") or "",
        "duration": int(entry.get("duration") or 0),
        "thumb": thumb,
    }


def _scrape_search(query: str, limit: int) -> list[dict]:
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": query, "hl": "en"})
    html = _fetch(url)
    data = _json_at(html, "ytInitialData")
    if not data:
        return []
    return _cards_from_data(data, limit)


def trending(limit: int = 12) -> list[dict]:
    url = "https://www.youtube.com/feed/trending?" + urllib.parse.urlencode({"hl": "en", "gl": "US"})
    data = _json_at(_fetch(url), "ytInitialData")
    if not data:
        return search("trending videos", limit)
    cards = _cards_from_data(data, limit)
    return cards or search("trending videos", limit)


def _cards_from_data(data: dict, limit: int) -> list[dict]:
    raw_cards: list[dict] = []

    def walk(node):
        if isinstance(node, dict):
            if "videoRenderer" in node:
                raw_cards.append(node["videoRenderer"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    out: list[dict] = []
    for vr in raw_cards:
        vid = vr.get("videoId")
        if not vid:
            continue
        title = "".join(r.get("text", "") for r in (vr.get("title") or {}).get("runs", []))
        author = "".join(r.get("text", "") for r in (vr.get("ownerText") or {}).get("runs", []))
        length = (vr.get("lengthText") or {}).get("simpleText") or ""
        secs = 0
        if length:
            parts = [int(p) for p in re.findall(r"\d+", length)]
            for p in parts:
                secs = secs * 60 + p
        thumbs = ((vr.get("thumbnail") or {}).get("thumbnails") or [{}])
        out.append(
            {
                "videoId": vid,
                "title": title or "(untitled)",
                "author": author,
                "duration": secs,
                "thumb": thumbs[-1].get("url"),
            }
        )
        if len(out) >= limit:
            break
    return out
