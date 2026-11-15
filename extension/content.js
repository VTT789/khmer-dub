/* Khmer Dub — runs on youtube.com
 *
 * Adds a floating "Khmer Dub" panel, asks the local app for subtitles +
 * translations, and speaks the Khmer voice in sync with YouTube's own player.
 */
(() => {
  "use strict";
  if (window.__khmerDubLoaded) return;
  window.__khmerDubLoaded = true;

  const PORTS = [8765, 8766, 8767, 8768, 8769, 8770, 8771, 8772, 8773, 8774, 8775];
  const CHUNK = 20;          // segments per translation request
  const WINDOW = 60;         // seconds of video prepared per round (fast start)

  let base = null;
  const st = {
    video: null,
    segments: [],
    idx: -1,
    audio: new Audio(),
    playing: false,
    raf: 0,
    offset: 0,
    voice: "km-KH-SreymomNeural",
    voices: [],
    runId: 0,
    lastTime: -1,
    overlay: null,
    auto: true,
    startedForId: null,
    lastVideoId: null,
    dlTimer: 0,
    rangesInFlight: new Set(),
    origVolume: 18,
    subOnly: false,
    ttsInflight: 0,
    character: "woman",
    pitch: "+0Hz",
  };
  st.audio.preload = "auto";
  st.audio.loop = false;

  /* ------------------------------------------------------------- helpers */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const $ = (sel) => document.querySelector(sel);

  const CHARACTERS = {
    girl: { voice: "km-KH-SreymomNeural", pitch: "+30Hz" },
    woman: { voice: "km-KH-SreymomNeural", pitch: "+0Hz" },
    boy: { voice: "km-KH-PisethNeural", pitch: "+20Hz" },
    man: { voice: "km-KH-PisethNeural", pitch: "+0Hz" },
  };

  function applyCharacter() {
    const preset = CHARACTERS[st.character];
    if (!preset) return;
    st.pitch = preset.pitch;
    const select = document.getElementById("khmer-dub-voice");
    if (select && [...select.options].some((o) => o.value === preset.voice)) {
      select.value = preset.voice;
      st.voice = preset.voice;
      storageSet("khmerDubVoice", st.voice);
    }
  }

  function cleanForSpeech(text) {
    return String(text || "")
      .replace(/\[[^\]]*\]|\([^)]*\)|♪|♫/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isMusicOnly(text) {
    const spoken = cleanForSpeech(text);
    if (!spoken) return true;
    // digits count as speakable ("2018", "3", "50%"); only pure symbols are skipped
    return !/[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(spoken);
  }

  function desiredOriginalLevel() {
    if (st.subOnly) return 0;
    if (!st.playing) return 100;
    const seg = st.segments[st.idx];
    // Duck only under actual Khmer speech; gaps and music stay at full volume.
    if (seg && !seg.noSpeech) return st.origVolume;
    return 100;
  }

  function applyOriginalVolume() {
    if (!st.video) return;
    const level = desiredOriginalLevel();
    const vol = clamp(level / 100, 0, 1);
    if (Math.abs((st.video.volume ?? 1) - vol) > 0.004) st.video.volume = vol;
    if (st.video.muted !== (level === 0)) st.video.muted = level === 0;
  }

  function setStatus(text) {
    const el = document.getElementById("khmer-dub-status");
    if (el) el.textContent = text;
  }

  async function storageGet(key) {
    try {
      const got = await chrome.storage.local.get(key);
      return got[key];
    } catch (_) {
      return null;
    }
  }

  async function storageSet(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (_) {}
  }

  async function healthy(root) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 900);
      const res = await fetch(root + "/api/health", { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return !!data && data.app === "khmer-dub";
    } catch (_) {
      return false;
    }
  }

  async function resolveBase() {
    if (base) return base;
    const saved = await storageGet("khmerDubBase");
    if (saved && (await healthy(saved))) {
      base = saved;
      return base;
    }
    for (const port of PORTS) {
      const url = `http://127.0.0.1:${port}`;
      if (await healthy(url)) {
        base = url;
        await storageSet("khmerDubBase", url);
        return base;
      }
    }
    throw new Error("Khmer Dub app is not running — start run.cmd first");
  }

  async function api(path, options) {
    const root = await resolveBase();
    const res = await fetch(root + path, options);
    if (!res.ok) {
      let message = res.statusText;
      try {
        const data = await res.json();
        message = data.error || message;
      } catch (_) {}
      throw new Error(message);
    }
    return res.json();
  }

  function currentVideoId() {
    try {
      const url = new URL(location.href);
      const v = url.searchParams.get("v");
      if (v) return v;
      const match = url.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ UI */
  function buildUI() {
    if (document.getElementById("khmer-dub-launch")) return;

    const launch = document.createElement("div");
    launch.id = "khmer-dub-launch";
    launch.innerHTML = `<button id="khmer-dub-btn" title="Interpret subtitles to Khmer voice">🇰🇭 Khmer Dub</button>`;
    document.body.appendChild(launch);

    const panel = document.createElement("div");
    panel.id = "khmer-dub-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <h3>Khmer Dub</h3>
      <div id="khmer-dub-status">Ready — press Interpret.</div>
      <label><input type="checkbox" id="khmer-dub-auto" checked> Auto interpret on video change</label>
      <label>Character</label>
      <select id="khmer-dub-character">
        <option value="girl">Young girl — Sreymom, higher pitch</option>
        <option value="woman" selected>Woman — Sreymom</option>
        <option value="boy">Young man — Piseth, higher pitch</option>
        <option value="man">Man — Piseth</option>
        <option value="custom">Custom voice…</option>
      </select>
      <label>Voice</label>
      <select id="khmer-dub-voice"></select>
      <label>Original audio during speech</label>
      <select id="khmer-dub-orig">
        <option value="0">Mute while speaking</option>
        <option value="18" selected>18% while speaking</option>
        <option value="50">50% while speaking</option>
        <option value="100">100% (no ducking)</option>
      </select>
      <label><input type="checkbox" id="khmer-dub-subonly"> Subtitles only (no voice)</label>
      <div class="row">
        <button class="action primary" id="khmer-dub-start">Interpret</button>
        <button class="action" id="khmer-dub-stop" disabled>Stop</button>
      </div>
      <label>Download</label>
      <select id="khmer-dub-dl-mode">
        <option value="video">Video + Khmer voice + subtitles (.mkv)</option>
        <option value="video_sub">Video + Khmer subtitles (.mkv)</option>
        <option value="audio">Khmer voice + subtitles (.m4a + .srt)</option>
        <option value="srt">Subtitles only (.srt)</option>
      </select>
      <div class="row"><button class="action" id="khmer-dub-download">Download</button></div>
      <div id="khmer-dub-dl-status" class="muted"></div>
      <div id="khmer-dub-dl-links"></div>
      <div class="muted">Needs the Khmer Dub app running (run.cmd). Subtitles must exist.</div>`;
    document.body.appendChild(panel);

    launch.querySelector("#khmer-dub-btn").addEventListener("click", togglePanel);
    panel.querySelector("#khmer-dub-start").addEventListener("click", () => startDub());
    panel.querySelector("#khmer-dub-stop").addEventListener("click", stopDub);
    panel.querySelector("#khmer-dub-download").addEventListener("click", () => {
      const mode = document.getElementById("khmer-dub-dl-mode").value;
      download(mode);
    });

    const autoBox = document.getElementById("khmer-dub-auto");
    st.auto = localStorage.getItem("khmerDubAuto") !== "0";
    autoBox.checked = st.auto;
    autoBox.addEventListener("change", () => {
      st.auto = autoBox.checked;
      localStorage.setItem("khmerDubAuto", st.auto ? "1" : "0");
      if (st.auto) maybeAutoStart();
    });

    const charSelect = document.getElementById("khmer-dub-character");
    st.character = localStorage.getItem("khmerDubCharacter") || "woman";
    if (!CHARACTERS[st.character] && st.character !== "custom") st.character = "woman";
    charSelect.value = st.character;
    charSelect.addEventListener("change", () => {
      st.character = charSelect.value;
      localStorage.setItem("khmerDubCharacter", st.character);
      if (st.character !== "custom") applyCharacter();
      else st.pitch = "+0Hz";
      for (const seg of st.segments) seg.audio = null;
      st.idx = -1;
      pumpPrefetch();
    });

    const origSelect = document.getElementById("khmer-dub-orig");
    st.origVolume = Number(localStorage.getItem("khmerDubOrig") || 18);
    origSelect.value = String(st.origVolume);
    origSelect.addEventListener("change", () => {
      st.origVolume = Number(origSelect.value);
      localStorage.setItem("khmerDubOrig", String(st.origVolume));
      applyOriginalVolume();
    });

    const subOnlyBox = document.getElementById("khmer-dub-subonly");
    st.subOnly = localStorage.getItem("khmerDubSubOnly") === "1";
    subOnlyBox.checked = st.subOnly;
    subOnlyBox.addEventListener("change", () => {
      st.subOnly = subOnlyBox.checked;
      localStorage.setItem("khmerDubSubOnly", st.subOnly ? "1" : "0");
      applyOriginalVolume();
      if (st.subOnly) {
        st.audio.pause();
        setStatus("Subtitles only — no voice.");
      }
    });

    loadVoices().catch(() => {});
  }

  function togglePanel() {
    const panel = document.getElementById("khmer-dub-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  }

  async function loadVoices() {
    const data = await api("/api/voices?prefix=km");
    st.voices = data.voices || [];
    const select = document.getElementById("khmer-dub-voice");
    if (!select) return;
    select.innerHTML = st.voices
      .map(
        (v) =>
          `<option value="${v.shortName}">${v.gender === "Female" ? "♀" : "♂"} ${v.shortName}</option>`
      )
      .join("");
    const saved = await storageGet("khmerDubVoice");
    if (saved && st.voices.some((v) => v.shortName === saved)) select.value = saved;
    st.voice = select.value || st.voice;
    if (st.character !== "custom") applyCharacter();
    select.addEventListener("change", () => {
      st.voice = select.value;
      st.character = "custom";
      st.pitch = "+0Hz";
      const charBox = document.getElementById("khmer-dub-character");
      if (charBox) charBox.value = "custom";
      localStorage.setItem("khmerDubCharacter", "custom");
      storageSet("khmerDubVoice", st.voice);
      for (const seg of st.segments) seg.audio = null;
      st.idx = -1;
      pumpPrefetch();
    });
  }

  function installOverlayDrag(el) {
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      el.classList.add("dragging");
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = clamp(e.clientX - drag.dx, 4, window.innerWidth - el.offsetWidth - 4);
      const y = clamp(e.clientY - drag.dy, 4, window.innerHeight - el.offsetHeight - 4);
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.bottom = "auto";
      el.style.transform = "none";
    });
    el.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      el.classList.remove("dragging");
      localStorage.setItem("khmerDubSubsPos", JSON.stringify({ x: el.style.left, y: el.style.top }));
    });
    el.addEventListener("dblclick", () => {
      el.style.left = "50%";
      el.style.top = "";
      el.style.bottom = "110px";
      el.style.transform = "translateX(-50%)";
      localStorage.removeItem("khmerDubSubsPos");
    });
    try {
      const saved = JSON.parse(localStorage.getItem("khmerDubSubsPos") || "null");
      if (saved && saved.x && saved.y) {
        el.style.left = saved.x;
        el.style.top = saved.y;
        el.style.bottom = "auto";
        el.style.transform = "none";
      }
    } catch (_) {}
  }

  function ensureOverlay() {
    if (st.overlay) return st.overlay;
    const el = document.createElement("div");
    el.id = "khmer-dub-subs";
    el.style.display = "none";
    el.innerHTML = '<div class="kd-line"></div><div class="kd-orig"></div>';
    document.body.appendChild(el);
    st.overlay = el;
    installOverlayDrag(el);
    return el;
  }

  function showSubs(idx) {
    const el = ensureOverlay();
    if (idx < 0) {
      el.style.display = "none";
      return;
    }
    const seg = st.segments[idx];
    el.style.display = "flex";
    el.querySelector(".kd-line").textContent = seg.text || seg.orig || "";
    el.querySelector(".kd-orig").textContent = seg.orig || "";
  }

  /* -------------------------------------------------------------- player */
  function findBestVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;
    const viewport = window.innerHeight || 1;
    let best = null;
    let bestScore = -1;
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      const visible = Math.max(0, Math.min(rect.bottom, viewport) - Math.max(rect.top, 0));
      const score = Math.max(0, rect.width) * visible + (video.paused ? 0 : 1e7) + (video.readyState >= 2 ? 1e6 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  function bindVideo() {
    const video = findBestVideo();
    if (!video) return false;
    st.video = video;
    return true;
  }

  /* ------------------------------------------------------------ dubbing */
  async function ensureTranscript(videoId, runId) {
    // Use an existing AI transcript if the app already made one.
    try {
      return await api(`/api/segments?v=${encodeURIComponent(videoId)}&lang=auto`);
    } catch (err) {
      if (!/no captions|caption|429|rate.?limit/i.test(err.message || "")) throw err;
    }

    setStatus("No captions — transcribing audio with AI (first run can take a while)…");
    const job = await api("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, model: "base" }),
    });

    let lastPct = -1;
    const started = Date.now();
    while (Date.now() - started < 60 * 60 * 1000) {
      await sleep(1500);
      if (runId !== st.runId) return null;
      let snap;
      try {
        snap = await api(`/api/transcribe/status?job=${encodeURIComponent(job.job)}`);
      } catch (_) {
        continue;
      }
      if (runId !== st.runId) return null;
      if (snap.state === "done") {
        return await api(`/api/segments?v=${encodeURIComponent(videoId)}&lang=auto`);
      }
      if (snap.state === "error") throw new Error(snap.error || "transcription failed");
      if (snap.progress !== lastPct) {
        lastPct = snap.progress;
        setStatus(`Transcribing audio… ${snap.progress}% — ${snap.message}`);
      }
    }
    throw new Error("transcription timed out");
  }

  async function startDub(fromAuto = false) {
    const startBtn = document.getElementById("khmer-dub-start");
    const stopBtn = document.getElementById("khmer-dub-stop");
    try {
      if (!bindVideo()) throw new Error("No video found on this page — open a video first");
      const videoId = currentVideoId();
      if (!videoId) throw new Error("Open a specific YouTube video first");
      st.startedForId = videoId;

      const runId = ++st.runId;
      if (st.character !== "custom") applyCharacter();
      const voiceSelect = document.getElementById("khmer-dub-voice");
      if (voiceSelect && voiceSelect.value) st.voice = voiceSelect.value;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      setStatus("Fetching subtitles…");

      let data = null;
      try {
        data = await api(`/api/segments?v=${encodeURIComponent(videoId)}&lang=auto`);
      } catch (err) {
        const message = String(err.message || "");
        const captionIssue = /no captions|caption|429|rate.?limit/i.test(message);
        if (!captionIssue) throw err;
        if (fromAuto) {
          setStatus("Captions unavailable — press Interpret in the panel to transcribe with AI.");
          startBtn.disabled = false;
          stopBtn.disabled = true;
          return;
        }
        data = await ensureTranscript(videoId, runId);
      }
      if (!data || runId !== st.runId) return;

      st.segments = (data.segments || []).map((seg) => ({ ...seg, text: "", audio: null }));
      st.idx = -1;
      st.playing = false;
      st.audio.pause();

      setStatus("Translating first minute…");
      await translateRange(0, WINDOW, runId);
      if (runId !== st.runId) return;

      setStatus("Generating Khmer voice…");
      verifyWindow(0, WINDOW);
      await waitForAudio(2, 15000);
      if (runId !== st.runId) return;

      st.playing = true;
      st.lastTime = -1;
      applyOriginalVolume();
      document.getElementById("khmer-dub-btn").classList.add("active");
      stopBtn.disabled = false;
      startLoop();
      setStatus(
        st.subOnly
          ? "Subtitles only — press play ▶ (rest prepares in background)"
          : "Ready — first minute. Press play ▶ (rest prepares in background)"
      );
      setTimeout(() => {
        if (runId === st.runId && st.playing) prepareRest(runId);
      }, 2500);
    } catch (err) {
      const message = /no captions/i.test(err.message || "")
        ? "No captions. Open the Khmer Dub app and press “Transcribe with AI” first."
        : "Error: " + err.message;
      setStatus(message);
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function segmentsInRange(start, end) {
    return st.segments.filter((seg) => !seg.text && seg.start >= start && seg.start < end);
  }

  async function translateList(list, runId) {
    for (let i = 0; i < list.length; i += CHUNK) {
      if (runId !== st.runId) return false;
      const batch = list.slice(i, i + CHUNK);
      try {
        const res = await api("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: batch.map((seg) => seg.orig), target: "km" }),
        });
        res.texts.forEach((text, k) => {
          batch[k].text = (text || "").trim() || batch[k].orig;
        });
      } catch (_) {
        batch.forEach((seg) => {
          seg.text = seg.orig;
        });
      }
      pumpPrefetch();
    }
    return true;
  }

  async function translateRange(start, end, runId) {
    const list = segmentsInRange(start, end);
    if (!list.length) return true;
    return translateList(list, runId);
  }

  async function waitForAudio(needed, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ready = st.segments.slice(0, 10).filter((seg) => seg.audio).length;
      if (ready >= needed) return true;
      await sleep(250);
    }
    return false;
  }

  function ensureAhead(start) {
    const key = Math.floor(start / WINDOW);
    if (st.rangesInFlight.has(key)) return;
    st.rangesInFlight.add(key);
    translateRange(start, start + WINDOW, st.runId).finally(() => st.rangesInFlight.delete(key));
  }

  async function prepareRest(runId) {
    const totalEnd = st.segments.length ? st.segments[st.segments.length - 1].end : 0;
    for (let start = WINDOW; start < totalEnd; start += WINDOW) {
      if (runId !== st.runId) return;
      const end = Math.min(start + WINDOW, totalEnd);
      setStatus(`Preparing ${fmtClock(start)}–${fmtClock(end)} in background…`);
      await translateRange(start, end, runId);
      if (runId !== st.runId) return;
      verifyWindow(start, end);
      pumpPrefetch();
    }
    if (runId === st.runId) setStatus(`Ready — full video (${st.segments.length} segments) ▶`);
  }

  function prefetch(i, retry = false) {
    const seg = st.segments[i];
    if (!seg || seg.audio || seg.pending || !seg.text) return;
    if (st.subOnly || seg.noSpeech) return;
    if (!retry && (seg.attempts || 0) >= 4 && seg.error) return;
    if ((st.ttsInflight || 0) >= 4) return;

    const spoken = cleanForSpeech(seg.text);
    if (!spoken || isMusicOnly(seg.text)) {
      seg.noSpeech = true;
      if (st.segments[st.idx] === seg) applyOriginalVolume();
      return;
    }

    seg.pending = true;
    seg.attempts = (seg.attempts || 0) + 1;
    seg.lastTry = Date.now();
    st.ttsInflight = (st.ttsInflight || 0) + 1;
    const target = clamp(seg.end - seg.start, 0.4, 30);
    api("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken, voice: st.voice, target, pitch: st.pitch }),
    })
      .then(async (audio) => {
        const root = await resolveBase();
        seg.audio = { ...audio, url: root + audio.url };
        seg.error = null;
        // The clip may arrive while its cue is already playing: start it now.
        if (st.playing && st.idx === i && st.video) {
          switchTo(i, st.video.currentTime - st.offset);
        }
      })
      .catch((err) => {
        seg.error = String(err);
        const attempts = seg.attempts || 0;
        if (attempts < 4) {
          setTimeout(() => {
            if (!seg.audio && !st.subOnly && !seg.noSpeech) prefetch(i, true);
          }, 1200 * attempts);
        } else if (st.idx === i) {
          setStatus("Voice unavailable for this line — subtitles only.");
        }
      })
      .finally(() => {
        seg.pending = false;
        st.ttsInflight = Math.max(0, (st.ttsInflight || 1) - 1);
      });
  }

  // Force a line to get voice, even if earlier attempts failed (with a cooldown).
  function forceEnsure(i) {
    const seg = st.segments[i];
    if (!seg || seg.audio || seg.noSpeech || seg.pending || !seg.text) return;
    if (st.subOnly) return;
    if ((seg.attempts || 0) >= 4) {
      if (Date.now() - (seg.lastTry || 0) < 30000) return;
      seg.attempts = 0;
      seg.error = null;
    }
    prefetch(i, true);
  }

  // Every 1-minute window must have voice for all speech segments.
  function verifyWindow(start, end) {
    for (let i = 0; i < st.segments.length; i++) {
      const seg = st.segments[i];
      if (seg.start < start || seg.start >= end) continue;
      forceEnsure(i);
    }
  }

  function ensureVoicesAhead() {
    if (st.subOnly || !st.segments.length) return;
    const from = st.idx >= 0 ? st.idx : 0;
    for (let i = from; i < Math.min(from + 20, st.segments.length); i++) {
      forceEnsure(i);
    }
  }

  function pumpPrefetch() {
    if (!st.segments.length) return;
    const from = st.idx >= 0 ? st.idx : 0;
    for (let i = from; i < Math.min(from + 4, st.segments.length); i++) {
      if (st.segments[i] && st.segments[i].noSpeech) continue;
      prefetch(i);
    }
  }

  function findSegment(t) {
    const segs = st.segments;
    let lo = 0;
    let hi = segs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 && t <= segs[best].end + 0.12 ? best : -1;
  }

  function fitRate(seg) {
    if (!seg.audio || !seg.audio.duration) return 1;
    // Server already stretched each clip to the cue; only a small correction here.
    return clamp(seg.audio.duration / Math.max(0.35, seg.end - seg.start), 0.95, 1.15);
  }

  function switchTo(idx, t) {
    st.idx = idx;
    showSubs(idx);
    if (idx < 0 || !st.playing) {
      st.audio.pause();
      if (idx < 0) applyOriginalVolume(); // music-only gap: back to base level
      return;
    }
    const seg = st.segments[idx];
    if (!seg.text) ensureAhead(seg.start);
    applyOriginalVolume();
    if (st.subOnly || seg.noSpeech) {
      st.audio.pause();
      pumpPrefetch();
      return;
    }
    if (!seg.audio) {
      // Current line has no voice yet: always force a fresh attempt.
      seg.attempts = 0;
      seg.error = null;
      seg.lastTry = 0;
      if (!seg.pending) prefetch(idx, true);
      st.audio.pause();
      pumpPrefetch();
      return;
    }
    const rate = fitRate(seg);
    const newSeg = st.audio.dataset.seg !== String(idx);
    if (newSeg) {
      st.audio.src = seg.audio.url;
      st.audio.dataset.seg = String(idx);
    }
    st.audio.playbackRate = rate;
    const expected = clamp(
      (t - seg.start) * rate,
      0,
      Math.max(0, seg.audio.duration - 0.05)
    );
    if (newSeg || Math.abs(st.audio.currentTime - expected) > 0.6) {
      try { st.audio.currentTime = expected; } catch (_) {}
    }
    if (!newSeg && st.audio.ended) return; // never loop a finished clip
    st.audio.play().catch(() => {});
    pumpPrefetch();
  }

  function resync(t) {
    const seg = st.segments[st.idx];
    if (!seg || !seg.audio || seg.noSpeech || st.subOnly) return;
    if (st.audio.ended || st.audio.currentTime >= seg.audio.duration - 0.02) {
      st.audio.pause();
      return;
    }
    const rate = st.audio.playbackRate || 1;
    const expected = clamp((t - seg.start) * rate, 0, seg.audio.duration);
    if (Math.abs(st.audio.currentTime - expected) > 0.35) {
      try {
        st.audio.currentTime = expected;
      } catch (_) {}
    }
    if (st.audio.paused) st.audio.play().catch(() => {});
  }

  function startLoop() {
    if (st.raf) return;
    st.raf = requestAnimationFrame(tick);
  }

  function tick() {
    st.raf = requestAnimationFrame(tick);
    if (!st.playing) return;
    const video = st.video;
    if (!video || video.paused || video.ended) {
      st.audio.pause();
      return;
    }
    const t = video.currentTime - st.offset;
    if (st.lastTime >= 0 && Math.abs(t - st.lastTime) > 1.0) {
      st.audio.pause();
      st.idx = -1;
    }
    st.lastTime = t;
    const idx = findSegment(t);
    if (idx !== st.idx) switchTo(idx, t);
    else if (idx >= 0) resync(t);

    // Re-check every frame: a segment can become "no speech" after it started
    // (music detection happens during voice prefetch), so keep audio/levels right.
    const seg = st.segments[st.idx];
    if (seg && (seg.noSpeech || st.subOnly) && !st.audio.paused) st.audio.pause();
    applyOriginalVolume();
  }

  function stopDub() {
    st.playing = false;
    st.runId++;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0;
    st.audio.pause();
    try {
      st.audio.removeAttribute("src");
    } catch (_) {}
    st.idx = -1;
    st.lastTime = -1;
    showSubs(-1);
    const startBtn = document.getElementById("khmer-dub-start");
    const stopBtn = document.getElementById("khmer-dub-stop");
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    const launch = document.getElementById("khmer-dub-btn");
    if (launch) launch.classList.remove("active");
    if (st.video) {
      st.video.volume = 1;
      st.video.muted = false;
    }
    setStatus("Stopped.");
  }

  /* ------------------------------------------------------------- downloads */
  function srtTime(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const p = (n, w = 2) => String(Math.floor(n)).padStart(w, "0");
    return `${p(ms / 3600000)}:${p((ms % 3600000) / 60000)}:${p((ms % 60000) / 1000)},${p(ms % 1000, 3)}`;
  }

  function buildSrt(segments) {
    return segments
      .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${(seg.text || seg.orig || "").trim()}\n`)
      .join("\n");
  }

  function setDlStatus(text) {
    const el = document.getElementById("khmer-dub-dl-status");
    if (el) el.textContent = text;
  }

  function renderDlLinks(files) {
    const box = document.getElementById("khmer-dub-dl-links");
    if (!box) return;
    box.innerHTML = "";
    for (const file of files) {
      const a = document.createElement("a");
      a.href = base + file.url;
      a.download = file.name;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "⬇ " + file.name;
      box.appendChild(a);
    }
  }

  async function download(mode) {
    const videoId = currentVideoId();
    if (!videoId) {
      setDlStatus("Open a video first.");
      return;
    }
    if (mode === "srt") {
      if (!st.segments.length || !st.segments.some((seg) => seg.text)) {
        setDlStatus("Interpret the video first, then download subtitles.");
        return;
      }
      const blob = new Blob([buildSrt(st.segments)], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `khmer-${videoId}.srt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setDlStatus("Subtitles saved.");
      return;
    }

    setDlStatus("Starting export…");
    try {
      const job = await api("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, mode, voice: st.voice, target: "km" }),
      });
      pollExport(job.job);
    } catch (err) {
      setDlStatus("Export failed: " + err.message);
    }
  }

  function pollExport(jobId) {
    if (st.dlTimer) clearInterval(st.dlTimer);

    const tick = async () => {
      try {
        const snap = await api(`/api/export/status?job=${encodeURIComponent(jobId)}`);
        setDlStatus(`${snap.progress}% — ${snap.message}`);
        if (snap.state === "done") {
          clearInterval(st.dlTimer);
          st.dlTimer = 0;
          setDlStatus("Done — click a file:");
          renderDlLinks(snap.files || []);
        } else if (snap.state === "error") {
          clearInterval(st.dlTimer);
          st.dlTimer = 0;
          setDlStatus("Export failed: " + (snap.error || "unknown error"));
        }
      } catch (err) {
        clearInterval(st.dlTimer);
        st.dlTimer = 0;
        setDlStatus("Status check failed: " + err.message);
      }
    };

    st.dlTimer = setInterval(tick, 1200);
    tick();
  }

  /* ----------------------------------------------------------- auto start */
  function maybeAutoStart() {
    if (!st.auto || st.playing) return;
    const videoId = currentVideoId();
    if (!videoId || videoId === st.startedForId) return;
    if (!findBestVideo()) return;
    st.startedForId = videoId;
    setTimeout(() => {
      if (st.auto && !st.playing && currentVideoId() === videoId) startDub(true);
    }, 1500);
  }

  /* ----------------------------------------------------------------- init */
  function onNavigate() {
    buildUI();
    if (st.playing) stopDub();
    st.lastTime = -1;
    const videoId = currentVideoId();
    if (videoId !== st.lastVideoId) {
      st.startedForId = null;
      st.lastVideoId = videoId;
    }
    maybeAutoStart();
  }

  buildUI();
  window.__khmerDubInternals = { isMusicOnly, cleanForSpeech };
  st.lastHref = location.href;
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  window.addEventListener("popstate", onNavigate);
  setInterval(() => {
    if (!document.getElementById("khmer-dub-launch")) buildUI();
    if (location.href !== st.lastHref) {
      st.lastHref = location.href;
      onNavigate();
      return;
    }
    if (!st.playing) maybeAutoStart();
  }, 2000);
  setInterval(ensureVoicesAhead, 4000);
  setInterval(() => {
    // Wider sweep: keep the next ~30 lines voiced even if earlier attempts failed.
    if (st.subOnly || !st.segments.length) return;
    const from = st.idx >= 0 ? st.idx : 0;
    for (let i = from; i < Math.min(from + 30, st.segments.length); i++) forceEnsure(i);
  }, 15000);
  maybeAutoStart();
})();
