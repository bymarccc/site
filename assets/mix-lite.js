/* bymarccc — music on pages opened directly (product / checkout / members, e.g. Safari reopening the tab).
   The homepage has the full music engine (window.__bymMix). When it is running (the visitor came from the
   homepage through BYM_NAV) this file stays idle. Otherwise it gives these pages the same behaviour:
   - the next song starts by itself when one ends,
   - DJ mix: the last 10 s of a song fade out while the next song fades in (Web Audio decks, also with the phone locked),
   - lock-screen title + alien artwork, re-asserted because iPhone drops them. */
(() => {
  if (window.__bymMixLite) return; window.__bymMixLite = true;
  if (window.top !== window) return;   // the homepage quick-view sheet (iframe) must never start its own audio engine
  const audio = document.getElementById('miniAudio'); if (!audio) return;
  const idle = () => !!window.__bymMix;   // homepage engine in charge
  const $ = id => document.getElementById(id);
  const list = () => (window.BYMARCCC_PLAYLIST || []).filter(t => t.src);
  const abs = p => !p ? '' : /^(https?:|data:|\/)/.test(p) ? p : '/' + p;
  const cur = () => { const src = audio.currentSrc || audio.src; if (!src) return null; return list().find(t => src.endsWith(String(t.src).replace(/^\.?\//, ''))) || null; };
  const nextOf = c => { const L = list(); if (!L.length) return null; const i = c ? L.indexOf(c) : -1; return L[(i + 1) % L.length]; };
  const split = t => { const s = String(t || ''); const i = s.indexOf(' - '); return i > 0 ? [s.slice(i + 3), s.slice(0, i)] : [s, '']; };
  function play(t) {   // same as the dock's playTrack
    const [title, artist] = split(t.title);
    ['miniTitle', 'miniArtist'].forEach(id => { if (!$(id)) { const s = document.createElement('span'); s.id = id; s.hidden = true; document.body.appendChild(s); } });
    $('miniTitle').textContent = title; $('miniArtist').textContent = artist;
    audio.src = abs(t.src); audio.play().catch(() => {});
  }
  audio.addEventListener('ended', () => { if (idle() || audio.loop) return; const n = nextOf(cur()); if (n) play(n); });

  /* ---------- lock screen ---------- */
  const ART = [
    { src: new URL('/assets/img/lockscreen-alien-sky-v2-512.jpg', location.origin).href, sizes: '512x512', type: 'image/jpeg' },
    { src: new URL('/assets/img/lockscreen-alien-sky-v2.jpg', location.origin).href, sizes: '1024x1024', type: 'image/jpeg' },
  ];
  const hasMS = 'mediaSession' in navigator;
  const update = () => {
    if (!hasMS) return;
    const t = cur(); const [st, sa] = t ? split(t.title) : ['', ''];
    const title = ($('miniTitle')?.textContent || '').trim() || st, artist = ($('miniArtist')?.textContent || '').trim() || sa;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: title && title !== '—' ? title : 'bymarccc', artist: artist || 'bymarccc', album: 'bymarccc', artwork: ART }); } catch (e) {}
  };
  const assert = () => { if (!hasMS || audio.paused || idle()) return; update(); navigator.mediaSession.playbackState = 'playing'; };
  if (hasMS) {
    audio.addEventListener('playing', assert);
    audio.addEventListener('loadedmetadata', () => { if (!idle()) update(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) assert(); });
    setInterval(assert, 15000);
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
    audio.addEventListener('play', () => { if (idle()) return; set('nexttrack', () => { const n = nextOf(cur()); if (n) play(n); }); });
  }

  /* ---------- DJ mix (same engine as the homepage) ---------- */
  let mixing = false, mixCtx = null, mixFailSrc = '', mixSwitchAt = 0, mixPrep = null, mixDecks = null, mixGhost = null;
  const MIX_S = 10, PREP_S = 25;
  const MIX_SILENT = (() => { const n = 400, b = new Uint8Array(44 + n), v = new DataView(b.buffer), w = (o, t) => [...t].forEach((c, i) => b[o + i] = c.charCodeAt(0));
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
    let s = ''; b.forEach(x => s += String.fromCharCode(x)); return 'data:audio/wav;base64,' + btoa(s); })();
  function mixEnsure() {   // from taps: create the context and unlock both decks (iPhone only lets an <audio> play later if it played once from a tap)
    if (idle()) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      if (!mixCtx) mixCtx = new AC();
      if ((mixCtx.state === 'suspended' || mixCtx.state === 'interrupted') && !(mixDecks && mixDecks.every(d => d.unlocked))) mixCtx.resume().catch(() => {});
      if (!mixDecks) mixDecks = [0, 1].map(() => { const g = new Audio(); g.crossOrigin = 'anonymous'; g.preload = 'auto'; g.playsInline = true; const n = mixCtx.createMediaElementSource(g), gn = mixCtx.createGain(), an = mixCtx.createAnalyser(); an.fftSize = 2048; gn.gain.value = 0; n.connect(gn); n.connect(an); gn.connect(mixCtx.destination); return { g, gn, an, unlocked: false, busy: false }; });
      mixDecks.forEach(d => { if (d.unlocked || d.busy || mixing) return; d.busy = true; d.g.src = MIX_SILENT; const pr = d.g.play(); (pr && pr.then ? pr : Promise.resolve()).then(() => { d.unlocked = true; d.g.pause(); }).catch(() => {}).finally(() => { d.busy = false; mixSleep(); }); });
    } catch (e) {}
  }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (!idle() && (!mixDecks || !mixDecks.every(d => d.unlocked))) setTimeout(mixEnsure, 0); }, { passive: true }));
  const mixDead = d => { try { const b = new Float32Array(d.an.fftSize); d.an.getFloatTimeDomainData(b); for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false; return true; } catch (e) { return false; } };   // digital zero = file blocked for Web Audio
  const mixReady = () => !!(mixCtx && mixCtx.state !== 'closed' && mixDecks && mixDecks.every(d => d.unlocked && !d.busy));
  /* iPhone shows no lock-screen title / artwork while an AudioContext runs: it sleeps outside the ~25 s blend window */
  function mixSleep() {
    if (mixCtx && mixCtx.state === 'running' && !mixPrep && !mixing && mixDecks && mixDecks.every(d => !d.busy))
      mixCtx.suspend().then(assert).catch(() => {});
  }
  setInterval(mixSleep, 4000);   // safety net: never leave the context running outside a blend (it hides the lock-screen title + artwork)
  function mixQuiet(d) { if (!d) return; d.gn.gain.cancelScheduledValues?.(0); d.gn.gain.value = 0; try { d.g.pause(); } catch (e) {} }
  function mixAbortPrep() { if (mixPrep) { mixQuiet(mixPrep.out); mixQuiet(mixPrep.inn); } mixPrep = null; if (!mixing) setTimeout(mixSleep, 0); }
  function mixStop() {
    const P = mixPrep; mixGhost = null;
    if (P && mixing) { try { const gi = P.inn.g; if (!gi.paused && audio.duration && gi.currentTime - audio.currentTime > 0.3 && gi.currentTime < audio.duration - 1) audio.currentTime = gi.currentTime; } catch (e) {} }
    audio.muted = false;
    mixing = false; mixAbortPrep();
    assert();
  }
  function mixPrepare() {   // ≤25 s before the end: buffer this song (near its end) on deck A and the next one on deck B, silently
    if (mixPrep || !mixReady()) return;
    if (mixCtx.state !== 'running') mixCtx.resume().catch(() => {});
    const cur0 = cur(), nxt = nextOf(cur0); if (!nxt || !cur0 || nxt === cur0) return;
    const [out, inn] = mixDecks; const P = mixPrep = { out, inn, nxt, bad: false, outOk: false, innOk: false };
    const bad = () => { if (mixPrep !== P) return; P.bad = true; mixFailSrc = audio.currentSrc || audio.src; };
    const prime = (d, src, at, flag) => {
      d.gn.gain.value = 0;
      d.g.onerror = bad;
      d.g.onloadedmetadata = () => { try { d.g.currentTime = Math.max(0, Math.min(at(), (d.g.duration || 9e9) - 1)); } catch (e) {} };
      d.g.onplaying = () => { if (mixPrep !== P || mixing) return; d.g.pause(); try { d.g.currentTime = Math.max(0, Math.min(at(), (d.g.duration || 9e9) - 1)); } catch (e) {} P[flag] = true; };
      d.g.src = src; d.g.play().catch(bad);
    };
    prime(out, audio.currentSrc || audio.src, () => Math.max(0, (audio.duration || 0) - MIX_S - 0.5), 'outOk');
    prime(inn, abs(nxt.src), () => (nxt.start > 0 ? nxt.start : 0), 'innOk');
  }
  function mixGo() {   // ≤10 s left: deck A carries the old song, the real player switches (muted) to the next one
    const P = mixPrep; if (!P || P.bad || !P.outOk || !P.innOk || mixing || mixCtx.state !== 'running') return;
    const left = audio.duration - audio.currentTime; if (!(left > 2)) return;
    mixing = true; mixGhost = P.out.g; mixSwitchAt = performance.now();
    const { out, inn } = P;
    out.g.onplaying = null; inn.g.onplaying = null;
    try { out.g.currentTime = audio.currentTime + 0.12; } catch (e) {}
    const L = m => { try { window.__bymMixLog && window.__bymMixLog('go ' + m); } catch (e) {} };   // diagnostics only (?mixdebug=1)
    L('start real=' + audio.currentTime.toFixed(2) + ' deck=' + out.g.currentTime.toFixed(2) + ' buf=' + (out.g.buffered.length ? out.g.buffered.end(out.g.buffered.length - 1).toFixed(1) : '-'));
    /* iPhone fires 'playing' BEFORE the seek has finished and delivers the first audio later (LTE): wait until deck A is really playing
       (position moving, not seeking), jump it to the real player's position if it fell behind (inside buffered data = instant), only then judge it */
    let startT = 0; try { startT = out.g.currentTime; } catch (e) {}
    const deckWait = cb => {
      const w0 = performance.now(); let fixes = 0;
      const inBuf = tt => { try { const b = out.g.buffered; for (let i = 0; i < b.length; i++) if (tt >= b.start(i) && tt <= b.end(i) - 0.3) return true; } catch (e) {} return false; };
      const step = () => {
        if (mixPrep !== P || !mixing) return;
        const el = performance.now() - w0;
        if (!out.g.seeking && out.g.readyState >= 3 && out.g.currentTime > startT + 0.15) {
          const lag = audio.currentTime - out.g.currentTime;
          if (lag > 0.3 && fixes < 2 && el < 2500 && inBuf(audio.currentTime + 0.3)) { fixes++; L('deck behind by ' + lag.toFixed(2) + ' s → jump to real'); try { out.g.currentTime = audio.currentTime + 0.25; startT = out.g.currentTime; } catch (e) {} setTimeout(step, 80); return; }
          L('deck moving after ' + Math.round(el) + ' ms, lag=' + lag.toFixed(2)); setTimeout(cb, 100); return;
        }
        if (el > 3500 || !(audio.duration - audio.currentTime > 1.5)) { L('FAIL deck never moved: seeking=' + out.g.seeking + ' rs=' + out.g.readyState + ' t=' + out.g.currentTime.toFixed(2)); mixFailSrc = audio.currentSrc || audio.src; mixStop(); return; }
        setTimeout(step, 50);
      };
      step();
    };
    let started = false;
    const abort = setTimeout(() => { if (!started && mixPrep === P) { mixFailSrc = audio.currentSrc || audio.src; mixStop(); } }, 3000);
    out.g.addEventListener('playing', () => {
      if (started || mixPrep !== P) return; started = true; clearTimeout(abort);
      deckWait(() => {
        if (mixPrep !== P) return;
        if (mixDead(out)) { L('deck A DEAD (digital zero)'); mixFailSrc = audio.currentSrc || audio.src; mixStop(); return; }
        const rest = Math.max(2, Math.min(MIX_S, (out.g.duration || audio.duration) - out.g.currentTime));
        out.gn.gain.value = 1; audio.muted = true;
        inn.gn.gain.value = 0; const inn0 = inn.g.currentTime; inn.g.play().catch(() => {});
        play(P.nxt); audio.muted = true;
        /* fades on the audio clock, so they also happen with the phone locked */
        const N = 64, fOut = new Float32Array(N), fIn = new Float32Array(N);
        for (let i = 0; i < N; i++) { const k = i / (N - 1); fOut[i] = Math.cos(k * Math.PI / 2); fIn[i] = Math.sin(k * Math.PI / 2); }
        const c0 = mixCtx.currentTime + 0.02, w0 = performance.now(); let innDead = false, zeroSince = 0;
        try { out.gn.gain.cancelScheduledValues(0); out.gn.gain.value = 1; out.gn.gain.setValueCurveAtTime(fOut, c0, rest);
              inn.gn.gain.cancelScheduledValues(0); inn.gn.gain.value = 0; inn.gn.gain.setValueCurveAtTime(fIn, c0, rest); } catch (e) { mixStop(); return; }
        const iv = setInterval(() => {
          if (mixPrep !== P || !mixing) { clearInterval(iv); return; }
          const k = (mixCtx.currentTime - c0) / rest;
          /* deck B only counts as dead if it REALLY played (position moved) and stayed digitally silent for 2 s in a row: on iPhone it needs a moment to start, and a stalled/slow start is not a blocked file */
          const innMoved = inn.g.currentTime - inn0, zero = k > 0.12 && innMoved > 0.3 && !inn.g.paused && mixDead(inn);
          if (zero) { if (!zeroSince) zeroSince = performance.now(); } else zeroSince = 0;
          if (!innDead && (zero && performance.now() - zeroSince > 2000 || k > 0.35 && (inn.g.paused || inn.g.readyState < 2) || k > 0.5 && innMoved < 0.3)) { L('deck B DEAD moved=' + innMoved.toFixed(2) + ' zero=' + zero + ' paused=' + inn.g.paused + ' rs=' + inn.g.readyState + ' → real player unmuted'); innDead = true; mixQuiet(inn); audio.muted = false; }
          if (k >= 1 || out.g.ended || mixCtx.state !== 'running' || performance.now() - w0 > rest * 1000 + 4000) { clearInterval(iv); mixStop(); }
        }, 100);
      });
    }, { once: true });
    out.g.play().catch(() => { clearTimeout(abort); if (mixPrep === P) { mixFailSrc = audio.currentSrc || audio.src; mixStop(); } });
  }
  audio.addEventListener('loadstart', () => { if (!mixing) mixAbortPrep(); });   // another song picked → drop the prepared blend
  audio.addEventListener('timeupdate', () => {
    if (idle() || mixing || audio.loop || audio.paused || list().length < 2) return;
    const d = audio.duration, left = d - audio.currentTime;
    if (d > 45 && left <= PREP_S && left > 2 && (audio.currentSrc || audio.src) !== mixFailSrc) { mixPrepare(); if (left <= MIX_S) mixGo(); }
  });
  audio.addEventListener('play', () => { if (!idle()) setTimeout(mixEnsure, 0); });
  audio.addEventListener('pause', () => { if (mixGhost && performance.now() - mixSwitchAt > 1500) mixStop(); });
  window.__bymMixLiteState = () => ({ ctx: mixCtx && mixCtx.state, ready: mixReady(), prep: !!mixPrep, mixing, out: mixPrep && +mixPrep.out.gn.gain.value.toFixed(2), inn: mixPrep && +mixPrep.inn.gn.gain.value.toFixed(2), muted: audio.muted });
})();
