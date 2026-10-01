# D3 line by line: the 293 "by-note" triage commits

The triage closed 293 commits (tracked builds 3.6.3 .. 3.7.0-rc.2) with a section note instead of an event: they touch the G-code,
object-model or reply surface only incidentally, or the note says why the surface is unchanged. `d3-second-look.md` re-judged
those from their subjects and file lists. This pass read **every one of them as a diff against the RRF clone** (`git show <sha>`, nothing checked out)
and recorded a verdict for each. What follows says what that does and does not mean.

## How each commit was read

- **Tooling.** A throwaway reader printed, per commit, every changed hunk of every file, with three filters that only ever
  *hide* lines and always say they did: identifier-only substitutions are collapsed to one line (`tuning1 -> tuning1_heating_up x4`),
  files in the motion maths (`Movement/DDA*.cpp/h`, `DriveMovement`, `MoveSegment`, `DDARing`, `StepTimer`, ...) show only lines that match a surface pattern
  (a `case`, `gb.Seen`, a `reply.`/`Message` string, an object-model table row, `Version.h`) and say how many lines they hid, and vendored code is shown in surface mode only.
- **Read in full**: everything under `GCodes/`, `Platform/`, `Endstops/`, `Heating/`, `FilamentMonitors/`, `CAN/`, `SBC/`, `GPIO/`, `Display/`, `Storage/`, `Networking/` (RRF's own files), `Hardware/` and the
  object-model tables, for all 293 commits.
- **Surface-scanned only, by design**: the motion-maths files named above (the numerical core of third-order motion control and of the planner); vendored third-party code
  (lwIP 2.2.1, only RRF's glue file read: #113); and the TMC51xx look-up-table builder in #265 (188 residual lines the reader did not print; driver-internal).
  A change that is visible only as a *numerical* difference in those files (a path's timing, a rounding) is not something this pass can see, and nothing here claims it did.
- **Each candidate was checked against both ends**: the 3.6.3 tree and the rc.2 tree, not only the commit, because 3.7.0-alpha.2 is older than 3.6.3 and a fix can reach the 3.7 line first and 3.6.3 later (#43 and #57 are
  exactly that: not changes against 3.6.3). The first tracked release that contains a commit decides an event's version (`git merge-base --is-ancestor`).
- **Source decides over the wiki.** Where an existing event was sourced from a wiki phrase and the source disagrees, the event was corrected (see below).

## Verdicts (293 commits)

| Verdict | Commits | Meaning |
|---|---|---|
| none | 202 | internal; no G-code, reply, object-model or behaviour surface |
| covered | 46 | already an event or a dictionary entry (the pass checked the dating and the parameter set) |
| event / dictionary fix | 21 | a new or corrected event, a corrected dictionary entry, or both |
| text-only, SBC-only, developer-only | 14 | reply wording; DSF/SBC-mode behaviour; M122 test values (developer commands, deliberately not enumerated) |
| topology | 2 | already in 3.6.3 (the fix reached 3.7-dev first); not a change against 3.6.3 |
| widening | 4 | a new accepted value or form that cannot be detected from a line and only matters on a downgrade (M118 P7 precedent) |
| reverted / retired | 3 | added and removed again before a tracked build (M140.1 and its OM key; M221 `F1`); net zero |
| hardware | 1 | per-board capability the catalogue has no way to gate on |

The reading ledger (number, sha, verdict, one-line reason) was a working file of the session that did this pass and is not kept in the repo; the sections below are its findings. Two commits (#159, #173)
were missing from the first ledger and were read afterwards: #173 (WiFi TLS) turned out to have a stated-too-thin event, see below.

## What it found

### New or corrected events

- **`M116`** (#233): the colon-list `P` event was pinned to 3.7.0-beta.3 from the wiki; the source puts it in **3.7.0-beta.2+1**. And a **bare `M116` now waits for every tool's heaters** (3.6.3: only the selected tool's, plus bed and chambers),
  except a tool another motion system has selected: new event `m116-bare-waits-for-all-tools`. This needed a new target condition, `alsoAbsent` (the line must leave out P *and* H *and* C), so the event fires on `M116` and `M116 S5` and not on `M116 P1`.
- **`M221`** (#286, #287, #289): `m221-rescales-queued-moves` (3.7.0-rc.1). M221 now also rescales extrusion in moves already planned but not yet committed, within the extruder jerk limit; the channel decides whether it does.
  The commit subject of `e707b11e9` ("not immediate when from a File channel") and its code (`immediate = gb.IsFileChannel()`) disagree; the description says what is certain and the sources say what disagrees.
- **`M950 J`** virtual inputs (#232, #249): `C"fm0.switch"`, `C"fm0.motion"` from **3.7.0-beta.2+1** and `C"probe0"` from **3.7.0-beta.3**, each with a leading `!` to invert (`m950-j-filament-monitor-input`, `m950-j-probe-input`).
  A parameter target's `whenValue` list can now hold a prefix (`fm*`).
- **`M552 T`** (#173, `m552-t-tristate` existed): its description now says what the code does with the files: `T1` on WiFi sends `/sys/server.crt` and `/sys/server.key` to the module and **securely deletes the SD copies**;
  `T-1` clears the module (and wipes the two files on an Ethernet interface that is not yet active). The dictionary's `T` text says so too.
- **`boards[0].firmwareDate`** now carries the time (#227, `om-boards-firmware-date-includes-time`, beta.2). M115's `FIRMWARE_DATE` already did.
- **`inputs[].state`** reports `"unused"` for a channel that never ran anything (#52, `om-inputs-state-unused`, alpha.2).
- **`m141-chamber-heater-own-defaults`** (#71), **`m141-h-colon-list`** (#106), **`m950-led-k-honoured-for-neopixel`** (#121), **`m586-t-tls-listener`** (#118; the dictionary's M586 `T`/`R` text was wrong too),
  **`m997-s3-wifi-external-removed`** (#127), **`m569-4-hangprinter-t-per-driver`** (#194), the Hangprinter `M669`/`M666` events (#195), and `move.accelerationTime`/`move.usingSCurve` (#21: 3.6.3 serves neither; the schema had given them no `since`).
- **`M669` per-kinematics letters** (the item this pass was opened for): the schema grew `selectorVariants` (letters read per `K` value), events carry `whenCompanion` (the other letter has this value) and `whenElements` (list length), and the diagnostics rule reads them.
  Hangprinter (`K6`) and five-bar SCARA (`K9`) are enumerated, with the two-value `D` of the five-bar and the eight-anchor Hangprinter as their own events.

### Object model: dates the mirror got wrong

The published `Duet3D/ObjectModel` mirror lags RRF at the pre-release snapshots and flags things earlier than RRF does. RRF's own tables decide (rule 12), checked with a literal `git grep '"key"' <tag> -- src` per tracked tag.
`scripts/build-om-schema.mjs` now carries these corrections as overlays/decisions, each with its source in the generated entry:

- **Deprecations were all dated 3.6.3** (so a scan could never report them: its window is `(from, to]`), but RRF flags eleven of them `ObjectModelEntryFlags::obsolete` only from alpha.3/alpha.4: redated to **beta.1** (`RRF_OBSOLETE_FROM`); five stay at the baseline because RRF flags them already at 3.6.3.
- `state.restorePoints[].gCommandNumber` and `move.motionSystems[].restorePoints[].gCommandNumber`: beta.1 -> **beta.2**. `boards[].timeout`: beta.3 -> **beta.2**. `move.currentMove.filePosition`: rc.1 -> **beta.2**.
- `sensors.probes[].loadCell` (+ `.force`, `.gramsPerCount`, `.preload`, `.preloadWindow`), `sensors.filamentMonitors[].filamentPresent` and `.agc`: rc.1 -> **beta.3** (`agc` sat inside `#ifdef DUET3_ATE` until #239).
- `boards[].drivers[].config`: rc.1 -> **beta.1** (its own children `direction`/`mode` were already beta.1).
- **`move.motionSystems[].currentMove.filePosition` is removed from the schema**: RRF's `MovementState` table serves no `filePosition` at any tracked build (only `move.currentMove` does). The event id it had shipped with (`om-move.motionSystems[].currentMove.filePosition-added`) is listed under `retired` in `test/fixtures/event-ids.json`.
- Every mismatch the comparison found was either corrected above or checked and found to be a shared leaf name (a different table serving a key of the same name); the accelerometer `resolution`/`samplingRate` rc.1 hit is `boards[].accelerometer.*`, a different path that moved at rc.2.

### Dictionary corrections and notes

- `M116`: summary and `P` text corrected (above). `M950` `C`: the virtual input names. `M906`: an over-maximum current is clamped **and reported as an error** from rc.1 (the maximum is per driver, so no line can be matched; stated in the summary, no event).
- Reply-text-only changes (#8, #86, #119, #185, #188, ...) are recorded as text-only: no event, because nothing in a file can depend on them.

## Value-level pass (2026-10-01, after the by-note read)

Asked to close the gap the list below names (value-level and required-ness changes; motion-maths files; a change hidden in a shared helper). What was done, mechanically, over `git diff -U0 3.6.3 3.7.0-rc.2` of `GCodes/`, `Heating/`, `Platform/`, `Endstops/`, `Fans/`, `Tools/`, `Movement/Kinematics/`, `Display/`, `Accelerometers/` and `CAN/`:

- **Every changed `GetLimited*`/`TryGetLimited*`/`GetValidated*` read** (28 added, 9 removed) was matched to an existing event or dictionary `since`: `M574 K` (`m574-k-range-checked`), the M575/M260/M261 channel numbering, `M575 F`, `M955 P`, `M952`/`M953` timing, `M564 R`, `M574 E`. Nothing new.
- **Every changed `MustSee`, rejecting `reply.*`/`ThrowGCodeException` line and parameter-default ternary** (about 240 added lines, grouped by function) was read. Already covered: `G68` (bare reports), `M955`/`M956` `P`, `M669` five-bar/Hangprinter letters, `M558 P3/P12`, `M558 V/U` and the load-cell rules (`m558-p12-load-cell`), `M569.4` per-driver `T`, `M301`/`M304` removal. **Found and added: `M563 H`/`M140 H`/`M141 H` heater cross-assignment** (`m563-h-rejects-bed-or-chamber-heater`; the M140/M141 descriptions extended). It was in commit `8a1738d02` (the one that made `H` a colon list) and nobody had read the validation it adds.
- **Shared helpers**: the whole of `GCodeBuffer.cpp` and `StringParser.cpp` was read. The G-code line limit is unchanged (256, `MaxGCodeLength` -> `MaxGCodeStringLength`). New, and only a *widening* (nothing in 3.6.3 accepted it, so it matters only on a downgrade, and a line cannot be matched on it): an IP address (`M552 P` and the other IP parameters) or MAC may now be quoted or an expression, and stops at the first space; `GetStringOrUIValue` accepts a string or an unsigned number where one was expected. Runtime-only: a macro frame now remembers the command that invoked it (`RestoreInvokingCommand`), `SetModalGCommand` on resume.
- **Motion maths**: every commit touching `DDA*.cpp`, `DriveMovement*`, `MoveSegment*`, `DDARing`, `Move*.cpp`, `StepTimer`, `RawMove`, `MovementProfile` and `PhaseStep` (168 non-merge) was listed by subject and the ones that could touch the default (2nd-order) path were read. Most of the diff is the 3rd-order planner itself, which only runs when S-curve is on, and bug fixes to code that did not exist in 3.6.3 (`518cacbbf` one step off after input shaping, `adcbbf939` negative-delta junction limit, `8b52ef0af`, `36388362c`). **One real difference on the default path**: on a Duet 3 MB6HC, `DDA::InitStandardMove` now plans the junction of two printing moves from their extrusion ratio even when S-curve is off (event `planner-junction-extrusion-ratio-mb6hc`, undetectable by design and read from the code, not measured).
- **Configuration limits**: `Config/Configuration.h` and the per-board `Pins_*.h` constants were diffed. Only serial-channel counts (covered by the renumbering events), `UsbTimeout` 2000 -> 500 ms and new per-board capabilities changed.

The two gaps this pass left open (the planner's numerics; `Libraries/`, `Hardware/`, `Storage/`, `Networking/`) are closed in the next section. "No new finding" in a directory still means the read found none, not that none exists.

## Second value pass: the helper directories and the planner's numerics (2026-10-01)

Same method (`git diff 3.6.3 3.7.0-rc.2` read as source, nothing checked out), over what the first value pass skipped.

### `Libraries/`, `Hardware/`, `Storage/`, `Networking/`

- **`Libraries/`** is FatFs and the SD driver (7 files changed). Nearly all of it is the LRU sector cache (`FF_LRU`, `DiskBuffer`; the single window per volume is gone), which changes who owns a sector buffer and nothing a file can see: file names, long-file-name rules, attributes and dates are untouched. One reply text moved (the M122 SD line now also gives sectors read/written). Text only.
- **`Hardware/`**: the UART objects moved to CoreN2G (`AsyncSerial` is no longer declared here), the SPI stack moved to CoreN2G (the `Hardware/Spi` files are deleted), a second USB CDC port, the INDX board, the GMAC Ethernet drivers (TX ring refill, TLS 1.3 stack sizes, mDNS multicast filter), linker scripts. None is a G-code, reply or object-model surface. **I2C** is the one that matters: M260/M261 now work on the Duet 3 MB6HC, MB6XD and Mini (a `SharedI2CMaster` on io2.in, `9b6d229d3`, `4c8dd1a81`), and the first M260/M261 reserves the bus pins (`i2c0.clk+i2c0.dat`) so they cannot also be a GPIO: if something already owns them, the command fails with a port-in-use error. That is the `hardware` verdict again (the catalogue cannot gate an event on a board), so it is recorded here and not evented.
- **`Storage/`**: **M472 `R1` (recursive delete)** is a real fix (`095e5824b`, rc.2), now the event `m472-r1-recursive-delete-nested`: in 3.6.3 the recursion passed the outer directory handle, so a directory with a sub-directory could not be deleted. Also read and recorded without an event: `SecureDelete` (already in `m552-t-tristate`), the SBC async write buffering and chunked directory listing (SBC-only, internal), the preFlight layer count (already `fileinfo-preflight-layer-count`), `FileStore` atomics.
- **`Networking/`**: TLS listeners (`m586-t-tls-listener`, `m552-t-tristate`), the TLS handshake timeout, mDNS TLS service names, W5500 socket close handling, reply text for M586/M552/M122 (the M122 network line prints `n/a` instead of a 5.7-million-ms loop time). **One real change the TLS commit carried with it: HTTP is no longer enabled by default.** `NetworkInterface`'s constructor set `protocolEnabled[HttpProtocol]` in 3.6.3 and sets nothing in rc.2, so a board with a network enabled but no `M586 P0 S1` serves no web interface after the update (`0f8da3b79`, alpha.3). A config.g written by the Duet configuration tool has the line; a hand-trimmed one may not. Event `network-http-not-enabled-by-default` (undetectable: it is an absent line). Read from the code, not measured on a board, and no commit message says whether it was intended - if upstream restores the default, the event should say so.
- The lwIP vendor tree was read in surface mode only, as before (only RRF's glue file, #113).

### The planner's numerics

What was done: the default (2nd-order, S-curve off) path and the code every move passes through were read as diffs, not matched by pattern: `DDA.cpp` (the whole diff), `DriveMovement.cpp` (the whole diff), `MoveSegment.cpp`, `ExtruderShaper.*`, `AxisShaper.cpp`, `RawMove.cpp`, `DDA_3rdOrder.cpp` for what it adds to non-S-curve moves, `Move::AddLinearSegments` against its 3.6.3 text, the kinematics files that changed (`LinearDelta`, `RotaryDelta`, `Scara`, `ZLeadscrew`, `Kinematics`, `Core`: float/double casts and a reply-text fix; `Hangprinter` and `FiveBar` were read for their configuration surface in the by-note pass, not for their numerics), and the segmentation arithmetic in `GCodes.cpp` (arc segment length, `totalSegments`, the per-segment extrusion split: identical apart from the `ms.raw.` rename). The `Config/` constants had been diffed already.

**Unchanged on the default path** (compared line by line): the accelerate/cruise/decelerate maths (`RecalculateMove`'s `vsquared`, the accel and decel distances, the clock counts and their `lrint` rounding; `maxDeceleration` is gone but 3.6.3 always set it equal to `maxAcceleration`, so the new `V^2 = (2a.dist + v^2 + u^2)/2` is the old formula with d = a), `MatchSpeeds` (same body), the segment lengths and start times `AddLinearSegments` hands each driver (for a single-slope pressure advance `GetAverageAdvanceClocks` returns k0, i.e. the old `accelClocks * K`), the step-time quadratic (`fastLimSqrtm`, `CalcNextStepTimeFull`, the 0.05 end-of-segment snap), kinematics segmentation and arc splitting.

**Different, all small and none selectable from a file** (read from the code, none measured):

- On an MB6HC the junction rule (`planner-junction-extrusion-ratio-mb6hc`, found in the first value pass). Its non-printing branch (`SetSpeedRatioAndMaxJunctionSpeedForNonPrintingMoves`) applies the same cap by each visible axis's M566 maximum to travel and mixed junctions and also by the previous move's own requested speed; `MatchSpeeds` still runs after it with the (lower) printing limits, so for those junctions the effect is nil or tiny. Not a separate event.
- Input shaping: which moves wait for the previous shaping tail (new event `input-shaping-unshaped-move-start-gap`, alpha.2, `a30caa5b9`).
- A segment shorter than 20 step clocks is merged into the next one when it is about to execute (`MinimumExecutingSegmentDuration`, `DriveMovement::NewSegment`), and an axis whose last segment ends within 0.05 of a whole step is snapped onto it there as well as in `CalcNextStepTimeFull`. Sub-step effects that remove speed/acceleration "discontinuities" the new diagnostics would report; no distance or time a user can see.
- `MovementState::AllocateAxes`/`UpdateCoordinatesFromLastKnownEndpoints` now refresh the ring's start coordinates from the motor-rounded position (`UpdateStartCoordinates`), so the first move after allocating an axis no longer sees a sub-step delta on every axis. A rounding fix, not a new rule.
- `extrusionFraction` (the average extrusion speed that feeds the heater feed-forward) now also counts extruder-only moves with a positive extrusion (`DDA::Prepare`); relevant only to `M309` users and covered in spirit by `m309-extrusion-feedforward-reworked` and `om-value-heat-heaters-extrpwmboost`.
- `DDA::Prepare` shortens the lead time before a move that touches no CAN-connected driver to `AbsoluteMinimumPreparedTime` (latency, not the path).

**Not compared, and it is not a small remainder.** The 3rd-order planner (`DDA_3rdOrder.cpp`'s `PlanMoves`, `MovementProfile.cpp`, the jerk phases of `DriveMovement`/`MoveSegment`) has no 3.6.3 counterpart, so there is nothing to diff it against; it only runs with S-curve on, and its output (a path's exact timing) can be judged only by running it. The quartic/cubic step-time solver for the jerk phases is the same. The `Hangprinter` and `FiveBar` kinematics numerics, `PhaseStep`/closed-loop and the TMC51xx look-up-table builder were not read for numbers. And "compared by reading" is not "measured": none of the above was run on a machine.

## Not done / limits

- The by-note read surface-scanned the motion-maths files; the second value pass then read the default-path ones. What is still unread is listed at the end of that section: the 3rd-order planner has no 3.6.3 counterpart to diff, and nothing here was measured on a machine.
- The line-by-line read is of the **293 by-note commits**. The rest of the triage (commits that got an event or a dictionary change at the time) was reviewed then, not again here.
- `widening` and `hardware` verdicts are recorded, not evented: the catalogue cannot say "this port is on an expansion board" or "this board has I2C".
- `M122 P1xxx` developer test values and `M111` debug-flag numbers are not enumerated in the dictionary (crash and diagnostic tests); #38-#42, #258 and #275 are in that category.
- The catalogue is still **"known changes"**, never "your files are safe": value-level and required-ness changes need a hand-written event, and this read found several that a one-line subject had hidden
  (M116, M221, M950 J, M552 T, the object-model dates). A commit whose diff is one line in a shared helper can still hide the same kind of change, and a numerical change in the motion maths is invisible to it.
