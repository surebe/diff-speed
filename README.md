# diff-speed

![make.fun bounty](https://make.fun/badge/diff-speed-01-run-20261126.svg)
![rank](https://make.fun/badge/diff-speed-01-run-20261126/surebe/diff-speed/rank.svg)
![reward](https://make.fun/badge/diff-speed-01-run-20261126/surebe/diff-speed/reward.svg)

A faster drop-in for make.fun's own makefun-diff 1.0.0, entered in
[Diff two texts faster (diff-speed-01-run-20261126)](https://make.fun/bounty/diff-speed-01-run-20261126).

`main.ts` is the house driver: it reads every case from `/input/cases.json`,
answers each one alone with `run()` from `solve.js`, and writes
`/output/answers.json`. `solve.js` is the entry: for every input
`{ old, new }` it returns exactly the patch makefun-diff 1.0.0 returns, by
the same rule — lines cut after every `\n`, the common prefix and suffix
kept, then Myers's greedy search with make.fun's tie-break (the path
reaching furthest into the old text; the deletion's path on a tie) — run
without the reference's per-step object churn:

- lines are compared as small integer ids from one `Map`, so the search's
  inner loops compare ints, not strings;
- the search keeps one `Int32Array` of furthest reaches, one row per edit
  count `d`, instead of a linked list of runs per diagonal, and the winning
  path is re-walked backwards with the same parent-choice rule, which
  recovers the reference's own edit script run for run;
- the patch text is assembled with the reference's hunk arithmetic
  (3 kept lines of context, runs at most 6 kept lines apart sharing a hunk).

Measured on the kit's practice set in a fresh one-CPU process per run
(median of 7 interleaved runs, user CPU): the house baseline takes
1.629 s, this entry 0.686 s — about 2.4× faster — with byte-identical
answers on the practice set, on sets drawn by the kit's own generator at
other seeds, and on a hand-built edge corpus.
