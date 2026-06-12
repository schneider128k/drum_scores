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
// One box per rendered measure, in viewBox user-units of its row's <svg>:
// { index, x0, x1, svg, yTop, yBottom }. Cleared and repopulated every renderScore;
// drawLoopMarkers() reads it to place the blue begin/end repeat signs.
let MEASURE_BOXES = [];
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
const BAR_PEAK_OPACITY = 0.9;   // gradient is greenest in the middle, fading to 0 at both edges (no hard contour)
const BAR_WIDTH = 12;           // still narrow; the soft fade makes the visible core ~half this
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

  const n = measures.length;
  const offset = Number(score.youtube_offset) || 0;
  const mPos = measures.map(m => m.position[0] / m.position[1]);
  const mDur = measures.map(m => m.duration[0] / m.duration[1]);

  // points[i] is the recording-time of measure i's downbeat. Songsterr often
  // supplies one extra trailing anchor — the downbeat *after* the final
  // measure (points.length === n + 1) — which is a useful end-anchor, not an
  // error. (It used to make us bail out entirely, leaving the song with no
  // cursor, no video and a disabled Play button.) Clamp to the measures we
  // have, give every anchored measure a real next-anchor end when one exists,
  // and extrapolate only the tail measures that fall past the last anchor.
  const anchored = Math.min(points.length, n);
  const starts = new Array(n);
  const ends = new Array(n);
  for (let i = 0; i < anchored; i++) starts[i] = points[i] - offset;
  for (let i = 0; i < anchored; i++) {
    if (i + 1 < points.length) ends[i] = points[i + 1] - offset;
  }

  // Close the last anchored measure (if it has no next-anchor) using the local
  // seconds-per-whole-note from the preceding anchored pair, then extrapolate
  // any remaining tail measures at that same rate.
  const last = anchored - 1;
  const spw = (last >= 1 && mDur[last - 1] > 0)
    ? (starts[last] - starts[last - 1]) / mDur[last - 1]
    : 1.0;
  if (ends[last] === undefined) ends[last] = starts[last] + spw * mDur[last];
  let cursor = ends[last];
  for (let i = last + 1; i < n; i++) {
    starts[i] = cursor;
    cursor += spw * mDur[i];
    ends[i] = cursor;
  }
  if (!isFinite(ends[n - 1])) return null;

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
  cowbell:        { key: 'd/5/t2', voice: 1 },
  tambourine:     { key: 'b/5/x3', voice: 1 },
  vibraslap:      { key: 'b/5/x3', voice: 1 },
};

// Plain-language names for the drum key shown at the bottom of each score.
// Pieces that share the same notehead+position are grouped into one entry.
const PIECE_LABEL = {
  closedhihat:  'Hi-hat (closed)', openhihat: 'Hi-hat (open)',
  halfopenhihat:'Hi-hat (half-open)', pedalhihat: 'Hi-hat (foot)',
  ridecymbal:   'Ride', ridebell: 'Ride bell',
  crashcymbal:  'Crash', crashcymbalb: 'Crash',
  splashcymbal: 'Splash', chinesecymbal: 'China',
  cowbell:      'Cowbell', tambourine: 'Tambourine', vibraslap: 'Vibraslap',
  hightom:      'High tom', lowtom: 'Mid tom', tommh: 'Mid tom',
  highfloortom: 'Floor tom (high)', lowfloortom: 'Floor tom (low)',
  acousticsnare:'Snare', sidestick: 'Cross-stick', bassdrum: 'Bass drum (kick)',
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

      // Ghost notes: render the notehead in grey instead of parenthesising it —
      // "quieter = fainter", and far more compact than ( ) in dense 16th runs.
      // accent = strongest in the chord (drawn later as a uniform top band).
      let maxAccent = 0;
      chord.forEach((c, j) => {
        if (c.dn.ghost) n.setKeyStyle(j, { fillStyle: GHOST_COLOR, strokeStyle: GHOST_COLOR });
        if (c.dn.accent > maxAccent) maxAccent = c.dn.accent;
      });
      n.__accent = maxAccent;
      n.__posf = t.relpos[0] / t.relpos[1];
      n.__abspos = mPos[0] / mPos[1] + n.__posf;
    }
    // Notehead glyph size (screen default 39; print 45 so the thin ✕ closed-hi-hat
    // reads). Set before formatting so the spacing accounts for the larger heads.
    if (n.render_options) n.render_options.glyph_font_scale = GLYPH_SCALE;
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
// Print packs rows closer vertically: the score content only spans ~[ROW_TOP-14 ..
// lyric baseline], so for print we shift it up (smaller top inset) and crop the SVG
// canvas just below the lyric line — cutting the empty headroom that caused the wide
// gaps, without clipping section labels (top) or lyrics/beams (bottom).
const PRINT_ROW_TOP = 16;
const PRINT_ROW_HEIGHT = 188;   // taller than screen-crop: print spreads the drum lanes (below)
// Print spreads the five staff lines further apart than the screen's 10px. On paper the
// vertical POSITION is what distinguishes kick/snare/tom/cymbal (they share an oval head),
// so wider lanes = faster sight-reading — the honest "a bit larger" lever when 4-bars-fill-
// width fixes the overall scale. Screen keeps VexFlow's default (undefined → 10px).
const PRINT_LINE_SPACING = 12;
const PAGE_WIDTH = 1100;     // fallback width when the container hasn't laid out yet
const MIN_PAGE_WIDTH = 360;  // floor so a tiny window still renders something legible
const CLEF_W = 70;           // width the clef + time signature eat on the first row
// Fixed bars-per-row contract: the song's 4-/8-measure structure is the spine you
// read its form down, so we ALWAYS pack a full BARS_PER_ROW per line and scale the
// engraving down (uniform CSS scale, below) to make them fit — never fewer-to-fit.
const BARS_PER_ROW = 4;      // iPad (either orientation) and print
const NARROW_BARS = 2;       // phones: 2 bars/row still keeps measure pairs together
const NARROW_BP = 700;       // px: container narrower than this is treated as a phone
const SIDE_MARGIN = 10;
const ACCENT_RISE = 26;      // px above the top staff line for the accent band
const BEAM_DROP = 35;        // px below the bottom staff line for the flat beam
const SECTION_RISE = 42;     // px above the top staff line for the section label
const LYRIC_GAP = 26;        // px below the flat beam for the (flat) lyric baseline

// Two palettes. SCREEN is the Songsterr look: note heads the only dark element,
// everything else grey, so on a bright display the eye lands on the notes. PRINT
// is high-contrast and heavier — on paper, in a dim music-room light, the grey
// staff/stems/beams nearly vanish, so for the printout we darken every line, thicken
// the staff/stems/beams, and enlarge+embolden the section labels and lyrics (the text
// a player reads at a glance). The active palette is swapped per render by applyPalette()
// (screen vs. print), so the same draw code serves both. Ghost notes stay clearly
// lighter than the black hits in BOTH palettes.
const SCREEN_PAL = {
  NOTE: '#1a1a1a', GHOST: '#9a9a9a', STAVE: '#b6b6b6', STAVE_LW: 1,
  STEM: '#8c8c8c', STEM_W: 1, BEAM: '#8c8c8c', BEAM_W: 4, ACCENT: '#777', SECTION: '#777',
  NOTE_LW: 1, GLYPH: 39,                            // 39 = VexFlow default notehead scale
  SEC_FONT: ['Georgia', 13, 'normal', 'italic'],   // grey italic, understated on screen
  LYR_FONT: ['Arial', 9, 'normal'], LYR_COLOR: '#7a7a7a',
};
const PRINT_PAL = {
  NOTE: '#000', GHOST: '#5a5a5a', STAVE: '#202020', STAVE_LW: 1.6,
  STEM: '#141414', STEM_W: 3, BEAM: '#141414', BEAM_W: 5, ACCENT: '#000', SECTION: '#000',
  NOTE_LW: 1.5, GLYPH: 45,                          // larger noteheads so the thin ✕ (closed hi-hat) reads;
  SEC_FONT: ['Georgia', 17, 'bold'],               // spacing recomputes from the bigger heads, so no collisions
  LYR_FONT: ['Arial', 11, 'bold'], LYR_COLOR: '#000',
};
let NOTE_COLOR, GHOST_COLOR, STAVE_COLOR, STAVE_LINE_WIDTH, STEM_COLOR, STEM_WIDTH,
    BEAM_COLOR, BEAM_WIDTH, ACCENT_COLOR, SECTION_COLOR, NOTE_LINE_WIDTH, GLYPH_SCALE,
    SECTION_FONT, LYRIC_FONT, LYRIC_COLOR, IS_PRINT;
function applyPalette(print) {
  const p = print ? PRINT_PAL : SCREEN_PAL;
  NOTE_COLOR = p.NOTE; GHOST_COLOR = p.GHOST; STAVE_COLOR = p.STAVE;
  STAVE_LINE_WIDTH = p.STAVE_LW; STEM_COLOR = p.STEM; STEM_WIDTH = p.STEM_W;
  BEAM_COLOR = p.BEAM; BEAM_WIDTH = p.BEAM_W; ACCENT_COLOR = p.ACCENT;
  SECTION_COLOR = p.SECTION; NOTE_LINE_WIDTH = p.NOTE_LW; GLYPH_SCALE = p.GLYPH;
  SECTION_FONT = p.SEC_FONT; LYRIC_FONT = p.LYR_FONT; LYRIC_COLOR = p.LYR_COLOR;
  IS_PRINT = !!print;
}
applyPalette(false);   // screen palette is the default until a render says otherwise

function isFirstRow(rowIdx) { return rowIdx === 0; }
function frac(f) { return f[0] / f[1]; }

// Minimum centre-to-centre breathing room between adjacent noteheads, on top of
// their two half-widths — the smallest legible gap. Used by applyProportionalSpacing
// for both the feasibility test and the spacing projection.
const SPACING_PAD = 4;
// A drawn notehead's right edge runs a few px past the tickable's getWidth() (glyph
// overhang beyond the measured box). Added to the right-boundary reservation so a
// note set flush to the bar's right edge still doesn't poke over the barline.
const HEAD_OVERHANG = 6;

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

    // Floor the bar's min width by its note count (~26px each: a notehead plus the
    // breathing room a 16th run needs to not cram). This makes the packer give a
    // dense bar (e.g. Come As You Are bar 27 — three 8ths then an eleven-note 16th
    // run) enough width, taking FEWER bars per row rather than crowding. Sparse
    // bars have few notes so the floor doesn't bind and the spacious look is kept.
    minW = Math.max(minW, notes.length * 26);
  }
  return { m, notes, voice, minW, tuplets };
}

// Give each measure its width: the LARGER of its musical-duration share of
// `target` (a 4/4 bar gets twice a 2/4 bar) and its `floor` (min legible width).
// Crucially this does NOT steal from neighbours — a dense bar that needs more
// than its share makes the row EXTEND to the right (up to `cap`, the page width)
// while its equal-duration neighbours keep their fair share. The old water-filling
// version pinned the dense bar and split the *remainder* among the rest, which
// starved a sparse bar sitting next to a ghost-heavy 16th run (Come As You Are
// Refrain: bar 30 collapsed next to bars 29/31). Only if the floors together
// overflow `cap` do we scale everything down to fit.
function allocateWidths(weights, floors, target, cap) {
  const n = weights.length;
  let wsum = 0;
  for (const w of weights) wsum += w;
  const w = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const share = wsum > 0 ? (weights[i] / wsum) * target : target / n;
    w[i] = Math.max(share, floors[i]);
    total += w[i];
  }
  if (cap && total > cap) {
    const k = cap / total;
    for (let i = 0; i < n; i++) w[i] *= k;
  }
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

  // half[i] = half the tickable's FULL formatted width (notehead + dots + the lyric/
  // accidental space it reserved) — drives the inter-note min gap, so dense syllables
  // still push heads apart. rightExt[i] = how far the drawn notehead's right edge sits
  // past the tick-context x: a stem-down drum head sits to the RIGHT of the context, so
  // its edge is ~the full width plus a few px of glyph overhang past getWidth(). We
  // reserve that on the boundary caps so no head crosses the barline.
  const ideal = new Array(n), half = new Array(n), rightExt = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    ideal[i] = (acc / total) * usable;
    let wd = 12; try { wd = ticks[i].getWidth() || wd; } catch (_) {}
    half[i] = wd / 2;
    rightExt[i] = wd + HEAD_OVERHANG;
    let tk = 0; try { tk = ticks[i].getTicks().value(); } catch (_) {}
    acc += tk;
  }
  const PAD = SPACING_PAD;
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

  // Project the ideal onset positions onto "monotone, ≥ min-gap apart, inside
  // [half[0], usable-half[n-1]]" in ONE forward sweep with a precomputed right cap.
  // M[i] = the latest x[i] may sit while still leaving room for every LATER note at
  // min gap plus the right edge; it steps left by one gap each note. Because the bar
  // passed the feasibility test (need ≤ usable), M[i] is always ≥ the running left
  // bound, so the clamp can't invert. Each x[i] is max(left-bound, ideal) capped at
  // M[i] — so it honours the proportional onset where there's room and compresses to
  // min spacing only inside a dense cluster, and the LAST note's right edge is
  // provably ≤ usable. (The old forward/clamp/back/latch sequence ran the latch AFTER
  // the right clamp, which could shove the tail back across the barline — the 32nd-run
  // overflow in The Man Who Sold The World m2/m3. This construction can't.)
  // Right cap per note: its context may sit at most usable - rightExt[i] so the drawn
  // notehead's right edge lands exactly on (never past) the note-area edge. M steps left
  // by one full gap per note AND is independently capped by each note's own head edge —
  // so no note's head crosses the barline, not just the last. (The 6-11px spill in The
  // Man Who Sold The World m2/m3 was this head-vs-context offset; the spacer ran fine,
  // nothing bailed — capping centres by half left a notehead-half hanging over.)
  const M = new Array(n);
  M[n - 1] = usable - rightExt[n - 1];
  for (let i = n - 2; i >= 0; i--) M[i] = Math.min(M[i + 1] - gap(i), usable - rightExt[i]);
  const x = new Array(n);
  let lo = half[0];                                  // left edge / running min from prior note
  for (let i = 0; i < n; i++) {
    x[i] = Math.min(M[i], Math.max(lo, ideal[i]));   // honour onset where it fits; never past the cap
    lo = x[i] + (i + 1 < n ? gap(i) : 0);            // next note must clear this one by ≥ min gap
  }

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
function renderRow(built, rowIdx, container, pageWidth, fillFrac, rowHeight, rowTop) {
  rowHeight = rowHeight || ROW_HEIGHT;
  rowTop = rowTop || ROW_TOP;
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(pageWidth, rowHeight);
  const ctx = renderer.getContext();
  // Every row is rendered at the same internal width `pageWidth` (= the uniform W
  // from renderScore) and a viewBox to match, then `.row svg { width:100% }` scales
  // the whole system DOWN to the container (screen) or page (print). The cursor and
  // its note anchors are both in these viewBox user-units, so they scale together —
  // the bar still lands on the note under any CSS scale.
  const svgEl = container.querySelector('svg');
  if (svgEl) {
    svgEl.setAttribute('viewBox', '0 0 ' + pageWidth + ' ' + rowHeight);
    // VexFlow's resize() writes an inline `style="width:<W>px;height:<H>px"`, which
    // would beat the `.row svg { width:100% }` stylesheet rule and let the row render
    // at full internal width (overflowing the screen). Clear it so the CSS scale wins;
    // the width/height ATTRIBUTES stay to give the browser the aspect ratio.
    svgEl.style.width = '';
    svgEl.style.height = '';
  }

  const clefWidth = isFirstRow(rowIdx) ? CLEF_W : 0;
  const fullAvail = pageWidth - SIDE_MARGIN * 2 - clefWidth;   // hard cap: a row never exceeds the page
  const target = fullAvail * (fillFrac || 1);                 // fillFrac-reduced ideal width
  // Bar widths proportional to musical duration (not content density), floored at
  // each bar's min legible width. A 2/4 bar is then half a 4/4 bar, and the whole
  // row is one linear time→x map (constant cursor velocity within a steady bar).
  const weights = built.map(b => b.m.duration[0] / b.m.duration[1]);
  const floors = built.map(b => b.minW);
  const widths = allocateWidths(weights, floors, target, fullAvail);

  const rowLyrics = [];   // {x, text, cont} collected across the row, drawn last
  let baselineY = rowTop;

  // Playback-cursor anchors for this row: {seconds, x} at each notehead, plus a
  // single edge anchor at each END of the row. Interior bar lines deliberately
  // get NO edge anchor — two anchors at the same time (measure i's end and
  // measure i+1's start share a score position) but different x would teleport
  // the bar across the bar-line gap. Instead the bar glides straight from the
  // last note of one bar through the bar line to the first note of the next.
  // One cursor anchor per BARLINE: each bar's downbeat second → its note-start x.
  // (Was one per notehead, which made the cursor accelerate across the trailing-rest
  // + bar-line gap after a bar's last note. Bar widths are ~proportional to duration,
  // so barline anchors give a near-constant-slope ramp = steady cursor speed.)
  const corners = [];
  let rowYTop = null, rowYBottom = null;
  let rowStartPos = null, rowStartX = 0, rowEndPos = 0, rowEndX = 0;

  let x = SIDE_MARGIN;
  for (let i = 0; i < built.length; i++) {
    const { m, notes, voice, tuplets } = built[i];
    const myWidth = widths[i] + (i === 0 ? clefWidth : 0);
    const stave = new VF.Stave(x, rowTop, myWidth,
      IS_PRINT ? { spacing_between_lines_px: PRINT_LINE_SPACING } : undefined);
    // Thin grey staff lines / barlines / clef / measure number.
    stave.setStyle({ strokeStyle: STAVE_COLOR, fillStyle: STAVE_COLOR, lineWidth: STAVE_LINE_WIDTH });
    if (i === 0 && isFirstRow(rowIdx)) {
      stave.addClef('percussion');   // clef only; the time signature is drawn ABOVE the staff (below)
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
      corners.push({ seconds: SCHED.at(mStart), x: stave.getNoteStartX() });
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

    // Time signature — ALWAYS drawn above the staff, never in it (consistent placement,
    // and an in-staff time sig would reserve note-area width, distorting the duration-
    // proportional spacing and bumping the cursor). The bar WIDTH already encodes the
    // meter (a 2/4 bar is half a 4/4 bar); this names it. Drawn on the song's first bar
    // and again at every meter change, at the section-label height so it clears the notes,
    // the accent band and the measure number; if the bar also carries a section label we
    // place it just after that label so the two never overlap.
    const prevM = measureByIndex(m.index - 1);
    if (!prevM || prevM.time_sig[0] !== m.time_sig[0] || prevM.time_sig[1] !== m.time_sig[1]) {
      ctx.save();
      let mx = stave.getNoteStartX();
      const my = stave.getYForLine(0) - SECTION_RISE;
      if (m.marker) { ctx.setFont(...SECTION_FONT); mx += ctx.measureText(m.marker).width + 12; }  // sit after the section label if both
      ctx.setFont('Georgia', 12, 'normal', 'italic');
      ctx.setFillStyle(SECTION_COLOR);
      ctx.fillText(m.time_sig.join('/'), mx, my);
      ctx.restore();
    }

    // Record this measure's box (barline-to-barline x, staff top/bottom) so the
    // loop's blue repeat signs can be overlaid later without a re-render.
    MEASURE_BOXES.push({
      index: m.index,
      x0: x, x1: x + myWidth,
      svg: svgEl,
      yTop: stave.getYForLine(0),
      yBottom: stave.getYForLine(4),
    });
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
    ctx.setLineWidth(NOTE_LINE_WIDTH);
    for (const n of notes) {
      if (n.setStemStyle) n.setStemStyle({ strokeStyle: STEM_COLOR, lineWidth: STEM_WIDTH });
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
    // bar lines). Cursor anchors are per-barline now (captured above), not per-note.
    for (const n of notes) {
      if (!n.__lyric) continue;
      rowLyrics.push({ x: (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2, text: n.__lyric, cont: n.__cont });
    }
  }

  drawRowLyrics(ctx, baselineY, rowLyrics);

  if (!SCHED || rowStartPos === null) return null;

  // Close the row with a right-edge anchor at the last bar line, so the cursor
  // reaches the row's end exactly there (the one place a screen jump is wanted —
  // the line wrap) and row k's endSec == row k+1's startSec for a seamless hand-off.
  // Then drop any anchors that collapse to the same instant (float-dupe safety).
  const EPS = 1e-4;
  corners.push({ seconds: SCHED.at(rowEndPos), x: rowEndX });
  const anchors = [];
  for (const a of corners) {
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

function renderScore(score, container, opts) {
  opts = opts || {};
  const print = !!opts.print;
  applyPalette(print);   // swap to the high-contrast/heavier palette for the printout
  const measures = score.measures;
  // Lyrics gated by the user's setting (PlayerUI); empty array = none drawn.
  const lyrics = (window.PlayerUI && !PlayerUI.lyricsOn()) ? [] : (score.lyrics || []);
  ROWS = [];
  MEASURE_BOXES = [];
  container.innerHTML = '';

  // Row capacity is FIXED as a musical TIME, not a bar count: 16 quarter-note beats
  // on iPad/print, 8 on a phone. That is four (resp. two) 4/4 bars — the historical
  // "4 bars per row" — but it now generalises to mixed meters. Three 6/4 bars are 18
  // beats and CANNOT share a row, so two of them (12 beats) fill a line and the third
  // wraps; the bar count per row therefore varies with meter while the musical time
  // per row stays bounded. The container width only selects which regime we're in.
  const cw = Math.max(MIN_PAGE_WIDTH, Math.floor(container.clientWidth) || PAGE_WIDTH);
  const barsPerRow = print ? BARS_PER_ROW : (cw < NARROW_BP ? NARROW_BARS : BARS_PER_ROW);
  const ROW_BEATS = barsPerRow * 4;   // quarter-note beats per row (16 iPad/print, 8 phone)
  const rowHeight = print ? PRINT_ROW_HEIGHT : ROW_HEIGHT;
  const rowTop = print ? PRINT_ROW_TOP : ROW_TOP;

  // Build every measure once, then greedily pack bars into a row until the next bar
  // would push the row past ROW_BEATS quarter-note beats, with a forced break before
  // every section marker so each section starts flush-left on its own line (the spine
  // you read the song's form down; an 8-bar 4/4 section still lands as two stacked
  // rows of 4 so repeated phrases line up vertically). The beat budget resets on every
  // break. A single bar longer than the budget (>16 beats) still goes on its own row —
  // a bar is never split. No comfort gate: crowding is handled by the uniform scale
  // below, never by taking fewer bars than the budget allows.
  const weightOf = m => m.duration[0] / m.duration[1];     // measure length in whole-notes
  const beatsOf  = m => weightOf(m) * 4;                    // …in quarter-note beats
  const BEAT_EPS = 1e-6;                                    // exact for 4/4, 6/4, 2/4; guards float dust
  // NOTE on COMPOUND meters (6/8, 9/8, 12/8 — none in the corpus yet, but coming):
  // beatsOf counts QUARTER-note beats, so a 6/8 bar scores 3, not the 2 dotted-quarter
  // beats a musician feels. Width stays correct either way (it's proportional to musical
  // length, i.e. whole-notes — that part is meter-agnostic). What shifts is only the
  // ROW BUDGET semantics: a 16-quarter-beat row fits ~5⅓ bars of 6/8. If that ever reads
  // as too many compound bars per line, switch the budget to "felt beats" — for n/8
  // compound meters that's numerator/3 dotted-quarters — rather than retuning ROW_BEATS.
  const builtAll = measures.map(m => buildMeasure(m, lyrics));
  const rows = [];
  let cur = [];
  let curBeats = 0;
  for (const b of builtAll) {
    const newSection = !!b.m.marker;   // every marked measure opens a fresh line
    if (cur.length && (newSection || curBeats + beatsOf(b.m) > ROW_BEATS + BEAT_EPS)) {
      rows.push(cur); cur = []; curBeats = 0;
    }
    cur.push(b);
    curBeats += beatsOf(b.m);
  }
  if (cur.length) rows.push(cur);

  // One uniform internal scale for the WHOLE score: P = internal px per whole-note,
  // chosen as the densest bar's required pixels-per-whole-note (its min legible width
  // divided by its musical length). At this scale every bar clears its floor AND every
  // whole-note of music occupies exactly P px in every row — so bar width is strictly
  // proportional to duration (a 2/4 bar is half a 4/4 bar, a 6/4 bar is one-and-a-half)
  // and equal-meter bars line up across rows. W holds a full budget of music
  // (barsPerRow whole-notes = ROW_BEATS beats) at that scale, plus margins and the
  // first-row clef. Rendering every row at W and letting `.row svg { width:100% }`
  // scale it to the container/page gives the whole score one staff size, sized so a
  // full row never crowds; denser songs simply scale smaller. (For a pure-4/4 song
  // weight==1 everywhere, so P is just the densest bar floor and W matches the old
  // barsPerRow*maxBarFloor — this is a strict generalisation, not a change for them.)
  let P = 1;
  for (const b of builtAll) { const wt = weightOf(b.m); if (wt > 0) P = Math.max(P, b.minW / wt); }
  const W = Math.round(barsPerRow * P + SIDE_MARGIN * 2 + CLEF_W);

  // A "full" row carries barsPerRow whole-notes of music (= ROW_BEATS beats); that fills W.
  // Rows carrying less musical time (a short section, a partial tail, the 2/4 outro of a
  // 6/4 run) fill proportionally less and sit left-aligned, so columns align across rows.
  const fullRowWeight = barsPerRow;

  rows.forEach((rowBuilt, idx) => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';
    container.appendChild(rowDiv);
    const rowWeight = rowBuilt.reduce((s, b) => s + weightOf(b.m), 0);
    // Width is proportional to the row's musical TIME, so the bar widths honestly reflect
    // the meter: a row that carries a 2/4 bar holds less time than four 4/4 bars and is
    // drawn proportionally narrower (a 2/4 bar is half a 4/4 bar). The time-signature
    // label above the staff names the change; the width shows it. One whole-note occupies
    // the same width in every row, so equal-meter bars line up; short section-tail rows
    // fill proportionally and sit left-aligned.
    const fillFrac = fullRowWeight > 0 ? Math.min(1, rowWeight / fullRowWeight) : 1;
    try {
      const rec = renderRow(rowBuilt, idx, rowDiv, W, fillFrac, rowHeight, rowTop);
      if (rec) ROWS.push(rec);
    } catch (e) {
      rowDiv.textContent = '[row render error: ' + e.message + ']';
      console.error('row', idx, e);
    }
  });

  // Drum key: on screen it trails the score. On print it moves onto the roadmap page
  // IF the user opted into the song-map page (off by default); otherwise it trails the
  // score as on screen. So the roadmap is opt-in and never forced.
  const wantRoadmap = print && window.PlayerUI && PlayerUI.roadmapOn();
  if (wantRoadmap) renderRoadmap(score, container);
  else renderDrumKey(score, container);
}

// Print-only first page: a condensed "song map" you read before playing — the form
// (section + bar range + length), the key facts, a proportional shape bar, and the
// drum key — so the structure is internalised up front and the score pages that follow
// are pure notation. Built from data every score already carries (per-measure marker +
// time_sig, tempo_changes). Prepended to the container and given a page break after, so
// the music starts on page 2.
function renderRoadmap(score, container) {
  const measures = score.measures || [];
  if (!measures.length) return;

  // Group consecutive measures into sections by their markers. A measure carries a
  // marker only where a section opens; everything after extends the current section.
  // Bars before the first marker (rare) become a leading untitled section.
  const sections = [];
  for (const m of measures) {
    if (m.marker || !sections.length) {
      sections.push({ name: m.marker || '—', start: m.index, end: m.index });
    } else {
      sections[sections.length - 1].end = m.index;
    }
  }

  const wrap = document.createElement('div');
  wrap.className = 'roadmap';

  const bpm = score.tempo_changes[0]?.bpm;
  const bpms = [...new Set((score.tempo_changes || []).map(t => t.bpm).filter(Boolean))];
  const meters = [...new Set(measures.map(m => m.time_sig.join('/')))];
  const facts = [`${measures.length} bars`];
  if (bpms.length > 1) facts.push(`${bpms[0]}–${bpms[bpms.length - 1]} bpm`);
  else if (bpm) facts.push(`${bpm} bpm`);
  if (meters.length) facts.push(meters.join(', '));
  if (score.drummer) facts.push(score.drummer);

  let html =
    `<div class="rm-title">${esc(score.artist)} — ${esc(score.title)}</div>` +
    `<div class="rm-facts">${esc(facts.join('  ·  '))}</div>`;

  // Proportional shape bar: one segment per section, width ∝ its bar count, so the
  // song's form is graspable at a glance. Segments carry only a NUMBER (always fits a
  // narrow block — section names would clip); the number keys into the map below.
  // Grayscale alternation prints cleanly.
  const total = measures.length;
  html += `<div class="rm-shape">` + sections.map((s, i) => {
    const len = s.end - s.start + 1;
    const pct = (len / total * 100).toFixed(3);
    return `<div class="rm-seg ${i % 2 ? 'b' : 'a'}" style="width:${pct}%" title="${esc(s.name)}">` +
           `<span>${i + 1}</span></div>`;
  }).join('') + `</div>`;

  // The map itself: number · section · bar range · length, in reading order. The number
  // matches the shape-bar segment above.
  html += `<div class="rm-map-title">Song map</div><table class="rm-map"><tbody>` +
    sections.map((s, i) => {
      const len = s.end - s.start + 1;
      const range = s.start === s.end ? `bar ${s.start}` : `bars ${s.start}–${s.end}`;
      return `<tr><td class="rm-num">${i + 1}</td>` +
             `<td class="rm-name">${esc(s.name)}</td>` +
             `<td class="rm-range">${range}</td>` +
             `<td class="rm-len">${len} ${len === 1 ? 'bar' : 'bars'}</td></tr>`;
    }).join('') + `</tbody></table>`;

  wrap.innerHTML = html;
  container.insertBefore(wrap, container.firstChild);   // page 1
  renderDrumKey(score, wrap);                           // drum key sits on the roadmap page
}

// Minimal HTML-escape for the text we inject into the roadmap (titles, section names).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A drum key at the bottom of the score: one mini percussion staff per piece
// the song actually uses, drawn from DRUM_MAP so the glyph AND staff position
// match the score exactly (position is what tells kick/snare/toms apart — they
// share the same oval head). Pieces with an identical notehead+position are
// merged into one labelled entry. Rebuilt with the score on each (re)render.
function renderDrumKey(score, container) {
  const used = new Set();
  for (const m of (score.measures || []))
    for (const e of (m.events || []))
      for (const n of (e.notes || []))
        if (n.lily && DRUM_MAP[n.lily]) used.add(n.lily);
  if (!used.size) return;

  const byKey = new Map();   // mapKey → set of friendly labels
  for (const lily of used) {
    const k = DRUM_MAP[lily].key;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(PIECE_LABEL[lily] || lily);
  }
  const entries = [...byKey.entries()]
    .map(([k, labels]) => ({ key: k, label: [...labels].join(' / ') }))
    .sort((a, b) => keyVal(b.key) - keyVal(a.key));   // high on the staff first

  const wrap = document.createElement('div');
  wrap.className = 'drumkey';
  const title = document.createElement('div');
  title.className = 'drumkey-title';
  title.textContent = 'Drum key — what the symbols mean';
  wrap.appendChild(title);
  const grid = document.createElement('div');
  grid.className = 'drumkey-grid';
  wrap.appendChild(grid);

  // Each cell is a tiny 5-line percussion staff with the one piece on it, sized
  // with generous headroom above/below so pieces that sit off the staff — high
  // cymbals (above) and kick/floor-tom/foot-hat (below) — aren't clipped by the
  // SVG viewBox. VexFlow reserves space above the staff by default, so we zero
  // that and place the lines explicitly at STAVE_TOP within the CH-tall cell.
  const CW = 64, CH = 96, STAVE_TOP = 30;
  for (const ent of entries) {
    const cell = document.createElement('div');
    cell.className = 'dk-cell';
    const art = document.createElement('div');
    art.className = 'dk-art';
    cell.appendChild(art);
    const lab = document.createElement('div');
    lab.className = 'dk-label';
    lab.textContent = ent.label;
    cell.appendChild(lab);
    grid.appendChild(cell);
    try {
      const r = new VF.Renderer(art, VF.Renderer.Backends.SVG);
      r.resize(CW, CH);
      const ctx = r.getContext();
      const stave = new VF.Stave(2, STAVE_TOP, CW - 8, {
        space_above_staff_ln: 0, space_below_staff_ln: 0,
      });
      stave.setStyle({ strokeStyle: STAVE_COLOR, fillStyle: STAVE_COLOR, lineWidth: STAVE_LINE_WIDTH });
      stave.setContext(ctx).draw();
      const note = new VF.StaveNote({ keys: [ent.key], duration: 'q', stem_direction: -1 });
      VF.Formatter.FormatAndDraw(ctx, stave, [note]);
    } catch (e) {
      art.textContent = '?';
      console.error('drumkey', ent, e);
    }
  }
  container.appendChild(wrap);
}

// ── Travelling-bar playback (Phase 1) ─────────────────────────────────────────
// One opaque green vertical rect, parented to the active row's <svg> (SVG user
// units == screen px here — the svg isn't CSS-scaled). On a row change we
// re-parent it (also brings it on top) and reset its y/height; every frame we
// just set x. All timing is in score-seconds (YT.getCurrentTime() - OFFSET).

// The cursor's fill is a horizontal gradient: opaque green at the centre, fading to
// fully transparent at the left and right edges — so it has no hard contour and reads
// as a soft vertical glow centred exactly on the play position. Each row is its own
// <svg>, and a paint server (url(#id)) only resolves within the same <svg>, so we add
// the gradient def to whichever row svg the bar currently lives in (idempotent).
const CURSOR_GRAD_ID = 'cursor-grad';
function ensureCursorGradient(svg) {
  if (!svg || svg.querySelector('#' + CURSOR_GRAD_ID)) return;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const lg = document.createElementNS(SVG_NS, 'linearGradient');
  lg.setAttribute('id', CURSOR_GRAD_ID);
  lg.setAttribute('x1', '0'); lg.setAttribute('y1', '0');
  lg.setAttribute('x2', '1'); lg.setAttribute('y2', '0');   // horizontal, across the rect width
  for (const [off, op] of [['0', 0], ['0.5', BAR_PEAK_OPACITY], ['1', 0]]) {
    const s = document.createElementNS(SVG_NS, 'stop');
    s.setAttribute('offset', off);
    s.setAttribute('stop-color', BAR_COLOR);
    s.setAttribute('stop-opacity', String(op));
    lg.appendChild(s);
  }
  defs.appendChild(lg);
  svg.insertBefore(defs, svg.firstChild);
}

function makeBar() {
  BAR_RECT = document.createElementNS(SVG_NS, 'rect');
  BAR_RECT.id = 'cursor-bar';   // so print CSS can hide it
  BAR_RECT.setAttribute('fill', 'url(#' + CURSOR_GRAD_ID + ')');
  BAR_RECT.setAttribute('stroke', 'none');   // no contour
  BAR_RECT.setAttribute('width', BAR_WIDTH);
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
  ensureCursorGradient(r0.svg);
  r0.svg.appendChild(BAR_RECT);
  BAR_RECT.setAttribute('y', r0.yTop);
  BAR_RECT.setAttribute('height', r0.yBottom - r0.yTop);
  BAR_RECT.style.transform = 'translate3d(' + (r0.anchors[0].x - BAR_WIDTH / 2) + 'px,0,0)';
  ACTIVE_ROW = 0;
}

// Cursor line mode (shared setting): 'on' always shown, 'peek' hidden until you tap
// the score, 'off' never shown. The teleprompter still SCROLLS to keep the current
// row centred regardless — only the green bar's visibility changes.
let _cursorPeekTimer = null;
function applyLineMode() {
  if (!BAR_RECT) return;
  const mode = window.PlayerUI ? PlayerUI.lineMode('on') : 'on';
  clearTimeout(_cursorPeekTimer);
  BAR_RECT.style.opacity = (mode === 'on') ? '1' : '0';
}
function peekCursor() {
  if (!BAR_RECT || !window.PlayerUI || PlayerUI.lineMode('on') !== 'peek') return;
  BAR_RECT.style.opacity = '1';
  clearTimeout(_cursorPeekTimer);
  _cursorPeekTimer = setTimeout(() => { if (BAR_RECT) BAR_RECT.style.opacity = '0'; }, 1800);
}

// Re-render the score on screen (e.g. lyrics toggled) and restore the cursor + loop.
function rerenderScore() {
  if (!SCORE_REF) return;
  renderScore(SCORE_REF, document.getElementById('score'));
  if (SCHED && ROWS.length) { makeBar(); applyLineMode(); }
  drawLoopMarkers();
}

function printNow(orientation) {
  enterPrint(orientation);
  setTimeout(() => window.print(), 60);
}

// Monotone cubic (Fritsch–Carlson) tangents for the (seconds → x) anchor data.
// Piecewise-linear interpolation makes the cursor's pixel VELOCITY step at every
// note and jump at every bar line (the recording's per-measure tempo changes) — what
// reads as a slight "acceleration at the end of a measure". A monotone cubic Hermite
// gives a CONTINUOUS velocity (C1) instead, yet on collinear data (a steady passage)
// the tangents equal the common slope so it stays exactly linear — no wiggle where the
// tempo is constant — and the Fritsch–Carlson limiter guarantees the result never
// reverses (the cursor can't step backwards). Anchors are strictly increasing in both
// seconds and x, so every secant slope is positive.
function monotoneTangents(s, x) {
  const n = s.length, m = new Array(n);
  if (n < 2) { m[0] = 0; return m; }
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const ds = s[i + 1] - s[i];
    d[i] = ds > 0 ? (x[i + 1] - x[i]) / ds : 0;
  }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], sq = a * a + b * b;
    if (sq > 9) { const tau = 3 / Math.sqrt(sq); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return m;
}

// Interpolate the bar's x within a row from score-seconds, between the two bracketing
// anchors, with the monotone cubic above. `row._hint` caches the last segment so the
// common forward case is O(1); the tangents are computed once per row and cached.
function xAtTime(row, t) {
  const a = row.anchors, n = a.length;
  if (t <= a[0].seconds) return a[0].x;
  if (t >= a[n - 1].seconds) return a[n - 1].x;
  if (!row._mt) {
    row._ss = a.map(p => p.seconds);
    row._sx = a.map(p => p.x);
    row._mt = monotoneTangents(row._ss, row._sx);
  }
  let i = row._hint || 0;
  if (i >= n - 1 || a[i].seconds > t) i = 0;
  while (i < n - 1 && a[i + 1].seconds <= t) i++;
  row._hint = i;
  const s0 = a[i].seconds, s1 = a[i + 1].seconds, h = s1 - s0;
  if (h <= 0) return a[i].x;
  const u = (t - s0) / h, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return h00 * a[i].x + h10 * h * row._mt[i] + h01 * a[i + 1].x + h11 * h * row._mt[i + 1];
}

function updateBar(t) {
  if (!ROWS.length || !BAR_RECT) return;
  let r = ACTIVE_ROW < 0 ? 0 : ACTIVE_ROW;
  while (r > 0 && t < ROWS[r].startSec) r--;
  while (r < ROWS.length - 1 && t >= ROWS[r].endSec) r++;
  const row = ROWS[r];
  if (r !== ACTIVE_ROW) {
    ensureCursorGradient(row.svg);
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
  // While a loop seek is settling, getCurrentTime still reports the OLD (loop-end)
  // position for a moment; fusing it would yank the clock back to the end and
  // re-fire the seek. Hold the hard-set value until the seek lands.
  if (performance.now() / 1000 < LOOP_SEEK_UNTIL) return;
  let y; try { y = YT_PLAYER.getCurrentTime(); } catch (_) { return; }
  if (typeof y !== 'number' || !isFinite(y) || y === CLK_RAW) return;
  CLK_RAW = y;
  const e = (y - OFFSET) - CLK_M;
  if (Math.abs(e) > CLK_SEEK_EPS) {
    // While looping we only ever seek BACKWARD; a large FORWARD jump is a stale
    // pre-seek reading lingering just after a loop-back — ignore it so it can't
    // yank the clock to the loop end and re-fire the seek.
    if (LOOP_ON && e > 0) return;
    clkHardSet(y - OFFSET); return;
  }
  CLK_M += CLK_KP * e;
  CLK_R += CLK_KI * e;
  const lo = PLAYBACK_RATE * 0.8, hi = PLAYBACK_RATE * 1.2;
  if (CLK_R < lo) CLK_R = lo; else if (CLK_R > hi) CLK_R = hi;
}

function startBarLoop() {
  let lastStatus = 0;
  const frame = () => {
    // SYNCED gates out the preroll-ad window: until the user taps Sync, the bar
    // stays parked at beat 1 even while the video (or its ad) is playing. A loop
    // seek briefly drops YT out of PLAYING (buffering) — keep advancing through that
    // window so the bar doesn't freeze at the seam.
    const tau = performance.now() / 1000;
    const loopSeeking = LOOP_ON && tau < LOOP_SEEK_UNTIL;
    if (YT_READY && SYNCED && (IS_PLAYING || loopSeeking)) {
      clkPredict(tau);                 // advance the smooth phase
      clkCorrect();                    // fuse a fresh YT sample if there is one
      // Subtract the user's Bluetooth audio-delay so the cursor matches what's HEARD.
      // (Loop seek/end checks below use CLK_M, not t, so practice loops are unaffected.)
      let t = CLK_M + LATENCY_LEAD - (window.PlayerUI ? PlayerUI.delaySec() : 0);
      // Monotonic latch: while playing the bar never steps back, independent of
      // gain tuning. A seek/resync releases it (CLK_OUT was reset in clkHardSet).
      if (t < CLK_OUT) t = CLK_OUT; else CLK_OUT = t;

      // Loop: seek back the instant the audio reaches the PLAY end (block end + the
      // fade-out bars) — judged by the smooth, per-frame clock (CLK_M). Until the
      // seek fires, pin the bar just short of the play-end bar line. Volume rides the
      // fade envelope across the whole play range.
      let shown = t;
      if (LOOP_ON) {
        if (tau >= LOOP_SEEK_UNTIL && CLK_M >= LOOP_PLAY_END_SEC) {
          seekToLoopStart();
          shown = LOOP_SEEK_SEC;                            // snap the bar back this same frame
        } else if (shown > LOOP_PLAY_END_SEC - LOOP_EDGE_EPS) {
          shown = LOOP_PLAY_END_SEC - LOOP_EDGE_EPS;        // hold at the play-end edge
        }
        applyLoopFade(shown);
      }
      updateBar(shown);
      if (tau - lastStatus > 0.2) { updateStatus(shown); lastStatus = tau; }
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
    case 'IDLE':    STARTED = true; try { YT_PLAYER.setPlaybackRate(PLAYBACK_RATE); } catch (_) {} YT_PLAYER.playVideo(); if (window.PlayerUI) PlayerUI.maybeShowSyncHint(); break;
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
  if (LOOP_ON) seekToLoopStart();   // jump straight to the practice region once we're past the ad
  refreshTransport();
  if (window.PlayerUI) PlayerUI.maybeShowDelayHint();   // one-time first-Sync nudge
}

// ── Loop / section repeat ─────────────────────────────────────────────────────
// Repeat a [start..end] measure range. Timing is in score-seconds (the YT video
// time minus OFFSET), so a seek-back stays WITHIN the song and never replays the
// preroll ad. The loop is independent of Play/Sync: you still press Play, wait
// out any ad, and tap Sync — only then (and on each pass) do we seek.
let LOOP_ON = false;
let LOOP_FADE_BARS = 1;                     // measures of fade-in before / fade-out after the block (0 = hard cut)
let LOOP_START = 0, LOOP_END = 0;          // measure numbers, 1-based as printed — the repeat BLOCK
let LOOP_START_SEC = 0, LOOP_END_SEC = 0;  // score-seconds of the repeat block's edges (drive the repeat signs)
// The PLAY range extends the block by the fade bars on each side: we seek back to
// PLAY_START (fading the audio up to the block) and only loop once we pass PLAY_END
// (having faded the audio down past the block). The repeat signs stay on the block.
let LOOP_PLAY_START_SEC = 0, LOOP_PLAY_END_SEC = 0;
let LOOP_SEEK_SEC = 0;                      // where a loop-back seeks to (= PLAY_START)
let LOOP_SEEK_UNTIL = 0;                    // perf-seconds: suppress end-checks + sensor fusion while a seek settles
let LOOP_VOL = -1;                          // last YouTube volume we set (throttle: only call setVolume on an integer change)
const LOOP_EDGE_EPS = 0.02;                 // s kept below the end bar line so the bar never tips into the next measure

function measureByIndex(k) {
  return (SCORE_REF && SCORE_REF.measures.find(m => m.index === k)) || null;
}
function measureStartSec(m) { return SCHED.at(m.position[0] / m.position[1]); }
function measureEndSec(m) { return SCHED.at(m.position[0] / m.position[1] + m.duration[0] / m.duration[1]); }
function loopComputeSecs() {
  const a = measureByIndex(LOOP_START), b = measureByIndex(LOOP_END);
  if (!a || !b || !SCHED) return false;
  LOOP_START_SEC = measureStartSec(a);
  LOOP_END_SEC = measureEndSec(b);
  // Fade range: start the play F bars before the block (fade in) and run F bars past
  // it (fade out), clamped to the song. F=0 collapses PLAY to the block (hard loop).
  // EDGE CASE — block starts on the song's first measure: there are no bars before it
  // to fade in over, so preIdx clamps to firstIdx == LOOP_START, PLAY_START == block
  // start, and the fade-in length is 0. applyLoopFade then holds full volume from the
  // top (you can't fade in from before the recording). Same clamp on the tail end.
  const measures = SCORE_REF.measures;
  const firstIdx = measures[0].index, lastIdx = measures[measures.length - 1].index;
  const preIdx = Math.max(firstIdx, LOOP_START - LOOP_FADE_BARS);
  const postIdx = Math.min(lastIdx, LOOP_END + LOOP_FADE_BARS);
  const pre = measureByIndex(preIdx), post = measureByIndex(postIdx);
  LOOP_PLAY_START_SEC = pre ? measureStartSec(pre) : LOOP_START_SEC;
  LOOP_PLAY_END_SEC = post ? measureEndSec(post) : LOOP_END_SEC;
  LOOP_SEEK_SEC = LOOP_PLAY_START_SEC;
  return LOOP_END_SEC > LOOP_START_SEC;
}
function seekToLoopStart() {
  if (!LOOP_ON || !YT_READY) return;
  try { YT_PLAYER.seekTo(LOOP_SEEK_SEC + OFFSET, true); } catch (_) {}
  clkHardSet(LOOP_SEEK_SEC);                         // releases the monotonic latch so the bar may jump back
  LOOP_SEEK_UNTIL = performance.now() / 1000 + 0.6; // let the seek land before checking/fusing again
}

// Set the YouTube volume (0..100), throttled to integer changes so we don't spam
// the iframe with a postMessage every animation frame.
function setLoopVolume(v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  if (v === LOOP_VOL) return;
  LOOP_VOL = v;
  try { if (YT_PLAYER && YT_PLAYER.setVolume) YT_PLAYER.setVolume(v); } catch (_) {}
}
// Volume envelope across the play range: ramp 0→100 over [PLAY_START..block start],
// hold 100 across the block, ramp 100→0 over [block end..PLAY_END]. Called per frame
// with the smooth clock; a zero-length fade edge (block at the song edge) is full.
function applyLoopFade(t) {
  if (!LOOP_ON || LOOP_FADE_BARS <= 0) { setLoopVolume(100); return; }
  let v = 100;
  const inLen = LOOP_START_SEC - LOOP_PLAY_START_SEC;
  const outLen = LOOP_PLAY_END_SEC - LOOP_END_SEC;
  if (inLen > 1e-3 && t < LOOP_START_SEC) {
    v = 100 * Math.max(0, (t - LOOP_PLAY_START_SEC) / inLen);
  } else if (outLen > 1e-3 && t > LOOP_END_SEC) {
    v = 100 * Math.max(0, (LOOP_PLAY_END_SEC - t) / outLen);
  }
  setLoopVolume(v);
}
function restoreVolume() { setLoopVolume(100); }

// Draw (or clear) the loop markers at the block's edges: a BLACK musical repeat sign
// (thick|thin bar + two dots) at each edge — begin at the START measure's left barline,
// end at the END measure's right barline — plus a larger BLUE arrow just below the staff
// pointing into the loop. Drawn as an SVG overlay from MEASURE_BOXES so no re-render is
// needed when the loop changes.
const LOOP_BLUE = '#2f6fed';        // the arrows (app cue)
const LOOP_SIGN = NOTE_COLOR;       // the repeat sign — black, like the noteheads
function clearLoopMarkers() {
  for (const g of document.querySelectorAll('.loop-marker')) g.remove();
}
function repeatSign(box, x, kind) {
  // kind: 'begin' (bar on the left, dots to the right) | 'end' (dots left, bar right).
  // A normal staff-height musical repeat sign (NOT taller — a taller bar collides with
  // the measure number above), PLUS a blue triangle just BELOW the staff at the barline
  // pointing INTO the loop. The triangle sits in clear space (no notehead/stem lands on
  // a barline) and gives an at-a-glance start/end flag without a highlight wash.
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'loop-marker');
  g.setAttribute('pointer-events', 'none');
  const yT = box.yTop, yB = box.yBottom, h = yB - yT;
  const dotY1 = yT + h * (1.5 / 4), dotY2 = yT + h * (2.5 / 4);
  const dir = kind === 'begin' ? 1 : -1;
  const thickW = 3.2, thinW = 1.2, gap = 2.6, dotGap = 5, dotR = 2.1;
  const thickX = kind === 'begin' ? x : x - thickW;          // thick bar hugs the barline
  const thinX = kind === 'begin' ? x + thickW + gap : x - thickW - gap - thinW;
  const dotX = kind === 'begin' ? thinX + thinW + dotGap : thinX - dotGap;
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', thickX); rect.setAttribute('y', yT);
  rect.setAttribute('width', thickW); rect.setAttribute('height', h);
  rect.setAttribute('fill', LOOP_SIGN);
  g.appendChild(rect);
  const line = document.createElementNS(SVG_NS, 'rect');
  line.setAttribute('x', thinX); line.setAttribute('y', yT);
  line.setAttribute('width', thinW); line.setAttribute('height', h);
  line.setAttribute('fill', LOOP_SIGN);
  g.appendChild(line);
  for (const dy of [dotY1, dotY2]) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', dotX + dir * dotR); c.setAttribute('cy', dy);
    c.setAttribute('r', dotR); c.setAttribute('fill', LOOP_SIGN);
    g.appendChild(c);
  }
  // Larger inward-pointing blue arrow below the staff at the barline (▶ at the start,
  // ◀ at the end) — the prominent at-a-glance loop cue.
  const fy = yB + 5, fh = 16, fw = 15;
  const tipX = x + dir * fw;
  const tri = document.createElementNS(SVG_NS, 'polygon');
  tri.setAttribute('points', `${x},${fy} ${x},${fy + fh} ${tipX},${fy + fh / 2}`);
  tri.setAttribute('fill', LOOP_BLUE);
  g.appendChild(tri);
  box.svg.appendChild(g);
}
function drawLoopMarkers() {
  clearLoopMarkers();
  if (!LOOP_ON || !MEASURE_BOXES.length) return;
  const startBox = MEASURE_BOXES.find(b => b.index === LOOP_START);
  const endBox = MEASURE_BOXES.find(b => b.index === LOOP_END);
  if (startBox) repeatSign(startBox, startBox.x0, 'begin');
  if (endBox) repeatSign(endBox, endBox.x1, 'end');
}
function refreshLoopBtn() {
  const btn = document.getElementById('loopbtn');
  if (!btn) return;
  btn.textContent = LOOP_ON ? `Loop ${LOOP_START}–${LOOP_END}` : 'Loop';
  btn.classList.toggle('on', LOOP_ON);
}
function applyLoop() {
  const hint = document.getElementById('loopHint');
  const setHint = m => { if (hint) hint.textContent = m; };
  if (!SCHED) { setHint('This song has no synced timing to loop.'); return; }
  const n = SCORE_REF ? SCORE_REF.measures.length : 0;
  const sEl = document.getElementById('loopStart'), eEl = document.getElementById('loopEnd');
  const fEl = document.getElementById('loopFade');
  let s = parseInt(sEl && sEl.value, 10), e = parseInt(eEl && eEl.value, 10);
  if (!Number.isFinite(s) || !Number.isFinite(e)) { setHint('Enter a start and end bar.'); return; }
  s = Math.max(1, Math.min(n, s)); e = Math.max(1, Math.min(n, e));
  if (s > e) { const t = s; s = e; e = t; }   // the first loop bar is ALWAYS ≤ the last (reversed input is swapped)
  let f = parseInt(fEl && fEl.value, 10);
  if (!Number.isFinite(f) || f < 0) f = 0;
  f = Math.min(4, f);
  LOOP_START = s; LOOP_END = e; LOOP_FADE_BARS = f;
  if (sEl) sEl.value = s; if (eEl) eEl.value = e; if (fEl) fEl.value = f;
  if (!loopComputeSecs()) { setHint('Could not set that range.'); return; }
  LOOP_ON = true;
  setHint(`Looping bars ${s}–${e}${f > 0 ? ` · fade ${f} bar${f > 1 ? 's' : ''}` : ''}.`);
  refreshLoopBtn();
  drawLoopMarkers();
  if (SYNCED && IS_PLAYING) seekToLoopStart();   // already playing → jump to the region now
}
function clearLoop() {
  LOOP_ON = false;
  const hint = document.getElementById('loopHint');
  if (hint) hint.textContent = '';
  refreshLoopBtn();
  drawLoopMarkers();
  restoreVolume();   // loop off → back to full volume
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
          // A loop-back seek makes YT flicker through BUFFERING/PAUSED before it
          // resumes PLAYING. That transient is NOT a real pause: don't let it flip
          // the transport button back to "Play" or re-anchor the clock to a stale
          // pre-seek time (the seek already hard-set the clock to the loop start).
          const loopSeeking = LOOP_ON && performance.now() / 1000 < LOOP_SEEK_UNTIL;
          IS_PLAYING = (e.data === YT.PlayerState.PLAYING);
          if (IS_PLAYING) STARTED = true;            // play via the app button OR YouTube's own play → advance the button to Sync
          if (IS_PLAYING && SYNCED && !loopSeeking) clkResync();
          if (loopSeeking && !IS_PLAYING) return;    // keep showing "⏸ Pause" across the seam
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

  // Tap the score to peek at the cursor (when the line mode is "Peek").
  const scoreEl = document.getElementById('score');
  if (scoreEl) scoreEl.addEventListener('pointerdown', peekCursor);

  // Gear → shared settings panel.
  if (window.PlayerUI) PlayerUI.mount({
    slot: document.getElementById('gear-slot'),
    viewSwitch: { mode: 'teleprompter' },
    defaults: { lineMode: 'on' },                  // the teleprompter cursor is on by default
    show: { print: true, lyrics: true },
    on: {
      lineMode: () => applyLineMode(),
      delay: () => {},                             // read live in the bar loop
      lyrics: () => rerenderScore(),              // re-render with/without the lyric line
      print: (orient) => printNow(orient),
    },
  });

  // Loop popover: toggle on its button, close on any outside click.
  const loopBtn = document.getElementById('loopbtn');
  const loopMenu = document.getElementById('loopmenu');
  if (loopBtn && loopMenu) {
    loopBtn.addEventListener('click', e => { e.stopPropagation(); loopMenu.hidden = !loopMenu.hidden; });
    document.addEventListener('click', e => {
      if (!loopMenu.hidden && !loopMenu.contains(e.target) && e.target !== loopBtn) loopMenu.hidden = true;
    });
  }
  const la = document.getElementById('loopApply');
  if (la) la.addEventListener('click', applyLoop);
  const lc = document.getElementById('loopClear');
  if (lc) lc.addEventListener('click', clearLoop);

  // Fade-bars change: re-apply so the play range, hint, and (if playing) seek update.
  const fade = document.getElementById('loopFade');
  if (fade) fade.addEventListener('change', () => { if (LOOP_ON) applyLoop(); });
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
    drawLoopMarkers();                     // re-draw the repeat signs after the rebuild
  }, 200);
}

// ── Print to Letter ───────────────────────────────────────────────────────────
// Re-lay the score forcing 4 bars/row (a phone-width screen is in 2-bar mode, but
// the printout always wants the full structure), then `.row svg { width:100% }`
// scales each system down to the page width. PORTRAIT is the default (Pawel fits three
// portrait pages on the stand vs. two landscape); LANDSCAPE stays available for ~1.3×
// larger staves. The chosen orientation is written into an injected `@page` rule before
// printing, along with the running footer (Artist — Title · page N / total). enterPrint/exitPrint are idempotent and reached three
// ways for cross-browser cover: the Print buttons, beforeprint/afterprint (desktop),
// and a matchMedia('print') change (iPad Safari). Print also uses a tighter row crop
// (PRINT_ROW_HEIGHT) so rows pack closer vertically — fewer pages.
let _printing = false;
// PORTRAIT is the default: Pawel fits three portrait pages side by side on the music
// stand (≈ a whole song at a glance) vs. only two in landscape. The staff is smaller
// than landscape's, but the print palette (darker, heavier lines) keeps it legible.
let PRINT_ORIENTATION = 'portrait';    // 'portrait' (default) | 'landscape'

// Quote a string as a CSS <string> token for use in `content:`.
function cssQuote(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Write the page orientation + margins + a running footer into an injected stylesheet
// so the browser's print picks them up (a static @page can't be toggled at runtime).
// The footer lives in the page's BOTTOM MARGIN (an @page margin box), so it costs zero
// score space, yet repeats on every page with "Artist — Title · page N / total" — so a
// shuffled stack of printed pages can be reordered. counter(page)/counter(pages) and
// @page margin boxes are honoured by Chrome's print engine (verified) — Pawel's browser.
function setPageStyle(orientation) {
  let el = document.getElementById('page-style');
  if (!el) { el = document.createElement('style'); el.id = 'page-style'; document.head.appendChild(el); }
  const s = SCORE_REF;
  const label = s ? `${s.artist} — ${s.title}   ·   ` : '';
  const foot = cssQuote(label) + ' "page " counter(page) " / " counter(pages)';
  // Paper size: US Letter is the default; A4 for metric printers (gear → Print).
  const paper = (window.PlayerUI && PlayerUI.paper && PlayerUI.paper() === 'a4') ? 'A4' : 'letter';
  // Margins as tight as is physically printable so the 4 bars stretch edge-to-edge and
  // more rows pack per page — Pawel wants every bit of the sheet used. Most consumer
  // printers can't image the outer ~0.1in (hardware clip), so 0.1in L/R is about the
  // safe floor; top is just a hairline. The bottom keeps a slim band (0.3in) for the
  // running footer (Artist — Title · page N / total) that lets a shuffled stack reorder.
  el.textContent =
    '@page { size: ' + paper + ' ' + orientation + '; margin: 0.1in 0.1in 0.3in 0.1in;' +
    ' @bottom-center { content: ' + foot + '; font: bold 8pt Arial, sans-serif; color: #000; } }';
}

function enterPrint(orientation) {
  if (orientation) PRINT_ORIENTATION = orientation;
  setPageStyle(PRINT_ORIENTATION);
  if (_printing || !SCORE_REF) return;
  _printing = true;
  if (BAR_RECT) BAR_RECT.style.display = 'none';
  renderScore(SCORE_REF, document.getElementById('score'), { print: true });
  drawLoopMarkers();
}

function exitPrint() {
  if (!_printing || !SCORE_REF) return;
  _printing = false;
  renderScore(SCORE_REF, document.getElementById('score'));   // back to screen width
  if (SCHED && ROWS.length) { makeBar(); if (BAR_RECT) BAR_RECT.style.display = ''; }
  drawLoopMarkers();
}

function setupPrint(score) {
  const hdr = document.getElementById('print-header');
  if (hdr) {
    const bpm = score.tempo_changes[0]?.bpm;
    const sub = [`${score.measures.length} bars`];
    if (bpm) sub.push(`${bpm} bpm`);
    const meters = [...new Set((score.measures || []).map(m => m.time_sig.join('/')))];
    if (meters.length) sub.push(meters.join(', '));
    if (score.drummer) sub.push(score.drummer);
    hdr.innerHTML =
      `<div class="pt"></div><div class="ps"></div>`;
    hdr.querySelector('.pt').textContent = `${score.artist} — ${score.title}`;
    hdr.querySelector('.ps').textContent = sub.join('  ·  ');
  }
  // Print is triggered from the gear panel (printNow); here we just set up the
  // header, the default page style, and the browser print-event hooks.
  setPageStyle(PRINT_ORIENTATION);                        // sensible default for a direct Ctrl+P
  window.addEventListener('beforeprint', () => enterPrint());
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
  // ?map=1 / ?map=0 deep-links (and overrides) the print song-map page setting, so a
  // print-with-map can be shared/bookmarked; otherwise the gear-panel toggle decides.
  const mapParam = new URLSearchParams(location.search).get('map');
  if ((mapParam === '1' || mapParam === '0') && window.PlayerUI) PlayerUI.setRoadmap(mapParam === '1');
  // ?paper=letter|a4 deep-links (and overrides) the print paper size; otherwise the
  // gear-panel picker decides. Lets a print be shared/bookmarked and aids headless verify.
  const paperParam = (new URLSearchParams(location.search).get('paper') || '').toLowerCase();
  if ((paperParam === 'letter' || paperParam === 'a4') && window.PlayerUI) PlayerUI.setPaper(paperParam);
  const st = document.getElementById('status');
  // The status line shows the song before play and the live bar/section readout
  // once the cursor is running (updateStatus overwrites it).
  if (st) st.textContent = `${score.artist} — ${score.title}`;

  // Timing before render — renderRow reads SCHED to lay down the cursor anchors.
  SCHED = buildSecondsAt(score);
  OFFSET = SCHED ? SCHED.offset : 0;
  buildMeasureTimeline(score);

  renderScore(score, document.getElementById('score'));

  // ?probe=1 — report the worst within-row cursor-velocity spread (smoothness check).
  if (new URLSearchParams(location.search).get('probe') && ROWS.length) {
    const spreads = ROWS.map((row, ri) => {
      const t0 = row.startSec, t1 = row.endSec, N = 400, dt = (t1 - t0) / N;
      if (!(dt > 0)) return 0;
      let vmin = Infinity, vmax = -Infinity;
      for (let k = 0; k < N; k++) {
        const v = (xAtTime(row, t0 + (k + 1) * dt) - xAtTime(row, t0 + k * dt)) / dt;
        vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
      }
      const mean = (xAtTime(row, t1) - xAtTime(row, t0)) / (t1 - t0);
      return mean > 0 ? (vmax - vmin) / mean * 100 : 0;
    });
    const worst = Math.max(...spreads), worstRow = spreads.indexOf(worst);
    const body = spreads.slice(1);   // exclude the intro row (clef + meter change)
    const worstBody = Math.max(...body), worstBodyRow = spreads.indexOf(worstBody);
    const st0 = document.getElementById('status');
    if (st0) st0.textContent = `probe: worst spread ${worst.toFixed(1)}% (row ${worstRow}); excl. intro ${worstBody.toFixed(1)}% (row ${worstBodyRow}) of ${ROWS.length}`;
  }

  wireControls();
  setupPrint(score);
  window.addEventListener('resize', onResize);

  if (SCHED && ROWS.length && score.youtube_id) {
    makeBar();
    applyLineMode();
    initYt(score.youtube_id);
    startBarLoop();
  }
  refreshTransport();

  // ?print=landscape|portrait — auto-open the print dialog (used by the conveyor's
  // "Print" action, which hands off to this sheet view).
  const pParam = (new URLSearchParams(location.search).get('print') || '').toLowerCase();
  if (pParam === 'landscape' || pParam === 'portrait') setTimeout(() => printNow(pParam), 200);

  // Optional ?loop=<start>-<end>[&fade=<n>] deep link (e.g. ?song=14_6&loop=27-30):
  // pre-set a practice loop so it can be shared/bookmarked. Takes effect on the next
  // Sync. The blue repeat signs render immediately.
  const params = new URLSearchParams(location.search);
  const lp = (params.get('loop') || '').match(/^(\d+)-(\d+)$/);
  if (lp && SCHED) {
    const sEl = document.getElementById('loopStart'), eEl = document.getElementById('loopEnd');
    const fEl = document.getElementById('loopFade');
    if (sEl) sEl.value = lp[1];
    if (eEl) eEl.value = lp[2];
    const fade = params.get('fade');
    if (fEl && fade != null && /^\d+$/.test(fade)) fEl.value = fade;
    applyLoop();
  }
}

// Apply the per-song edit overlay (overrides_<id>_<part>.json) onto window.SCORE
// before boot() reads/renders it, so edits show in the notation and the drum key.
function startWithOverrides() {
  const p = (window.PlayerUI && PlayerUI.loadAndApplyOverrides) ? PlayerUI.loadAndApplyOverrides() : Promise.resolve();
  p.then(boot, boot);   // never let an overlay error block rendering
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWithOverrides);
} else {
  startWithOverrides();
}
