# Performance

Task 16's own hardening requirement (`docs/tasks/16-hardening-and-readiness.md`): benchmark
`parseDocument` on a 200 MB synthetic print file, processed in chunks the way a consumer actually
reads one, and on a 5,000-line config; record the numbers. Numbers below are from
`scripts/bench-lex.mjs` on this development machine (Node v25.7.0, Windows) — a single-machine
snapshot, not a formal multi-run statistical benchmark; re-run and update this file whenever a change
could plausibly move the numbers, not just when this task revisits it.

## Baseline: `lexLine` and `parseDocument`, whole file in memory (1,000,000 lines)

```
node scripts/bench-lex.mjs --lines 1000000
node scripts/bench-lex.mjs --lines 1000000 --document
```

| | throughput |
| --- | --- |
| `lexLine` (per line) | 649,439 lines/s |
| `parseDocument` (whole text at once) | 314,092 lines/s |

`parseDocument` does roughly 2x `lexLine`'s own work per line (the block-tree builder, Fanuc
continuation resolution, machine-mode threading), so its lower throughput here is expected, not a
regression to chase.

## The 5,000-line config

```
node scripts/bench-lex.mjs --config 5000
```

```
parseDocument (config-shaped): 5,000 lines (111.1 KB) in 27.43ms = 182,303 lines/s (400 top-level blocks, 0 errors)
```

A real `config.g` is realistically well under 5,000 lines; even a large, dictionary-realistic one
(the generator mixes `M584`/`M574`/`M950`/`M563`/`M308`/`G10`/`if`/`while` blocks, not just flat
motion, so the block-tree builder has real work to do) parses in well under 30 ms — not a scenario
this package needs to optimise further for a config/macro editor's own responsiveness.

## The 200 MB print file, processed in chunks

The consumer-realistic scenario per the task's own wording — "processed in chunks, the way consumers
read files", not one `join()`ed multi-hundred-MB string. `lexLines(chunks, options)` (new this task,
`src/lex.ts`) is exactly this: it splits a stream of raw chunks into complete lines, carrying a
partial line across a chunk boundary exactly once, and lexes each one as it becomes available.

**The synthetic generator is not free, so every run below is reported twice** — once with
`--generate-only` (no lexing at all) and once end to end. Building the input is a materially different
cost in the two chunk modes (one 200 MB string means ~5.5M `buf +=` concatenations), and an earlier
version of this document did not subtract it, which attributed the harness's own string-building to
`lexLines` and overstated the gap. Always subtract.

```
node --expose-gc scripts/bench-lex.mjs --chunked-print 200 --chunk-bytes 65536 [--generate-only]
node --expose-gc --max-old-space-size=4096 scripts/bench-lex.mjs --chunked-print 200 --chunk-bytes 209715200 [--generate-only]
```

| 200 MB, 5,473,696 lines | generate only | generate + lex | **lexing alone (difference)** |
| --- | --- | --- | --- |
| 64 KB chunks | 2.17 s, 12 MB | 9.89 s, 38 MB | **~7.7 s, ~26 MB** |
| one 200 MB chunk | 5.98 s, 1533 MB | 13.21 s, 1713 MB | **~7.2 s, ~181 MB** |

**What this actually shows, stated no more strongly than the measurement supports:**

- **Throughput is the same either way** (~7.2–7.7 s of lexing for 200 MB, ~700k lines/s). Chunking is
  not faster. An earlier draft of this file claimed ~30% faster; that difference was entirely the
  generator building a 200 MB string by concatenation, not anything `lexLines` does.
- **Working set is the real difference, and it's about 7x here, not the ~37x once claimed**: ~26 MB
  for `lexLines` when fed 64 KB pieces, versus ~181 MB when handed the whole file — the latter being
  essentially the retained 200 MB string itself. The chunked figure is roughly *constant* in file
  size; the whole-file figure grows with it.
- **The 1533 MB is the benchmark's own concatenation, and should not be read as a consumer cost.** A
  real caller doing the naive thing gets its 200 MB string in one allocation from `file.text()`,
  paying ~200 MB, not 1.5 GB.

So the case for `lexLines` is a bounded working set, not speed: a plugin scanning a real 200 MB print
file should read it in bounded-size pieces (a `Blob`/`File`'s own chunked read, or a stream) and feed
them straight into `lexLines`, rather than calling `.text()`/`readAsText()` on the whole file and
holding a several-hundred-MB string alive in a browser tab for the duration of the scan.

## What this does and doesn't tell you

- These numbers are for `lexLine`/`lexLines`/`parseDocument` in isolation — a real plugin's own
  per-line work (state tracking, UI updates) sits on top and will usually dominate wall-clock time for
  anything but the largest files.
- `parseDocument` builds a full `Block` tree and needs the whole file in memory for it (task 06's own
  design - `if`/`elif`/`else` structure can't be resolved from a prefix alone), so it is NOT a
  chunk-streaming API and was never benchmarked as one here; it's the right tool for a config/macro
  file (small, needs full-document features), not a multi-hundred-MB print file (large, usually only
  needs a line-by-line scan) — `lexLines` is the right tool for that second case.
- No formal statistical methodology (multiple runs, warm-up discarding, confidence intervals) was
  applied — these are single-run snapshots on one development machine, good enough to catch a gross
  regression or validate a design decision (chunking), not to make a precise SLA claim.
