"""Group caption cues into speech-friendly segments.

YouTube cues are often 1-3 second fragments. Translating and speaking each
fragment sounds robotic, so consecutive cues are merged until a sentence
boundary, a pause, or a size limit is reached.
"""
from __future__ import annotations

END_PUNCT = (".", "!", "?", "…", "។", "៕", "。", "！", "？", ":", "：", ";")


def merge_cues(
    cues: list[dict],
    gap: float = 0.65,
    max_chars: int = 170,
    max_sec: float = 7.0,
    sentence_gap: float = 0.30,
    limit: int = 0,
) -> list[dict]:
    items: list[dict] = []
    for cue in cues:
        text = (cue.get("text") or "").strip()
        if not text:
            continue
        start = float(cue.get("start") or 0.0)
        end = float(cue.get("end") or 0.0)
        if end <= start:
            end = start + 0.7
        items.append({"start": start, "end": end, "text": text})
    items.sort(key=lambda c: (c["start"], c["end"]))

    segments: list[dict] = []
    cur: dict | None = None
    for item in items:
        if cur is None:
            cur = _new_segment(item)
            continue
        gap_s = item["start"] - cur["end"]
        joined = " ".join(cur["parts"])
        sentence_done = joined.rstrip().endswith(END_PUNCT)
        would_be_long = len(joined) + 1 + len(item["text"]) > max_chars
        too_slow = (item["end"] - cur["start"]) > max_sec
        if gap_s > gap or would_be_long or too_slow or (sentence_done and gap_s > sentence_gap):
            segments.append(_finish(cur))
            cur = _new_segment(item)
        else:
            cur["parts"].append(item["text"])
            cur["end"] = max(cur["end"], item["end"])
            cur["cues"].append(item)
    if cur is not None:
        segments.append(_finish(cur))

    if limit and limit > 0:
        segments = segments[:limit]
    for i, seg in enumerate(segments):
        seg["i"] = i
    return segments


def _new_segment(item: dict) -> dict:
    return {
        "start": item["start"],
        "end": item["end"],
        "parts": [item["text"]],
        "cues": [item],
    }


def _finish(seg: dict) -> dict:
    text = " ".join(part.strip() for part in seg["parts"] if part.strip())
    text = " ".join(text.split())
    return {
        "start": round(seg["start"], 3),
        "end": round(seg["end"], 3),
        "orig": text,
        "cues": [
            {"start": round(c["start"], 3), "end": round(c["end"], 3), "text": c["text"]}
            for c in seg["cues"]
        ],
    }
