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

```
node --expose-gc scripts/bench-lex.mjs --chunked-print 200 --chunk-bytes 65536
```

```
lexLines (chunked, 65536B chunks): ~200 MB, 5,473,696 lines in 9.002s = 22.2 MB/s, 608,078 lines/s
(sanity command count 5,200,011; heap delta 46.6 MB)
```

**Why chunking is the right default, not just an option** — the same 200 MB of synthetic content fed
as a single giant chunk (i.e. materialised as one JS string before lexing, the naive approach):

```
node --expose-gc --max-old-space-size=4096 scripts/bench-lex.mjs --chunked-print 200 --chunk-bytes 209715200
```

```
lexLines (chunked, 209715200B chunks): ~200 MB, 5,473,696 lines in 13.226s = 15.1 MB/s, 413,852 lines/s
(sanity command count 5,200,011; heap delta 1704.3 MB)
```

Same content, same function, only the chunk size differs: reading in 64 KB pieces uses **~37x less
heap** (46.6 MB vs. 1704.3 MB — the giant-string case needed `--max-old-space-size=4096` just to avoid
an out-of-memory crash) and is **~30% faster** (memory pressure and GC overhead from the giant string
dominate). This is the concrete, measured case for `lexLines` existing at all, not a theoretical one —
a plugin scanning a real 200 MB print file (state-building for a preview, a post-processor pass) should
read it in bounded-size pieces (a `Blob`/`File`'s own chunked read, or a stream) and feed them straight
into `lexLines`, never call `.text()`/`readAsText()` on the whole file first.

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
