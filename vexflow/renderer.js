// renderer.js — minimal IR → VexFlow drum render. Classic script.
// Loads window.SCORE (set by a score_*.js file) and renders all measures.
// Expects Vex.Flow to be set by a prior <script src="vexflow.js"> tag.
//
// Scope of this prototype (Songsterr-style engraving):
//  - SINGLE voice, all stems DOWN — cymbals high, kick/snare low, one chord/event
//  - kick / snare / toms / hi-hat / ride / crash positioning + X noteheads
//  - flat horizontal beams on a fixed line below the staff
//  - accents (>) drawn in one uniform band above the staff
//  - ghost-note parentheses, dotted durations down to 64ths
//  - section markers (Intro / Verse / Chorus …) above the stave
//  - multi-measure rows with content-proportional widths
//
// Intentionally out of scope for now (TODO list):
//  - grace notes, tremolo rolls, tuplets, ties
//  - hairpin crescendos, dynamics, performance-text annotations
//  - lyrics row
//  - data-pos cursor metadata

const VF = Vex.Flow;

// Thinner stems than the 1.5 default (Stem.draw reads this global, ignoring any
// per-note style lineWidth).
VF.STEM_WIDTH = 1.1;

// ── Playback state (the travelling-bar cursor, Phase 1) ───────────────────────
// SCHED: { at(absPos)->score-seconds, total }. Null when the score has no
//        usable YouTube sync (no chosen video / no points[]) — then we render
//        statically with no bar, exactly as before.
// ROWS:  one record per rendered row, { div, svg, anchors:[{seconds,x}],
//        startSec, endSec, yTop, yBottom }, populated by renderRow.
let SCHED = null;
let ROWS = [];
let OFFSET = 0;               // youtube_offset: video-seconds where score time 0 lands
let YT_PLAYER = null;
let YT_READY = false;
let IS_PLAYING = false;       // mirrors the YT PLAYING state (NOT Tone.Transport — see ios-audiocontext note)
let SYNCED = false;           // the PRESYNC gate: the bar stays parked at beat 1 until the user taps Sync.
                              // The YT IFrame API can't tell us a preroll ad is playing (getCurrentTime/
                              // getVideoData return the MAIN video during the ad), so a human taps Sync once
                              // the song is actually playing — same two-step UX as the deployed player.
let STARTED = false;          // has the video been told to play at least once (IDLE vs PRESYNC)
const RATES = [0.25, 0.5, 0.75, 1];   // YouTube-supported learning speeds
let RATE_IDX = RATES.length - 1;      // start at 100%
let PLAYBACK_RATE = 1;        // scales the between-sample cursor advance (0.5× audio ⇒ half real-time)
let MEASURE_TIMELINE = [];    // [{sec, idx, marker}] per measure downbeat — drives the status line
let SCORE_REF = null;         // kept so a resize can re-render responsively
// Cursor clock estimator: a type-2 (PI) tracking loop that fuses the quantised,
// ~250 ms-stale YouTube getCurrentTime() sensor into a smooth, monotonic media
// clock. State = phase (estimated score-seconds) + rate (score-sec per
// wall-sec). We PREDICT every frame from performance.now() and CORRECT only on a
// genuinely new sensor value. The loop is over-damped, so the phase never
// overshoots (no backward jump); CLK_OUT is a hard monotonic latch on top. A
// residual above CLK_SEEK_EPS is a real seek/(re)sync, so we hard-set there.
let CLK_M = 0;        // phase: estimated score-seconds
let CLK_R = 1;        // rate: estimated score-seconds per wall-second (nominal = PLAYBACK_RATE)
let CLK_TAU = 0;      // performance.now()/1000 at the last predict()
let CLK_RAW = NaN;    // last raw getCurrentTime() — the correction is skipped unless it changed
let CLK_OUT = 0;      // last emitted t; the bar never steps back below this while playing
let ACTIVE_ROW = -1;
let BAR_RECT = null;
const SVG_NS = 'http://www.w3.org/2000/svg';
const BAR_COLOR = '#36b35a';
const BAR_OPACITY = 0.32;
const BAR_WIDTH = 9;
// Estimator tuning. Kp/Ki give a critically-/over-damped loop that settles a
// 250 ms quantisation step in ~0.5-1 s with no overshoot. SEEK_EPS draws the
// line between sensor noise (corrected gently) and a real seek (hard-set).
// LATENCY_LEAD nudges the bar slightly ahead to offset audio-output latency
// (getCurrentTime reports a touch behind what you actually hear); tune by eye.
const CLK_KP = 0.2;          // phase gain (per correction)
const CLK_KI = 0.05;         // rate gain (per correction)
const CLK_SEEK_EPS = 0.35;   // |residual| (s) above which we hard-set (seek/resync)
const LATENCY_LEAD = 0.05;   // s the bar leads the reported time

// Build a score-position → score-seconds function from the chosen YouTube
// candidate's per-measure anchors. This is a faithful port of the deployed
// player's applyPointsToSchedule (player.js), which itself mirrors the Python
// _make_anchor_seconds_at: points[i] is the recording-time (YT seconds) of
// measure i's downbeat; we subtract the offset so position 0 maps to 0 s, and
// extrapolate any tail measures past the last anchor at the last anchored
// pair's seconds-per-whole-note. One timing implementation for both first load
// and (future) picker swaps.
function buildSecondsAt(score) {
  const measures = score.measures || [];
  const chosen = (score.youtube_candidates || [])
    .find(c => c.video_id === score.youtube_id);
  const points = chosen && chosen.points;
  if (!points || points.length < 2) return null;
  if (points.length > measures.length) return null;

  const n = measures.length;
  const nPts = points.length;
  const offset = Number(score.youtube_offset) || 0;
  const mPos = measures.map(m => m.position[0] / m.position[1]);
  const mDur = measures.map(m => m.duration[0] / m.duration[1]);

  const starts = new Array(n);
  const ends = new Array(n);
  for (let i = 0; i < nPts; i++) starts[i] = points[i] - offset;
  for (let i = 0; i < nPts - 1; i++) ends[i] = points[i + 1] - offset;

  const lastSpw = mDur[nPts - 2] > 0
    ? (starts[nPts - 1] - starts[nPts - 2]) / mDur[nPts - 2]
    : 1.0;
  ends[nPts - 1] = starts[nPts - 1] + lastSpw * mDur[nPts - 1];
  let cursor = ends[nPts - 1];
  for (let i = nPts; i < n; i++) {
    starts[i] = cursor;
    cursor += lastSpw * mDur[i];
    ends[i] = cursor;
  }

  function at(absPos) {
    let i = 0;
    while (i < n - 1 && absPos >= mPos[i] + mDur[i]) i++;
    const f = mDur[i] > 0 ? (absPos - mPos[i]) / mDur[i] : 0;
    return starts[i] + f * (ends[i] - starts[i]);
  }
  return { at, total: ends[n - 1], offset };
}

// lily drum name → vexflow key on a 5-line treble-position percussion staff.
// Position choices favour visual separation over strict pitch correctness;
// adjust if specific instruments collide.
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
  cowbell:        { key: 'd/5/x3', voice: 1 },
  tambourine:     { key: 'b/5/x3', voice: 1 },
  vibraslap:      { key: 'b/5/x3', voice: 1 },
};

// Fraction (of whole-note) → [vexflow duration string, dot count].
// Mirrors emitter._DURS so we accept the same set the LilyPond path emits.
const DUR_TABLE = [
  [[1, 1],  'w',   0],
  [[7, 8],  'h',   2],
  [[3, 4],  'h',   1],
  [[1, 2],  'h',   0],
  [[7, 16], 'q',   2],
  [[3, 8],  'q',   1],
  [[1, 4],  'q',   0],
  [[7, 32], '8',   2],
  [[3, 16], '8',   1],
  [[1, 8],  '8',   0],
  [[3, 32], '16',  1],
  [[1, 16], '16',  0],
  [[3, 64], '32',  1],
  [[1, 32], '32',  0],
  [[1, 64], '64',  0],
];

// Fraction helpers — IR stores fractions as [num, den] arrays.
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const reduce = (n, d) => { const g = gcd(Math.abs(n), Math.abs(d)) || 1; return [n / g, d / g]; };
const fEq  = (a, b) => a[0] * b[1] === b[0] * a[1];
const fLT  = (a, b) => a[0] * b[1] <  b[0] * a[1];
const fLE  = (a, b) => a[0] * b[1] <= b[0] * a[1];
const fSub = (a, b) => reduce(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const fAdd = (a, b) => reduce(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const fMul = (a, b) => reduce(a[0] * b[0], a[1] * b[1]);

function lookupDur(frac) {
  for (const [f, vd, dots] of DUR_TABLE) {
    if (fEq(frac, f)) return [vd, dots];
  }
  return null;
}

// Greedy split of an arbitrary fraction into rest tokens that VexFlow can draw.
function fillRests(remaining) {
  const out = [];
  let rem = remaining;
  for (const [f, vd, dots] of DUR_TABLE) {
    while (fLE(f, rem)) {
      out.push([vd, dots]);
      rem = fSub(rem, f);
      if (rem[0] === 0) return out;
    }
  }
  return out;
}

// Pitch ordering so chord noteheads stack low→high and parenthesis/ghost
// modifier indices line up with the keys array we pass to StaveNote.
const STEP = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };
function keyVal(key) {
  const [step, oct] = key.split('/');
  return parseInt(oct, 10) * 7 + (STEP[step[0]] || 0);
}

// Collapse one event's DrumNotes into a sorted, de-duplicated chord. Returns
// [{ key, dn }] low→high; identical noteheads (same staff position) are merged.
function chordFromNotes(notes) {
  const seen = new Set();
  const out = [];
  for (const dn of notes) {
    const key = (DRUM_MAP[dn.lily] || { key: 'b/4' }).key;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, dn });
  }
  out.sort((a, b) => keyVal(a.key) - keyVal(b.key));
  return out;
}

// Largest standard duration ≤ gap (used when gap isn't itself standard).
function largestDurLE(gap) {
  for (const [f, vd, dots] of DUR_TABLE) {
    if (fLE(f, gap)) return [f, vd, dots];
  }
  return null;
}

// Build VexFlow StaveNotes for one measure as a SINGLE voice, all stems down —
// the way Songsterr engraves drums. Every event becomes one chord (cymbals high
// + kick/snare low) so beams sit on one flat line at the bottom.
//
// Drums are instantaneous, so we stretch each event's notated duration to fill
// the gap to the next event. That collapses Songsterr's noisy "8th + 8th rest"
// tick-grid into clean quarter/8th hits. Trade-off: lose the IR's notated
// duration, but for drums that's purely cosmetic.
//
// Each returned StaveNote is tagged with `__accent` (0/1/2) so the row renderer
// can draw accent marks in a single uniform band above the staff.
// Returns { tickables: [StaveNote...], tuplets: [{notes, num_notes, notes_occupied,
// bracketed}] }. Tuplets are kept out of the stretch model: their members render
// at the written duration (actual × N/M, mirroring emitter.py's `\tuplet N/M`)
// and are wrapped in a VF.Tuplet so VexFlow draws the bracket/"3" and reduces the
// spacing. Everything else still stretches to the next event to collapse the
// tick-grid rest noise into clean hits.
function buildMeasureTickables(measure) {
  const mPos = measure.position;

  // Partition events: tuplet members (grouped by tuplet_group, rests kept — they
  // fill the bracket) vs plain note events (stretched).
  const groups = new Map();   // gid -> { members:[{rel,ev}], n, m }
  const plain = [];           // [{rel, notes}]
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

  // One timeline anchor per plain note (instantaneous) and per tuplet group
  // (spans its summed actual duration). Sorted, they drive the stretch walk.
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
        const written = fMul(mem.ev.duration, [g.n, g.m]);   // displayed note value
        let vd, dots;
        const ld = lookupDur(written);
        if (ld) { vd = ld[0]; dots = ld[1]; }
        else { const fb = largestDurLE(written); if (!fb) continue; vd = fb[1]; dots = fb[2]; }
        const hasNotes = mem.ev.notes && mem.ev.notes.length;
        tokens.push({
          type: hasNotes ? 'note' : 'rest',
          dur: vd, dots,
          notes: hasNotes ? mem.ev.notes : null,
          relpos: mem.rel,
          tupId: a.gid,
        });
      }
      cursor = fAdd(a.rel, a.dur);
      if (fLT(cursor, nextPos)) {
        for (const [rd, rdots] of fillRests(fSub(nextPos, cursor))) tokens.push({ type: 'rest', dur: rd, dots: rdots });
        cursor = nextPos;
      }
      continue;
    }

    // Plain note: stretch to the next anchor.
    const gap = fSub(nextPos, a.rel);
    const exact = lookupDur(gap);
    if (exact) {
      tokens.push({ type: 'note', dur: exact[0], dots: exact[1], notes: a.notes, relpos: a.rel });
      cursor = nextPos;
      continue;
    }
    const fallback = largestDurLE(gap);
    if (!fallback) { cursor = nextPos; continue; }
    const [f, vd, dots] = fallback;
    tokens.push({ type: 'note', dur: vd, dots, notes: a.notes, relpos: a.rel });
    cursor = fAdd(a.rel, f);
    if (fLT(cursor, nextPos)) {
      for (const [rd, rdots] of fillRests(fSub(nextPos, cursor))) tokens.push({ type: 'rest', dur: rd, dots: rdots });
      cursor = nextPos;
    }
  }

  // Materialize tokens → StaveNotes, bucketing tuplet members in order.
  const tickables = [];
  const buckets = new Map();   // tupId -> [StaveNote...]
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

      // Ghost notes parenthesize that notehead; accent = strongest in the chord
      // (drawn later as a uniform top band).
      let maxAccent = 0, hasGhost = false;
      chord.forEach((c, j) => {
        if (c.dn.ghost) {
          n.addModifier(new VF.Parenthesis(VF.ModifierPosition.LEFT), j);
          n.addModifier(new VF.Parenthesis(VF.ModifierPosition.RIGHT), j);
          hasGhost = true;
        }
        if (c.dn.accent > maxAccent) maxAccent = c.dn.accent;
      });
      n.__accent = maxAccent;
      n.__hasGhost = hasGhost;   // parentheses widen the head — floors its min width
      n.__posf = t.relpos[0] / t.relpos[1];
      n.__abspos = mPos[0] / mPos[1] + n.__posf;
    }
    tickables.push(n);
    if (t.tupId != null) {
      n.__tuplet = true;   // beamed as its own group, excluded from the general beamer
      if (!buckets.has(t.tupId)) buckets.set(t.tupId, []);
      buckets.get(t.tupId).push(n);
    }
  }

  // A tuplet's bracket shows only when its notes can't be beamed (quarter or
  // longer); beamed 8th/16th triplets just carry the "3", like Songsterr.
  const beamable = new Set(['8', '16', '32', '64']);
  const tuplets = [];
  for (const [gid, notes] of buckets) {
    const g = groups.get(gid);
    const bracketed = notes.some(n => !beamable.has(n.getDuration && n.getDuration()));
    tuplets.push({ notes, num_notes: g.n, notes_occupied: g.m, bracketed });
  }
  return { tickables, tuplets };
}

const ROW_HEIGHT = 215;
const ROW_TOP = 55;          // headroom above the stave for section label + accent band
const PAGE_WIDTH = 1100;     // fallback width when the container hasn't laid out yet
const MIN_PAGE_WIDTH = 360;  // floor so a tiny window still renders something legible
const CLEF_W = 70;           // width the clef + time signature eat on the first row
const MAX_BARS_PER_ROW = 4;  // ceiling; the greedy breaker uses fewer when they don't fit
const SIDE_MARGIN = 10;
const ACCENT_RISE = 26;      // px above the top staff line for the accent band
const BEAM_DROP = 35;        // px below the bottom staff line for the flat beam
const SECTION_RISE = 42;     // px above the top staff line for the section label
const LYRIC_COLOR = '#7a7a7a';
const LYRIC_FONT = ['Arial', 9, 'normal'];   // smaller, like Songsterr — also lightens the width it reserves, so lyrics pull the note spacing less
const LYRIC_GAP = 26;        // px below the flat beam for the (flat) lyric baseline

// Songsterr palette: the note heads are the only dark element; everything else
// — staff, stems, beams, accents, section labels — is grey, so the eye lands
// on the notes.
const NOTE_COLOR = '#1a1a1a';
const STAVE_COLOR = '#b6b6b6';
const STAVE_LINE_WIDTH = 1;
const STEM_COLOR = '#8c8c8c';
const BEAM_COLOR = '#8c8c8c';
const BEAM_WIDTH = 4;        // default is 5
const ACCENT_COLOR = '#777';
const SECTION_COLOR = '#777';
const SECTION_FONT = ['Georgia', 13, 'normal', 'italic'];

function isFirstRow(rowIdx) { return rowIdx === 0; }
function frac(f) { return f[0] / f[1]; }

// Draw accents as one uniform band above the staff (Songsterr style), instead
// of per-note articulations that bob up and down with the chord height.
function drawAccentBand(ctx, stave, notes) {
  const y = stave.getYForLine(0) - ACCENT_RISE;
  ctx.save();
  ctx.setFont('Arial', 13, 'bold');
  ctx.setFillStyle(ACCENT_COLOR);
  for (const n of notes) {
    if (!n.__accent || (n.isRest && n.isRest())) continue;
    ctx.fillText(n.__accent === 2 ? '^' : '>', n.getNoteHeadBeginX(), y);
  }
  ctx.restore();
}

// Attach lyric syllables to the notes, BEFORE formatting. We use a VexFlow
// Annotation purely to RESERVE horizontal space: it reserves half the text
// width on each side of the note, so dense syllables push the notes apart
// instead of colliding — the same width-driven spacing Songsterr's renderer
// uses (it measures syllable text and reserves the space). We do NOT let the
// annotation draw, because its vertical position tracks each note's stem/heads
// and the lyrics end up zig-zagging; instead we draw them on one flat baseline
// afterwards (see drawRowLyrics). Each syllable snaps to the nearest note in
// time, kept in order so the line reads left to right.
function attachLyrics(notes, measure, lyrics) {
  if (!lyrics || !lyrics.length) return;
  const mStart = frac(measure.position);
  const mDur = frac(measure.duration);
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
    // Walk forward to the candidate note closest to this syllable's time,
    // never moving backward (monotonic → one syllable per note, in order).
    while (ni + 1 < cand.length &&
           Math.abs(cand[ni + 1].__posf - s.rel) < Math.abs(cand[ni].__posf - s.rel)) {
      ni++;
    }
    const note = cand[ni];
    if (note.__lyric) {
      // Overflow (more syllables than notes): merge onto this note.
      note.__lyric += ' ' + s.text;
      note.__cont = s.cont;
      note.__ann.text = note.__lyric;
    } else {
      // Reserve width with the bare syllable; the hyphen is drawn later,
      // centred in the gap to the next syllable (see drawRowLyrics).
      const ann = new VF.Annotation(s.text);
      ann.setFont(...LYRIC_FONT);
      note.addModifier(ann, 0);
      note.__lyric = s.text;
      note.__cont = s.cont;
      note.__ann = ann;
    }
    ni = Math.min(ni + 1, cand.length - 1);
  }
}

// Draw the whole row's lyrics on one flat baseline, each syllable centred under
// its note. Done at row level (not per measure) so a continuing syllable can
// place its hyphen centred in the gap to the NEXT syllable — even across a bar
// line — the way Songsterr does it. `items` is [{x, text, cont}] with absolute x.
function drawRowLyrics(ctx, y, items) {
  if (!items.length) return;
  items.sort((a, b) => a.x - b.x);
  ctx.save();
  ctx.setFont(...LYRIC_FONT);
  ctx.setFillStyle(LYRIC_COLOR);
  const halfDash = ctx.measureText('-').width / 2;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const w = ctx.measureText(it.text).width;
    ctx.fillText(it.text, it.x - w / 2, y);
    if (it.cont && i + 1 < items.length) {
      const next = items[i + 1];
      const rightEdge = it.x + w / 2;
      const leftEdge = next.x - ctx.measureText(next.text).width / 2;
      const hx = (rightEdge + leftEdge) / 2;
      ctx.fillText('-', hx - halfDash, y);
    }
  }
  ctx.restore();
}

// Build one measure's renderables once (tickables, voice, tuplets, min width).
// Pulled out of renderRow so the score can be measured for line-breaking before
// any row is laid out. Tuplet objects are created here (not at draw time) so
// VF.Tuplet's tick reduction is already in effect for the width precalc.
function buildMeasure(m, lyrics) {
  const { tickables: notes, tuplets: tupletSpecs } = buildMeasureTickables(m);
  let voice = null, minW = 40;
  const tuplets = [];
  if (notes.length) {
    // Attach lyrics first so their width feeds into the min-width estimate —
    // lyric-heavy bars then get proportionally wider, like Songsterr.
    attachLyrics(notes, m, lyrics);
    for (const t of tupletSpecs) {
      try {
        tuplets.push(new VF.Tuplet(t.notes, {
          num_notes: t.num_notes, notes_occupied: t.notes_occupied,
          bracketed: t.bracketed, ratioed: false, location: VF.Tuplet.LOCATION_TOP,
        }));
      } catch (e) { console.warn('tuplet failed m', m.index, e); }
    }
    voice = new VF.Voice({ num_beats: m.time_sig[0], beat_value: m.time_sig[1] });
    voice.setStrict(false).addTickables(notes);
    try {
      minW = new VF.Formatter().preCalculateMinTotalWidth([voice]);
    } catch (e) { console.warn('minwidth failed m', m.index, e); }

    // Floor the bar's min width by its note count — ghost noteheads carry
    // parentheses that VexFlow's preCalc under-reserves. This makes the packer
    // give a dense 16th run (e.g. Come As You Are's Refrain) enough room, putting
    // FEWER such bars per row on a narrow window instead of crowding them. At a
    // wide window the floor doesn't bind, so the spacious look is unchanged.
    let floor = 0;
    for (const n of notes) floor += (n.__hasGhost ? 30 : 17);
    minW = Math.max(minW, floor);
  }
  return { m, notes, voice, minW, tuplets };
}

// Distribute a row's available width across its measures PROPORTIONALLY TO
// MUSICAL DURATION (a 4/4 bar gets twice a 2/4 bar), subject to a per-measure
// minimum (its min legible width) so dense bars are never crushed. One-pass
// water-filling / isotonic projection: repeatedly pin any measure whose
// proportional share falls below its floor, then split the remaining width among
// the rest by weight. The row packer keeps Σ floors ≤ total, so slack stays ≥ 0.
function allocateWidths(weights, floors, total) {
  const n = weights.length;
  const w = new Array(n).fill(0);
  const fixed = new Array(n).fill(false);
  let remaining = total;
  for (let pass = 0; pass <= n; pass++) {
    let wsum = 0;
    for (let i = 0; i < n; i++) if (!fixed[i]) wsum += weights[i];
    if (wsum <= 0) break;
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      if (remaining * weights[i] / wsum < floors[i]) {
        w[i] = floors[i]; fixed[i] = true; remaining -= floors[i]; changed = true;
      }
    }
    if (!changed) {
      for (let i = 0; i < n; i++) if (!fixed[i]) w[i] = remaining * weights[i] / wsum;
      break;
    }
  }
  for (let i = 0; i < n; i++) if (!fixed[i] && w[i] === 0) w[i] = floors[i];
  return w;
}

// Re-space one bar's tickables so horizontal position is proportional to musical
// ONSET (quarter ⇒ 2× the room of an eighth; triplet members evenly fill their
// span), then project to honour a minimum centre-to-centre gap so heads, dots
// and reserved lyric widths never collide. Onsets come from cumulative ticks
// (covers notes, rests and tuplets); footprints from each tickable's formatted
// width. We move each tickable's TickContext x, so stems, beams, heads and the
// cursor anchors (read after draw) all follow. Composed with duration-weighted
// bar widths, this makes the cursor's pixel velocity constant within a steady
// bar — the spatial half of "smooth".
function applyProportionalSpacing(voice, usable) {
  const ticks = voice.getTickables();
  const n = ticks.length;
  if (n < 2 || usable <= 0) return;
  let total = 0;
  try { total = voice.getTicksUsed().value(); } catch (_) {}
  if (!total) return;

  const ideal = new Array(n), half = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    ideal[i] = (acc / total) * usable;
    let wd = 12; try { wd = ticks[i].getWidth() || wd; } catch (_) {}
    half[i] = wd / 2;
    let tk = 0; try { tk = ticks[i].getTicks().value(); } catch (_) {}
    acc += tk;
  }
  const PAD = 4;
  const gap = i => half[i] + half[i + 1] + PAD;   // min centre-to-centre

  // Feasibility: can the bar hold every note at its minimum centre-to-centre
  // spacing? Dense 16th runs widened by ghost-note parentheses sometimes can't.
  // If we forced the onset projection anyway, the backward pass below could place
  // a LATER note left of an earlier one — non-monotonic x — which both crams the
  // heads to one side and makes the playback cursor jump backwards. When it won't
  // fit, keep VexFlow's own formatted positions (justified to fill, always
  // monotonic) instead. (Come As You Are bars 27-29/31-32.)
  let need = half[0] + half[n - 1];
  for (let i = 0; i < n - 1; i++) need += gap(i);
  if (need > usable) return;

  const x = ideal.slice();
  x[0] = Math.max(half[0], x[0]);                                            // left edge in bounds
  for (let i = 1; i < n; i++) x[i] = Math.max(x[i], x[i - 1] + gap(i - 1));  // push right to clear
  x[n - 1] = Math.min(x[n - 1], usable - half[n - 1]);                       // right edge in bounds
  for (let i = n - 2; i >= 0; i--) x[i] = Math.min(x[i], x[i + 1] - gap(i)); // pull back toward ideal
  for (let i = 1; i < n; i++) if (x[i] < x[i - 1]) x[i] = x[i - 1];          // hard monotonic latch: never let the cursor reverse

  for (let i = 0; i < n; i++) {
    const tc = ticks[i].getTickContext && ticks[i].getTickContext();
    if (tc && tc.setX) tc.setX(x[i]);
  }
}

// Lay out and draw one row of pre-built measures into `container`, sized to
// `pageWidth`. Bar widths are proportional to musical duration (floored at each
// bar's min legible width) and notes are placed proportionally to onset time.
// `fillFrac` (0..1) is how much of the page this row should occupy: a full
// MAX_BARS row of the song's typical meter fills the width; a short section row
// (forced break, or a partial tail) lays out at its natural width, left-aligned,
// like a paragraph's last line — so a lone bar never smears across the screen and
// repeated phrases stack in aligned columns.
function renderRow(built, rowIdx, container, pageWidth, fillFrac) {
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(pageWidth, ROW_HEIGHT);
  const ctx = renderer.getContext();
  // A viewBox (matching the px size, so 1:1 on screen) lets print CSS scale the
  // row to the paper width via `.row svg { width: 100% }` — the fallback for when
  // beforeprint can't re-render (iPad Safari). On screen the svg isn't CSS-scaled,
  // so the cursor's px == user-unit assumption is unaffected.
  const svgEl = container.querySelector('svg');
  if (svgEl) svgEl.setAttribute('viewBox', '0 0 ' + pageWidth + ' ' + ROW_HEIGHT);

  const clefWidth = isFirstRow(rowIdx) ? CLEF_W : 0;
  const availWidth = (pageWidth - SIDE_MARGIN * 2 - clefWidth) * (fillFrac || 1);
  // Bar widths proportional to musical duration (not content density), floored at
  // each bar's min legible width. A 2/4 bar is then half a 4/4 bar, and the whole
  // row is one linear time→x map (constant cursor velocity within a steady bar).
  const weights = built.map(b => b.m.duration[0] / b.m.duration[1]);
  const floors = built.map(b => b.minW);
  const widths = allocateWidths(weights, floors, availWidth);

  const rowLyrics = [];   // {x, text, cont} collected across the row, drawn last
  let baselineY = ROW_TOP;

  // Playback-cursor anchors for this row: {seconds, x} at each notehead, plus a
  // single edge anchor at each END of the row. Interior bar lines deliberately
  // get NO edge anchor — two anchors at the same time (measure i's end and
  // measure i+1's start share a score position) but different x would teleport
  // the bar across the bar-line gap. Instead the bar glides straight from the
  // last note of one bar through the bar line to the first note of the next.
  const rowAnchors = [];
  let rowYTop = null, rowYBottom = null;
  let rowStartPos = null, rowStartX = 0, rowEndPos = 0, rowEndX = 0;

  let x = SIDE_MARGIN;
  for (let i = 0; i < built.length; i++) {
    const { m, notes, voice, tuplets } = built[i];
    const myWidth = widths[i] + (i === 0 ? clefWidth : 0);
    const stave = new VF.Stave(x, ROW_TOP, myWidth);
    // Thin grey staff lines / barlines / clef / measure number.
    stave.setStyle({ strokeStyle: STAVE_COLOR, fillStyle: STAVE_COLOR, lineWidth: STAVE_LINE_WIDTH });
    if (i === 0 && isFirstRow(rowIdx)) {
      stave.addClef('percussion').addTimeSignature(m.time_sig.join('/'));
    }
    stave.setMeasure(m.index);
    stave.setContext(ctx).draw();
    baselineY = stave.getYForLine(4) + BEAM_DROP + LYRIC_GAP;

    // Capture the row's outer edges for the two end anchors (left edge of the
    // first stave, right edge of the last). rowEndPos/X are overwritten each
    // measure so they end up holding the last measure's values.
    if (SCHED) {
      const mStart = m.position[0] / m.position[1];
      const mEnd = mStart + m.duration[0] / m.duration[1];
      if (rowStartPos === null) {
        rowStartPos = mStart;
        rowStartX = stave.getNoteStartX();
        rowYTop = stave.getYForLine(0) - ACCENT_RISE - 4;
        rowYBottom = stave.getYForLine(4) + BEAM_DROP + LYRIC_GAP + 4;
      }
      rowEndPos = mEnd;
      rowEndX = stave.getNoteEndX();
    }

    // Section label (Intro / Verse 1 / Chorus …) drawn by hand for colour
    // control: grey italic, above the accent band, clear of the notes.
    if (m.marker) {
      ctx.save();
      ctx.setFont(...SECTION_FONT);
      ctx.setFillStyle(SECTION_COLOR);
      ctx.fillText(m.marker, stave.getNoteStartX(), stave.getYForLine(0) - SECTION_RISE);
      ctx.restore();
    }
    x += myWidth;

    if (!voice) continue;
    const noteArea = stave.getNoteEndX() - stave.getNoteStartX();
    for (const n of notes) { if (n.setStave) n.setStave(stave); }   // so getYs() works below
    try {
      new VF.Formatter().joinVoices([voice]).format([voice], noteArea - 6);
      applyProportionalSpacing(voice, noteArea - 6);
    } catch (e) { console.warn('format failed m', m.index, e); }

    // Width is now reserved; blank the annotations so they don't draw at their
    // zig-zagging note-relative positions. We draw the lyrics flat ourselves.
    for (const n of notes) { if (n.__ann) n.__ann.text = ''; }

    // Flat beams on a fixed line below the staff so every beam is horizontal and
    // at the same height across the row. Full tickable list (rests included) so
    // beams break at rests. Must run before voice.draw — beaming suppresses the
    // individual flags at draw time.
    const beamOpts = {
      stem_direction: -1, beam_rests: false, flat_beams: true,
      flat_beam_offset: stave.getYForLine(4) + BEAM_DROP,
    };
    let beams = [];
    try {
      // Beam the plain notes together; beam each tuplet group on its OWN notes so
      // a triplet's members beam as a clean unit and never merge with their
      // neighbours (the stray-flag mess in the first tuplet attempt).
      beams = VF.Beam.generateBeams(notes.filter(n => !n.__tuplet), beamOpts);
      for (const tp of tuplets) {
        beams = beams.concat(
          VF.Beam.generateBeams(tp.notes.filter(n => !(n.isRest && n.isRest())), beamOpts));
      }
    } catch (e) { console.warn('beam failed m', m.index, e); }

    // Reset the context to dark after the grey stave so note heads stay dark,
    // then grey the stems, ledger lines (matched to the staff) and beams.
    ctx.setFillStyle(NOTE_COLOR);
    ctx.setStrokeStyle(NOTE_COLOR);
    ctx.setLineWidth(1);
    for (const n of notes) {
      if (n.setStemStyle) n.setStemStyle({ strokeStyle: STEM_COLOR });
      if (n.setLedgerLineStyle) {
        n.setLedgerLineStyle({ strokeStyle: STAVE_COLOR, lineWidth: STAVE_LINE_WIDTH });
      }
    }
    for (const b of beams) {
      b.render_options.beam_width = BEAM_WIDTH;
      b.setStyle({ fillStyle: BEAM_COLOR, strokeStyle: BEAM_COLOR });
    }

    // Flat-bottom stems. A non-beamed note (quarter, half, lone hit) gets a
    // default short stem that stops well above the flat beam line, dangling
    // disconnected next to the long beamed stems. Extend each one down to that
    // same line so every stem bottoms out uniformly — the Songsterr look, and
    // the fix for the "stem that doesn't connect" report.
    const yFlat = stave.getYForLine(4) + BEAM_DROP;
    for (const n of notes) {
      if ((n.isRest && n.isRest()) || (n.hasBeam && n.hasBeam()) || !n.setStemLength) continue;
      try {
        const topY = Math.min.apply(null, n.getYs());
        if (yFlat - topY > 0) n.setStemLength(yFlat - topY);
      } catch (_) { /* no Y-values — keep the default stem */ }
    }

    voice.draw(ctx, stave);
    for (const b of beams) b.setContext(ctx).draw();
    // The beam repaints the grey stems over the note heads (and beams need the
    // notes' Y-values, so they can't draw first). Redraw the heads on top so the
    // dark circles aren't clipped by the stem line.
    ctx.setFillStyle(NOTE_COLOR);
    ctx.setStrokeStyle(NOTE_COLOR);
    for (const n of notes) {
      if ((n.isRest && n.isRest()) || !n.drawNoteHeads) continue;
      n.drawNoteHeads();
    }
    drawAccentBand(ctx, stave, notes);

    // Tuplet brackets / "3" — drawn last because they read the notes' rendered
    // Y positions (set by voice.draw). Grey to match the section labels.
    if (tuplets && tuplets.length) {
      ctx.save();
      ctx.setFillStyle(SECTION_COLOR);
      ctx.setStrokeStyle(SECTION_COLOR);
      for (const tp of tuplets) {
        try { tp.setContext(ctx).draw(); } catch (e) { console.warn('tuplet draw m', m.index, e); }
      }
      ctx.restore();
    }

    // Collect this bar's lyrics (drawn together afterwards so hyphens can span
    // bar lines) and the per-note cursor anchors (bar lands on each notehead).
    for (const n of notes) {
      if (SCHED && n.__abspos != null && !(n.isRest && n.isRest())) {
        rowAnchors.push({
          seconds: SCHED.at(n.__abspos),
          x: (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2,
        });
      }
      if (!n.__lyric) continue;
      rowLyrics.push({ x: (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2, text: n.__lyric, cont: n.__cont });
    }
  }

  drawRowLyrics(ctx, baselineY, rowLyrics);

  if (!SCHED || rowStartPos === null) return null;

  // Noteheads are already in rowAnchors (left→right = increasing time). Add a
  // left-edge anchor ONLY when there's a real gap before the first note (a
  // leading rest / anacrusis); when the first note is on the downbeat it IS
  // the start, and a same-time left-edge anchor would jump the bar onto it.
  // Always add a right-edge anchor so the bar reaches the row's end exactly at
  // the bar line (the only place a screen jump is wanted — the line wrap) and
  // so row k's endSec == row k+1's startSec for a seamless hand-off.
  const EPS = 1e-4;
  const startSec = SCHED.at(rowStartPos);
  const endSec = SCHED.at(rowEndPos);
  rowAnchors.sort((a, b) => a.seconds - b.seconds);
  if (!rowAnchors.length || rowAnchors[0].seconds > startSec + EPS) {
    rowAnchors.unshift({ seconds: startSec, x: rowStartX });
  }
  if (!rowAnchors.length || rowAnchors[rowAnchors.length - 1].seconds < endSec - EPS) {
    rowAnchors.push({ seconds: endSec, x: rowEndX });
  }
  // Drop any anchors that collapse to the same instant (safety against float
  // dupes); equal-time/different-x pairs are exactly what caused the jerk.
  const anchors = [];
  for (const a of rowAnchors) {
    if (anchors.length && a.seconds - anchors[anchors.length - 1].seconds < EPS) continue;
    anchors.push(a);
  }
  return {
    div: container,
    svg: container.querySelector('svg'),
    anchors,
    startSec: anchors[0].seconds,
    endSec: anchors[anchors.length - 1].seconds,
    yTop: rowYTop,
    yBottom: rowYBottom,
  };
}

function renderScore(score, container, forceWidth) {
  const measures = score.measures;
  const lyrics = score.lyrics || [];
  ROWS = [];
  container.innerHTML = '';

  // Size to the container (the iPad's real width); fall back to PAGE_WIDTH if it
  // hasn't laid out yet. This is what makes the score fit any screen. `forceWidth`
  // overrides it for print, where we lay rows out to the paper's printable width.
  const pageWidth = forceWidth || Math.max(MIN_PAGE_WIDTH, Math.floor(container.clientWidth) || PAGE_WIDTH);

  // Build every measure once, then greedily pack measures into rows: at most
  // MAX_BARS_PER_ROW, fewer when the next bar wouldn't fit COMFORTABLY, AND a
  // forced break before every section marker so each section (Intro / Verse /
  // Chorus …) starts flush-left on its own line. That left margin becomes the
  // spine you read the song's form down, and an 8-bar section lands as two
  // stacked rows of 4 — repeated phrases line up vertically instead of drifting
  // mid-row. Packing only to each bar's *minimum* legible width (scale ≈ 1) reads
  // as crowded, so we require every row to stay at ≥ COMFORT × the minimum —
  // dense or lyric-heavy bars (and narrow screens) then get fewer per row, with
  // air around every note, like Songsterr. No manual knob; never wider than screen.
  const COMFORT = 1.6;
  const weightOf = m => m.duration[0] / m.duration[1];
  const builtAll = measures.map(m => buildMeasure(m, lyrics));
  const usableFirst = (pageWidth - SIDE_MARGIN * 2 - CLEF_W) / COMFORT;
  const usableRest = (pageWidth - SIDE_MARGIN * 2) / COMFORT;
  const rows = [];
  let cur = [], curW = 0;
  for (const b of builtAll) {
    const usable = (rows.length === 0) ? usableFirst : usableRest;
    const newSection = !!b.m.marker;   // every marked measure opens a fresh line
    if (cur.length && (newSection || cur.length >= MAX_BARS_PER_ROW || curW + b.minW > usable)) {
      rows.push(cur); cur = []; curW = 0;
    }
    cur.push(b); curW += b.minW;
  }
  if (cur.length) rows.push(cur);

  // A "full" row = MAX_BARS_PER_ROW bars of the song's most common meter; that
  // fills the page. Rows carrying less musical time (a short section, a partial
  // tail, the 2/4 intro) fill proportionally less and sit left-aligned, so one
  // whole-note occupies the same width in every row and the columns align.
  const freq = new Map();
  for (const m of measures) { const w = weightOf(m); freq.set(w, (freq.get(w) || 0) + 1); }
  let modalW = 1, best = -1;
  for (const [w, c] of freq) { if (c > best) { best = c; modalW = w; } }
  const fullRowWeight = MAX_BARS_PER_ROW * modalW;

  rows.forEach((rowBuilt, idx) => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';
    container.appendChild(rowDiv);
    const rowWeight = rowBuilt.reduce((s, b) => s + weightOf(b.m), 0);
    const fillFrac = fullRowWeight > 0 ? Math.min(1, rowWeight / fullRowWeight) : 1;
    try {
      const rec = renderRow(rowBuilt, idx, rowDiv, pageWidth, fillFrac);
      if (rec) ROWS.push(rec);
    } catch (e) {
      rowDiv.textContent = '[row render error: ' + e.message + ']';
      console.error('row', idx, e);
    }
  });
}

// ── Travelling-bar playback (Phase 1) ─────────────────────────────────────────
// One opaque green vertical rect, parented to the active row's <svg> (SVG user
// units == screen px here — the svg isn't CSS-scaled). On a row change we
// re-parent it (also brings it on top) and reset its y/height; every frame we
// just set x. All timing is in score-seconds (YT.getCurrentTime() - OFFSET).

function makeBar() {
  BAR_RECT = document.createElementNS(SVG_NS, 'rect');
  BAR_RECT.id = 'cursor-bar';   // so print CSS can hide it
  BAR_RECT.setAttribute('fill', BAR_COLOR);
  BAR_RECT.setAttribute('fill-opacity', BAR_OPACITY);
  BAR_RECT.setAttribute('width', BAR_WIDTH);
  BAR_RECT.setAttribute('rx', 1.5);
  BAR_RECT.setAttribute('pointer-events', 'none');
  // Driven by CSS transform (compositor layer) rather than the x attribute, so
  // per-frame moves never trigger an SVG repaint/relayout — smoother on iPad.
  // The svg isn't CSS-scaled, so 1px == 1 user unit; transform-box/origin are
  // pinned so the translate is unambiguous.
  BAR_RECT.setAttribute('x', 0);
  BAR_RECT.style.willChange = 'transform';
  BAR_RECT.style.transformBox = 'view-box';
  BAR_RECT.style.transformOrigin = '0 0';
  const r0 = ROWS[0];
  r0.svg.appendChild(BAR_RECT);
  BAR_RECT.setAttribute('y', r0.yTop);
  BAR_RECT.setAttribute('height', r0.yBottom - r0.yTop);
  BAR_RECT.style.transform = 'translate3d(' + (r0.anchors[0].x - BAR_WIDTH / 2) + 'px,0,0)';
  ACTIVE_ROW = 0;
}

// Interpolate the bar's x within a row from score-seconds, between the two
// bracketing anchors. `row._hint` caches the last segment so the common
// forward case is O(1).
function xAtTime(row, t) {
  const a = row.anchors;
  if (t <= a[0].seconds) return a[0].x;
  if (t >= a[a.length - 1].seconds) return a[a.length - 1].x;
  let i = row._hint || 0;
  if (i >= a.length - 1 || a[i].seconds > t) i = 0;
  while (i < a.length - 1 && a[i + 1].seconds <= t) i++;
  row._hint = i;
  const s0 = a[i].seconds, s1 = a[i + 1].seconds;
  const f = s1 > s0 ? (t - s0) / (s1 - s0) : 0;
  return a[i].x + f * (a[i + 1].x - a[i].x);
}

function updateBar(t) {
  if (!ROWS.length || !BAR_RECT) return;
  let r = ACTIVE_ROW < 0 ? 0 : ACTIVE_ROW;
  while (r > 0 && t < ROWS[r].startSec) r--;
  while (r < ROWS.length - 1 && t >= ROWS[r].endSec) r++;
  const row = ROWS[r];
  if (r !== ACTIVE_ROW) {
    row.svg.appendChild(BAR_RECT);
    BAR_RECT.setAttribute('y', row.yTop);
    BAR_RECT.setAttribute('height', row.yBottom - row.yTop);
    ACTIVE_ROW = r;
    centerRow(row.div);          // teleprompter: keep the active row centred
  }
  BAR_RECT.style.transform = 'translate3d(' + (xAtTime(row, t) - BAR_WIDTH / 2) + 'px,0,0)';
}

// Teleprompter scroll: keep the active row vertically centred in the reading
// zone — the screen above the sticky bottom dock — so the green bar never drops
// behind the controls.
function centerRow(div) {
  const dock = document.getElementById('dock');
  const dockH = dock ? dock.getBoundingClientRect().height : 0;
  const zone = Math.max(120, window.innerHeight - dockH);
  const rect = div.getBoundingClientRect();
  const rowCenterAbs = window.scrollY + rect.top + rect.height / 2;
  const target = rowCenterAbs - zone / 2;
  window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

// The bar runs on performance.now() (the iPad-safe clock — Tone.Transport stalls
// when a silent AudioContext suspends; see the ios-audiocontext note), corrected
// toward the YouTube sensor by the PI loop above.

// Hard-set the estimator to a known media time (first sync, resume, seek, rate
// change): rate resets to nominal and the monotonic latch is released, so a
// backward seek can legitimately move the bar back.
function clkHardSet(scoreSec) {
  CLK_M = scoreSec;
  CLK_R = PLAYBACK_RATE;
  CLK_OUT = scoreSec;
}

// Read getCurrentTime() and re-anchor hard. Used on Sync / resume / speed change.
function clkResync() {
  let y; try { y = YT_PLAYER.getCurrentTime(); } catch (_) { return; }
  if (typeof y !== 'number' || !isFinite(y)) return;
  CLK_RAW = y;
  CLK_TAU = performance.now() / 1000;
  clkHardSet(y - OFFSET);
}

// Predict: advance the phase by rate × wall-time elapsed since the last call.
function clkPredict(tau) {
  CLK_M += CLK_R * (tau - CLK_TAU);
  CLK_TAU = tau;
}

// Correct: fuse a fresh sensor reading. The value is constant for ~250 ms, so we
// ignore unchanged samples (feeding duplicates in is what makes a naive loop
// oscillate). A small residual nudges phase and trims rate; a large one is a
// seek, so we hard-set.
function clkCorrect() {
  let y; try { y = YT_PLAYER.getCurrentTime(); } catch (_) { return; }
  if (typeof y !== 'number' || !isFinite(y) || y === CLK_RAW) return;
  CLK_RAW = y;
  const e = (y - OFFSET) - CLK_M;
  if (Math.abs(e) > CLK_SEEK_EPS) { clkHardSet(y - OFFSET); return; }
  CLK_M += CLK_KP * e;
  CLK_R += CLK_KI * e;
  const lo = PLAYBACK_RATE * 0.8, hi = PLAYBACK_RATE * 1.2;
  if (CLK_R < lo) CLK_R = lo; else if (CLK_R > hi) CLK_R = hi;
}

function startBarLoop() {
  let lastStatus = 0;
  const frame = () => {
    // SYNCED gates out the preroll-ad window: until the user taps Sync, the bar
    // stays parked at beat 1 even while the video (or its ad) is playing.
    if (YT_READY && SYNCED && IS_PLAYING) {
      const tau = performance.now() / 1000;
      clkPredict(tau);                 // advance the smooth phase
      clkCorrect();                    // fuse a fresh YT sample if there is one
      let t = CLK_M + LATENCY_LEAD;
      // Monotonic latch: while playing the bar never steps back, independent of
      // gain tuning. A seek/resync releases it (CLK_OUT was reset in clkHardSet).
      if (t < CLK_OUT) t = CLK_OUT; else CLK_OUT = t;
      updateBar(t);
      if (tau - lastStatus > 0.2) { updateStatus(t); lastStatus = tau; }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ── Transport FSM (YouTube-only; the deployed player's FSM minus sampled drums)
//   IDLE    ▶ Play  → start the video (a preroll ad may run)         → PRESYNC
//   PRESYNC ▶ Sync  → align the cursor to the song's current time    → PLAYING
//   PLAYING ⏸ Pause → pause the video                                → PAUSED
//   PAUSED  ▶ Play  → resume (the next resample re-aligns the bar)    → PLAYING
function playerState() {
  if (!STARTED) return 'IDLE';
  if (!SYNCED) return 'PRESYNC';
  return IS_PLAYING ? 'PLAYING' : 'PAUSED';
}

function onTransport() {
  if (!YT_READY) return;
  switch (playerState()) {
    case 'IDLE':    STARTED = true; try { YT_PLAYER.setPlaybackRate(PLAYBACK_RATE); } catch (_) {} YT_PLAYER.playVideo(); break;
    case 'PRESYNC': doSync(); break;
    case 'PLAYING': YT_PLAYER.pauseVideo(); break;
    case 'PAUSED':  YT_PLAYER.playVideo(); break;
  }
  refreshTransport();
}

function refreshTransport() {
  const btn = document.getElementById('transport');
  if (!btn) return;
  const s = playerState();
  const labels = { IDLE: '▶ Play', PRESYNC: '▶ Sync', PLAYING: '⏸ Pause', PAUSED: '▶ Play' };
  const hints = {
    IDLE: 'Press Play. After any ad, tap Sync the moment the song starts.',
    PRESYNC: 'Ad running? Wait or Skip — then tap Sync when the song starts.',
    PLAYING: '',
    PAUSED: 'Paused.',
  };
  btn.textContent = labels[s];
  btn.disabled = !YT_READY;
  btn.classList.toggle('attention', s === 'PRESYNC');   // nudge toward Sync
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = hints[s];
}

// Sync (mirrors the deployed player's onStartMusic): align the cursor to the
// video's CURRENT position via the known youtube_offset, so it's right no matter
// how long an ad ran. Re-anchoring (here and on resume / speed change) means a
// mistimed Sync self-corrects within one 250 ms sample.
function doSync() {
  if (!YT_READY) return;
  SYNCED = true;
  clkResync();
  refreshTransport();
}

function setRate(delta) {
  RATE_IDX = Math.max(0, Math.min(RATES.length - 1, RATE_IDX + delta));
  PLAYBACK_RATE = RATES[RATE_IDX];
  try { if (YT_PLAYER) YT_PLAYER.setPlaybackRate(PLAYBACK_RATE); } catch (_) {}
  if (SYNCED) clkResync();   // re-anchor at the new rate so the bar doesn't lurch
  const el = document.getElementById('rate');
  if (el) el.textContent = Math.round(PLAYBACK_RATE * 100) + '%';
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function updateStatus(t) {
  const el = document.getElementById('status');
  if (!el || !MEASURE_TIMELINE.length) return;
  let i = 0;
  while (i < MEASURE_TIMELINE.length - 1 && MEASURE_TIMELINE[i + 1].sec <= t) i++;
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
      videoId: videoId, width: 160, height: 90,
      playerVars: { playsinline: 1 },
      events: {
        onReady: () => { YT_READY = true; refreshTransport(); },
        onStateChange: (e) => {
          IS_PLAYING = (e.data === YT.PlayerState.PLAYING);
          if (IS_PLAYING) STARTED = true;            // play via the app button OR YouTube's own play → advance the button to Sync
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

function wireControls() {
  const t = document.getElementById('transport');
  if (t) t.addEventListener('click', onTransport);
  const slower = document.getElementById('slower');
  const faster = document.getElementById('faster');
  if (slower) slower.addEventListener('click', () => setRate(-1));
  if (faster) faster.addEventListener('click', () => setRate(+1));

  // Overflow (⋮) menu: toggle on its button, close on any outside click.
  const moreBtn = document.getElementById('morebtn');
  const moreMenu = document.getElementById('moremenu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', e => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; });
    document.addEventListener('click', e => {
      if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreBtn) moreMenu.hidden = true;
    });
  }
}

function closeMoreMenu() {
  const m = document.getElementById('moremenu');
  if (m) m.hidden = true;
}

function buildMeasureTimeline(score) {
  MEASURE_TIMELINE = [];
  if (!SCHED) return;
  for (const m of score.measures) {
    MEASURE_TIMELINE.push({ sec: SCHED.at(m.position[0] / m.position[1]), idx: m.index, marker: m.marker || '' });
  }
}

let _resizeTimer = null;
function onResize() {
  if (_printing) return;   // print re-renders manage their own sizing
  if (!SCORE_REF) return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    renderScore(SCORE_REF, document.getElementById('score'));
    if (SCHED && ROWS.length) makeBar();   // re-attach the bar to the fresh rows
  }, 200);
}

// ── Print to Letter ───────────────────────────────────────────────────────────
// Re-lay the score to the paper's printable width (~7.5in at 96dpi) so the line
// breaks are right on the page, not the screen. enterPrint/exitPrint are
// idempotent and reached three ways for cross-browser cover: the Print button,
// the beforeprint/afterprint events (desktop), and a matchMedia('print') change
// (iPad Safari, which doesn't reliably fire beforeprint).
const PRINT_WIDTH = 960;   // ~10in printable on Letter landscape at 96dpi (fits 4 bars/row)
let _printing = false;

function enterPrint() {
  if (_printing || !SCORE_REF) return;
  _printing = true;
  if (BAR_RECT) BAR_RECT.style.display = 'none';
  renderScore(SCORE_REF, document.getElementById('score'), PRINT_WIDTH);
}

function exitPrint() {
  if (!_printing || !SCORE_REF) return;
  _printing = false;
  renderScore(SCORE_REF, document.getElementById('score'));   // back to screen width
  if (SCHED && ROWS.length) { makeBar(); if (BAR_RECT) BAR_RECT.style.display = ''; }
}

function setupPrint(score) {
  const hdr = document.getElementById('print-header');
  if (hdr) {
    const bpm = score.tempo_changes[0]?.bpm;
    const sub = [`${score.measures.length} bars`];
    if (bpm) sub.push(`${bpm} bpm`);
    if (score.drummer) sub.push(score.drummer);
    hdr.innerHTML =
      `<div class="pt"></div><div class="ps"></div>`;
    hdr.querySelector('.pt').textContent = `${score.artist} — ${score.title}`;
    hdr.querySelector('.ps').textContent = sub.join('  ·  ');
  }
  const btn = document.getElementById('printbtn');
  if (btn) btn.addEventListener('click', () => { closeMoreMenu(); enterPrint(); setTimeout(() => window.print(), 60); });
  window.addEventListener('beforeprint', enterPrint);
  window.addEventListener('afterprint', exitPrint);
  const mq = window.matchMedia && window.matchMedia('print');
  if (mq) {
    const onChange = e => { if (e.matches) enterPrint(); else exitPrint(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);   // older Safari
  }
}

function boot() {
  const score = window.SCORE;
  if (!score) {
    const h = document.getElementById('heading');
    if (h) h.textContent = 'No window.SCORE — load a score_*.js first.';
    return;
  }
  SCORE_REF = score;
  document.title = `${score.artist} — ${score.title}`;
  const st = document.getElementById('status');
  // The status line shows the song before play and the live bar/section readout
  // once the cursor is running (updateStatus overwrites it).
  if (st) st.textContent = `${score.artist} — ${score.title}`;

  // Timing before render — renderRow reads SCHED to lay down the cursor anchors.
  SCHED = buildSecondsAt(score);
  OFFSET = SCHED ? SCHED.offset : 0;
  buildMeasureTimeline(score);

  renderScore(score, document.getElementById('score'));

  wireControls();
  setupPrint(score);
  window.addEventListener('resize', onResize);

  if (SCHED && ROWS.length && score.youtube_id) {
    makeBar();
    initYt(score.youtube_id);
    startBarLoop();
  }
  refreshTransport();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
