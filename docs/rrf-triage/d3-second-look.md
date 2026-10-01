# D3: second look at what the bulk closures skipped

Plan: `Flexible-Layouts/FIRMWARE-CHANGES-PLAN.md` D3. The two range documents were closed with a **section-level note** for most items
("internal refactor, no G-code surface"); `scripts/split-triage.mjs` counts 581 item lines (293 distinct commits, merges excluded) that carry
no closure text of their own. This page records how they were re-read and what it found, so the next person knows what was and was not looked at.

## Step 1 - every event sits where its commit ships (script-checked)

`node scripts/split-triage.mjs --check`: for each item whose closure text names an event, the event's `version` must not be EARLIER than the
release the commit first ships in. 0 DIFFs. Three events sit later, each for a stated reason: `om-move.motionSystems-added` and
`om-move.motionSystems[].currentObject-added` (object-model events are tag-precise: dated to the snapshot that shows the path, `beta.1`) and
`m309-extrusion-feedforward-reworked` (cites four commits, dated to the last, `rc.2`). `scripts/audit-releases.mjs --events` does the same from the
event side, by cited SHA; it is the test (`test/releaseAudit.test.ts`).

## Step 2 - the second look (what was read, what was not)

The 293 distinct commits were narrowed three ways, then read as diffs (`git show -U<n> <sha> -- src`, and each claim re-checked against the file at
`3.6.3` and `3.7.0-rc.2`, never against the commit alone):

1. a filter for diff lines that change a **default** (same `Default*` constant, different value) or add a new **error return** next to a parameter reader -
   4 commits flagged, all read: none is file-visible (the TMC5160 defaults are identical at 3.6.3 and rc.2; the rest are analog-probe type lists and a comment);
2. the **subject** of every one of the 293, read for a behaviour change the filters miss;
3. a filter over `gb.Seen`/`MustSee`/`Get*`/error/object-model/default lines for the subsystems the plan names (384 items, 114 flagged) - too noisy
   to read whole (renames, object-model reshuffles); only its first 300 of 828 lines were read, so treat it as a cross-check on the subject-level picks, not as coverage.

About 25 commits were read as diffs (plus the skim above). **Not** done: a line-by-line read of the other ~250. Parameter-reading lines were already read in full
(294 lines, 3.6.3..rc.2, `docs/dictionary-param-history/`), which is why this pass looked for what that one cannot see: a default, a newly
raised error, a value renumbering.

### Found (new events, `src/releases/changes.ts`)

| Event | Release | What a file sees |
| --- | --- | --- |
| `axis-limit-absolute-moves-error` | alpha.2 | An absolute G0/G1 beyond the M208 limits (M564 S1, the default) is an error on a 3D printer too; 3.6.3 clamped it silently. Relative moves: error alpha.2-beta.1, clamped again from beta.2, `M564 R0` (beta.2+1) makes them errors. Not detectable (depends on coordinates). |
| `m575-p-channel-numbering`, `aux-port-numbering-m260-1..4`, `aux-port-numbering-m261-1/2` | alpha.2 | On a Duet 3 main board `P1` is the SECOND USB channel and the first auxiliary UART (the usual PanelDue line) becomes `P2`. `M575 P1 B57600 S1` silently configures the wrong port. Confirmed in source and in the wiki's M575 notes. |
| `m574-k-range-checked` | rc.1 | `M574 K` is range-checked against `MaxZProbes` on any line that gives it (3.6.3 read it unchecked, only for S3). |
| `g68-bare-reports-rotation` | beta.3 | A bare `G68` was a missing-parameter error; it now reports the rotation. |

### Found in step 3 (the wiki pass, 2026-09-30; parameter-VALUE events, `whenValue`)

Every "RRF 3.6.4/3.7 and later", "removed", "deprecated" and "not supported from" phrase in the current `Gcodes.md` (169 lines matched a loose
version regex; the 81 that name 3.6.3 or later or 3.7 were read one by one) was set against `CHANGES` and the dictionary's `since`/`until`, and the ones with no matching event
were read in RRF source at 3.6.3 and rc.2. Almost all matched. The misses were one kind: a change to which VALUE of an existing parameter
is accepted, which a `parameter` target could not say (M558's P description recorded `P3` as gone, but no event existed, so no scan flagged it).

| Event | Release | What a file sees |
| --- | --- | --- |
| `m558-p3-removed` | rc.1 | `M558 P3` is now "Invalid Z probe type 3" (3.6.3 accepted it). The one real break the pass found. |
| `m558-p12-load-cell` | beta.3 | `P12` (load cell probe) does not exist at 3.6.3: matters going back. |
| `m574-s5-encoder-endstop` | rc.1 | `M574 S5` (encoder endstop) does not exist at 3.6.3: matters going back. |
| `m308-bme68x-added` | alpha.3 | `M308 Y"bme68x"` does not exist at 3.6.3 (and only on boards built with `SUPPORT_BME68X`): matters going back. |

Judged and recorded, no event: the wiki's "P2/P5 deprecated from 3.7.0" is not in the firmware (`docs/wiki-discrepancies.md`); `M586 T`
(already read at 3.6.3), `M308 Y"board-temp"` (tool-board firmware), the `M574` type-0 message (already at 3.6.3) and `M400`'s position
re-read (not file-visible). The wiki's version *dates* for `M26 C`, `M116 P`, `M140 H`, `M201 T`, `M301/M304/M408`, `M552 T`, `M558.4`, `M558 V`,
`M564 R`, `M572 S:L`, `M575 F`, `M576 F`, `M950 B`, `M953`, `M959`, `M970*` and the `M260/M261 P` renumbering all agree with the catalogue.
Two things worth keeping: `git describe --contains` dated `m308-bme68x-added` to beta.1 while the commit is already in the tracked `alpha.3` build (the pin
rule is the first TRACKED release whose commit contains the change, `git merge-base --is-ancestor`, not the first tag); and `scripts/audit-releases.mjs` and
`test/releaseAudit.test.ts` read `dist/`, so they audit the last `npm run build`, not the source - they reported "91 citations, clean" while the new events were
not yet built in, and flagged the wrong pin (95 citations) only after a rebuild. Run `npm run build` before either.

### Found (dictionary)

- `M564 R` said "also applies the S axis-limit restriction to relative moves". The code's `limitAxesRelative` defaults to true and means *clamp relative
  moves instead of raising an error*; corrected, with the code cited.
- `M575 P` now says what the numbers mean.

### Judged not file-visible (no event)

The heater PWM-too-high fault (`CHECK_HEATER_PWM` is `0` except on TOOLINDX), M221 immediate-vs-queued extrusion factor (runtime; `F1` never shipped), default
event handlers also logging to the DWC console, TMC51xx default registers (refactor by driver), `0bfca0e98` driver mode/direction (object model only), the
LED-strip colour order moving into `LocalLedStrip` (K is now honoured for NeoPixel strips too; it was read only for DotStar - a judgment call, not added),
`M118 P7` (second USB channel: a new accepted value), `5c42f4345` (IP/MAC expressions accepted: a widening, not a break).

### Still open

- ~~The ~250 commits not individually read~~ - **done**: all 293 were read as diffs, see `d3-line-by-line.md` (what was read in full, what was only surface-scanned, and what it found: M116, M221, M950 J, M552 T,
  M669 per-kinematics letters and a set of object-model dates the mirror had wrong). The dictionary's `historyChecked` is 282 of 282 (E7).
- Step 3 is done for the current `Gcodes.md` (above), but only for claims that carry a version phrase. A behaviour change the wiki never words that way is
  invisible to it; the per-release documents list the wiki commits by date for anyone who wants to read the diffs instead.
- `test/releaseAudit.test.ts` audits `dist/`, so it can pass against a stale build; making the test build first (or read `src/`) would close that. Not done.
