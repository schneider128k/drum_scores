// player_common.js — shared controls for BOTH playback modes (teleprompter
// renderer.js + conveyor.js): a persisted settings store, the Bluetooth audio-delay
// value, and the gear button → settings panel UI (incl. the delay calibrator).
// Loaded before renderer.js / conveyor.js. Exposes window.PlayerUI.
(function () {
  'use strict';

  // ── Persisted settings (per device, shared across modes and songs) ──────────
  const get = (k, d) => { try { const v = localStorage.getItem('ds.' + k); return v == null ? d : v; } catch (_) { return d; } };
  const set = (k, v) => { try { localStorage.setItem('ds.' + k, String(v)); } catch (_) {} };

  const API = {
    // 'on' = position line always shown · 'peek' = tap the score to flash it · 'off'
    lineMode(def) { const v = get('lineMode', def || 'peek'); return ['on', 'peek', 'off'].includes(v) ? v : (def || 'peek'); },
    setLineMode(v) { set('lineMode', v); },
    // Bluetooth audio delay: how far the HEARD sound lags the video, in ms. The
    // players show the cursor this much EARLIER so it matches what you hear.
    delayMs() { return Math.max(0, Math.min(600, parseInt(get('delayMs', '0'), 10) || 0)); },
    setDelayMs(v) { set('delayMs', Math.max(0, Math.min(600, Math.round(v)))); },
    delaySec() { return this.delayMs() / 1000; },
    lyricsOn() { return get('lyrics', '1') !== '0'; },
    setLyrics(b) { set('lyrics', b ? '1' : '0'); },
    // Print-only "song map" overview page. OFF by default — opt in per device.
    roadmapOn() { return get('roadmap', '0') === '1'; },
    setRoadmap(b) { set('roadmap', b ? '1' : '0'); },
    // Print paper size. US Letter is the default; A4 for metric printers.
    paper() { const v = get('paper', 'letter'); return v === 'a4' ? 'a4' : 'letter'; },
    setPaper(v) { set('paper', v === 'a4' ? 'a4' : 'letter'); },
    noteSize() { return Math.max(0.6, Math.min(2.2, parseFloat(get('noteSize', '1')) || 1)); },
    setNoteSize(v) { set('noteSize', Math.max(0.6, Math.min(2.2, v))); },
  };

  // ── One-time stylesheet for the gear button, panel and calibrator ───────────
  function injectStyle() {
    if (document.getElementById('pui-style')) return;
    const css = `
    .pui-wrap { position: relative; flex: 0 0 auto; }
    #pui-gear {
      min-height: 44px; min-width: 44px; font-size: 21px; line-height: 1;
      border: 1px solid #cfcfcf; border-radius: 10px; background: #fff; color: #555; cursor: pointer;
    }
    #pui-gear:hover { background: #f4f4f4; }
    #pui-panel {
      position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 30;
      width: 280px; max-width: 86vw;
      background: #fff; border: 1px solid #d8d8d8; border-radius: 14px; padding: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.18);
      display: flex; flex-direction: column; gap: 16px;
      color: #1a1a1a; font-size: 14px;
    }
    #pui-panel[hidden] { display: none; }
    .pui-sec { display: flex; flex-direction: column; gap: 7px; }
    .pui-sec > .pui-label { font-size: 12px; font-weight: 700; letter-spacing: .03em; color: #777; text-transform: uppercase; }
    .pui-seg { display: inline-flex; background: #f1f1f1; border-radius: 10px; padding: 3px; gap: 2px; }
    .pui-seg button {
      flex: 1; min-height: 38px; font: inherit; font-size: 13px; font-weight: 600;
      color: #555; background: transparent; border: 0; border-radius: 8px; cursor: pointer;
    }
    .pui-seg button.on { background: #36b35a; color: #fff; }
    .pui-row { display: flex; align-items: center; gap: 10px; }
    .pui-row .grow { flex: 1; }
    .pui-stepper { display: inline-flex; align-items: center; gap: 8px; }
    .pui-stepper button {
      min-height: 38px; min-width: 38px; font-size: 19px; line-height: 1;
      border: 1px solid #cfcfcf; border-radius: 9px; background: #fff; color: #1a1a1a; cursor: pointer;
    }
    .pui-toggle { position: relative; width: 46px; height: 28px; flex: 0 0 auto; cursor: pointer; }
    .pui-toggle input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
    .pui-track { position: absolute; inset: 0; background: #cfcfcf; border-radius: 999px; transition: background .15s; }
    .pui-knob { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; background: #fff; border-radius: 50%; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .pui-toggle input:checked + .pui-track { background: #36b35a; }
    .pui-toggle input:checked + .pui-track + .pui-knob { transform: translateX(18px); }
    #pui-delay { flex: 1; accent-color: #36b35a; }
    .pui-delayval { min-width: 54px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
    .pui-btn {
      min-height: 40px; padding: 0 12px; font: inherit; font-size: 13px; font-weight: 600;
      border: 1px solid #cfcfcf; border-radius: 9px; background: #fff; color: #1a1a1a; cursor: pointer;
    }
    .pui-btn.primary { background: #36b35a; color: #fff; border: 0; }
    .pui-hint { font-size: 12px; color: #999; line-height: 1.4; }
    .pui-print { display: flex; gap: 8px; }
    .pui-print .pui-btn { flex: 1; }

    /* Calibrator overlay */
    #pui-cal {
      position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 22px;
      background: rgba(20,22,26,0.96); color: #f1f1f1; text-align: center; padding: 24px;
    }
    #pui-cal[hidden] { display: none; }
    #pui-cal h2 { margin: 0; font-size: 20px; font-weight: 700; }
    #pui-cal .pui-hint { color: #b9bdc4; max-width: 420px; }
    #pui-pulse {
      width: 150px; height: 150px; border-radius: 50%;
      background: radial-gradient(circle, #36b35a 0%, rgba(54,179,90,0) 70%);
      opacity: 0.12; transform: scale(0.85); transition: none;
    }
    #pui-pulse.hit { opacity: 1; transform: scale(1.12); }
    #pui-cal .cal-delay { display: flex; align-items: center; gap: 12px; width: min(420px, 86vw); }
    #pui-cal input[type=range] { flex: 1; accent-color: #36b35a; }
    #pui-cal .cal-val { min-width: 64px; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
    #pui-cal .cal-actions { display: flex; gap: 12px; }
    #pui-cal .pui-btn { min-height: 48px; padding: 0 22px; font-size: 15px; background: #2b2f36; color: #f1f1f1; border: 1px solid #444; }
    #pui-cal .pui-btn.primary { background: #36b35a; border: 0; color: #fff; }

    /* First-play one-time hint, anchored above the gear. */
    .pui-callout {
      position: absolute; bottom: calc(100% + 12px); right: 0; z-index: 31;
      width: 252px; background: #fff; border: 1px solid #d8d8d8; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.2); padding: 12px 13px 10px;
      color: #1a1a1a; font-size: 13px; line-height: 1.45;
    }
    .pui-callout strong { display: block; margin-bottom: 3px; }
    .pui-callout::after {
      content: ""; position: absolute; top: 100%; right: 17px;
      border: 7px solid transparent; border-top-color: #fff;
    }
    .pui-callout .pui-co-actions { display: flex; justify-content: flex-end; margin-top: 9px; }
    .pui-callout .pui-btn { min-height: 36px; padding: 0 14px; font-size: 13px; font-weight: 600; border-radius: 9px; background: #36b35a; color: #fff; border: 0; cursor: pointer; }
    /* Fixed-position variant (anchored to an arbitrary button, e.g. the transport). */
    .pui-callout-fixed { position: fixed; right: auto; }
    .pui-callout-fixed::after { left: var(--pui-arrow, 18px); right: auto; }
    `;
    const s = document.createElement('style');
    s.id = 'pui-style'; s.textContent = css;
    document.head.appendChild(s);
  }

  let mountedWrap = null;

  // Build a one-time callout (persisted via `key`) with a Got-it button + auto-dismiss.
  function makeCallout(html) {
    const co = document.createElement('div');
    co.className = 'pui-callout';
    co.innerHTML = html + `<div class="pui-co-actions"><button type="button">Got it</button></div>`;
    const remove = () => { if (co.parentNode) co.parentNode.removeChild(co); };
    co.querySelector('button').addEventListener('click', remove);
    setTimeout(remove, 12000);
    return co;
  }

  // First-Sync hint: once per device, point the user at the gear for the Bluetooth
  // audio-delay (the moment any drift between score and sound is visible).
  function maybeShowDelayHint() {
    if (!mountedWrap || get('delayHintSeen', '0') === '1') return;
    set('delayHintSeen', '1');
    mountedWrap.appendChild(makeCallout(
      `<strong>Playing through a speaker?</strong>If the score drifts from the sound, open ⚙ Settings and set the audio delay.`));
  }

  // First-Play hint: once per device, remind the user to tap Sync after any ad.
  // Anchored (fixed) above the transport button — that's the control they'll use.
  function maybeShowSyncHint() {
    const t = document.getElementById('transport');
    if (!t || get('syncHintSeen', '0') === '1') return;
    set('syncHintSeen', '1');
    const co = makeCallout(`<strong>One step after ads</strong>When an ad plays, let it finish — then tap <b>Sync</b> so the score follows the song.`);
    co.classList.add('pui-callout-fixed');
    document.body.appendChild(co);
    const r = t.getBoundingClientRect();
    const left = Math.max(8, r.left);
    co.style.left = left + 'px';
    co.style.bottom = (window.innerHeight - r.top + 12) + 'px';
    co.style.setProperty('--pui-arrow', Math.max(12, r.left + r.width / 2 - left) + 'px');
  }

  // ── Mount the gear button + settings panel ──────────────────────────────────
  // cfg = { slot, defaults:{lineMode}, show:{noteSize,lyrics,print},
  //         on:{ lineMode(m), delay(ms), lyrics(on), noteSizeStep(dir), print(orient) } }
  function mount(cfg) {
    injectStyle();
    const on = cfg.on || {};
    const show = cfg.show || {};

    const wrap = document.createElement('div');
    wrap.className = 'pui-wrap';
    wrap.innerHTML =
      `<button id="pui-gear" aria-label="Settings" aria-haspopup="true">⚙</button>
       <div id="pui-panel" hidden role="dialog" aria-label="Settings"></div>`;
    cfg.slot.appendChild(wrap);
    mountedWrap = wrap;

    const gear = wrap.querySelector('#pui-gear');
    const panel = wrap.querySelector('#pui-panel');

    // — View switch (Conveyor / Teleprompter) —
    if (cfg.viewSwitch) {
      const sec = document.createElement('div');
      sec.className = 'pui-sec';
      const m = cfg.viewSwitch.mode;
      sec.innerHTML =
        `<span class="pui-label">View</span>
         <div class="pui-seg" id="pui-view">
           <button data-href="conveyor.html${location.search}" class="${m === 'conveyor' ? 'on' : ''}">Conveyor</button>
           <button data-href="player.html${location.search}" class="${m === 'teleprompter' ? 'on' : ''}">Teleprompter</button>
         </div>`;
      panel.appendChild(sec);
      sec.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        if (!b.classList.contains('on')) location.href = b.dataset.href;
      }));
    }

    // — Position line —
    const lineSec = document.createElement('div');
    lineSec.className = 'pui-sec';
    lineSec.innerHTML =
      `<span class="pui-label">Position line</span>
       <div class="pui-seg" id="pui-line">
         <button data-m="on">Always</button>
         <button data-m="peek">Peek</button>
         <button data-m="off">Off</button>
       </div>
       <span class="pui-hint">Over a Bluetooth speaker the sound lags, so the line may drift. “Peek” hides it until you tap the score.</span>`;
    panel.appendChild(lineSec);
    const lineSeg = lineSec.querySelector('#pui-line');
    const paintLine = () => {
      const m = API.lineMode(cfg.defaults && cfg.defaults.lineMode);
      lineSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    };
    lineSeg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      API.setLineMode(b.dataset.m); paintLine(); if (on.lineMode) on.lineMode(b.dataset.m);
    });
    paintLine();

    // — Lyrics —
    if (show.lyrics) {
      const sec = document.createElement('div');
      sec.className = 'pui-sec';
      sec.innerHTML =
        `<div class="pui-row"><span class="grow"><span class="pui-label">Lyrics</span></span>
           <label class="pui-toggle"><input type="checkbox" id="pui-lyr"><span class="pui-track"></span><span class="pui-knob"></span></label>
         </div>`;
      panel.appendChild(sec);
      const cb = sec.querySelector('#pui-lyr');
      cb.checked = API.lyricsOn();
      cb.addEventListener('change', () => { API.setLyrics(cb.checked); if (on.lyrics) on.lyrics(cb.checked); });
    }

    // — Note size (conveyor) —
    if (show.noteSize) {
      const sec = document.createElement('div');
      sec.className = 'pui-sec';
      sec.innerHTML =
        `<div class="pui-row"><span class="grow"><span class="pui-label">Note size</span></span>
           <span class="pui-stepper"><button id="pui-smaller" aria-label="Smaller">−</button><button id="pui-bigger" aria-label="Bigger">+</button></span>
         </div>`;
      panel.appendChild(sec);
      sec.querySelector('#pui-smaller').addEventListener('click', () => { if (on.noteSizeStep) on.noteSizeStep(-1); });
      sec.querySelector('#pui-bigger').addEventListener('click', () => { if (on.noteSizeStep) on.noteSizeStep(1); });
    }

    // — Audio delay (Bluetooth) —
    const delSec = document.createElement('div');
    delSec.className = 'pui-sec';
    delSec.innerHTML =
      `<span class="pui-label">Audio delay (Bluetooth)</span>
       <div class="pui-row">
         <input type="range" id="pui-delay" min="0" max="500" step="10">
         <span class="pui-delayval" id="pui-delayval"></span>
       </div>
       <div class="pui-row"><button class="pui-btn" id="pui-cal-open">Calibrate…</button>
         <span class="pui-hint grow">Shifts the cursor to match what you hear.</span></div>`;
    panel.appendChild(delSec);
    const slider = delSec.querySelector('#pui-delay');
    const dval = delSec.querySelector('#pui-delayval');
    const paintDelay = () => { slider.value = API.delayMs(); dval.textContent = API.delayMs() + ' ms'; };
    slider.addEventListener('input', () => { API.setDelayMs(+slider.value); dval.textContent = API.delayMs() + ' ms'; if (on.delay) on.delay(API.delayMs()); });
    delSec.querySelector('#pui-cal-open').addEventListener('click', () => openCalibrator(ms => { API.setDelayMs(ms); paintDelay(); if (on.delay) on.delay(ms); }));
    paintDelay();

    // — Print —
    if (show.print) {
      const sec = document.createElement('div');
      sec.className = 'pui-sec';
      sec.innerHTML =
        `<span class="pui-label">Print</span>
         <div class="pui-row"><span class="grow"><span class="pui-label" style="text-transform:none;color:#1a1a1a;font-size:14px;font-weight:400">Song map page</span></span>
           <label class="pui-toggle"><input type="checkbox" id="pui-roadmap"><span class="pui-track"></span><span class="pui-knob"></span></label>
         </div>
         <div class="pui-seg"><button data-paper="letter">Letter</button><button data-paper="a4">A4</button></div>
         <div class="pui-print"><button class="pui-btn primary" data-o="portrait">Portrait</button><button class="pui-btn" data-o="landscape">Landscape</button></div>`;
      panel.appendChild(sec);
      const rmCb = sec.querySelector('#pui-roadmap');
      rmCb.checked = API.roadmapOn();
      rmCb.addEventListener('change', () => API.setRoadmap(rmCb.checked));
      const paintPaper = () => sec.querySelectorAll('[data-paper]').forEach(b => b.classList.toggle('on', b.dataset.paper === API.paper()));
      sec.querySelectorAll('[data-paper]').forEach(b => b.addEventListener('click', () => { API.setPaper(b.dataset.paper); paintPaper(); }));
      paintPaper();
      sec.querySelectorAll('.pui-print button').forEach(b => b.addEventListener('click', () => { panel.hidden = true; if (on.print) on.print(b.dataset.o); }));
    }

    // Toggle + outside-click close.
    gear.addEventListener('click', e => { e.stopPropagation(); panel.hidden = !panel.hidden; });
    document.addEventListener('click', e => { if (!panel.hidden && !panel.contains(e.target) && e.target !== gear) panel.hidden = true; });
    if (new URLSearchParams(location.search).get('openpanel')) panel.hidden = false;   // headless/debug aid
    if (new URLSearchParams(location.search).get('showhint')) setTimeout(maybeShowDelayHint, 50);   // headless/debug aid
    if (new URLSearchParams(location.search).get('showsync')) setTimeout(maybeShowSyncHint, 50);    // headless/debug aid

    return { gear, panel };
  }

  // ── Audio-delay calibrator ──────────────────────────────────────────────────
  // Plays a steady click and flashes a pulse at (click time + delay). You raise the
  // delay until the FLASH lines up with the CLICK you hear over the speaker — a
  // simultaneity judgement (no reaction-time bias). The matched value is the audio
  // delay, applied to the cursor. Self-contained (no YouTube needed).
  function openCalibrator(onDone) {
    injectStyle();
    let host = document.getElementById('pui-cal');
    if (!host) {
      host = document.createElement('div');
      host.id = 'pui-cal'; host.hidden = true;
      host.innerHTML =
        `<h2>Match the flash to the click</h2>
         <p class="pui-hint">Listen to the steady click on your speaker, then drag until the green flash happens at the same moment you hear it.</p>
         <div id="pui-pulse"></div>
         <div class="cal-delay">
           <input type="range" id="pui-cal-slider" min="0" max="500" step="5">
           <span class="cal-val" id="pui-cal-val"></span>
         </div>
         <div class="cal-actions">
           <button class="pui-btn" id="pui-cal-cancel">Cancel</button>
           <button class="pui-btn primary" id="pui-cal-done">Use this delay</button>
         </div>`;
      document.body.appendChild(host);
    }
    const pulse = host.querySelector('#pui-pulse');
    const slider = host.querySelector('#pui-cal-slider');
    const valEl = host.querySelector('#pui-cal-val');
    slider.value = API.delayMs();
    const paint = () => valEl.textContent = slider.value + ' ms';
    paint();
    slider.oninput = paint;
    host.hidden = false;

    // WebAudio click scheduler + a rAF that flashes the pulse at click+delay.
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const PERIOD = 0.9;             // seconds between clicks
    let nextClick = ctx.currentTime + 0.25;
    let stopped = false;
    function scheduleClicks() {
      while (nextClick < ctx.currentTime + 0.5) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 1200;
        g.gain.setValueAtTime(0.0001, nextClick);
        g.gain.exponentialRampToValueAtTime(0.6, nextClick + 0.001);
        g.gain.exponentialRampToValueAtTime(0.0001, nextClick + 0.05);
        o.connect(g).connect(ctx.destination);
        o.start(nextClick); o.stop(nextClick + 0.06);
        nextClick += PERIOD;
      }
    }
    let lastFlash = -1;
    function frame() {
      if (stopped) return;
      scheduleClicks();
      const delay = (+slider.value) / 1000;
      // phase of (now - delay) within the click grid; flash briefly after each click+delay
      const t = ctx.currentTime - 0.25 - delay;
      const phase = ((t % PERIOD) + PERIOD) % PERIOD;
      const idx = Math.floor((t) / PERIOD);
      if (phase < 0.12) {
        if (idx !== lastFlash) { lastFlash = idx; pulse.classList.add('hit'); }
      } else {
        pulse.classList.remove('hit');
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    function close(save) {
      stopped = true;
      try { ctx.close(); } catch (_) {}
      host.hidden = true;
      if (save) onDone(+slider.value);
    }
    host.querySelector('#pui-cal-cancel').onclick = () => close(false);
    host.querySelector('#pui-cal-done').onclick = () => close(true);
  }

  // ── Score edit overlay ──────────────────────────────────────────────────────
  // Edits are NOT baked into the imported score_<id>.js (that file is regenerable
  // from Songsterr and would wipe corrections on re-import). Instead a tiny, hand-
  // authored overrides_<id>_<part>.json sits alongside it and is APPLIED ON TOP at
  // load — both renderers (renderer.js teleprompter + conveyor.js) call applyOverrides
  // before they draw, so one edit shows up in every view. The file is the committable
  // source of truth: Pawel edits, exports it, and pushes it; students pull it. No
  // server, no auth — repo write-access is the access control.
  //
  // Op format (overrides_<id>_<part>.json). All ops key on bar + beat:
  //   change: { type:"change", bar, beat, from:"closedhihat", to:"openhihat" }
  //            replace a piece (its staff line + glyph + midi follow the new piece).
  //   add:    { type:"add", bar, beat, piece:"pedalhihat" }
  //            add a note to that beat's chord (e.g. the hi-hat foot ✕ below the staff).
  //   flam:   { type:"flam", bar, beat, from:"acousticsnare" }
  //            mark the matched note as a flam (a small grace notehead before the hit).
  //   set:    { type:"set", bar, beat, pieces:["acousticsnare","highfloortom"] }
  //            replace that beat's whole chord with `pieces` (creates the event if
  //            none exists). The primitive for rewriting a run of notes, e.g. a fill.
  // Any op may also carry accent (0/1/2) and ghost (true/false).
  // bar  = the printed measure number (measure.index).
  // beat = 1-based beat within the bar (1, 1.5, 2.5, …), in the bar's own beat unit.

  // Canonical lily → General-MIDI drum note, so a `change`/`add` also sets playback/MIDI.
  const LILY_MIDI = {
    bassdrum: 35, acousticbassdrum: 35, sidestick: 37, acousticsnare: 38, handclap: 39,
    electricsnare: 40, lowfloortom: 41, closedhihat: 42, highfloortom: 43, pedalhihat: 44,
    lowtom: 45, openhihat: 46, halfopenhihat: 46, lowmidtom: 47, himidtom: 48, hightom: 50,
    crashcymbal: 49, crashcymbala: 49, crashcymbalb: 57, ridecymbal: 51, ridecymbala: 51,
    chinesecymbal: 52, ridebell: 53, splashcymbal: 55, cowbell: 56, tommh: 48, hightomtom: 50,
  };
  const FEET = new Set(['bassdrum', 'acousticbassdrum', 'pedalhihat']);   // voice 2 (feet)

  // Beat (1-based, in the bar's beat unit) of an event within its measure.
  function beatOf(measure, event) {
    const [mn, md] = measure.position, [en, ed] = event.position;
    const offsetWhole = (en / ed) - (mn / md);       // whole notes from the bar's start
    return offsetWhole * measure.time_sig[1] + 1;     // → beats in this bar's unit
  }

  // Exact small fraction [num, den] for a float (handles binary + triplet grids).
  const _GCD = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; };
  function _frac(x) {
    for (const d of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192]) {
      const n = Math.round(x * d);
      if (Math.abs(x * d - n) < 1e-6) { const g = _GCD(n, d); return [n / g, d / g]; }
    }
    return [Math.round(x * 192), 192];
  }

  // A fresh note object matching the imported score's note shape.
  function makeNote(piece, op) {
    return {
      midi: op.midi != null ? op.midi : (LILY_MIDI[piece] != null ? LILY_MIDI[piece] : null),
      lily: piece,
      voice: FEET.has(piece) ? 2 : 1,   // for data fidelity; the renderer is single-voice
      ghost: op.ghost != null ? op.ghost : false,
      accent: op.accent != null ? op.accent : 0,
      tie: false,
    };
  }

  // Build a note list from `pieces` (strings, or {piece,accent?,ghost?} objects).
  function makeNoteList(pieces, op) {
    return (pieces || []).map(p => typeof p === 'string' ? makeNote(p, {}) : makeNote(p.piece, p));
  }

  // A fresh event holding `notes` at `beat`, for `add`/`set` ops that land where no
  // event exists yet (e.g. inserting the "e of 1" 16th). Its rendered duration is
  // derived from the gap to the next event by the renderer's stretch model, so
  // `duration` here is only nominal. tuplet_group:null keeps it in the plain-note path.
  function makeEventAt(measure, beat, notes, op) {
    const off = (beat - 1) / measure.time_sig[1];     // whole notes from bar start
    const [on, od] = _frac(off);
    const [mn, md] = measure.position;
    const g = _GCD(mn * od + on * md, md * od);
    return {
      position: [(mn * od + on * md) / g, (md * od) / g],
      duration: Array.isArray(op.dur) ? op.dur : [1, 16],
      notes,
      grace: false, tuplet_group: null, tuplet_n: null, tuplet_m: null, dots: 0, text: null,
    };
  }
  const makeEvent = (measure, beat, piece, op) => makeEventAt(measure, beat, [makeNote(piece, op)], op);

  // Mutate `score` in place by the overlay's ops. Unmatched ops warn (re-import safety:
  // if Songsterr's tab shifts and an anchor is gone, you find out instead of it silently
  // doing nothing). Returns { applied, missed }.
  function applyOverrides(score, ov) {
    if (!score || !ov || !Array.isArray(ov.ops)) return { applied: 0, missed: 0 };
    let applied = 0, missed = 0;
    for (const op of ov.ops) {
      const m = (score.measures || []).find(mm => mm.index === op.bar);
      if (!m) { console.warn('[overrides] no bar', op.bar); missed++; continue; }
      const evs = (m.events || []).filter(ev => Math.abs(beatOf(m, ev) - op.beat) <= 1e-4);

      // `add` can land where no event exists yet — then it CREATES one (insert a hit
      // at a new beat). All other ops need an existing note to act on.
      if (op.type === 'add') {
        const piece = op.piece || op.to;
        if (!evs.length) { m.events = m.events || []; m.events.push(makeEvent(m, op.beat, piece, op)); applied++; continue; }
        let hit = false;
        for (const ev of evs) {
          ev.notes = ev.notes || [];
          if (ev.notes.some(n => n.lily === piece)) { hit = true; continue; }   // already there
          ev.notes.push(makeNote(piece, op));
          hit = true; applied++;
        }
        if (!hit) console.warn('[overrides] add already present', JSON.stringify(op));
        continue;
      }

      // `set` replaces a beat's WHOLE chord with the given pieces (creating the event
      // if none exists). The clean primitive for rewriting a run of notes, e.g. a fill.
      if (op.type === 'set') {
        const notes = makeNoteList(op.pieces || (op.piece ? [op.piece] : []), op);
        if (!evs.length) { m.events = m.events || []; m.events.push(makeEventAt(m, op.beat, notes, op)); applied++; continue; }
        for (const ev of evs) ev.notes = notes.map(n => ({ ...n }));
        applied++;
        continue;
      }

      if (!evs.length) { console.warn('[overrides] no event at', op.bar + ':' + op.beat); missed++; continue; }
      let hit = false;
      for (const ev of evs) for (const n of ev.notes || []) {
        if (op.from && n.lily !== op.from) continue;
        if (op.type === 'flam') { n.flam = true; }
        else if (op.type === 'change' || op.to) {
          n.lily = op.to;
          if (op.midi != null) n.midi = op.midi;
          else if (LILY_MIDI[op.to] != null) n.midi = LILY_MIDI[op.to];
        }
        if (op.accent != null) n.accent = op.accent;
        if (op.ghost != null) n.ghost = op.ghost;
        hit = true; applied++;
      }
      if (!hit) { console.warn('[overrides] no match for', JSON.stringify(op)); missed++; }
    }
    if (applied) console.info(`[overrides] applied ${applied} edit(s)` + (missed ? `, ${missed} missed` : ''));
    return { applied, missed };
  }

  // Fetch overrides_<id>_<part>.json (if any) and apply it to window.SCORE. A 404 just
  // means "no edits for this song" — silent. Call (and await) before boot() renders.
  async function loadAndApplyOverrides() {
    const s = window.SCORE;
    if (!s) return;
    const id = s.song_id + '_' + s.part_id;
    try {
      const res = await fetch('overrides_' + id + '.json', { cache: 'no-store' });
      if (!res.ok) return;                 // 404 / no overlay → nothing to do
      applyOverrides(s, await res.json());
    } catch (_) { /* offline / file:// — skip silently */ }
  }

  API.mount = mount;
  API.openCalibrator = openCalibrator;
  API.maybeShowDelayHint = maybeShowDelayHint;
  API.maybeShowSyncHint = maybeShowSyncHint;
  API.applyOverrides = applyOverrides;
  API.loadAndApplyOverrides = loadAndApplyOverrides;
  window.PlayerUI = API;
})();
