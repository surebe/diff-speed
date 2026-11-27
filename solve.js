// A faster drop-in for makefun-diff 1.0.0: run(input) returns make.fun's own
// patch of { old, new }, byte for byte the reference's answer, computed with
// the same rule but without the reference's per-step object churn.
//
// The rule (the reference's header states it in full): a text is cut into
// lines after every "\n" (a line keeps its "\n"; a last line may lack one);
// the common line prefix is kept, then the common suffix of what is left;
// between them, Myers's greedy search runs from the first lines — for
// d = 0, 1, 2, ... edits and each diagonal k = x - y it keeps the path
// reaching furthest into the old text, the deletion's path when a deletion
// and an insertion reach the same point, never moving past either text's
// end, pruning no edge diagonal, following every snake of equal lines as
// far as it goes; the first path to reach both ends is the script.
//
// How this module runs the same search faster:
//  - Lines are compared as small integer ids (one Map hands the same id to
//    equal lines), so the search's inner loops compare ints, not strings.
//    A line's id key is its text without the trailing "\n" every non-final
//    line shares; the one possible final line without a "\n" is keyed with
//    one appended, which no split part can collide with, so it never shares
//    an id with a newline-ended line. The patch's lines are rebuilt from
//    the split parts only where a hunk actually writes them.
//  - Instead of a linked list of runs per diagonal, the search keeps one
//    Int32Array of furthest reaches, one row per d: row d holds, for each
//    diagonal of d's parity, the last old line the best path on it consumed
//    (or -2 where no path reaches that diagonal). A row is all the parent
//    choice ever reads. The buffer is a reusable scratch, regrown as d
//    outruns it; every slot a case reads was written by that case's own
//    forward pass, so nothing carries from one case to the next. In the
//    inner loop the two boundary diagonals, which have a single parent
//    each, are handled outside it, and the interior chooses its parent by
//    comparing the two reaches directly (an unreachable or end-blocked
//    parent reads as -2 and loses to any real reach).
//  - The winning path is then re-walked backwards from (winD, winK): at
//    each step the same parent rule (furthest into the old text, deletion
//    on a tie, the same end-of-text limits) is applied to row d - 1, which
//    selects exactly the parent the forward pass extended, so the script
//    recovered is the reference's own, run for run.
//  - The patch text is assembled with the reference's hunk arithmetic:
//    change runs between kept lines, deletions before insertions in a run,
//    up to 3 kept lines of context, runs at most 6 kept lines apart sharing
//    a hunk, a line with no trailing newline written with one and followed
//    by a "%" line.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

const KEEP = 0;
const DEL = 1;
const INS = 2;

// The furthest-reach trace: row d starts at slot d(d + 1) / 2 and holds
// d + 1 reaches for the diagonals -d, -d + 2, ..., d. Reused across cases
// as scratch (see the header) and doubled when a case's d outgrows it.
let traceCapD = 2048;
let trace = new Int32Array(((traceCapD + 1) * (traceCapD + 2)) / 2);

function growTrace(d) {
  let nd = traceCapD * 2;
  while (nd < d) nd *= 2;
  const grown = new Int32Array(((nd + 1) * (nd + 2)) / 2);
  grown.set(trace.subarray(0, (d * (d + 1)) / 2));
  trace = grown;
  traceCapD = nd;
}

/**
 * A text cut into lines: its split parts, the parts' last index, and one id
 * per line (see the header for the keying). Line i's text is
 * parts[i] + "\n" for i < last, and parts[last] for the final line.
 */
function linesOf(text, map) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const bare = parts[last] !== '';
  const count = bare ? last + 1 : last;
  const ids = new Int32Array(count);
  for (let i = 0; i < last; i++) {
    const part = parts[i];
    let id = map.get(part);
    if (id === undefined) {
      id = map.size;
      map.set(part, id);
    }
    ids[i] = id;
  }
  if (bare) {
    const key = parts[last] + '\n';
    let id = map.get(key);
    if (id === undefined) {
      id = map.size;
      map.set(key, id);
    }
    ids[last] = id;
  }
  return { parts, last, ids };
}

/**
 * The edit runs of the middle slices ia[alo..ahi) into ib[blo..bhi), as
 * [{ kind, count }] in order, by the reference's search (see the header).
 */
function middleRuns(ia, alo, ahi, ib, blo, bhi) {
  const n = ahi - alo;
  const m = bhi - blo;
  if (n === 0) return m === 0 ? [] : [{ kind: INS, count: m }];
  if (m === 0) return [{ kind: DEL, count: n }];
  const A = ia.subarray(alo, ahi);
  const B = ib.subarray(blo, bhi);
  const tr = trace;
  let winD = -1;
  let winK = 0;

  // d = 0: the snake from the start, which may already reach both ends.
  {
    let x = -1;
    let y = -1;
    while (x + 1 < n && y + 1 < m && A[x + 1] === B[y + 1]) {
      x++;
      y++;
    }
    tr[0] = x;
    if (x + 1 >= n && y + 1 >= m) {
      winD = 0;
      winK = 0;
    }
  }

  for (let d = 1; winD < 0; d++) {
    if (d > traceCapD) growTrace(d);
    const t = trace;
    const po = ((d - 1) * d) / 2; // row d - 1
    const co = (d * (d + 1)) / 2; // row d
    // Diagonal -d (slot 0): only its insertion parent, on diagonal -(d - 1).
    {
      const ap = t[po];
      let x = ap !== -2 && ap + d < m ? ap : -2;
      let y = x + d;
      while (x + 1 < n && y + 1 < m && A[x + 1] === B[y + 1]) {
        x++;
        y++;
      }
      t[co] = x;
      if (x + 1 >= n && y + 1 >= m) {
        winD = d;
        winK = -d;
        break;
      }
    }
    // Interior diagonals: the deletion parent is row d - 1 slot j - 1, the
    // insertion parent slot j; the further reach into the old text wins,
    // the deletion on a tie (xDel >= xIns), an unreachable or end-blocked
    // parent counting as -2.
    for (let j = 1; j < d; j++) {
      const k = 2 * j - d;
      const delX = t[po + j - 1] + 1;
      const ap = t[po + j];
      const xDel = delX >= 0 && delX < n ? delX : -2;
      const xIns = ap !== -2 && ap - k < m ? ap : -2;
      let x = xDel >= xIns ? xDel : xIns;
      let y = x - k;
      while (x + 1 < n && y + 1 < m && A[x + 1] === B[y + 1]) {
        x++;
        y++;
      }
      t[co + j] = x;
      if (x + 1 >= n && y + 1 >= m) {
        winD = d;
        winK = k;
        break;
      }
    }
    if (winD >= 0) break;
    // Diagonal d (slot d): only its deletion parent, on diagonal d - 1.
    {
      const delX = t[po + d - 1] + 1;
      let x = delX >= 0 && delX < n ? delX : -2;
      let y = x - d;
      while (x + 1 < n && y + 1 < m && A[x + 1] === B[y + 1]) {
        x++;
        y++;
      }
      t[co + d] = x;
      if (x + 1 >= n && y + 1 >= m) {
        winD = d;
        winK = d;
      }
    }
  }

  // Re-walk the winning path backwards: steps are collected last-first,
  // each with the snake that followed its edit.
  const t = trace;
  const steps = [];
  let k = winK;
  let x = t[(winD * (winD + 1)) / 2 + (winK + winD) / 2];
  for (let d = winD; d >= 1; d--) {
    const po = ((d - 1) * d) / 2;
    const j = (k + d) / 2;
    const rp = j > 0 ? t[po + j - 1] : -2;
    const ap = j < d ? t[po + j] : -2;
    const canDel = rp !== -2 && rp + 1 < n;
    const canIns = ap !== -2 && ap - k < m;
    const byDel = canDel ? rp + 1 : -2;
    const byIns = canIns ? ap : -2;
    if (byDel >= byIns) {
      steps.push(DEL, x - (rp + 1));
      x = rp;
      k = k - 1;
    } else {
      steps.push(INS, x - ap);
      x = ap;
      k = k + 1;
    }
  }

  // Forward again: the opening snake, then each edit and the snake after it,
  // runs of one kind merged as the reference's path components merge.
  const runs = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const tail = runs[runs.length - 1];
    if (tail !== undefined && tail.kind === kind) tail.count += count;
    else runs.push({ kind, count });
  };
  push(KEEP, t[0] + 1);
  for (let i = steps.length - 2; i >= 0; i -= 2) {
    push(steps[i], 1);
    push(KEEP, steps[i + 1]);
  }
  return runs;
}

/** makefun-diff 1.0.0's answer for one case's input { old, new }: its patch, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const a = linesOf(input.old, map);
  const b = linesOf(input.new, map);
  const ia = a.ids;
  const ib = b.ids;
  const n = ia.length;
  const m = ib.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && ia[prefix] === ib[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ia[n - 1 - suffix] === ib[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of middleRuns(ia, prefix, n - suffix, ib, prefix, m - suffix)) runs.push(r);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DEL) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  // A line as the patch writes it: its op, the line, and a "%" line after
  // it when it had no newline (only a text's final line can lack one).
  const aParts = a.parts;
  const bParts = b.parts;
  const aLast = a.last;
  const bLast = b.last;
  const written = (op, parts, last, i) => {
    if (i < last) return op + parts[i] + '\n';
    const line = parts[i];
    return line.endsWith('\n') ? op + line : `${op}${line}\n%\n`;
  };

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aParts, aLast, at));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aParts, aLast, c.o + i));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bParts, bLast, c.p + i));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aParts, aLast, at));
  }
  return out.join('');
}
