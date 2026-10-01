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

## Not done / limits

- The motion-maths files were surface-scanned, not read (see above). A timing or rounding difference there is invisible to this method.
- The line-by-line read is of the **293 by-note commits**. The rest of the triage (commits that got an event or a dictionary change at the time) was reviewed then, not again here.
- `widening` and `hardware` verdicts are recorded, not evented: the catalogue cannot say "this port is on an expansion board" or "this board has I2C".
- `M122 P1xxx` developer test values and `M111` debug-flag numbers are not enumerated in the dictionary (crash and diagnostic tests); #38-#42, #258 and #275 are in that category.
- The catalogue is still **"known changes"**, never "your files are safe": value-level and required-ness changes need a hand-written event, and this read found several that a one-line subject had hidden
  (M116, M221, M950 J, M552 T, the object-model dates). A commit whose diff is one line in a shared helper can still hide the same kind of change, and a numerical change in the motion maths is invisible to it.
