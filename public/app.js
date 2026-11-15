/* Khmer Dub — YouTube subtitle interpreter + Edge TTS dubbing
 * Voice audio is fetched per segment and played at a playbackRate that makes
 * it exactly as long as the subtitle cue, so speech follows the picture.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    searchForm: $("searchForm"),
    searchInput: $("searchInput"),
    pasteBtn: $("pasteBtn"),
    playerWrap: document.querySelector(".player-wrap"),
    placeholder: $("placeholder"),
    subs: $("subs"),
    subsTranslated: $("subsTranslated"),
    subsOriginal: $("subsOriginal"),
    rateBadge: $("rateBadge"),
    notice: $("notice"),
    noticeText: $("noticeText"),
    noticeAction: $("noticeAction"),
    videoTitle: $("videoTitle"),
    videoSub: $("videoSub"),
    dubBadge: $("dubBadge"),
    ytLink: $("ytLink"),
    dubToggle: $("dubToggle"),
    fitToggle: $("fitToggle"),
    origVol: $("origVol"),
    showOriginal: $("showOriginal"),
    offsetRange: $("offsetRange"),
    offsetVal: $("offsetVal"),
    volRange: $("volRange"),
    prepareBtn: $("prepareBtn"),
    exportBtn: $("exportBtn"),
    statusText: $("statusText"),
    statusDetail: $("statusDetail"),
    targetLang: $("targetLang"),
    voiceSelect: $("voiceSelect"),
    sourceTrack: $("sourceTrack"),
    character: $("character"),
    autoInterpret: $("autoInterpret"),
    listTitle: $("listTitle"),
    list: $("list"),
    chips: $("chips"),
    promptModal: $("promptModal"),
    promptThumb: $("promptThumb"),
    promptTitle: $("promptTitle"),
    promptAuthor: $("promptAuthor"),
    promptVoice: $("promptVoice"),
    promptWatch: $("promptWatch"),
    promptDub: $("promptDub"),
    promptClose: $("promptClose"),
    downloadModal: $("downloadModal"),
    dlClose: $("dlClose"),
    dlCloseBtn: $("dlCloseBtn"),
    dlStart: $("dlStart"),
    dlBilingual: $("dlBilingual"),
    dlProgress: $("dlProgress"),
    dlBar: $("dlBar"),
    dlMsg: $("dlMsg"),
    dlLinks: $("dlLinks"),
  };

  const state = {
    ytReady: false,
    pendingId: null,
    player: null,
    video: null,
    tracks: [],
    segments: [],
    ready: false,
    preparing: false,
    runId: 0,
    currentIdx: -1,
    audioIdx: -1,
    inflight: 0,
    prefetchTimer: 0,
    rafId: 0,
    lastTime: 0,
    offset: 0,
    fit: true,
    dub: true,
    origVol: 18,
    lastOrigLevel: null,
    character: "woman",
    pitch: "+0Hz",
    audio: new Audio(),
    rowEls: [],
    pendingCard: null,
    exportJob: null,
    exportTimer: 0,
    asrTimer: 0,
    auto: true,
    subsApplied: false,
  };

  const SUBS_POS_KEY = "khmdub.subsPos";

  const CHARACTERS = {
    girl: { voice: "km-KH-SreymomNeural", pitch: "+30Hz" },
    woman: { voice: "km-KH-SreymomNeural", pitch: "+0Hz" },
    boy: { voice: "km-KH-PisethNeural", pitch: "+20Hz" },
    man: { voice: "km-KH-PisethNeural", pitch: "+0Hz" },
  };

  function applyCharacter() {
    const preset = CHARACTERS[state.character];
    if (!preset) return;
    state.pitch = preset.pitch;
    if ([...el.voiceSelect.options].some((o) => o.value === preset.voice)) {
      el.voiceSelect.value = preset.voice;
      localStorage.setItem("khmdub.voice", preset.voice);
    }
  }

  function enforceCharacterVoice() {
    if (state.character === "custom") return;
    applyCharacter();
  }

  /* ------------------------------------------------------------ helpers */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, "0");

  function cleanForSpeech(text) {
    return String(text || "")
      .replace(/\[[^\]]*\]|\([^)]*\)|♪|♫/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isMusicOnly(text) {
    const spoken = cleanForSpeech(text);
    if (!spoken) return true;
    return !/[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(spoken);
  }

  const fmtClock = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  };

  const srtTime = (s) => {
    s = Math.max(0, s || 0);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)},${pad(ms, 3)}`;
  };

  const escapeHtml = (str) =>
    String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function setStatus(text, detail = "", kind = "") {
    el.statusText.textContent = text || "";
    el.statusText.style.color = kind === "err" ? "var(--danger)" : kind === "ok" ? "var(--accent-2)" : "";
    el.statusDetail.textContent = detail || "";
  }

  function setBadge(text, kind = "") {
    el.dubBadge.textContent = text;
    el.dubBadge.className = "badge" + (kind ? " " + kind : "");
  }

  function showNotice(message) {
    if (!message) return hideNotice();
    el.noticeText.textContent = message;
    el.notice.classList.remove("hidden");
  }

  function setNoticeAction(label, handler) {
    if (!label) {
      el.noticeAction.classList.add("hidden");
      el.noticeAction.onclick = null;
      return;
    }
    el.noticeAction.textContent = label;
    el.noticeAction.onclick = handler;
    el.noticeAction.classList.remove("hidden");
  }

  function hideNotice() {
    el.notice.classList.add("hidden");
    setNoticeAction(null, null);
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    return r.json();
  }

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    return r.json();
  }

  /* ------------------------------------------------------- YouTube player */
  window.onYouTubeIframeAPIReady = function () {
    state.ytReady = true;
    if (state.pendingId) {
      const id = state.pendingId;
      state.pendingId = null;
      ensurePlayer(id);
    }
  };

  function ensurePlayer(videoId) {
    el.placeholder.classList.add("hidden");
    if (!state.ytReady || !window.YT || !window.YT.Player) {
      state.pendingId = videoId;
      setTimeout(() => {
        if (!state.ytReady && state.pendingId) {
          setStatus(
            "YouTube player script did not load. Subtitles and voice still work; use “open on YouTube”.",
            "",
            "err"
          );
        }
      }, 9000);
      return;
    }
    if (state.player) {
      state.player.loadVideoById(videoId);
      return;
    }
    state.player = new YT.Player("player", {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        origin: window.location.origin,
        rel: 0,
        playsinline: 1,
        modestbranding: 1,
        enablejsapi: 1,
        iv_load_policy: 3,
        cc_load_policy: 0,
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerState,
        onError: onPlayerError,
      },
    });
  }

  function applyOriginalVolume() {
    if (!state.player || !state.player.setVolume) return;
    const base = clamp(Number(el.origVol.value) || 0, 0, 100);
    state.origVol = base;
    const seg = state.segments[state.currentIdx];
    // Duck only while Khmer speech plays; otherwise the original is full volume.
    const level = state.dub && seg && !seg.noSpeech ? base : 100;
    if (state.lastOrigLevel === level) return;
    state.lastOrigLevel = level;
    state.player.setVolume(level);
    if (level === 0) {
      if (state.player.mute) state.player.mute();
    } else if (state.player.unMute) {
      state.player.unMute();
    }
  }

  function onPlayerReady() {
    applyOriginalVolume();
  }

  function onPlayerState(ev) {
    const s = ev.data;
    if (s === 1) { // playing
      applyOriginalVolume();
      startLoop();
      hardResync(state.player.getCurrentTime() - state.offset);
    } else if (s === 2 || s === 0) { // paused / ended
      stopLoop();
      pauseAudio();
      if (s === 0) hideSubs();
    } else if (s === 3) { // buffering
      pauseAudio();
    }
  }

  function onPlayerError(ev) {
    const codes = {
      2: "Invalid video id",
      5: "HTML5 player error",
      100: "Video not found or private",
      101: "The owner disabled embedding",
      150: "The owner disabled embedding",
    };
    setStatus(`Player: ${codes[ev.data] || "error " + ev.data}`, "", "err");
    setBadge("embed blocked", "error");
    showNotice(`This video can't play inside the app (${codes[ev.data] || "error"}). Use “open on YouTube”, or pick another video.`);
    if (state.video) {
      el.ytLink.classList.remove("hidden");
      el.ytLink.href = `https://www.youtube.com/watch?v=${state.video.id}`;
    }
  }

  /* ---------------------------------------------------------------- loop */
  const findSegment = (t) => {
    const segs = state.segments;
    let lo = 0, hi = segs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= 0 && t <= segs[best].end + 0.12) return best;
    return -1;
  };

  function startLoop() {
    if (state.rafId) return;
    state.lastTime = -1;
    state.rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    updateRateBadge(null);
  }

  function tick() {
    state.rafId = requestAnimationFrame(tick);
    const p = state.player;
    if (!p || !p.getCurrentTime) return;
    if (p.getPlayerState() !== 1) return;
    const t = p.getCurrentTime() - state.offset;
    if (state.lastTime >= 0 && Math.abs(t - state.lastTime) > 1.0) {
      hardResync(t);
    } else {
      syncAt(t);
    }
    state.lastTime = t;

    // Re-check each frame: music/no-speech can be discovered after a cue starts.
    const seg = state.segments[state.currentIdx];
    if (seg && (seg.noSpeech || !state.dub) && !state.audio.paused) pauseAudio();
    applyOriginalVolume();
  }

  function hardResync(t) {
    const idx = findSegment(t);
    if (idx !== state.currentIdx) switchTo(idx, t);
    else if (idx >= 0) resyncAudio(t);
    else pauseAudio();
  }

  function syncAt(t) {
    const idx = findSegment(t);
    if (idx !== state.currentIdx) { switchTo(idx, t); return; }
    if (idx < 0) return;
    resyncAudio(t);
  }

  /* --------------------------------------------------------------- audio */
  const fitRate = (seg) => {
    if (!state.fit || !seg.audio || !seg.audio.duration) return 1;
    const want = Math.max(0.35, seg.end - seg.start);
    // Server already stretched each clip to the cue; only a small correction here.
    return clamp(seg.audio.duration / want, 0.95, 1.15);
  };

  function switchTo(idx, t) {
    state.currentIdx = idx;
    showSubtitle(idx);
    if (idx < 0) {
      pauseAudio();
      updateRateBadge(null);
      pumpPrefetch();
      return;
    }
    const seg = state.segments[idx];
    if (!state.dub || seg.noSpeech) {
      pauseAudio();
      updateRateBadge(null);
      pumpPrefetch();
      return;
    }
    if (!seg.audio) {
      // User is looking at this line: force a fresh attempt if it failed before.
      if ((seg.attempts || 0) >= 6) {
        seg.attempts = 0;
        seg.nextTry = 0;
      }
      if (!seg.pending) fetchTTS(seg, idx);
      pauseAudio();
      updateRateBadge(null);
      pumpPrefetch();
      return;
    }
    const rate = fitRate(seg);
    const a = state.audio;
    const newSeg = state.audioIdx !== idx;
    if (newSeg) {
      a.src = seg.audio.url;
      state.audioIdx = idx;
    }
    a.playbackRate = rate;
    const expected = clamp((t - seg.start) * rate, 0, Math.max(0, seg.audio.duration - 0.05));
    if (newSeg || Math.abs(a.currentTime - expected) > 0.6) {
      try { a.currentTime = expected; } catch (_) {}
    }
    if (!newSeg && a.ended) return; // never loop a finished clip
    a.play().catch(() => {});
    updateRateBadge(rate);
    pumpPrefetch();
  }

  function resyncAudio(t) {
    const idx = state.currentIdx;
    if (idx < 0 || !state.dub) return;
    const seg = state.segments[idx];
    if (!seg || seg.noSpeech || !seg.audio || state.audioIdx !== idx) return;
    const a = state.audio;
    if (a.ended || a.currentTime >= seg.audio.duration - 0.02) {
      a.pause();
      return;
    }
    const rate = a.playbackRate || 1;
    const expected = clamp((t - seg.start) * rate, 0, seg.audio.duration);
    if (Math.abs(a.currentTime - expected) > 0.35) {
      try { a.currentTime = expected; } catch (_) {}
    }
    if (a.paused) a.play().catch(() => {});
  }

  function pauseAudio() {
    const a = state.audio;
    if (!a.paused) a.pause();
  }

  function updateRateBadge(rate) {
    if (rate == null || !state.dub || !state.fit) {
      el.rateBadge.classList.add("hidden");
      return;
    }
    el.rateBadge.textContent = `voice ${rate.toFixed(2)}×`;
    el.rateBadge.classList.remove("hidden");
  }

  /* --------------------------------------------------------- prefetching */
  function startPrefetchLoop() {
    if (state.prefetchTimer) return;
    state.prefetchTimer = setInterval(pumpPrefetch, 450);
    pumpPrefetch();
  }

  function stopPrefetchLoop() {
    if (state.prefetchTimer) clearInterval(state.prefetchTimer);
    state.prefetchTimer = 0;
  }

  function voiceReady() {
    const v = el.voiceSelect.value || "";
    return v.includes("-") && !v.startsWith("loading");
  }

  function pumpPrefetch() {
    if (!state.ready || !voiceReady()) return;
    const total = state.segments.length;
    if (!total) return;
    const base = state.currentIdx >= 0 ? state.currentIdx : 0;
    for (let i = base; i < Math.min(base + 4, total); i++) {
      if (state.inflight >= 3) break;
      const seg = state.segments[i];
      if (!seg || seg.audio || seg.pending || seg.noSpeech || !seg.text) continue;
      if (seg.nextTry && Date.now() < seg.nextTry) continue;
      if ((seg.attempts || 0) >= 6) {
        if (Date.now() - (seg.lastTry || 0) < 20000) continue;
        seg.attempts = 0;
        seg.nextTry = 0;
        seg.error = null;
      }
      fetchTTS(seg, i);
    }
  }

  function sweepVoices() {
    if (!state.ready || !voiceReady() || !state.dub) return;
    const from = state.currentIdx >= 0 ? state.currentIdx : 0;
    for (let i = from; i < Math.min(from + 24, state.segments.length); i++) {
      if (state.inflight >= 3) break;
      const seg = state.segments[i];
      if (!seg || seg.audio || seg.pending || seg.noSpeech || !seg.text) continue;
      if (seg.nextTry && Date.now() < seg.nextTry) continue;
      if ((seg.attempts || 0) >= 6) {
        if (Date.now() - (seg.lastTry || 0) < 20000) continue;
        seg.attempts = 0;
        seg.nextTry = 0;
        seg.error = null;
      }
      fetchTTS(seg, i);
    }
  }

  async function fetchTTS(seg, i) {
    if (isMusicOnly(seg.text)) {
      seg.noSpeech = true;
      if (state.currentIdx === i) applyOriginalVolume();
      return;
    }
    const spoken = cleanForSpeech(seg.text);
    if (!spoken) {
      seg.noSpeech = true;
      if (state.currentIdx === i) applyOriginalVolume();
      return;
    }
    seg.pending = true;
    seg.attempts = (seg.attempts || 0) + 1;
    seg.lastTry = Date.now();
    state.inflight++;
    const runId = state.runId;
    const voice = el.voiceSelect.value;
    const pitch = state.pitch;
    const text = seg.text;
    const target = clamp(seg.end - seg.start, 0.4, 30);
    try {
      const res = await postJSON("/api/tts", { text: spoken, voice, target, pitch });
      if (runId !== state.runId || seg.text !== text || el.voiceSelect.value !== voice) return;
      seg.audio = res;
      seg.error = null;
      seg.nextTry = 0;
      if (state.currentIdx === i) switchTo(i, currentTime());
      updateVoiceProgress();
    } catch (err) {
      seg.error = String(err);
      seg.nextTry = Date.now() + Math.min(15000, 1500 * (seg.attempts || 1));
    } finally {
      seg.pending = false;
      state.inflight = Math.max(0, state.inflight - 1);
      setTimeout(pumpPrefetch, 60);
    }
  }

  function updateVoiceProgress() {
    const total = state.segments.length;
    const ready = state.segments.filter((s) => s.audio).length;
    if (total) setStatus(el.statusText.textContent, `voice ${ready}/${total}`);
  }

  const currentTime = () => (state.player && state.player.getCurrentTime ? state.player.getCurrentTime() - state.offset : 0);

  /* -------------------------------------------------------------- visuals */
  function showSubtitle(idx) {
    if (idx < 0 || !state.segments[idx]) {
      hideSubs();
      return;
    }
    const seg = state.segments[idx];
    el.subsTranslated.textContent = seg.text || seg.orig || "";
    el.subsOriginal.textContent = seg.orig || "";
    el.subs.classList.remove("hidden");
    el.subsOriginal.classList.toggle("hidden", !el.showOriginal.checked);
    applySavedSubsPos();
    state.rowEls.forEach((row, i) => {
      if (row) row.classList.toggle("active", i === idx);
    });
  }

  /* ---------------------------------------------------------- subtitle drag */
  function applySavedSubsPos() {
    if (state.subsApplied) return;
    const raw = localStorage.getItem(SUBS_POS_KEY);
    if (!raw) {
      state.subsApplied = true;
      return;
    }
    try {
      const pos = JSON.parse(raw);
      const wrap = el.subs.parentElement;
      const wr = wrap.getBoundingClientRect();
      if (!wr.width || !wr.height || !el.subs.offsetWidth) return; // try again when visible
      const x = clamp(pos.x * wr.width - el.subs.offsetWidth / 2, 4, Math.max(4, wr.width - el.subs.offsetWidth - 4));
      const y = clamp(pos.y * wr.height - el.subs.offsetHeight / 2, 4, Math.max(4, wr.height - el.subs.offsetHeight - 4));
      el.subs.style.left = `${x}px`;
      el.subs.style.top = `${y}px`;
      el.subs.style.bottom = "auto";
      el.subs.style.transform = "none";
      state.subsApplied = true;
    } catch (_) {}
  }

  function resetSubsPosition() {
    localStorage.removeItem(SUBS_POS_KEY);
    state.subsApplied = true;
    el.subs.style.left = "";
    el.subs.style.top = "";
    el.subs.style.bottom = "";
    el.subs.style.transform = "";
  }

  function initSubsDrag() {
    const wrap = el.subs.parentElement;
    let drag = null;

    el.subs.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const r = el.subs.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      el.subs.classList.add("dragging");
      try { el.subs.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    el.subs.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const wr = wrap.getBoundingClientRect();
      const x = clamp(e.clientX - wr.left - drag.dx, 4, Math.max(4, wr.width - el.subs.offsetWidth - 4));
      const y = clamp(e.clientY - wr.top - drag.dy, 4, Math.max(4, wr.height - el.subs.offsetHeight - 4));
      el.subs.style.left = `${x}px`;
      el.subs.style.top = `${y}px`;
      el.subs.style.bottom = "auto";
      el.subs.style.transform = "none";
      state.subsApplied = true;
    });

    el.subs.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      el.subs.classList.remove("dragging");
      const wr = wrap.getBoundingClientRect();
      if (!wr.width || !wr.height) return;
      const pos = {
        x: (el.subs.offsetLeft + el.subs.offsetWidth / 2) / wr.width,
        y: (el.subs.offsetTop + el.subs.offsetHeight / 2) / wr.height,
      };
      localStorage.setItem(SUBS_POS_KEY, JSON.stringify(pos));
    });

    el.subs.addEventListener("dblclick", resetSubsPosition);
  }

  function hideSubs() {
    el.subs.classList.add("hidden");
    state.rowEls.forEach((row) => row && row.classList.remove("active"));
  }

  /* ---------------------------------------------------------------- lists */
  function renderResults(results) {
    state.rowEls = [];
    el.list.innerHTML = "";
    if (!results.length) {
      el.list.innerHTML = '<div class="empty">No results.</div>';
      return;
    }
    for (const r of results) {
      const div = document.createElement("div");
      div.className = "result";
      div.innerHTML = `
        <img src="${escapeHtml(r.thumb || "")}" alt="" loading="lazy">
        <div>
          <div class="r-title">${escapeHtml(r.title)}</div>
          <div class="r-sub">${escapeHtml(r.author || "")}${r.duration ? " · " + fmtClock(r.duration) : ""}</div>
        </div>`;
      div.addEventListener("click", () => (state.auto ? loadVideo(r.videoId, true) : openPrompt(r)));
      el.list.appendChild(div);
    }
  }

  /* --------------------------------------------------------- interpret ask */
  function openPrompt(card) {
    state.pendingCard = card;
    el.promptThumb.src = card.thumb || "";
    el.promptThumb.alt = "";
    el.promptTitle.textContent = card.title || "(untitled)";
    el.promptAuthor.textContent =
      `${card.author || ""}${card.duration ? " · " + fmtClock(card.duration) : ""}`;
    el.promptVoice.innerHTML = el.voiceSelect.innerHTML;
    if (el.voiceSelect.value) el.promptVoice.value = el.voiceSelect.value;
    el.promptModal.classList.remove("hidden");
  }

  function closePrompt() {
    el.promptModal.classList.add("hidden");
    state.pendingCard = null;
  }

  async function loadTrending() {
    el.listTitle.textContent = "Trending on YouTube";
    setStatus("Loading trending videos…");
    try {
      const data = await getJSON("/api/trending?limit=12");
      const results = data.results || [];
      renderResults(results);
      setStatus(results.length ? `Trending — ${results.length} videos. Click one to interpret.` : "Could not load trending.");
    } catch (err) {
      setStatus("Trending failed: " + err.message, "", "err");
    }
  }

  function renderTranscript() {
    state.rowEls = [];
    el.list.innerHTML = "";
    state.segments.forEach((seg, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `
        <div class="r-time">${fmtClock(seg.start)} – ${fmtClock(seg.end)}</div>
        <div class="r-khmer">…</div>
        <div class="r-orig">${escapeHtml(seg.orig)}</div>`;
      row.addEventListener("click", () => seekTo(seg.start + 0.05));
      state.rowEls[i] = row;
      el.list.appendChild(row);
    });
    el.listTitle.textContent = "Subtitles";
  }

  function updateTranscriptRows(from, to) {
    for (let i = from; i < to; i++) {
      const row = state.rowEls[i];
      const seg = state.segments[i];
      if (!row || !seg) continue;
      const khmer = row.querySelector(".r-khmer");
      if (khmer) khmer.textContent = seg.text || "…";
    }
  }

  function seekTo(t) {
    if (!state.player || !state.player.seekTo) return;
    pauseAudio();
    state.currentIdx = -1;
    state.audioIdx = -1;
    state.player.seekTo(Math.max(0, t), true);
    setTimeout(() => {
      if (state.player && state.player.getPlayerState && state.player.getPlayerState() === 1) startLoop();
    }, 350);
  }

  /* -------------------------------------------------------------- loading */
  function resetForVideo() {
    state.segments = [];
    state.ready = false;
    state.currentIdx = -1;
    state.audioIdx = -1;
    state.inflight = 0;
    state.rowEls = [];
    state.lastOrigLevel = null;
    if (state.asrTimer) {
      clearInterval(state.asrTimer);
      state.asrTimer = 0;
    }
    stopPrefetchLoop();
    pauseAudio();
    try { state.audio.removeAttribute("src"); } catch (_) {}
    hideSubs();
    el.exportBtn.disabled = true;
    el.prepareBtn.disabled = true;
    el.listTitle.textContent = "Subtitles";
    el.list.innerHTML = '<div class="empty">Waiting for subtitles…</div>';
    updateRateBadge(null);
  }

  function looksLikeVideo(value) {
    const v = (value || "").trim();
    return /(?:youtube\.com|youtu\.be)/i.test(v) || /^[A-Za-z0-9_-]{11}$/.test(v);
  }

  function extractVideoId(value) {
    const v = String(value || "").trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    try {
      const url = new URL(v);
      if (url.hostname.endsWith("youtu.be")) {
        const id = url.pathname.split("/").filter(Boolean)[0] || "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      const param = url.searchParams.get("v");
      if (param && /^[A-Za-z0-9_-]{11}$/.test(param)) return param;
      const m = url.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    } catch (_) {}
    return null;
  }

  async function loadVideo(rawValue, interpret = true) {
    const videoId = extractVideoId(rawValue) || String(rawValue || "").trim();
    state.runId++;
    resetForVideo();
    hideNotice();
    ensurePlayer(videoId);
    setBadge("loading…", "work");
    setStatus("Loading video…");
    history.replaceState(null, "", `?v=${encodeURIComponent(videoId)}`);

    try {
      const info = await getJSON(`/api/info?v=${encodeURIComponent(videoId)}`);
      const v = info.video;
      state.video = v;
      state.tracks = info.tracks || [];
      el.videoTitle.textContent = v.title;
      el.videoSub.textContent = `${v.author || ""}${v.duration ? " · " + fmtClock(v.duration) : ""}`;
      el.ytLink.href = `https://www.youtube.com/watch?v=${v.id}`;
      el.ytLink.classList.remove("hidden");
      renderTrackOptions();

      if (!state.tracks.length) {
        setStatus("No captions — you can transcribe the audio with AI.", "", "err");
        setBadge("no captions", "error");
        showNotice(
          "This video has no captions. AI can listen to the audio and write subtitles (a few minutes, first run downloads a model), or pick another video."
        );
        setNoticeAction("Transcribe with AI", () => startTranscription(videoId));
        return;
      }
      setBadge("ready", "ok");
      el.prepareBtn.disabled = false;
      el.exportBtn.disabled = false;
      if (interpret) {
        state.runId++;
        prepare();
      } else {
        setStatus("Loaded — press play, or use “Translate & dub” to add Khmer voice.", "");
      }
    } catch (err) {
      setStatus("Could not load video: " + err.message, "", "err");
      setBadge("error", "error");
      showNotice("Could not load this video: " + err.message);
    }
  }

  function renderTrackOptions() {
    el.sourceTrack.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "Auto — English preferred";
    el.sourceTrack.appendChild(auto);
    for (const t of state.tracks) {
      const o = document.createElement("option");
      o.value = t.lang;
      const kind = t.kind === "auto" ? "auto" : "CC";
      o.textContent = `${t.lang} · ${kind}${t.name && t.name !== t.lang ? " · " + t.name : ""}`;
      el.sourceTrack.appendChild(o);
    }
    el.sourceTrack.value = "auto";
  }

  /* ------------------------------------------------------------- prepare */
  async function prepare() {
    if (!state.video) return;
    enforceCharacterVoice();
    // Starting a new run invalidates any translation/prefetch already running.
    const runId = ++state.runId;
    state.preparing = true;
    el.prepareBtn.disabled = true;
    setBadge("translating", "work");
    try {
      setStatus("Fetching subtitles…");
      const lang = el.sourceTrack.value || "auto";
      const data = await getJSON(`/api/segments?v=${encodeURIComponent(state.video.id)}&lang=${encodeURIComponent(lang)}`);
      if (runId !== state.runId) return;
      if (!data.segments.length) throw new Error("no subtitle cues found");

      state.segments = data.segments.map((s, i) => ({ ...s, i, text: "", audio: null, pending: false }));
      state.ready = true;
      state.currentIdx = -1;
      renderTranscript();
      setStatus("Translating subtitles…", `0 / ${state.segments.length}`);

      await translateAll(runId);
      if (runId !== state.runId) return;

      setStatus(`Ready · ${state.segments.length} segments translated. Press play ▶`, "");
      setBadge("dub ready", "ok");
      el.exportBtn.disabled = false;
      startPrefetchLoop();
      pumpPrefetch();
    } catch (err) {
      if (runId === state.runId) {
        const message = String(err.message || "");
        setStatus("Prepare failed: " + message, "", "err");
        setBadge("error", "error");
        if (/no captions|caption|429|rate.?limit/i.test(message) && state.video) {
          showNotice("Captions are unavailable (" + message + ")");
          setNoticeAction("Transcribe with AI", () => startTranscription(state.video.id));
        }
      }
    } finally {
      if (runId === state.runId) {
        state.preparing = false;
        el.prepareBtn.disabled = false;
      }
    }
  }

  async function translateAll(runId) {    const segs = state.segments;
    const CHUNK = 8;
    const target = el.targetLang.value;
    for (let i = 0; i < segs.length; i += CHUNK) {
      if (runId !== state.runId) return;
      const batch = segs.slice(i, i + CHUNK);
      try {
        const res = await postJSON("/api/translate", { texts: batch.map((s) => s.orig), target });
        if (runId !== state.runId) return;
        res.texts.forEach((t, k) => {
          const seg = segs[i + k];
          seg.text = (t || "").trim() || seg.orig;
        });
      } catch (err) {
        batch.forEach((seg) => { seg.text = seg.orig; });
      }
      updateTranscriptRows(i, i + batch.length);
      setStatus("Translating subtitles…", `${Math.min(i + CHUNK, segs.length)} / ${segs.length}`);
      if (i === 0) startPrefetchLoop();
      pumpPrefetch();
    }
  }

  /* ------------------------------------------------------- AI transcription */
  async function startTranscription(videoId) {
    setNoticeAction("Starting…", null);
    try {
      const snap = await postJSON("/api/transcribe", { videoId, model: "base" });
      pollTranscription(snap.job, videoId);
    } catch (err) {
      showNotice("Could not start transcription: " + err.message);
      setNoticeAction("Retry", () => startTranscription(videoId));
    }
  }

  function pollTranscription(jobId, videoId) {
    if (state.asrTimer) clearInterval(state.asrTimer);

    const tick = async () => {
      try {
        const snap = await getJSON(`/api/transcribe/status?job=${encodeURIComponent(jobId)}`);
        if (snap.state === "done") {
          clearInterval(state.asrTimer);
          state.asrTimer = 0;
          hideNotice();
          el.prepareBtn.disabled = false;
          el.exportBtn.disabled = false;
          setStatus(`AI transcript ready (${snap.cues} lines) — translating…`);
          prepare();
          return;
        }
        if (snap.state === "error") {
          clearInterval(state.asrTimer);
          state.asrTimer = 0;
          showNotice("Transcription failed: " + (snap.error || "unknown error"));
          setNoticeAction("Retry", () => startTranscription(videoId));
          return;
        }
        showNotice(`Transcribing audio… ${snap.progress}% — ${snap.message}`);
      } catch (err) {
        clearInterval(state.asrTimer);
        state.asrTimer = 0;
        showNotice("Transcription status failed: " + err.message);
        setNoticeAction("Retry", () => startTranscription(videoId));
      }
    };

    state.asrTimer = setInterval(tick, 1200);
    tick();
  }

  /* ---------------------------------------------------------------- SRT */
  function downloadSRT() {
    const lines = state.segments.map((seg, i) => {
      const khmer = seg.text || seg.orig || "";
      const body = el.showOriginal.checked && seg.orig ? `${khmer}\n${seg.orig}` : khmer;
      return `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${body}\n`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    const name = (state.video ? state.video.title : "subtitles").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${el.targetLang.value}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* -------------------------------------------------------------- download */
  function openDownloadModal() {
    if (!state.video) return;
    resetDownloadUI();
    el.downloadModal.classList.remove("hidden");
  }

  function closeDownloadModal() {
    el.downloadModal.classList.add("hidden");
    if (state.exportTimer) {
      clearInterval(state.exportTimer);
      state.exportTimer = 0;
    }
    state.exportJob = null;
  }

  function resetDownloadUI() {
    el.dlLinks.innerHTML = "";
    el.dlProgress.classList.add("hidden");
    el.dlBar.style.width = "0%";
    el.dlMsg.textContent = "";
    el.dlStart.disabled = false;
    el.dlStart.textContent = "Start download";
  }

  function updateDlProgress(pct, msg) {
    el.dlProgress.classList.remove("hidden");
    el.dlBar.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
    if (msg) el.dlMsg.textContent = msg;
  }

  async function startDownload() {
    const checked = document.querySelector('input[name="dlMode"]:checked');
    const mode = checked ? checked.value : "srt";

    if (mode === "srt") {
      if (!state.segments.length || !state.segments.some((s) => s.text)) {
        updateDlProgress(0, "Translate the video first (Translate & dub), or choose the voice/video option.");
        return;
      }
      downloadSRT();
      updateDlProgress(100, "Saved the .srt file.");
      return;
    }

    if (!state.video) return;
    resetDownloadUI();
    el.dlStart.disabled = true;
    el.dlStart.textContent = "Working…";
    updateDlProgress(1, "Starting export…");

    try {
      const snap = await postJSON("/api/export", {
        videoId: state.video.id,
        target: el.targetLang.value,
        voice: el.voiceSelect.value,
        mode,
        bilingual: el.dlBilingual.checked,
      });
      state.exportJob = snap.job;
      pollExport(snap.job);
    } catch (err) {
      el.dlStart.disabled = false;
      el.dlStart.textContent = "Start download";
      updateDlProgress(0, "Export failed: " + err.message);
    }
  }

  function pollExport(jobId) {
    if (state.exportTimer) clearInterval(state.exportTimer);

    const tick = async () => {
      try {
        const snap = await getJSON(`/api/export/status?job=${encodeURIComponent(jobId)}`);
        updateDlProgress(snap.progress, snap.message);
        if (snap.state === "done") {
          clearInterval(state.exportTimer);
          state.exportTimer = 0;
          el.dlStart.disabled = false;
          el.dlStart.textContent = "Start download";
          el.dlMsg.textContent = "Done — files are ready:";
          el.dlLinks.innerHTML = (snap.files || [])
            .map((f) => `<a href="${f.url}" download="${escapeHtml(f.name)}">⬇ ${escapeHtml(f.name)}</a>`)
            .join("");
        } else if (snap.state === "error") {
          clearInterval(state.exportTimer);
          state.exportTimer = 0;
          el.dlStart.disabled = false;
          el.dlStart.textContent = "Start download";
          el.dlMsg.textContent = "Export failed: " + (snap.error || "unknown error");
        }
      } catch (err) {
        clearInterval(state.exportTimer);
        state.exportTimer = 0;
        el.dlStart.disabled = false;
        el.dlStart.textContent = "Start download";
        el.dlMsg.textContent = "Status check failed: " + err.message;
      }
    };

    state.exportTimer = setInterval(tick, 900);
    tick();
  }

  /* -------------------------------------------------------------- voices */
  async function loadVoices() {
    const code = el.targetLang.value;
    el.voiceSelect.disabled = true;
    el.voiceSelect.innerHTML = "<option>loading…</option>";
    try {
      const data = await getJSON(`/api/voices?prefix=${encodeURIComponent(code)}`);
      let voices = data.voices || [];
      if (!voices.length) voices = [{ shortName: "km-KH-SreymomNeural", locale: "km-KH", gender: "Female" }];
      const saved = localStorage.getItem("khmdub.voice");
      const preferred = code === "km" ? "km-KH-SreymomNeural" : voices[0].shortName;
      el.voiceSelect.innerHTML = voices
        .map((v) => `<option value="${escapeHtml(v.shortName)}">${v.gender === "Female" ? "♀" : "♂"} ${escapeHtml(v.shortName)}</option>`)
        .join("");
      const pick = voices.find((v) => v.shortName === saved) || voices.find((v) => v.shortName === preferred);
      if (pick) el.voiceSelect.value = pick.shortName;
      if (state.character !== "custom") applyCharacter();
      localStorage.setItem("khmdub.voice", el.voiceSelect.value);
    } catch (err) {
      el.voiceSelect.innerHTML = `<option value="km-KH-SreymomNeural">♀ km-KH-SreymomNeural</option>`;
    } finally {
      el.voiceSelect.disabled = false;
    }
  }

  function invalidateAudio() {
    for (const seg of state.segments) seg.audio = null;
    state.audioIdx = -1;
    state.inflight = 0;
    pauseAudio();
    pumpPrefetch();
  }

  /* ----------------------------------------------------------------- init */
  function bind() {
    el.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = el.searchInput.value.trim();
      if (!value) return;
      if (looksLikeVideo(value)) loadVideo(value);
      else doSearch(value);
    });

    el.pasteBtn.addEventListener("click", async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text) return;
        el.searchInput.value = text;
        if (looksLikeVideo(text)) loadVideo(text);
        else doSearch(text);
      } catch (_) {
        setStatus("Clipboard read was blocked — paste into the search box instead.", "", "err");
      }
    });

    el.prepareBtn.addEventListener("click", () => {
      if (!state.video) return;
      prepare();
    });

    el.exportBtn.addEventListener("click", openDownloadModal);

    el.chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      [...el.chips.querySelectorAll(".chip")].forEach((c) => c.classList.toggle("active", c === chip));
      const query = chip.dataset.query;
      if (query === "__trending") loadTrending();
      else doSearch(query);
    });

    el.promptClose.addEventListener("click", closePrompt);
    el.promptModal.addEventListener("click", (e) => {
      if (e.target === el.promptModal) closePrompt();
    });
    el.promptWatch.addEventListener("click", () => {
      const card = state.pendingCard;
      closePrompt();
      if (card) loadVideo(card.videoId, false);
    });
    el.promptDub.addEventListener("click", () => {
      const card = state.pendingCard;
      const voice = el.promptVoice.value;
      closePrompt();
      if (!card) return;
      if (voice) el.voiceSelect.value = voice;
      loadVideo(card.videoId, true);
    });

    el.dlClose.addEventListener("click", closeDownloadModal);
    el.dlCloseBtn.addEventListener("click", closeDownloadModal);
    el.downloadModal.addEventListener("click", (e) => {
      if (e.target === el.downloadModal) closeDownloadModal();
    });
    el.dlStart.addEventListener("click", startDownload);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closePrompt();
      closeDownloadModal();
    });

    el.autoInterpret.addEventListener("change", () => {
      state.auto = el.autoInterpret.checked;
      localStorage.setItem("khmdub.auto", String(state.auto));
    });

    el.targetLang.addEventListener("change", async () => {
      await loadVoices();
      if (state.video && state.tracks.length) prepare();
    });

    el.character.addEventListener("change", () => {
      state.character = el.character.value;
      localStorage.setItem("khmdub.character", state.character);
      if (state.character !== "custom") applyCharacter();
      else state.pitch = "+0Hz";
      if (state.segments.length) {
        invalidateAudio();
        if (state.currentIdx >= 0) switchTo(state.currentIdx, currentTime());
      }
    });

    el.voiceSelect.addEventListener("change", () => {
      state.character = "custom";
      state.pitch = "+0Hz";
      el.character.value = "custom";
      localStorage.setItem("khmdub.character", "custom");
      localStorage.setItem("khmdub.voice", el.voiceSelect.value);
      invalidateAudio();
      if (state.currentIdx >= 0) switchTo(state.currentIdx, currentTime());
    });

    el.sourceTrack.addEventListener("change", () => {
      if (state.video) prepare();
    });

    el.dubToggle.addEventListener("change", () => {
      state.dub = el.dubToggle.checked;
      if (!state.dub) pauseAudio();
      else if (state.currentIdx >= 0) switchTo(state.currentIdx, currentTime());
    });

    el.fitToggle.addEventListener("change", () => {
      state.fit = el.fitToggle.checked;
      if (state.currentIdx >= 0) switchTo(state.currentIdx, currentTime());
    });

    el.origVol.addEventListener("change", () => {
      applyOriginalVolume();
      localStorage.setItem("khmdub.origVol", el.origVol.value);
    });

    el.showOriginal.addEventListener("change", () => {
      if (state.currentIdx >= 0) showSubtitle(state.currentIdx);
    });

    el.offsetRange.addEventListener("input", () => {
      state.offset = parseFloat(el.offsetRange.value) || 0;
      el.offsetVal.textContent = `${state.offset >= 0 ? "+" : ""}${state.offset.toFixed(2)}s`;
      if (state.player && state.player.getPlayerState && state.player.getPlayerState() === 1) {
        state.audioIdx = -1;
        hardResync(state.player.getCurrentTime() - state.offset);
      }
    });

    el.volRange.addEventListener("input", () => {
      state.audio.volume = clamp(parseFloat(el.volRange.value) || 0, 0, 1);
    });

    state.audio.volume = 1;
    state.audio.preload = "auto";
    state.audio.loop = false;
    state.audio.addEventListener("ended", () => {});

    setInterval(sweepVoices, 10000);
  }

  async function doSearch(query) {
    setStatus(`Searching “${query}”…`);
    el.listTitle.textContent = "Search results";
    try {
      const data = await getJSON(`/api/search?q=${encodeURIComponent(query)}&limit=12`);
      renderResults(data.results || []);
      if (!(data.results || []).length) setStatus("No results — try different keywords.");
      else setStatus(`Found ${data.results.length} videos. Pick one.`);
    } catch (err) {
      setStatus("Search failed: " + err.message, "", "err");
    }
  }

  function init() {
    bind();
    initSubsDrag();
    window.__khmdubInternals = { isMusicOnly, cleanForSpeech };

    const savedChar = localStorage.getItem("khmdub.character");
    if (savedChar && (CHARACTERS[savedChar] || savedChar === "custom")) {
      state.character = savedChar;
      el.character.value = savedChar;
    }

    loadVoices();

    state.auto = localStorage.getItem("khmdub.auto") !== "false";
    el.autoInterpret.checked = state.auto;

    const savedVol = localStorage.getItem("khmdub.origVol");
    if (savedVol !== null && [...el.origVol.options].some((o) => o.value === savedVol)) {
      el.origVol.value = savedVol;
    }

    const params = new URLSearchParams(location.search);
    const v = params.get("v");
    if (v) {
      el.searchInput.value = `https://www.youtube.com/watch?v=${v}`;
      loadVideo(v);
    } else {
      loadTrending();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
