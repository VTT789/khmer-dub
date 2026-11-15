# Khmer Dub — YouTube subtitles → Khmer voice

A local web app that opens any YouTube video, reads its subtitles, translates them
(Khmer by default) and speaks the translation with Microsoft Edge's neural voices.
Each voice clip is speed-fitted to the subtitle's on-screen duration, so the dub
follows the picture instead of drifting.

No API keys. Runs entirely on your machine; only YouTube, Google Translate and
Microsoft's read-aloud service are contacted.

---

## Quick start

1. Double-click **`run.cmd`**.
2. The first start prepares a local Python environment (needs internet, ~1 minute),
   then opens **http://127.0.0.1:8765** — or the next free port if 8765 is taken;
   the browser opens the exact URL automatically.
3. Browse trending, or paste a YouTube link (or type a search) into the top bar.
4. Click a video — it starts interpreting automatically (disable “Auto interpret on
   click” to confirm first). Wait for “Ready”; subtitles are translated in batches and
   voice clips are generated in the background. Videos without captions offer
   **Transcribe with AI**.
5. Press play. Khmer subtitles appear over the video and the Khmer voice follows
   each cue.

If `run.cmd` cannot find Python, run **`setup.ps1`** once and follow its message,
or install Python 3.10+ and run `setup.ps1` again.

---

## Features

- **YouTube-style browsing** — trending videos on start, search, quick category chips
  (Music, Relaxing, News, Learning, Gaming, Khmer). Clicking a card **automatically
  interprets** it (toggle “Auto interpret on click” off to get the watch/interpret
  dialog instead). The **YouTube ↗** button opens the real site.
- **Subtitle interpretation** — manual captions are preferred; auto-generated ones work too.
  Choose which source track to translate from.
- **Khmer Edge TTS voices** — `km-KH-SreymomNeural` (female) and `km-KH-PisethNeural` (male);
  other languages are available too (en, th, vi, zh, ja, ko, …).
- **Speed matched to the picture** — each voice clip is **time-stretched server-side**
  (ffmpeg `atempo`, pitch preserved) to the subtitle's exact duration; the browser then
  applies only a ±5–15% correction. Speech never drifts or overruns the cue.
- **Sentence-aware segments** — 1–2 second caption fragments are merged into natural
  phrases; playback never chops mid-sentence.
- **White-blur subtitles** — Khmer text floats on a **transparent frosted-glass**
  background (no colour fill) with the original line underneath (toggleable).
  **Drag the subtitles anywhere**; double-click resets them to the bottom centre.
- **Voice controls** — the original audio plays at **full volume**, and **ducks to 18%
  only while the Khmer voice is speaking**, returning to 100% as soon as the speech
  ends (choose 0/18/50/100%; 100% disables ducking). Gaps and music-only moments stay
  at full volume. **Subtitles only** mode mutes everything and shows Khmer text with no
  speech; music-only captions (`[♪♪♪]`, `[music]`, `[applause]`, `(music)`) are never
  voiced.
- **Comfortable speed** — the browser correction is limited to 0.9–1.75× so Khmer stays
  intelligible instead of sounding rushed.
- **Offset slider** — nudge the dub ±2 s if a video's captions are slightly out of sync.
- **Transcript list** — click any line to jump there; rows highlight as they play.
- **Downloads** — from the **Download** button:
  - `khmer.srt` — translated subtitles (optionally bilingual),
  - `dub.m4a` — the full Khmer voice track on the video timeline,
  - `dubbed.mkv` — the video with **original audio + Khmer dub + soft subtitles**
    (the Khmer track is marked as the player's default audio),
  - `subtitled.mkv` — video + Khmer soft subtitles, keeping the original audio,
  - plus `video.mp4` (no re-encode).
- **AI transcription for caption-less videos** — if a video has no CC and no
  auto-captions, press **Transcribe with AI**: Whisper listens to the audio, writes
  timed subtitles, then the same translate → TTS pipeline runs. First use downloads
  a ~150 MB model; CPU transcription is roughly 1–3× video length.
- **Works directly on youtube.com (Chrome extension)** — the bundled extension adds a
  **Khmer Dub** button to YouTube itself. It auto-interprets when a video opens or you
  change videos, plays Khmer voice inside YouTube's player, overlays draggable
  glass subtitles, and can download the dubbed video / voice / SRT.
- **Voice coverage check** — after each 1-minute window is translated, the extension
  verifies that **every speech segment has a voice clip**, retries failed clips (up to
  4 attempts with backoff), and scans 10 segments ahead every 4 s. If a clip arrives
  while its cue is already playing, it starts immediately (no silent cues).
- **Caching** — translations and voice clips are stored under `data/`, so replays are instant.

---

## Watch directly on youtube.com (Chrome extension)

The web app can't embed youtube.com, but the extension runs **inside** YouTube pages:

1. Start the app (`run.cmd`) — the extension auto-discovers the local server port.
2. Open Chrome → `chrome://extensions` → enable **Developer mode**.
3. Click **Load unpacked** → select the `extension` folder in this project.
4. Open any YouTube video (or **Shorts**) → a **🇰🇭 Khmer Dub** button appears top-right.
   It starts interpreting **automatically when the video opens or you switch videos**
   (uncheck “Auto interpret on video change” to disable). Preparation is **windowed**:
   the **first minute** is translated and voiced in a few seconds, so you can press play
   immediately; the rest prepares in the background (“Ready — full video” when done),
   and jumping ahead prepares that part on demand. Videos **without captions** are
   transcribed by Whisper right from the panel (press **Interpret**; progress is shown).
   It mutes nothing by default: the original audio is lowered to **18%** so you still
   hear the music/atmosphere under the Khmer voice (change it in the panel; **Subtitles
   only** mutes everything and shows text without speech). Overlays are transparent
   frosted-glass Khmer cards (drag to move, double-click to reset).
5. **Download** directly from the panel: dubbed MKV, video + subtitles, voice-only
   M4A, or SRT. Progress is shown in the panel; click a produced file to save it.
6. **Stop** removes the dub; the panel remembers your voice choice.

Notes: the video must have captions, and the local app must be running. Works on
regular videos and Shorts.

---

## How the timing works

For every merged segment with start `s`, end `e`:

1. Khmer text is synthesized by Edge TTS (the server estimates a speaking rate from
   the character count, then corrects once if the result misses the target length).
2. The browser computes `rate = clipDuration / (e - s)` (clamped 0.65–2.2) and plays
   the clip with `audio.playbackRate = rate`.
3. While the video plays, the audio position is continuously checked against
   `(videoTime - s) * rate`; drift over 350 ms triggers a re-seek of the clip.

---

## Project layout

```
youtube-khmer-dub/
  run.cmd            launch (creates .venv on first run)
  setup.ps1          environment bootstrap
  app/
    server.py        HTTP server + JSON API
    yt.py            yt-dlp + scraping fallbacks for info/captions/search/trending
    translate.py     Google translate client with caching and retries
    tts.py           Edge TTS synthesis, MP3 duration, speed fitting
    export.py        video download + Khmer audio track + MKV muxing (ffmpeg)
    asr.py           faster-whisper transcription for videos without captions
    segments.py      cue → speech segment merging
  extension/         Chrome extension: Khmer Dub button on youtube.com
  public/
    index.html, style.css, app.js
  data/              cached audio + translations (created at runtime)
  tools/tmppatch/    sitecustomize shim used only while installing packages
```

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/info?v=` | title, author, duration, caption tracks |
| GET | `/api/segments?v=&lang=` | merged segments with source text |
| POST | `/api/translate` | `{texts:[], target}` → translated texts |
| POST | `/api/tts` | `{text, voice, target}` → `{url, duration, rate}` |
| GET | `/api/audio/<sha1>.mp3` | cached voice clip (supports Range) |
| GET | `/api/search?q=` | YouTube search |
| GET | `/api/trending?limit=` | trending videos |
| GET | `/api/voices?prefix=km` | available Edge voices |
| POST | `/api/export` | start download job (`mode`: audio/video) |
| GET | `/api/export/status?job=` | job progress + ready files |
| GET | `/api/export/file?job=&name=` | download a produced file |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| “The owner disabled embedding” | The video blocks iframes. Use “open on YouTube”, or pick another video (most are fine). |
| “This video has no captions” | Nothing to translate. Try a video with CC or auto-captions. |
| “YouTube did not return player data” | YouTube rate-limited this IP; wait a minute and retry. |
| Voice is missing / no sound | Click the page once (browser autoplay policy), check the **Dub voice** and **Voice volume** controls. |
| Dub drifts | Use the **Offset** slider; some videos have captions that start late. |
| Setup fails | Install Python 3.10+ manually, then run `setup.ps1` again. |
| Port already in use | The app automatically uses the next free port and opens that URL; check the console. |
| “Can I browse youtube.com inside the app?” | YouTube forbids embedding its pages; use the trending/search browser inside the app, or the **YouTube ↗** button. |
| Export stuck at “Downloading video” | Long videos take a while; the job keeps running server-side. |
| “Transcribe with AI” is slow | CPU Whisper `base` runs roughly 1–3× video length; set `YTDUB_WHISPER_MODEL=tiny` for speed or `small` for accuracy. |
| `HTTP 429` when fetching captions | YouTube throttled its caption endpoint. The server now prefers the video's **original-language** track (not auto-translated ones), serializes caption downloads, backs off for ~45 s after a 429, retries with a refreshed URL and caches captions on disk. If it still fails, wait a minute, or press **Interpret** and let the extension transcribe the audio with AI. |

---

## Publishing to GitHub

This folder is ready to be a repository; `.gitignore` excludes the big runtime
stuff (`.venv/` ≈ 350 MB, `data/` with Whisper models + caches ≈ 100 MB, `.tmp/`).
Only source + docs (~1 MB) get committed.

**Easy way — GitHub Desktop**

1. Install [GitHub Desktop](https://desktop.github.com/) and sign in.
2. **File → Add local repository…** → choose this folder
   (`...\youtube-khmer-dub`). It offers to create a repository → **create**.
3. Type a summary, click **Commit to main**.
4. Click **Publish repository** (untick *Keep this code private* if you want it public).

**Command line**

```powershell
# 1. Install Git once
winget install --id Git.Git -e --source winget

# 2. In the project folder
cd "C:\Users\cheav\OneDrive\ドキュメント\deepseek-harness\default-workspace\youtube-khmer-dub"
git init
git add .
git commit -m "Khmer Dub: YouTube subtitle interpreter with Edge TTS + Whisper"

# 3. Create an EMPTY repo on github.com (no README), then:
git remote add origin https://github.com/<your-user>/<repo-name>.git
git branch -M main
git push -u origin main
```

Notes:

- `run.cmd` / `setup.ps1` let anyone re-create `.venv` on first run, so nothing
  Python-specific needs to be committed.
- The Chrome extension lives in `extension/`; users still load it via
  `chrome://extensions → Load unpacked`.
- Don't commit `data/` — it holds generated audio and the Whisper model
  (re-downloaded automatically on first transcription).

---

## Notes

- Captions and translations come from public endpoints and may be blocked in some networks.
- Only subtitles are used — the app never downloads video files.
- Voice clips are cached by text+voice+rate, so repeated phrases and replays are free.
