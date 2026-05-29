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
let LAST_SAMPLE_SCORESEC = 0; // score-seconds at the last getCurrentTime() poll
let LAST_SAMPLE_PERF = 0;     // performance.now()/1000 at that poll; we interpolate between polls
let ACTIVE_ROW = -1;
let BAR_RECT = null;
const SVG_NS = 'http://www.w3.org/2000/svg';
const BAR_COLOR = '#36b35a';
const BAR_OPACITY = 0.32;
const BAR_WIDTH = 9;
const YT_RESAMPLE_SEC = 0.25; // getCurrentTime quantises to ~250 ms; polling faster just oscillates

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
function buildMeasureTickables(measure) {
  const filtered = [];
  for (const ev of measure.events) {
    if (!(ev.notes && ev.notes.length)) continue;
    filtered.push({ relPos: fSub(ev.position, measure.position), notes: ev.notes });
  }
  if (filtered.length === 0) return [];

  filtered.sort((a, b) => (a.relPos[0] * b.relPos[1]) - (b.relPos[0] * a.relPos[1]));

  const tokens = [];
  let cursor = [0, 1];

  // Lead-in rest if the first event isn't at the bar line.
  if (fLT(cursor, filtered[0].relPos)) {
    for (const [vd, d] of fillRests(fSub(filtered[0].relPos, cursor))) {
      tokens.push({ type: 'rest', dur: vd, dots: d });
    }
    cursor = filtered[0].relPos;
  }

  for (let i = 0; i < filtered.length; i++) {
    const ev = filtered[i];
    const nextPos = (i + 1 < filtered.length) ? filtered[i + 1].relPos : measure.duration;
    const gap = fSub(nextPos, ev.relPos);
    const exact = lookupDur(gap);
    if (exact) {
      tokens.push({ type: 'note', dur: exact[0], dots: exact[1], notes: ev.notes, relpos: ev.relPos });
      cursor = nextPos;
      continue;
    }
    // Non-standard gap (e.g. 5/16): take the largest standard duration that fits,
    // then pad the remainder with rests.
    const fallback = largestDurLE(gap);
    if (!fallback) { cursor = nextPos; continue; }
    const [f, vd, dots] = fallback;
    tokens.push({ type: 'note', dur: vd, dots, notes: ev.notes, relpos: ev.relPos });
    cursor = fAdd(ev.relPos, f);
    if (fLT(cursor, nextPos)) {
      for (const [rd, rdots] of fillRests(fSub(nextPos, cursor))) {
        tokens.push({ type: 'rest', dur: rd, dots: rdots });
      }
      cursor = nextPos;
    }
  }

  return tokens.map(t => {
    if (t.type === 'rest') {
      const n = new VF.StaveNote({ keys: ['b/4'], duration: t.dur + 'r' });
      for (let i = 0; i < t.dots; i++) VF.Dot.buildAndAttach([n], { all: true });
      n.__accent = 0;
      return n;
    }
    const chord = chordFromNotes(t.notes);
    const keys = chord.map(c => c.key);
    const n = new VF.StaveNote({ keys, duration: t.dur, stem_direction: -1 });
    for (let i = 0; i < t.dots; i++) VF.Dot.buildAndAttach([n], { all: true });

    // Ghost notes: parenthesize that specific notehead. Accent: remember the
    // strongest in the chord; the mark itself is drawn later as a top band.
    let maxAccent = 0;
    chord.forEach((c, j) => {
      if (c.dn.ghost) {
        n.addModifier(new VF.Parenthesis(VF.ModifierPosition.LEFT), j);
        n.addModifier(new VF.Parenthesis(VF.ModifierPosition.RIGHT), j);
      }
      if (c.dn.accent > maxAccent) maxAccent = c.dn.accent;
    });
    n.__accent = maxAccent;
    n.__posf = t.relpos[0] / t.relpos[1];   // position within measure, for lyric alignment
    n.__abspos = measure.position[0] / measure.position[1] + n.__posf;  // absolute score position (whole-notes), for the playback cursor
    return n;
  });
}

const ROW_HEIGHT = 215;
const ROW_TOP = 55;          // headroom above the stave for section label + accent band
const PAGE_WIDTH = 1100;
const SIDE_MARGIN = 10;
const ACCENT_RISE = 26;      // px above the top staff line for the accent band
const BEAM_DROP = 35;        // px below the bottom staff line for the flat beam
const SECTION_RISE = 42;     // px above the top staff line for the section label
const LYRIC_COLOR = '#7a7a7a';
const LYRIC_FONT = ['Arial', 11, 'normal'];
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

function renderRow(measures, rowIdx, container, lyrics) {
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(PAGE_WIDTH, ROW_HEIGHT);
  const ctx = renderer.getContext();

  const clefWidth = isFirstRow(rowIdx) ? 70 : 0;
  const availWidth = PAGE_WIDTH - SIDE_MARGIN * 2 - clefWidth;

  // Build every bar's notes up front so we can size each bar by the space its
  // notes actually need (note-value proportional), then stretch them all by the
  // same factor to fill the row. This is what gives Songsterr its even look.
  const built = measures.map(m => {
    const notes = buildMeasureTickables(m);
    let voice = null, minW = 40;
    if (notes.length) {
      // Attach lyrics first so their width feeds into the min-width estimate —
      // lyric-heavy bars then get proportionally wider, like Songsterr.
      attachLyrics(notes, m, lyrics);
      voice = new VF.Voice({ num_beats: m.time_sig[0], beat_value: m.time_sig[1] });
      voice.setStrict(false).addTickables(notes);
      try {
        minW = new VF.Formatter().preCalculateMinTotalWidth([voice]);
      } catch (e) { console.warn('minwidth failed m', m.index, e); }
    }
    return { m, notes, voice, minW };
  });
  const minSum = built.reduce((a, b) => a + b.minW, 0) || 1;
  const scale = availWidth / minSum;

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
    const { m, notes, voice } = built[i];
    const myWidth = built[i].minW * scale + (i === 0 ? clefWidth : 0);
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
    try {
      new VF.Formatter().joinVoices([voice]).format([voice], noteArea - 6);
    } catch (e) { console.warn('format failed m', m.index, e); }

    // Width is now reserved; blank the annotations so they don't draw at their
    // zig-zagging note-relative positions. We draw the lyrics flat ourselves.
    for (const n of notes) { if (n.__ann) n.__ann.text = ''; }

    // Flat beams on a fixed line below the staff so every beam is horizontal and
    // at the same height across the row. Full tickable list (rests included) so
    // beams break at rests. Must run before voice.draw — beaming suppresses the
    // individual flags at draw time.
    let beams = [];
    try {
      beams = VF.Beam.generateBeams(notes, {
        stem_direction: -1,
        beam_rests: false,
        flat_beams: true,
        flat_beam_offset: stave.getYForLine(4) + BEAM_DROP,
      });
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

function renderScore(score, container, barsPerRow) {
  const measures = score.measures;
  const lyrics = score.lyrics || [];
  ROWS = [];
  for (let i = 0; i < measures.length; i += barsPerRow) {
    const rowMeasures = measures.slice(i, i + barsPerRow);
    const rowDiv = document.createElement('div');
    rowDiv.className = 'row';
    container.appendChild(rowDiv);
    try {
      const rec = renderRow(rowMeasures, i / barsPerRow, rowDiv, lyrics);
      if (rec) ROWS.push(rec);
    } catch (e) {
      rowDiv.textContent = '[row render error: ' + e.message + ']';
      console.error('row', i, e);
    }
  }
}

// ── Travelling-bar playback (Phase 1) ─────────────────────────────────────────
// One opaque green vertical rect, parented to the active row's <svg> (SVG user
// units == screen px here — the svg isn't CSS-scaled). On a row change we
// re-parent it (also brings it on top) and reset its y/height; every frame we
// just set x. All timing is in score-seconds (YT.getCurrentTime() - OFFSET).

function makeBar() {
  BAR_RECT = document.createElementNS(SVG_NS, 'rect');
  BAR_RECT.setAttribute('fill', BAR_COLOR);
  BAR_RECT.setAttribute('fill-opacity', BAR_OPACITY);
  BAR_RECT.setAttribute('width', BAR_WIDTH);
  BAR_RECT.setAttribute('rx', 1.5);
  BAR_RECT.setAttribute('pointer-events', 'none');
  const r0 = ROWS[0];
  r0.svg.appendChild(BAR_RECT);
  BAR_RECT.setAttribute('y', r0.yTop);
  BAR_RECT.setAttribute('height', r0.yBottom - r0.yTop);
  BAR_RECT.setAttribute('x', r0.anchors[0].x - BAR_WIDTH / 2);
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
    row.div.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  BAR_RECT.setAttribute('x', xAtTime(row, t) - BAR_WIDTH / 2);
}

// getCurrentTime() quantises to ~250 ms, so we sample it sparsely and advance
// with performance.now() between samples (the iPad-safe clock — Tone.Transport
// stalls when a silent AudioContext suspends; see the ios-audiocontext note).
function resampleYt(perf) {
  let t; try { t = YT_PLAYER.getCurrentTime(); } catch (_) { return; }
  if (typeof t !== 'number' || !isFinite(t)) return;
  LAST_SAMPLE_SCORESEC = t - OFFSET;
  LAST_SAMPLE_PERF = perf;
}

function startBarLoop() {
  const frame = () => {
    // SYNCED gates out the preroll-ad window: until the user taps Sync, the bar
    // stays parked at beat 1 even while the video (or its ad) is playing.
    if (YT_READY && SYNCED && IS_PLAYING) {
      const perf = performance.now() / 1000;
      if (perf - LAST_SAMPLE_PERF > YT_RESAMPLE_SEC) resampleYt(perf);
      updateBar(LAST_SAMPLE_SCORESEC + (performance.now() / 1000 - LAST_SAMPLE_PERF));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// The Sync action (mirrors the deployed player's onStartMusic): align the
// cursor to the video's CURRENT position using the known youtube_offset, so it
// works no matter how long any preroll ad ran. Re-tappable to realign.
function doSync() {
  if (!YT_READY) return;
  SYNCED = true;
  resampleYt(performance.now() / 1000);
  const msg = document.getElementById('syncmsg');
  const btn = document.getElementById('syncbtn');
  if (btn) btn.textContent = 'Re-sync';
  if (msg) msg.textContent = 'Synced. Tap Re-sync to realign if the bar drifts.';
}

function initYt(videoId) {
  window.onYouTubeIframeAPIReady = function () {
    YT_PLAYER = new YT.Player('yt', {
      videoId: videoId, width: 480, height: 270,
      playerVars: { playsinline: 1 },
      events: {
        onReady: () => {
          YT_READY = true;
          const btn = document.getElementById('syncbtn');
          if (btn) btn.disabled = false;
        },
        onStateChange: (e) => {
          IS_PLAYING = (e.data === YT.PlayerState.PLAYING);
          if (IS_PLAYING) resampleYt(performance.now() / 1000);
        },
      },
    });
  };
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function boot() {
  const score = window.SCORE;
  if (!score) {
    document.getElementById('heading').textContent = 'No window.SCORE — load a score_*.js first.';
    return;
  }
  document.title = `${score.artist} — ${score.title} (VexFlow proto)`;
  document.getElementById('heading').textContent = `${score.artist} — ${score.title}`;
  document.getElementById('subheading').textContent =
    `${score.measures.length} measures · ${score.tempo_changes[0]?.bpm ?? '?'} bpm`;

  // Build the timing function before render — renderRow reads SCHED to lay down
  // the per-note cursor anchors. Null when the score has no usable YouTube sync.
  SCHED = buildSecondsAt(score);
  OFFSET = SCHED ? SCHED.offset : 0;

  const barsPerRow = parseInt(new URLSearchParams(location.search).get('bpr') || '4', 10);
  renderScore(score, document.getElementById('score'), barsPerRow);

  // If we have timing, rows with anchors, and a chosen video, light up the bar.
  if (SCHED && ROWS.length && score.youtube_id) {
    makeBar();
    initYt(score.youtube_id);
    startBarLoop();
    const btn = document.getElementById('syncbtn');
    if (btn) btn.addEventListener('click', doSync);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
