// conveyor.js — "guitar hero" prototype: render the WHOLE song as ONE infinite
// horizontal staff and scroll it right→left under a fixed playhead, instead of
// the multi-row teleprompter (renderer.js). Because there's only one line, the
// engraving can be scaled up to fill the screen height — bigger, more readable.
//
// Self-contained on purpose (a prototype): the note-building (buildMeasureTickables,
// chordFromNotes, …), the timing map (buildSecondsAt) and the smooth PI clock are
// faithful ports of renderer.js so the sync behaviour matches the shipped player.
// If this graduates, fold the shared pieces back into one module.

const VF = Vex.Flow;
VF.STEM_WIDTH = 1.1;

// ── Palette (light notation on the dark stage) ────────────────────────────────
// Palette mirrors the teleprompter (renderer.js) so the two modes look identical
// on the same white page: note heads are the only dark element, everything else grey.
const NOTE_COLOR  = '#1a1a1a';
const GHOST_COLOR = '#9a9a9a';
const STAVE_COLOR = '#b6b6b6';
const STEM_COLOR  = '#8c8c8c';
const BEAM_COLOR  = '#8c8c8c';
const ACCENT_COLOR  = '#777';
const SECTION_COLOR = '#777';
const SECTION_FONT  = ['Georgia', 13, 'normal', 'italic'];
const STAVE_LINE_WIDTH = 1;
const BEAM_WIDTH = 4;

// Vertical geometry of the strip's viewBox (user units; scaled up to the screen).
// The viewBox HEIGHT is derived per-build from the real stave geometry (see buildStrip),
// so it always clears the flat beam and the lyric baseline.
const STAVE_TOP  = 66;    // y passed to each Stave (VexFlow adds its own top padding above line 0)
const BEAM_DROP  = 35;    // px below the bottom staff line for the flat beam
const ACCENT_RISE  = 26;
const SECTION_RISE = 42;
const SIDE   = 12;

// Horizontal scale K (viewBox units per SECOND of music) is COMPUTED per song,
// not fixed: K = max over bars of (min legible width / duration in seconds). That
// is the smallest constant speed at which even the densest bar still fits its
// notes — so every bar can then be sized EXACTLY width = K · durationSeconds.
// Strict time-proportional width ⇒ the cursor's x is linear in time ⇒ CONSTANT
// scroll velocity (the fix for the noticeable end-of-bar acceleration: that came
// from min-width bars whose trailing/barline/clef gap wasn't proportional to time).
// MIN_PPS is a floor so a very sparse song still flows at a sensible pace.
const MIN_PPS = 95;

// Cap on the fit-to-height scale. Filling the WHOLE lane makes the notes huge but
// stretches time so only ~1 bar is visible; capping keeps notes legible while
// leaving a readable multi-bar look-ahead. The Size buttons multiply this via ZOOM.
const MAX_SCALE = 2.4;
const NOTE_FLOOR_PX = 20;   // min viewBox width per note (anti-cram); lighter than the teleprompter's 26

const HEAD_OVERHANG = 6;
const SPACING_PAD = 4;

// Lyrics (ported from renderer.js): a flat baseline under the beams.
const LYRIC_COLOR = '#7a7a7a';
const LYRIC_FONT = ['Arial', 9, 'normal'];
const LYRIC_GAP = 16;        // viewBox units below the flat beam for the lyric baseline

// Playhead sits this fraction from the left of the lane — centred so the eye has
// equal context behind (what you just played) and ahead (what's coming).
const PLAYHEAD_FRAC = 0.5;

// ── Playback / clock state (ported from renderer.js) ──────────────────────────
let SCHED = null;             // { at(absPos)->score-seconds, total, offset }
let OFFSET = 0;
let YT_PLAYER = null, YT_READY = false;
let IS_PLAYING = false, SYNCED = false, STARTED = false;
const RATES = [0.25, 0.5, 0.75, 1];
let RATE_IDX = RATES.length - 1;
let PLAYBACK_RATE = 1;
let SCORE_REF = null;
let MEASURE_TIMELINE = [];

let CLK_M = 0, CLK_R = 1, CLK_TAU = 0, CLK_RAW = NaN, CLK_OUT = 0;
const CLK_KP = 0.2, CLK_KI = 0.05, CLK_SEEK_EPS = 0.35, LATENCY_LEAD = 0.05;

// ── Strip state ───────────────────────────────────────────────────────────────
let STRIP = null;             // { svg, totalW, anchors:[{seconds,x}], startSec, endSec }
let SCALE = 1;                // viewBox-unit → screen-px factor
let PLAYHEAD_PX = 0;
let ZOOM = 1;                 // user size multiplier on top of fit-to-height

// ── Fraction helpers (ports) ──────────────────────────────────────────────────
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const reduce = (n, d) => { const g = gcd(Math.abs(n), Math.abs(d)) || 1; return [n / g, d / g]; };
const fEq  = (a, b) => a[0] * b[1] === b[0] * a[1];
const fLT  = (a, b) => a[0] * b[1] <  b[0] * a[1];
const fLE  = (a, b) => a[0] * b[1] <= b[0] * a[1];
const fSub = (a, b) => reduce(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const fAdd = (a, b) => reduce(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const fMul = (a, b) => reduce(a[0] * b[0], a[1] * b[1]);
const frac = f => f[0] / f[1];

const DRUM_MAP = {
  bassdrum:       { key: 'f/4',    voice: 2 },
  pedalhihat:     { key: 'd/4/x2', voice: 2 },
  lowfloortom:    { key: 'a/4',    voice: 2 },
  highfloortom:   { key: 'g/4',    voice: 2 },
  lowtom:         { key: 'd/5',    voice: 2 },
  tommh:          { key: 'd/5',    voice: 2 },
  hightom:        { key: 'e/5',    voice: 2 },
  acousticsnare:  { key: 'c/5',    voice: 2 },
  sidestick:      { key: 'c/5/x2', voice: 2 },
  closedhihat:    { key: 'g/5/x2', voice: 1 },
  openhihat:      { key: 'g/5/x3', voice: 1 },
  halfopenhihat:  { key: 'g/5/x2', voice: 1 },
  ridecymbal:     { key: 'f/5/x2', voice: 1 },
  ridebell:       { key: 'f/5/d2', voice: 1 },
  crashcymbal:    { key: 'a/5/x2', voice: 1 },
  crashcymbalb:   { key: 'a/5/x2', voice: 1 },
  splashcymbal:   { key: 'a/5/x2', voice: 1 },
  chinesecymbal:  { key: 'a/5/x2', voice: 1 },
  cowbell:        { key: 'd/5/t2', voice: 1 },
  tambourine:     { key: 'b/5/x3', voice: 1 },
  vibraslap:      { key: 'b/5/x3', voice: 1 },
};

const DUR_TABLE = [
  [[1, 1],  'w',   0], [[7, 8],  'h',   2], [[3, 4],  'h',   1], [[1, 2],  'h',   0],
  [[7, 16], 'q',   2], [[3, 8],  'q',   1], [[1, 4],  'q',   0],
  [[7, 32], '8',   2], [[3, 16], '8',   1], [[1, 8],  '8',   0],
  [[3, 32], '16',  1], [[1, 16], '16',  0], [[3, 64], '32',  1], [[1, 32], '32',  0], [[1, 64], '64',  0],
];
function lookupDur(f) { for (const [d, vd, dots] of DUR_TABLE) if (fEq(f, d)) return [vd, dots]; return null; }
function fillRests(remaining) {
  const out = []; let rem = remaining;
  for (const [f, vd, dots] of DUR_TABLE) while (fLE(f, rem)) { out.push([vd, dots]); rem = fSub(rem, f); if (rem[0] === 0) return out; }
  return out;
}
function largestDurLE(gap) { for (const [f, vd, dots] of DUR_TABLE) if (fLE(f, gap)) return [f, vd, dots]; return null; }

const STEP = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };
function keyVal(key) { const [step, oct] = key.split('/'); return parseInt(oct, 10) * 7 + (STEP[step[0]] || 0); }
function chordFromNotes(notes) {
  const seen = new Set(), out = [];
  for (const dn of notes) {
    const key = (DRUM_MAP[dn.lily] || { key: 'b/4' }).key;
    if (seen.has(key)) continue; seen.add(key); out.push({ key, dn });
  }
  out.sort((a, b) => keyVal(a.key) - keyVal(b.key));
  return out;
}

// ── Timing: score-position → score-seconds (port of buildSecondsAt) ───────────
function buildSecondsAt(score) {
  const measures = score.measures || [];
  const chosen = (score.youtube_candidates || []).find(c => c.video_id === score.youtube_id);
  const points = chosen && chosen.points;
  if (!points || points.length < 2) return null;
  const n = measures.length;
  const offset = Number(score.youtube_offset) || 0;
  const mPos = measures.map(m => m.position[0] / m.position[1]);
  const mDur = measures.map(m => m.duration[0] / m.duration[1]);
  const anchored = Math.min(points.length, n);
  const starts = new Array(n), ends = new Array(n);
  for (let i = 0; i < anchored; i++) starts[i] = points[i] - offset;
  for (let i = 0; i < anchored; i++) if (i + 1 < points.length) ends[i] = points[i + 1] - offset;
  const last = anchored - 1;
  const spw = (last >= 1 && mDur[last - 1] > 0) ? (starts[last] - starts[last - 1]) / mDur[last - 1] : 1.0;
  if (ends[last] === undefined) ends[last] = starts[last] + spw * mDur[last];
  let cursor = ends[last];
  for (let i = last + 1; i < n; i++) { starts[i] = cursor; cursor += spw * mDur[i]; ends[i] = cursor; }
  if (!isFinite(ends[n - 1])) return null;
  function at(absPos) {
    let i = 0;
    while (i < n - 1 && absPos >= mPos[i] + mDur[i]) i++;
    const f = mDur[i] > 0 ? (absPos - mPos[i]) / mDur[i] : 0;
    return starts[i] + f * (ends[i] - starts[i]);
  }
  return { at, total: ends[n - 1], offset };
}
function measureStartSec(m) { return SCHED.at(m.position[0] / m.position[1]); }
function measureEndSec(m) { return SCHED.at(m.position[0] / m.position[1] + m.duration[0] / m.duration[1]); }

// ── Per-measure StaveNotes (verbatim port of buildMeasureTickables) ───────────
function buildMeasureTickables(measure) {
  const mPos = measure.position;
  const groups = new Map(), plain = [];
  for (const ev of measure.events) {
    const rel = fSub(ev.position, mPos);
    if (ev.tuplet_group != null) {
      let g = groups.get(ev.tuplet_group);
      if (!g) { g = { members: [], n: ev.tuplet_n, m: ev.tuplet_m }; groups.set(ev.tuplet_group, g); }
      g.members.push({ rel, ev });
    } else if (ev.notes && ev.notes.length) {
      plain.push({ rel, notes: ev.notes });
    }
  }
  if (plain.length === 0 && groups.size === 0) return { tickables: [], tuplets: [] };

  const anchors = plain.map(p => ({ kind: 'note', rel: p.rel, notes: p.notes }));
  for (const [gid, g] of groups) {
    g.members.sort((a, b) => a.rel[0] * b.rel[1] - b.rel[0] * a.rel[1]);
    let dur = [0, 1];
    for (const mem of g.members) dur = fAdd(dur, mem.ev.duration);
    anchors.push({ kind: 'tuplet', rel: g.members[0].rel, dur, gid, group: g });
  }
  anchors.sort((a, b) => a.rel[0] * b.rel[1] - b.rel[0] * a.rel[1]);

  const tokens = [];
  let cursor = [0, 1];
  if (fLT(cursor, anchors[0].rel)) {
    for (const [vd, d] of fillRests(fSub(anchors[0].rel, cursor))) tokens.push({ type: 'rest', dur: vd, dots: d });
    cursor = anchors[0].rel;
  }
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const nextPos = (i + 1 < anchors.length) ? anchors[i + 1].rel : measure.duration;
    if (a.kind === 'tuplet') {
      const g = a.group;
      for (const mem of g.members) {
        const written = fMul(mem.ev.duration, [g.n, g.m]);
        let vd, dots; const ld = lookupDur(written);
        if (ld) { vd = ld[0]; dots = ld[1]; }
        else { const fb = largestDurLE(written); if (!fb) continue; vd = fb[1]; dots = fb[2]; }
        const hasNotes = mem.ev.notes && mem.ev.notes.length;
        tokens.push({ type: hasNotes ? 'note' : 'rest', dur: vd, dots, notes: hasNotes ? mem.ev.notes : null, relpos: mem.rel, tupId: a.gid });
      }
      cursor = fAdd(a.rel, a.dur);
      if (fLT(cursor, nextPos)) { for (const [rd, rdots] of fillRests(fSub(nextPos, cursor))) tokens.push({ type: 'rest', dur: rd, dots: rdots }); cursor = nextPos; }
      continue;
    }
    const gap = fSub(nextPos, a.rel);
    const exact = lookupDur(gap);
    if (exact) { tokens.push({ type: 'note', dur: exact[0], dots: exact[1], notes: a.notes, relpos: a.rel }); cursor = nextPos; continue; }
    const fallback = largestDurLE(gap);
    if (!fallback) { cursor = nextPos; continue; }
    const [f, vd, dots] = fallback;
    tokens.push({ type: 'note', dur: vd, dots, notes: a.notes, relpos: a.rel });
    cursor = fAdd(a.rel, f);
    if (fLT(cursor, nextPos)) { for (const [rd, rdots] of fillRests(fSub(nextPos, cursor))) tokens.push({ type: 'rest', dur: rd, dots: rdots }); cursor = nextPos; }
  }

  const tickables = [], buckets = new Map();
  for (const t of tokens) {
    let n;
    if (t.type === 'rest') {
      n = new VF.StaveNote({ keys: ['b/4'], duration: t.dur + 'r' });
      for (let k = 0; k < t.dots; k++) VF.Dot.buildAndAttach([n], { all: true });
      n.__accent = 0;
    } else {
      const chord = chordFromNotes(t.notes);
      const keys = chord.map(c => c.key);
      n = new VF.StaveNote({ keys, duration: t.dur, stem_direction: -1 });
      for (let k = 0; k < t.dots; k++) VF.Dot.buildAndAttach([n], { all: true });
      let maxAccent = 0;
      chord.forEach((c, j) => {
        if (c.dn.ghost) n.setKeyStyle(j, { fillStyle: GHOST_COLOR, strokeStyle: GHOST_COLOR });
        if (c.dn.accent > maxAccent) maxAccent = c.dn.accent;
      });
      n.__accent = maxAccent;
      n.__posf = t.relpos[0] / t.relpos[1];
      n.__abspos = mPos[0] / mPos[1] + n.__posf;
    }
    tickables.push(n);
    if (t.tupId != null) { n.__tuplet = true; if (!buckets.has(t.tupId)) buckets.set(t.tupId, []); buckets.get(t.tupId).push(n); }
  }

  const beamable = new Set(['8', '16', '32', '64']);
  const tuplets = [];
  for (const [gid, notes] of buckets) {
    const g = groups.get(gid);
    const bracketed = notes.some(n => !beamable.has(n.getDuration && n.getDuration()));
    tuplets.push({ notes, num_notes: g.n, notes_occupied: g.m, bracketed });
  }
  return { tickables, tuplets };
}

// Proportional onset spacing within a bar (port of applyProportionalSpacing).
function applyProportionalSpacing(voice, usable) {
  const ticks = voice.getTickables(); const n = ticks.length;
  if (n < 2 || usable <= 0) return;
  let total = 0; try { total = voice.getTicksUsed().value(); } catch (_) {}
  if (!total) return;
  const ideal = new Array(n), half = new Array(n), rightExt = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    ideal[i] = (acc / total) * usable;
    let wd = 12; try { wd = ticks[i].getWidth() || wd; } catch (_) {}
    half[i] = wd / 2; rightExt[i] = wd + HEAD_OVERHANG;
    let tk = 0; try { tk = ticks[i].getTicks().value(); } catch (_) {}
    acc += tk;
  }
  const PAD = SPACING_PAD;
  const gap = i => half[i] + half[i + 1] + PAD;
  let need = half[0] + half[n - 1];
  for (let i = 0; i < n - 1; i++) need += gap(i);
  if (need > usable) return;
  const M = new Array(n);
  M[n - 1] = usable - rightExt[n - 1];
  for (let i = n - 2; i >= 0; i--) M[i] = Math.min(M[i + 1] - gap(i), usable - rightExt[i]);
  const x = new Array(n);
  let lo = half[0];
  for (let i = 0; i < n; i++) { x[i] = Math.min(M[i], Math.max(lo, ideal[i])); lo = x[i] + (i + 1 < n ? gap(i) : 0); }
  for (let i = 0; i < n; i++) { const tc = ticks[i].getTickContext && ticks[i].getTickContext(); if (tc && tc.setX) tc.setX(x[i]); }
}

function drawAccentBand(ctx, stave, notes) {
  const y = stave.getYForLine(0) - ACCENT_RISE;
  ctx.save(); ctx.setFont('Arial', 13, 'bold'); ctx.setFillStyle(ACCENT_COLOR);
  for (const n of notes) {
    if (!n.__accent || (n.isRest && n.isRest())) continue;
    ctx.fillText(n.__accent === 2 ? '^' : '>', n.getNoteHeadBeginX(), y);
  }
  ctx.restore();
}

// Attach lyric syllables to a measure's notes BEFORE formatting (reserves width so
// dense syllables push notes apart), then we draw them flat afterwards. Port of
// renderer.js attachLyrics.
function attachLyrics(notes, measure, lyrics) {
  if (!lyrics || !lyrics.length) return;
  const mStart = frac(measure.position), mDur = frac(measure.duration);
  const syl = [];
  for (const ly of lyrics) {
    const rel = frac(ly.pos) - mStart;
    if (rel >= -1e-9 && rel < mDur) syl.push({ rel, text: ly.text, cont: ly.cont });
  }
  if (!syl.length) return;
  syl.sort((a, b) => a.rel - b.rel);
  const cand = notes.filter(n => n.__posf != null && !(n.isRest && n.isRest()));
  if (!cand.length) return;
  let ni = 0;
  for (const s of syl) {
    while (ni + 1 < cand.length && Math.abs(cand[ni + 1].__posf - s.rel) < Math.abs(cand[ni].__posf - s.rel)) ni++;
    const note = cand[ni];
    if (note.__lyric) { note.__lyric += ' ' + s.text; note.__cont = s.cont; note.__ann.text = note.__lyric; }
    else {
      const ann = new VF.Annotation(s.text); ann.setFont(...LYRIC_FONT);
      note.addModifier(ann, 0); note.__lyric = s.text; note.__cont = s.cont; note.__ann = ann;
    }
    ni = Math.min(ni + 1, cand.length - 1);
  }
}

// Draw the whole strip's lyrics on one flat baseline (hyphens centred in the gap).
function drawStripLyrics(ctx, y, items) {
  if (!items.length) return;
  items.sort((a, b) => a.x - b.x);
  ctx.save(); ctx.setFont(...LYRIC_FONT); ctx.setFillStyle(LYRIC_COLOR);
  const halfDash = ctx.measureText('-').width / 2;
  for (let i = 0; i < items.length; i++) {
    const it = items[i], w = ctx.measureText(it.text).width;
    ctx.fillText(it.text, it.x - w / 2, y);
    if (it.cont && i + 1 < items.length) {
      const next = items[i + 1];
      const hx = ((it.x + w / 2) + (next.x - ctx.measureText(next.text).width / 2)) / 2;
      ctx.fillText('-', hx - halfDash, y);
    }
  }
  ctx.restore();
}

function buildMeasure(m, lyrics) {
  const { tickables: notes, tuplets: tupletSpecs } = buildMeasureTickables(m);
  if (lyrics) attachLyrics(notes, m, lyrics);
  let voice = null, minW = 40; const tuplets = [];
  if (notes.length) {
    for (const t of tupletSpecs) {
      try {
        tuplets.push(new VF.Tuplet(t.notes, { num_notes: t.num_notes, notes_occupied: t.notes_occupied, bracketed: t.bracketed, ratioed: false, location: VF.Tuplet.LOCATION_TOP }));
      } catch (e) { console.warn('tuplet failed m', m.index, e); }
    }
    voice = new VF.Voice({ num_beats: m.time_sig[0], beat_value: m.time_sig[1] });
    voice.setStrict(false).addTickables(notes);
    try { minW = new VF.Formatter().preCalculateMinTotalWidth([voice]); } catch (e) {}
    minW = Math.max(minW, notes.length * NOTE_FLOOR_PX);
  }
  return { m, notes, voice, minW, tuplets };
}

// Measure the EXACT horizontal space the percussion clef adds to a stave's note
// area (clef-stave noteStartX minus plain-stave noteStartX). Reserving a guessed
// width instead inflated bar 1's advance — that bar then scrolled faster than K
// (the 43%-spread spike). Measured in a detached SVG so it never touches the page.
function clefExtraPx() {
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:absolute;left:-9999px;top:-9999px';
  document.body.appendChild(tmp);
  let e = 28;
  try {
    const r = new VF.Renderer(tmp, VF.Renderer.Backends.SVG); r.resize(300, 120);
    const c = r.getContext();
    const a = new VF.Stave(0, 10, 260); a.addClef('percussion'); a.setContext(c).draw();
    const b = new VF.Stave(0, 10, 260); b.setContext(c).draw();
    e = a.getNoteStartX() - b.getNoteStartX();
  } catch (_) {}
  document.body.removeChild(tmp);
  return e;
}

// ── Build the single horizontal strip ─────────────────────────────────────────
function buildStrip(score) {
  const measures = score.measures || [];
  const lyrics = (PlayerUI.lyricsOn() && score.lyrics && score.lyrics.length) ? score.lyrics : null;
  const built = measures.map(m => buildMeasure(m, lyrics));
  const CLEF_EXTRA = clefExtraPx();   // actual clef width, so bar 1 advances at exactly K

  // Compute K = the per-song pixels-per-second. K is the smallest constant speed
  // at which EVERY bar still has room for its notes: max over bars of (minWidth /
  // durationSeconds). Then width = K · durationSeconds for every bar — strictly
  // time-proportional, so the cursor's x is linear in time and the scroll velocity
  // is constant (no end-of-bar acceleration). A bar that's denser than the rest
  // simply raises K (the whole song scrolls a touch airier) instead of cramming.
  const durSec = built.map(b => Math.max(0.05, measureEndSec(b.m) - measureStartSec(b.m)));
  let K = MIN_PPS;
  built.forEach((b, i) => { if (b.notes.length) K = Math.max(K, b.minW / durSec[i]); });
  const widths = built.map((b, i) => K * durSec[i]);
  let totalW = SIDE * 2 + CLEF_EXTRA + widths.reduce((a, b) => a + b, 0);

  // Derive the viewBox height from the REAL stave geometry (VexFlow reserves more
  // top padding than a naive 5×10px), so the flat beam — and the lyric baseline,
  // when shown — are never clipped at the bottom edge.
  const yLine4 = new VF.Stave(0, STAVE_TOP, 100).getYForLine(4);
  const beamBottom = yLine4 + BEAM_DROP;
  const baselineY = beamBottom + LYRIC_GAP;
  const vbH = Math.ceil((lyrics ? baselineY : beamBottom) + 12);

  const container = document.getElementById('strip');
  container.innerHTML = '';
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(totalW, vbH);
  const ctx = renderer.getContext();
  const svg = container.querySelector('svg');
  svg.setAttribute('viewBox', '0 0 ' + totalW + ' ' + vbH);
  svg.style.width = ''; svg.style.height = '';   // we set size ourselves on layout

  // Cursor anchors are one per BARLINE (each bar's left note-start x at its downbeat
  // second), not per notehead. Consecutive bars are contiguous, so the seconds→x map
  // is one linear ramp per bar at slope K — constant velocity, with the monotone
  // cubic only bending where the recording's per-bar tempo genuinely changes.
  const anchors = [];
  const lyricItems = [];   // {x, text, cont} collected across the strip, drawn flat at the end
  let x = SIDE, lastNoteStartX = SIDE, lastWidth = 0;

  for (let i = 0; i < built.length; i++) {
    const { m, notes, voice, tuplets } = built[i];
    const myWidth = widths[i] + (i === 0 ? CLEF_EXTRA : 0);
    const stave = new VF.Stave(x, STAVE_TOP, myWidth);
    stave.setStyle({ strokeStyle: STAVE_COLOR, fillStyle: STAVE_COLOR, lineWidth: STAVE_LINE_WIDTH });
    if (i === 0) stave.addClef('percussion');
    stave.setMeasure(m.index);
    stave.setContext(ctx).draw();
    anchors.push({ seconds: measureStartSec(m), x: stave.getNoteStartX() });
    lastNoteStartX = stave.getNoteStartX();
    lastWidth = widths[i];

    // Section label + time-sig changes, above the staff (green, like the labels).
    if (m.marker) {
      ctx.save(); ctx.setFont(...SECTION_FONT); ctx.setFillStyle(SECTION_COLOR);
      ctx.fillText(m.marker, stave.getNoteStartX(), stave.getYForLine(0) - SECTION_RISE); ctx.restore();
    }
    const prevM = measures[i - 1];
    if (!prevM || prevM.time_sig[0] !== m.time_sig[0] || prevM.time_sig[1] !== m.time_sig[1]) {
      ctx.save(); let mx = stave.getNoteStartX(); const my = stave.getYForLine(0) - SECTION_RISE;
      if (m.marker) { ctx.setFont(...SECTION_FONT); mx += ctx.measureText(m.marker).width + 12; }
      ctx.setFont('Georgia', 12, 'normal', 'italic'); ctx.setFillStyle(SECTION_COLOR);
      ctx.fillText(m.time_sig.join('/'), mx, my); ctx.restore();
    }

    x += myWidth;
    if (!voice) continue;

    const noteArea = stave.getNoteEndX() - stave.getNoteStartX();
    for (const n of notes) if (n.setStave) n.setStave(stave);
    try { new VF.Formatter().joinVoices([voice]).format([voice], noteArea - 6); applyProportionalSpacing(voice, noteArea - 6); }
    catch (e) { console.warn('format failed m', m.index, e); }
    // Lyric annotations reserved width above; blank them so VexFlow doesn't draw them
    // at zig-zagging note-relative spots — we draw them flat ourselves below.
    for (const n of notes) { if (n.__ann) n.__ann.text = ''; }

    const beamOpts = { stem_direction: -1, beam_rests: false, flat_beams: true, flat_beam_offset: stave.getYForLine(4) + BEAM_DROP };
    let beams = [];
    try {
      beams = VF.Beam.generateBeams(notes.filter(n => !n.__tuplet), beamOpts);
      for (const tp of tuplets) beams = beams.concat(VF.Beam.generateBeams(tp.notes.filter(n => !(n.isRest && n.isRest())), beamOpts));
    } catch (e) { console.warn('beam failed m', m.index, e); }

    ctx.setFillStyle(NOTE_COLOR); ctx.setStrokeStyle(NOTE_COLOR); ctx.setLineWidth(1);
    for (const n of notes) {
      if (n.setStemStyle) n.setStemStyle({ strokeStyle: STEM_COLOR });
      if (n.setLedgerLineStyle) n.setLedgerLineStyle({ strokeStyle: STAVE_COLOR, lineWidth: STAVE_LINE_WIDTH });
    }
    for (const b of beams) { b.render_options.beam_width = BEAM_WIDTH; b.setStyle({ fillStyle: BEAM_COLOR, strokeStyle: BEAM_COLOR }); }

    const yFlat = stave.getYForLine(4) + BEAM_DROP;
    for (const n of notes) {
      if ((n.isRest && n.isRest()) || (n.hasBeam && n.hasBeam()) || !n.setStemLength) continue;
      try { const topY = Math.min.apply(null, n.getYs()); if (yFlat - topY > 0) n.setStemLength(yFlat - topY); } catch (_) {}
    }

    voice.draw(ctx, stave);
    for (const b of beams) b.setContext(ctx).draw();
    ctx.setFillStyle(NOTE_COLOR); ctx.setStrokeStyle(NOTE_COLOR);
    for (const n of notes) { if ((n.isRest && n.isRest()) || !n.drawNoteHeads) continue; n.drawNoteHeads(); }
    drawAccentBand(ctx, stave, notes);

    if (tuplets && tuplets.length) {
      ctx.save(); ctx.setFillStyle(SECTION_COLOR); ctx.setStrokeStyle(SECTION_COLOR);
      for (const tp of tuplets) { try { tp.setContext(ctx).draw(); } catch (e) {} }
      ctx.restore();
    }

    if (lyrics) {
      for (const n of notes) {
        if (n.__lyric) lyricItems.push({ x: (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2, text: n.__lyric, cont: n.__cont });
      }
    }
  }

  if (lyrics) drawStripLyrics(ctx, baselineY, lyricItems);

  // Close the last bar with an end anchor one bar-width past its downbeat anchor,
  // so the final bar keeps the same constant slope K right to its barline.
  const endSec = measureEndSec(measures[measures.length - 1]);
  anchors.push({ seconds: endSec, x: lastNoteStartX + lastWidth });
  const EPS = 1e-4;
  const clean = [];
  for (const a of anchors) { if (clean.length && a.seconds - clean[clean.length - 1].seconds < EPS) continue; clean.push(a); }

  _mt = _ss = _sx = null; _hint = 0;   // reset the seconds→x interpolation cache for the new strip

  return { svg, totalW, vbH, K, anchors: clean, startSec: clean[0].seconds, endSec: clean[clean.length - 1].seconds };
}

// ── Monotone-cubic seconds→x interpolation (ports) ────────────────────────────
function monotoneTangents(s, x) {
  const n = s.length, m = new Array(n);
  if (n < 2) { m[0] = 0; return m; }
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) { const ds = s[i + 1] - s[i]; d[i] = ds > 0 ? (x[i + 1] - x[i]) / ds : 0; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], sq = a * a + b * b;
    if (sq > 9) { const tau = 3 / Math.sqrt(sq); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return m;
}
let _ss = null, _sx = null, _mt = null, _hint = 0;
function xAtTime(t) {
  const a = STRIP.anchors, n = a.length;
  if (t <= a[0].seconds) return a[0].x;
  if (t >= a[n - 1].seconds) return a[n - 1].x;
  if (!_mt) { _ss = a.map(p => p.seconds); _sx = a.map(p => p.x); _mt = monotoneTangents(_ss, _sx); }
  let i = _hint;
  if (i >= n - 1 || a[i].seconds > t) i = 0;
  while (i < n - 1 && a[i + 1].seconds <= t) i++;
  _hint = i;
  const s0 = a[i].seconds, s1 = a[i + 1].seconds, h = s1 - s0;
  if (h <= 0) return a[i].x;
  const u = (t - s0) / h, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return h00 * a[i].x + h10 * h * _mt[i] + h01 * a[i + 1].x + h11 * h * _mt[i + 1];
}

// ── Scaling / scroll ──────────────────────────────────────────────────────────
function layoutStrip() {
  const stage = document.getElementById('stage');
  const availH = stage.clientHeight - 24;   // a little breathing room top/bottom
  SCALE = Math.max(0.4, Math.min(MAX_SCALE, availH / STRIP.vbH) * ZOOM);
  PLAYHEAD_PX = stage.clientWidth * PLAYHEAD_FRAC;
  document.getElementById('playhead').style.left = PLAYHEAD_PX + 'px';
  const svg = STRIP.svg;
  svg.style.width = (STRIP.totalW * SCALE) + 'px';
  svg.style.height = (STRIP.vbH * SCALE) + 'px';
}
function scrollTo(t) {
  const tx = PLAYHEAD_PX - xAtTime(t) * SCALE;
  STRIP.svg.style.transform = 'translate3d(' + tx + 'px,0,0)';
}

// ── Smooth clock (ports) ──────────────────────────────────────────────────────
function clkHardSet(s) { CLK_M = s; CLK_R = PLAYBACK_RATE; CLK_OUT = s; }
function clkResync() {
  let y; try { y = YT_PLAYER.getCurrentTime(); } catch (_) { return; }
  if (typeof y !== 'number' || !isFinite(y)) return;
  CLK_RAW = y; CLK_TAU = performance.now() / 1000; clkHardSet(y - OFFSET);
}
function clkPredict(tau) { CLK_M += CLK_R * (tau - CLK_TAU); CLK_TAU = tau; }
function clkCorrect() {
  let y; try { y = YT_PLAYER.getCurrentTime(); } catch (_) { return; }
  if (typeof y !== 'number' || !isFinite(y) || y === CLK_RAW) return;
  CLK_RAW = y; const e = (y - OFFSET) - CLK_M;
  if (Math.abs(e) > CLK_SEEK_EPS) { clkHardSet(y - OFFSET); return; }
  CLK_M += CLK_KP * e; CLK_R += CLK_KI * e;
  const lo = PLAYBACK_RATE * 0.8, hi = PLAYBACK_RATE * 1.2;
  if (CLK_R < lo) CLK_R = lo; else if (CLK_R > hi) CLK_R = hi;
}

function startScrollLoop() {
  let lastStatus = 0;
  const frame = () => {
    const tau = performance.now() / 1000;
    if (YT_READY && SYNCED && IS_PLAYING) {
      clkPredict(tau); clkCorrect();
      // Subtract the user's Bluetooth audio-delay so the cursor matches what's HEARD.
      let t = CLK_M + LATENCY_LEAD - PlayerUI.delaySec();
      if (t < CLK_OUT) t = CLK_OUT; else CLK_OUT = t;
      scrollTo(t);
      if (tau - lastStatus > 0.2) { updateStatus(t); lastStatus = tau; }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ── Transport FSM (port) ──────────────────────────────────────────────────────
function playerState() { if (!STARTED) return 'IDLE'; if (!SYNCED) return 'PRESYNC'; return IS_PLAYING ? 'PLAYING' : 'PAUSED'; }
function onTransport() {
  if (!YT_READY) return;
  switch (playerState()) {
    case 'IDLE':    STARTED = true; try { YT_PLAYER.setPlaybackRate(PLAYBACK_RATE); } catch (_) {} YT_PLAYER.playVideo(); PlayerUI.maybeShowSyncHint(); break;
    case 'PRESYNC': doSync(); break;
    case 'PLAYING': YT_PLAYER.pauseVideo(); break;
    case 'PAUSED':  YT_PLAYER.playVideo(); break;
  }
  refreshTransport();
}
function refreshTransport() {
  const btn = document.getElementById('transport'); if (!btn) return;
  const s = playerState();
  const labels = { IDLE: '▶ Play', PRESYNC: '▶ Sync', PLAYING: '⏸ Pause', PAUSED: '▶ Play' };
  const hints = {
    IDLE: 'Press Play. After any ad, tap Sync the moment the song starts.',
    PRESYNC: 'Ad running? Wait or Skip — then tap Sync when the song starts.',
    PLAYING: '', PAUSED: 'Paused.',
  };
  btn.textContent = labels[s]; btn.disabled = !YT_READY;
  btn.classList.toggle('attention', s === 'PRESYNC');
  const hint = document.getElementById('hint'); if (hint) hint.textContent = hints[s];
}
function doSync() { if (!YT_READY) return; SYNCED = true; clkResync(); refreshTransport(); PlayerUI.maybeShowDelayHint(); }

function setRate(delta) {
  RATE_IDX = Math.max(0, Math.min(RATES.length - 1, RATE_IDX + delta));
  PLAYBACK_RATE = RATES[RATE_IDX];
  document.getElementById('rate').textContent = Math.round(PLAYBACK_RATE * 100) + '%';
  try { if (YT_PLAYER && YT_PLAYER.setPlaybackRate) YT_PLAYER.setPlaybackRate(PLAYBACK_RATE); } catch (_) {}
  if (SYNCED) clkResync();
}
function setZoom(mult) {
  ZOOM = Math.max(0.6, Math.min(2.2, ZOOM * mult));
  PlayerUI.setNoteSize(ZOOM);
  layoutStrip();
  scrollTo(SYNCED ? CLK_OUT : STRIP.startSec);
}
// Rebuild the strip (e.g. lyrics toggled): re-render, re-fit, re-park.
function rebuildStrip() {
  STRIP = buildStrip(SCORE_REF);
  layoutStrip();
  applyLineMode();
  scrollTo(SYNCED ? CLK_OUT : STRIP.startSec);
}

function fmtTime(s) { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' : '') + sec; }
function updateStatus(t) {
  const el = document.getElementById('status'); if (!el || !MEASURE_TIMELINE.length) return;
  let i = 0; while (i < MEASURE_TIMELINE.length - 1 && MEASURE_TIMELINE[i + 1].sec <= t) i++;
  let section = '';
  for (let k = i; k >= 0; k--) { if (MEASURE_TIMELINE[k].marker) { section = MEASURE_TIMELINE[k].marker; break; } }
  let ytNow = t + OFFSET, ytDur = 0;
  try { ytNow = YT_PLAYER.getCurrentTime(); ytDur = YT_PLAYER.getDuration(); } catch (_) {}
  const parts = [`Bar ${MEASURE_TIMELINE[i].idx}/${MEASURE_TIMELINE.length}`];
  if (section) parts.push(section);
  parts.push(`${fmtTime(ytNow)} / ${fmtTime(ytDur)}`);
  el.textContent = parts.join('  ·  ');
}

function initYt(videoId) {
  window.onYouTubeIframeAPIReady = function () {
    YT_PLAYER = new YT.Player('yt', {
      videoId, width: 160, height: 90, playerVars: { playsinline: 1 },
      events: {
        onReady: () => { YT_READY = true; refreshTransport(); },
        onStateChange: (e) => {
          IS_PLAYING = (e.data === YT.PlayerState.PLAYING);
          if (IS_PLAYING) STARTED = true;
          if (IS_PLAYING && SYNCED) clkResync();
          refreshTransport();
        },
      },
    });
  };
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function buildMeasureTimeline(score) {
  MEASURE_TIMELINE = (score.measures || []).map(m => ({ sec: measureStartSec(m), idx: m.index, marker: m.marker || '' }));
}

let _peekTimer = null;
// Apply the persisted line mode: 'on' = always shown, 'peek'/'off' = hidden at rest.
function applyLineMode() {
  const ph = document.getElementById('playhead'); if (!ph) return;
  clearTimeout(_peekTimer);
  if (PlayerUI.lineMode('peek') === 'on') ph.classList.add('peek');
  else ph.classList.remove('peek');
}
function peek() {
  if (PlayerUI.lineMode('peek') !== 'peek') return;   // 'on' already shown, 'off' stays hidden
  const ph = document.getElementById('playhead'); if (!ph) return;
  ph.classList.add('peek');
  clearTimeout(_peekTimer);
  _peekTimer = setTimeout(() => ph.classList.remove('peek'), 1800);
}

function withParam(key, val) {
  const p = new URLSearchParams(location.search);
  p.set(key, val);
  return '?' + p.toString();
}

function wireControls() {
  document.getElementById('transport').addEventListener('click', onTransport);
  document.getElementById('slower').addEventListener('click', () => setRate(-1));
  document.getElementById('faster').addEventListener('click', () => setRate(1));

  // Tap the score to peek at the "now" line, then it fades out (see CSS).
  document.getElementById('stage').addEventListener('pointerdown', peek);

  // Gear → shared settings panel.
  PlayerUI.mount({
    slot: document.getElementById('gear-slot'),
    viewSwitch: { mode: 'conveyor' },
    defaults: { lineMode: 'peek' },
    show: { noteSize: true, lyrics: true, print: true },
    on: {
      lineMode: () => applyLineMode(),
      delay: () => {},                                 // read live in the scroll loop
      lyrics: () => rebuildStrip(),                    // re-render with/without lyrics
      noteSizeStep: (dir) => setZoom(dir > 0 ? 1.15 : 1 / 1.15),
      print: (orient) => { location.href = 'player.html' + withParam('print', orient); },
    },
  });

  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); onTransport(); }
  });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { layoutStrip(); scrollTo(SYNCED ? CLK_OUT : STRIP.startSec); }, 120); });
}

function boot() {
  const score = window.SCORE;
  const st = document.getElementById('status');
  if (!score) { if (st) st.textContent = 'No window.SCORE — load a score_*.js first.'; return; }
  SCORE_REF = score;
  document.title = `${score.artist} — ${score.title} (conveyor)`;
  document.getElementById('bignow').textContent = `${score.artist} — ${score.title}`;

  SCHED = buildSecondsAt(score);
  if (!SCHED) { if (st) st.textContent = `${score.artist} — ${score.title} — no YouTube sync for this song.`; return; }
  OFFSET = SCHED.offset;
  buildMeasureTimeline(score);

  ZOOM = PlayerUI.noteSize();   // restore the saved note size
  STRIP = buildStrip(score);
  layoutStrip();
  // ?t=<sec> parks the strip at a score-time so the layout can be eyeballed
  // without playing the (un-embeddable-in-headless) YouTube video.
  const dbgT = parseFloat(new URLSearchParams(location.search).get('t'));
  scrollTo(isFinite(dbgT) ? dbgT : STRIP.startSec);
  if (st) st.textContent = `${score.artist} — ${score.title}`;

  // ?probe=1 — sample the strip velocity (viewBox-x per second) across the song
  // and report the spread, to verify the scroll is constant-velocity.
  if (new URLSearchParams(location.search).get('probe')) {
    const t0 = STRIP.startSec, t1 = STRIP.endSec, N = 2000, dt = (t1 - t0) / N;
    let vmin = Infinity, vmax = -Infinity, sum = 0;
    for (let k = 0; k < N; k++) {
      const v = (xAtTime(t0 + (k + 1) * dt) - xAtTime(t0 + k * dt)) / dt;
      vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); sum += v;
    }
    const mean = sum / N;
    document.getElementById('bignow').textContent =
      `K=${STRIP.K.toFixed(1)} probe: vmin=${vmin.toFixed(1)} vmax=${vmax.toFixed(1)} mean=${mean.toFixed(1)} spread=${((vmax - vmin) / mean * 100).toFixed(1)}%`;
  }

  wireControls();
  applyLineMode();
  if (!new URLSearchParams(location.search).get('nopeek')) peek();   // flash once so the line is discoverable (peek mode only)
  if (score.youtube_id) { initYt(score.youtube_id); startScrollLoop(); }
  refreshTransport();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
