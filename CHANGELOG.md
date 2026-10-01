# Changelog

Hand-kept list of user-visible changes, in addition to the release workflow's own generated notes.

## 1.34.0 - 2026-10-01

- **`syntax/text-after-command` (warning).** Words after a command's parameters - `M104 S200 heat up`, `G28 home all axes`, `G1 X10 moves left`, `M98 P"a.g" then run it` - are one finding over all of the words. RRF reads each letter of them as a parameter, so they used to surface as a run of unrelated `dictionary/unknown-parameter`/`wrong-kind`/`unknown-command` warnings (or nothing, after `M98`); those are now dropped for the text. A group starts at a lowercase word of 3+ letters that is not a parameter of that command and runs over the lowercase words and numbers after it. Not reported for text a command takes as its argument (`M117`, `echo`), a code with no reviewed entry (custom codes), a word made only of the command's own parameter letters (`M18 xy`), or an unquoted string value (`M550 Pname`). A one-word note (`up`) is too short to tell from parameter letters and is not reported.
- **Quick fix on both rules.** `syntax/bad-command` and `syntax/text-after-command` carry a `fixes` entry ("Turn the line into a comment" / "Turn into a comment": insert `; ` at the start of the text).
- **`syntax/bad-command` (error).** A line RRF cannot read as a G/M/T command, a meta-command or a comment is now reported: RRF answers it with `Bad command: <line>`, but nothing flagged it before. It also catches text that lost its `;` (`Check the probe first`, `Tool change`, `go home now`: a line of words, including one starting with G, M or T followed by a letter) and says to start the line with `;`; a code with a number is still `dictionary/unknown-command`'s business, which knows custom codes. The motivating case is `endif` / `endwhile` (and `endfor`, `fi`, `done`, `elseif`, ... from other languages): RRF ends a block by indentation and has no closing keyword, so the message says so. A bare axis line (`X10 Y20`) is never flagged: on a CNC or laser machine it repeats the last G0-G3, and the machine's mode is not known to a static check. A capitalised meta keyword keeps its own rule, whose text no longer says the line is "silently ignored" (RRF reports an error for it). The `fff-basic` corpus fixtures had `endif` lines and lost them.
- `npm run check-rrf-release` and a daily workflow (`rrf-new-release.yml`) that opens an issue when RepRapFirmware tags a release newer than `RRF_BASELINE` (D7 of the firmware-change plan). Tooling only; nothing in the package changes.

## 1.33.0 - 2026-10-01

This release is the API below plus the catalogue-accuracy pass that followed it (the API was committed on 2026-09-30; neither was published until now).

### D3 finished: all 293 by-note triage commits read as diffs; M669 per-kinematics letters (Hangprinter, five-bar SCARA) enumerated

- **Method and limits** are in `docs/rrf-triage/d3-line-by-line.md`: every commit's diff was read (`git show`, nothing checked out) and compared against both the 3.6.3 and rc.2 trees; the motion-maths files and vendored code were surface-scanned only, and the document says so.
- **Schema.** `CommandSpec.selectorVariants` (letters read per value of a selector letter: `M669 K6` Hangprinter, `K9` five-bar) and, on event targets, `whenCompanion` (the other letter has this value), `whenElements` (list length), `alsoAbsent` (with `whenAbsent`: the line leaves out all of these letters) and a `*` prefix in `whenValue` lists. `dictionary/unknown-parameter` and missing-required read the variant.
- **New events.** `m116-bare-waits-for-all-tools` (a bare `M116` now waits for every tool, not the selected one) and a corrected pin for `m116-p-colon-list` (3.7.0-beta.2+1, the wiki said beta.3); `m221-rescales-queued-moves` (rc.1); `m950-j-filament-monitor-input` (beta.2+1) and `m950-j-probe-input` (beta.3);
  `om-boards-firmware-date-includes-time` (beta.2); the M669 events (`m669-hangprinter-anchor-count-8`, `m669-five-bar-d-two-values`, `m669-five-bar-own-kinematics-type`), `m666-hangprinter-*`, `m569-4-hangprinter-t-per-driver`, `m141-h-colon-list`, `m141-chamber-heater-own-defaults`,
  `m586-t-tls-listener`, `m950-led-k-honoured-for-neopixel`, `m997-s3-wifi-external-removed`, `om-inputs-state-unused`, `om-move.accelerationTime-added`, `om-move.usingSCurve-added`. `m552-t-tristate` now says T1 on WiFi moves `/sys/server.crt` + `.key` into the module and securely deletes the SD copies.
- **Dictionary.** `M669` per-type letters; `M116` P/summary; `M586` T/R; `M906` (over-maximum current is clamped and now reported as an error from rc.1); `M950` C virtual inputs; `M552` T.
- **Object-model dates the mirror had wrong, now decided by RRF's own tables** (`scripts/build-om-schema.mjs`: `RRF_OBSOLETE_FROM`, `RRF_SOURCE_OVERLAYS`, `RRF_TAG_DECISIONS`): eleven deprecations were dated 3.6.3 (so a scan could never report them) and are now beta.1; the restore-point `gCommandNumber`, `boards[].timeout` and
  `move.currentMove.filePosition` start at beta.2; `loadCell.*`, `filamentPresent` and `filamentMonitors[].agc` at beta.3; `boards[].drivers[].config` at beta.1; `move.motionSystems[].currentMove.filePosition` is removed (RRF never serves it). Its shipped event id is listed under `retired` in `test/fixtures/event-ids.json`.
  `deprecated` entries gained an optional `source`.
- **Tests.** `selectorVariants.test.ts`, `byNoteEvents.test.ts`, `objectModelSince.test.ts`, `objectModelObsolete.test.ts`, `thirdOrderObjectModel.test.ts` (mutation-checked against the previous schema), plus `releaseFixtures`/`releaseValueTargets` updates and `audit-releases.mjs` learning that an object-model event is dated to a tracked snapshot.

### Release audit test no longer passes on a stale build

- `test/releaseAudit.test.ts` now fails (with "run `npm run build` first") when `dist/releases/changes.js` is older than anything in `src/releases`. `audit-releases.mjs` reads `dist/`, so before this it could pass against old events after a data edit. Mutation-checked by touching `src/releases/changes.ts`.

### The last 24 unchecked commands, read by hand: `historyChecked` is 282 of 282 (E7 done)

- **Method.** Each handler (and the helpers it hands `gb` to) was read at rc.2, then its parameter-reading lines were hashed at all 18 tracked builds (a throwaway per-build script, same idea as `dictionary-handler-drift.mjs` but following the function the case calls, which that tool cannot for these). An identical hash at every build means no letter appeared, went or moved; a hash that moved was read as a diff. The two entries the tools could never follow (kinematics `Configure`, `DiagnosticTest`) were read whole.
- **Real catalogue misses found and fixed** (a line using the letter was flagged `dictionary/unknown-parameter` although RRF reads it, at every tracked build): **`G2`/`G3` `S`** (laser power, laser mode) and **`P`** (IOBITS) - `DoArcMove` reads both, the entry listed neither; **`M567 E`** (the mix ratios; the entry had only `P`, so every real M567 line was flagged); **`M568 F`** (spindle RPM) and **`A`** (heater state 0/1/2, since RRF 2021); **`M665 D`** (switches to delta mode like `L`, read only for that); **`M669 S`/`T`** (segmentation, read by every kinematics type through `TryConfigureSegmentation`); **`M122`'s** developer/factory-test letters `S`, `C`, `A`, `R`, `V`, `T`, `W` (each read only for a particular `P`, described as such).
- **Two wrong facts removed.** `M568` listed per-axis tool offsets, but `SetOrReportOffsets` reads the axis letters only for G10 (`if (code == 10)`), so an axis letter on M568 is now flagged and its summary no longer claims "offsets". `M669` flagged the axis letters of every Core kinematics line (`M669 K1 X1:1:0 Y1:-1:0 Z0:0:1`: the most common use); it now has an `axisParameters` catch-all that documents the letters are kinematics-specific and not enumerated.
- **One new event: `m569-2-bare-reports-waveform` (3.7.0-rc.1, `changed`, `M569.2` `R` `whenAbsent`).** A bare `M569.2 P<driver>` was an error at 3.6.3 ("missing parameter R", and on a CAN driver "Missing P or R parameter in CAN message", Duet3Expansion `ProcessM569Point2`); from rc.1 (RRF `6544cc727`) on a TMC51xx/TMC2240 SPI driver it reports the sine-table waveform corrections. This is the required-ness change that kept `M569.2` unchecked (E6); it is an event on the parameter, as `g68-bare-reports-rotation` is, with a real-file fixture in `releaseFixtures.test.ts`. Not in `test/fixtures/event-ids.json` on purpose (no published core has shipped it).
- **Confirmed unchanged at all 18 builds, no data change beyond `historyChecked`**: `M665`/`M666` (the delta `Configure`, both cases), `G0`/`G1` (`DoStraightMove`, `LoadFeedrateFromGCode`, `LoadExtrusionFromGCode`: only `ms.` became `ms.raw.`), `M109` (its body is shared with `M104`; R, S, T), `M150` (`HandleM150`, `GetM150Params`: colour variables renamed only), `M309`, `M571`, `M585`, `M675` (the letter-reading lines of the function each `case` calls, and of `FindAxisLetter`/`SetZProbeNumber`/`GetSpecifiedOrCurrentTool`), `G68` (only `R`'s mandatory-ness moved, already `g68-bare-reports-rotation`), `T` (`HandleTcode`: T, R, P).
- **The no-dispatch entries** `M573`, `M650`, `M651`, `M900` have no `case` at any of the 18 builds (macro-only throughout), and **`M569.9`** has no `case 9` in Duet3D's `ConfigureLocalDriver` at any of them: nothing of the tracked firmware to date them against. `M569.9` belongs to the gloomyandy fork, whose own releases are not tracked, so it is `historyChecked` for the Duet3D window and carries no `since`/`until` (the `platforms` marker limits it). `M669`'s check covers `K`, `S`, `T` and the catch-all, **not** the per-type letters: Hangprinter's `F`/`B`/`P` first appear in RRF `02473d7bf` (first contained by 3.7.0-beta.2) and the five-bar SCARA's `D` takes 2 or 4 values since 3.7, changes a per-type `since` cannot express (E6), recorded in the entry's source text and **not** events.
- **Found while testing, not fixed**: a hex number directly after a letter (`A0x20000000`) lexes as `A0` plus a parameter `x`, so the `unknown-parameter` rule flags it; the new test uses decimal.
- Core suite green (50 files, 2373 tests), typecheck clean; `HISTORY_CHECKED_FLOOR` is now 282 and a new diagnostics test (mutation-checked: dropping M567 `E`, M568 `A`, G2 `S` or M122 `W` fails it) holds the added letters.

### Fractional codes, second pass: the closed-loop family (Duet3Expansion and CANlib read), M260/M261, G38/G59, M970.x, M576.1 (E7)

- **`historyChecked`: 258 of 282** (was 227 of 281); one command entered (`M576.1`). Sources cloned for this pass: `Duet3D/Duet3Expansion` (tags `3.6.3` ... `3.7.0-rc.1`) and `Duet3D/CANlib` (tags `3.6.3`, `3.7.0-beta.3`, `3.7.0-rc.1`, `3.7.0-rc.2`); the closed-loop letters are defined by CANlib's `M569PointNParams` tables and read by the expansion's `ClosedLoop`/`Move`, neither of which RepRapFirmware contains. A table plus its parser at two releases is what confirms a forwarded letter.
- **`M569.1 B` is `since: 3.7.0-rc.1`** (Duet3Expansion `7f7fb7f7` "Added encoder stall endstops and standstill deadband" and CANlib `b51d61e`, both 2026-08-24; neither is an ancestor of the beta.3 tags, both of rc.1). Generated event `dict-M569.1-B-added`. Every other `M569.1` letter (T E C R I D S V A Q Y) is in CANlib's table and the expansion's `ProcessM569Point1` at 3.6.3 and rc.1.
- **`M970.3` is `since: 3.7.0-rc.1`** (RRF `6544cc727` "Added M970.3 to apply the same correction to the commutation waveform in phase stepping mode", 2026-08-21; `ConfigureStepMode` at 3.6.3 has only fractions -1, 1 and 2). It was not dated at all before, so a scan reported nothing for a line using it on 3.6.3. It also gains the `S` (harmonic 1-16), `J` (magnitude 0-90 degrees) and `O` (phase 0-360 degrees) that `PhaseStep::ConfigureCorrection` and CANlib's `M970Point3Params` read; before, only `P` was listed. Generated event `dict-M970.3-added` (beside the hand-written rc.2 `m970-3-can-expansion-boards` on the same target: an upgrade across both keeps the later one and a downgrade the earlier, as `collapseSuperseded` does for any chain).
- **`M576.1` entered** (`since: 3.7.0-alpha.4`, `P` the SBC protocol version): the fraction gate in `HandleMcode` and the `GetCommandFraction() == 1` branch of `SbcInterface::HandleM576` both arrive in RRF `a919948d3` and are absent at 3.6.3, alpha.2 and alpha.3. The previous section said "first allowed at beta.1"; the per-build check says alpha.4. DSF sends it, so this is a coverage gap closed rather than a missed notification.
- **`M569.3` and `M569.8` were described wrongly**: they are not closed-loop-board commands forwarded as a CAN message. They are Hangprinter-only calls into the ODrive code (`ReadODrive3Encoder` / `ReadODrive3AxisForce`) over the secondary CAN interface, in `DUAL_CAN` builds (Duet 3 MB6HC/MB6XD), and answer "not supported" otherwise; `M569.3` reads an `S` (take the reading as the new zero reference) that the entry lacked. **`M569.4` gains `V`** (the torque-mode maximum speed, read by the expansion's `ProcessM569Point4` at both releases). `M569.6`'s `S` and `A` are in CANlib's table but read by nothing in the expansion firmware at either release, so they are deliberately not listed (the entry's sources say why).
- **`M260.x`/`M261.x` entries were missing letters the shared prologue reads**: `S` (a string alternative to `B`) on `M260.1`, `.3` and `.4`, `B` on `M260.3` (the Nordson branch frames the `B`/`S` data; an old note saying it "does not use the general B/S parameters" was wrong and is corrected), and the result variable `V` on `M260.4`, `M261.1` and `M261.2`. `M260.1` also documents that one of `B`/`S` is required ("missing parameter 'B' or 'S'").
- **Confirmed per build (hash of the parameter-reading lines at all 18 tracked releases), no data change beyond `historyChecked`**: `M260.2`, `G38.2`-`G38.5` (`StraightProbe`: only the `ms.coords` -> `ms.raw.coords` line changed), `G59.1`-`G59.3` (`NumCoordinateSystems` is 9 at every build, the block is byte-identical), `M201.1` (every change in `case 201` is `T`, which is guarded `frac < 1`), `M505.1`, `M586.4` (`MqttClient::Configure` reads the same letters at every build), `M36.1`/`M36.2`, `M970`/`M970.1`/`M970.2`, `M569.5`/`.6`/`.7` and `M73` (`PrintMonitor::ProcessM73` reads `R` and `C`, never `P`, at every build). Against 3.6.3 the `M260/M261` handlers differ only in the aux channel numbering (`- 1` became `- FirstAuxChannel`, events `aux-port-numbering-*`) and `I2C::Init(reply)` now able to fail.
- **Still unchecked (24), all settled in the section above**: `M569.2` (required-ness of `R` changed, which `since` cannot express, E6), `M569.9` (the gloomyandy fork only; no per-release source for it here), and the ones the tools cannot follow: `G0`-`G3`, `G68`, `M109`, `M122`, `M150`, `M309`, `M567`, `M568`, `M571`, `M585`, `M665`, `M666`, `M669`, `M675`, and the no-dispatch-case entries `M573`, `M650`, `M651`, `M900`, `T`. A test holds the count from regressing.

### Fractional codes, read per fraction (E7, first family batch)

- **`M581.1` is dated `since: 3.7.0-alpha.2`** (RRF `489a47c43`, "Implemented triggering on an expresson becoming true"). At 3.6.3 `HandleMcode`'s
  fractional allow-list (`GCodes2.cpp:730-735`) has no 581, so `M581.1` fell through to `TryMacroFile`; alpha.2 adds it. The generated event is
  `dict-M581.1-added`, and a line using it now flags `dictionary/not-available-on-firmware` on 3.6.3.
- **`M581` and `M581.1` gain `R`** (the enable condition: 0 always, 1 only while printing, 2 only when not printing), read after the fraction switch at every
  tracked release and missing from both entries. `M581` is now `historyChecked` (its unmarking was only for this hidden fraction).
- **`historyChecked` for `M558.1`-`.4` and `M587.1`/`.2`: 227 of 281** (was 219). M558's fractions were read per fraction (`HandleM558Point1or2or3` /
  `HandleM558Subcommand`, `RemoteZProbe::CalibrateDriveLevel`, `ZProbe::SetTouchModeParameters`): identical letters at all seven releases,
  `M558.4` (`since` beta.3) confirmed from the `> 3` versus `> 4` `TryMacroFile` gate. `M587.x` by hashing `HandleWiFiCode` at every release (one hash).
- **`M569.2`'s `S`, `J`, `O` (sine-table waveform correction) are `since: 3.7.0-rc.1`** (RRF `6544cc727`, `546faee47`; `ConfigureLocalDriver` read only `R`/`V` at
  3.6.3 and is byte-identical through beta.3+1). Events `dict-M569.2-S-added` / `-J-` / `-O-`. `M569.2` itself stays unchecked: on a CAN driver
  `R` is required only when `V` is given as of rc.2 (always at 3.6.3), a required-ness change `since` cannot express.
- **`M569.4` was described wrongly and lacked `T`**: it is RRF's "set driver torque mode" (a Hangprinter's ODrives, experimentally an EXP1HCL/M23CL), not "set a
  target position". `T` added. On a Hangprinter the `T` value became one per `P` driver (a colon list, with `P` a list) in 3.7.0-beta.2 - a shape change, recorded in
  the entry's source text and **not yet an event** (E6). The closed-loop-board branch forwards `M569Point4Params`, which lives in CANlib; that, `M569.1/.3-.8` and the rest of the
  family were settled in the next section up once CANlib and Duet3Expansion were cloned (only `M569.2` and the fork-only `M569.9` stay unchecked).
- **Method**: the per-release function hash (same function text at all seven releases means the fraction cannot have changed) is the fast
  signal for a fraction family; a hash that moves is read as a diff. The families whose handler hash moved (`M569.x`, `M260.x`/`M261.x`, `G38.x`,
  `M201.1`, `M505.1`, `M586.4`, `M36.x`, `M970.x`, `G59.x`) were read as diffs in the next section up.
- **Found, then entered (next section up)**: `M576.1` (switch to USB SBC mode, `P` = protocol version; dated alpha.4 there, not beta.1 as first noted) had no dictionary entry; it is
  sent by DSF, not written in a user's files, so it is a coverage gap rather than a missed notification. `M970`'s fractional gate is
  `SUPPORT_PHASE_STEPPING` up to rc.1 and `|| SUPPORT_CAN_EXPANSION` at rc.2 (a build flag, board-dependent).

### Value-level change events (wiki `Gcodes.md` pass, D3 step 3)

- **`ChangeEventTarget` parameter targets take `whenValue`**: the event is about one accepted VALUE of a parameter that keeps existing, and `impactOf` flags only a line whose literal value is one of those (numbers compare numerically, text case-insensitively with its quotes dropped; a `{...}` expression or a bare letter never matches). `targetKey` includes it, so a value event never collapses with the letter's own. New events: `m558-p3-removed` (rc.1; the line is now an error, it was accepted at 3.6.3 - the catalogue already said so in M558 P's description but no event flagged it), `m558-p12-load-cell` (beta.3), `m574-s5-encoder-endstop` (rc.1), `m308-bme68x-added` (alpha.3). `docs/wiki-discrepancies.md` records the wiki's "P2/P5 deprecated from 3.7.0" (not in the firmware) and the claims checked and found consistent.

### Change-event catalogue: accurate per release (FIRMWARE-CHANGES-PLAN.md workstreams D and E, first pass)

- **`RELEASES` tracks every `Version.h` string a board can report**, not just tags: `3.7.0-alpha.3`..`alpha.8`, `3.7.0-beta.2+1` and
  `3.7.0-beta.3+1` join `3.7.0-rc.1+1..+3`, and every entry carries the `commit` it was read from. `scripts/audit-releases.mjs` checks the
  table against an RRF clone (`RRF_CLONE`, or `../RepRapFirmware`); `test/releaseAudit.test.ts` runs it when a clone is present.
- **Pin rule**: an event sits at the FIRST tracked release whose commit contains its change (`git merge-base --is-ancestor`), replacing
  the mix of `git describe --contains` and "the `Version.h` string in the commit's own tree". A `Version.h` string spans many commits and a
  tag comes a week after its bump, so the old rule could date a change to a build that predates it (silence for a user on that build).
  Re-pinned: `expr-array-concat` (alpha.4), `m552-t-tristate` (alpha.6), `m301-removed`/`m304-removed` (alpha.7), `m140-h-colon-list` (alpha.3),
  `m564-r-added` (beta.2+1), `m303-f-default`, the `om-*` current/direction fixes (rc.1+3) and the `rc.1+3` group that first shipped in
  rc.2 (`m201-t-warnings`, `m569-c-more-chopconf-bits`, `m970*`, `m959-*`, `m581-1-*`, `m669-*`, `fileinfo-preflight-layer-count`).
  `FEATURES.arrayConcatOperator.since` is now `3.7.0-alpha.4` (was `3.7.0-beta.1`).
- **The dictionary is the source of truth for command/parameter existence events.** `CommandSpec`/`ParamSpec` gain `eventIds`, so a
  generated event keeps an id a hand-written one already published; `m408-removed`, `m301-removed`, `m304-removed`, `m564-r-added` and
  `m558-4-added` now come from `since`/`until` (M408 gains an `unimplemented` entry, `until: "3.6.3"`).
- **`until` is the LAST release that has the command or parameter** (inclusive, as in the object-model schema). Its removal event now
  sits at the first release after it; before, the generator dated it at `until` itself, which `changesBetween`'s `(from, to]` window
  would have missed. `dictionary/not-available-on-firmware` now says "isn't available after RRF X" (it read "was removed in RRF X"), and
  no longer judges a macro-only (`unimplemented`) entry, whose `/sys/<code>.g` is a legitimate trigger.
- **Wrong facts removed.** `M140 H` did not begin at `3.7.0-beta.1`: RRF 3.6.3 already read it (only the colon-list form is new, event
  `m140-h-colon-list`), so a 3.6.3 board was told a valid line did not exist. `M221 F1` (`m221-f-added`) was added on 2026-09-03 and removed the
  next day, before the rc.1 tag - no tracked release reads it. `M574 E` is from `3.7.0-beta.2+1` (was `beta.3`) and `M959` (added by RRF
  commit `e77b50a1e`) is from `3.7.0-beta.2`. `M201 T` stays `3.7.0-alpha.2` but is now cited to the commit that brought it back
  (`ace7cc030`), not to the later warnings commit. Retired ids are listed with reasons in `test/fixtures/event-ids.json` (`retired`).
- **Object model**: `3.7.0-alpha.2` now has data (`hasData: true`), derived from its neighbours and RRF's own `OBJECT_MODEL_TABLE`s at that
  tag with an evidence check (`scripts/build-om-schema.mjs`, `scripts/lib/rrfTables.mjs`). `move.currentMove.distance`/`duration` are from
  alpha.2 (RRF `Move.cpp:198-199`), not beta.1. `objectModelChanges` reported a removal at the LAST release the path exists in; it now reports
  the first release without it.
- **`dictionary/coverage.json` gains `versionHistory`** and `CommandSpec.historyChecked`: the newest release up to which a command's own
  existence and every parameter's history were confirmed against source. 210 of 281 commands so far: the config-time batch, the homing/macro batch (G29 and M400 gained the
  `P` and `S` their handlers read first), then the remainder in which two independent signals agree (see `scripts/dictionary-handler-drift.mjs`) and every
  parameter-reading line that changed between 3.6.3 and rc.2 was read and assigned to a command. `M26 C`, `M572 L`, `M576 B/D`, `M576 F` (until beta.3) and
  `M953` (a stub that answered `errorNotSupported` until alpha.5) gained `since`/`until`; `M557` gained the `P`/`S`/`R` it reads (and its axis range no longer claims a
  third `spacing` value). Still open: commands whose entry lacks a letter the handler reads (M122, M260, M261, M588, M665, M666, M673, ...), the fractional codes
  (`M576.1`, `M581.1`, `M970.3`, ...), and the kinematics-, LED- and G0-G3-shaped handlers the tools cannot follow. A test holds
  the count from regressing, and another holds every `since`/`until` to the tracked releases.
- **Tools**: `scripts/dictionary-history.mjs` (which G/M/T codes RRF dispatched at every release -> `docs/dictionary-history.md`),
  `scripts/dictionary-param-history.mjs` (which listed letters a handler reads at every release -> `docs/dictionary-param-history/`),
  `scripts/dictionary-handler-drift.mjs` (a second signal: the parameter-reading lines of each handler compared at every release; a STABLE command cannot have gained or lost a letter in the text followed),
  `scripts/explain-handler.mjs` (the confirm step), `scripts/lib/rrfClone.mjs` (`RRF_CLONE`; `rrf-triage.mjs` no longer hard-codes a path).
- `ImpactReport.coverage` says when the range starts before 3.6.3 or ends after the newest tracked release (the catalogue is silent there).
- `test/releaseFixtures.test.ts`: a real-file fixture for each release that has events, forward and backward.
- **Per-release triage checklists** (plan D2): `scripts/split-triage.mjs` re-slices the two closed range documents into
  `docs/rrf-triage/per-release/<previous>..<release>.md` (777 items over 17 releases), carrying each closure by commit SHA, and `--check`
  confirms no event is pinned earlier than its commit's release (D3 step 1; 0 DIFFs, three later-pinned events explained). `rrf-triage.mjs`
  gains `--per-release` for a new range. 581 of them carry no closure text of their own (the script's count) and rely on their section note - the list D3 step 2 re-reads.
- **D3 second look found changes the bulk closures had skipped** (`docs/rrf-triage/d3-second-look.md`): `m575-p-channel-numbering` and
  `aux-port-numbering-m260-1..4`/`m261-1..2` (on a Duet 3 main board `M575 P1` is now the SECOND USB channel, the PanelDue UART moves to `P2` - alpha.2),
  `axis-limit-absolute-moves-error` (an absolute G0/G1 past the M208 limits errors on a 3D printer, where 3.6.3 clamped it; informational, not detectable - alpha.2),
  `m574-k-range-checked` (rc.1) and `g68-bare-reports-rotation` (beta.3). The reviewed `M564 R` description was close to backwards (R defaults to ON and means
  *clamp* relative moves instead of erroring) and is corrected; `M575 P` says what its numbers mean. Fixtures for each in `test/releaseFixtures.test.ts`.

### Firmware-change scan API (committed 2026-09-30)

### Firmware-change scan: which lines of a machine's own files a version change affects

- **`scanImpact(files, from, to, options?)`** (`dwc-gcode-core/releases/scan`) classifies each `{ path, text }` (menu, `board.txt`, CSV,
  binary and print files are skipped), runs `impactOf` and returns an `ImpactReport`: occurrences by event and by file with a one-line
  snippet, an `acknowledged` bucket for events the caller has already reviewed, `totals`, and `undetectable` - the in-range changes
  no matcher can see, which a UI must show so an empty report is never read as "all clear". Either version order works (a downgrade),
  and a board's `(CAN0)` suffix or a `+N` build is accepted. `scanFile` and `buildImpactReport` are the same thing in parts, for a host
  that caches per file.
- **`impactToDiagnostics(findings, { file, rules })`** (`dwc-gcode-core/releases/diagnostics`) reports findings as `Diagnostic`s under four
  new rules: `release/removed` (warning; also an added feature seen from a downgrade), `release/changed`, `release/deprecated` and
  `release/default-changed` (info; a parameter that is absent where its default or requirement changed). `impactEventId()` recovers the
  event id from a message.
- **`RELEASES`** (`dwc-gcode-core/releases/releases`): the tracked releases, tags and the `3.7.0-rc.1+N` builds, with dates.
  A test holds every object-model version and every in-window change event to it.
- **`isDetectable(event)` / `undetectableReason(event)`** and `scripts/audit-detectability.mjs`. `exists(#x)` and `exists(x[0])` are now
  recognised (`expr-exists-argument-forms`, previously skipped silently); 5 of 160 events remain unmatchable, all but one predating 3.6.3.
- `test/fixtures/event-ids.json` pins every event id this release ships: a host may persist an acknowledgement against one.

### Fixed

- **`impactOf` returned line-relative `start`/`end` for command and parameter findings but absolute ones for object-model paths and
  syntax**, so `release/impact` diagnostics on any line past the first pointed at the wrong text. All findings are now absolute offsets
  into the document text, as `Diagnostic` documents. (A consumer that added `line.start` itself to a command finding must stop.)

## 1.32.0 - 2026-09-30

### Stepper: probing moves, and homing or probing that can FAIL

`G30` did nothing in the stepper, `G28` always succeeded, and only a `G1 H1` move could be made to miss its endstop. Checked against
RRF `3.5-dev` (`GCodes4.cpp`, `ZProbe.cpp`, `Configuration.h`).

- **`G30`** probes at the current XY. A plain `G30` (no `P`, `S` not -1/-2/-3) sets Z to the trigger height and flags Z homed; every
  variant then retracts to the dive height above the trigger height, so Z ends at `triggerHeight + diveHeight`. `G30 S-1/-2/-3` and
  `G30 P<n>` (a mesh point) probe and retract but home nothing. `X`/`Y` on a `G30` name where the head goes.
- **`G38.2`-`G38.5`** probe towards (`.2`/`.3`) or away from (`.4`/`.5`) the target. Z heading down stops at the trigger height;
  every other named axis, and Z probing away, has no position the file can give, so it becomes unknown (a later read pauses and asks).
- **`G29`** (no `S`, or `S0`) probes the grid, and can fail; `S1`-`S3` never probe.
- **New `ProbeModel`** (`InitialMachineState.probe`, `SimulationInputs.start.probe`, `withProbe()`): `triggers`, `triggerHeight`
  (RRF default 0.7) and `diveHeight` (default 5). `probeFromObjectModel(model)` reads `sensors.probes[0].triggerHeight` and
  `diveHeights[0]`; `mergeProbe()` and `RunSimulationOptions.machineProbe` work like the endstop equivalents.
- **Failure.** `EndstopModel.triggers: false` already let a `G1 H1` miss its endstop (the axis stays unhomed, and the walk carries on,
  as RRF does). It now also makes a **`G28`** covering that axis fail - "Failed to home axes X", axes listed in axis order - and a
  `ProbeModel.triggers: false` makes `G30`, `G29` and `G38.2`/`G38.4` fail ("Probe was not triggered during probing move" / "Probe did
  not lose contact during probing move"); `G38.3`/`G38.5` just finish their move. A failure stops the walk on that line, as RRF stops a
  macro: `ExecutionIndex`/`WalkOutcome` gain `simulated?: true` on the `"error"` status so a host can tell it from a document problem.
- `MachineState` gains `probe` and `fault`; `WalkOptions` gains `checkStep`, which `buildExecutionIndex` uses to stop on the fault.
- Not covered: `G32` (runs `bed.g`), `M585`/`M675` probing, "Insufficient axes homed for bed probing", the probe's own XY offset,
  multiple probes (`K`), and the bed-compensation maths that `G30 P`/`G29` feed.

## 1.31.0 - 2026-09-30

### Stepper: `G1 H1` endstops from the machine's object model

The endstop model a homing move uses (which end each axis's endstop is at, and the axis limits it lands on) had to be typed
into the scenario. A connected machine reports all of it, so a host can now seed it from the object model.

- **`endstopsFromObjectModel(model)`** reads `move.axes[i].letter/min/max` and `sensors.endstops[i]` (matched by axis index, as RRF
  builds both arrays - `EndstopsManager.cpp` reports `GetTotalAxes()` entries, `Endstop.cpp` puts `highEnd` in the model):
  `highEnd` true/false is `end: "high"`/`"low"`, a `null` entry (`M574 ... S0`) is `end: "none"`. It says only what the model says - a
  missing array, a non-numeric limit or an entry without a boolean `highEnd` leaves that field unset - and never sets `triggers`.
- **`mergeEndstops(machine, scenario)`** lays a scenario's own settings over the machine's, field by field.
- **`RunSimulationOptions.machineEndstops`**: what `runSimulation` uses as the defaults, under `inputs.start.endstops`. Without it
  nothing changes.
- Not covered: `G28` running the homing macros, and answering `move.axes[n].min/max` / `sensors.endstops[]` reads in the walked
  file from the endstop model (they still ask, as before).

## 1.30.0 - 2026-09-29

### 12864 display emulator: `M291` message boxes

`MenuDisplay` now draws the message box a running `M291` puts on a real 12864 display - the gap the 1.28.0 notes listed
as "not ported". Ported from RRF `3.7.0-rc.2` `src/Display/Menu.cpp` (`Menu::DisplayMessageBox`, `Menu::ClearMessageBox`)
and the message-box handling in `src/Display/Display.cpp` (`Display::Spin`).

- **`displayMessageBox(box)`** draws the box over whatever is on screen: a 1-pixel border 4 pixels in from each edge with the
  interior cleared, then in font 0 the title and the message centred (one row each - a longer message is cut at the box, as
  RRF's own "only 1 row for now"), a row of X/Y/Z jog values (`N510`-`N512`, a quarter of the width each, adjusted with the
  encoder) for the axes in `controls`, and an OK button at the left (`M292 P0`, mode bit 2) and a Cancel button at the right
  (`M292 P1`, mode bit 1), 30 pixels wide. The menu underneath is not redrawn - its items are discarded, so it stays as a
  frozen picture around the box - and the inactivity timeout is switched off; turning the knob or touching does not arm it
  again while a box is showing (`Menu::EncoderAction`/`HandleTouch`'s "not displaying a message box" test).
- **`clearMessageBox()`** forgets the box and reloads the menu that was open, at the same depth.
- **`setMessageBox(box | null)`** is what `Display::Spin` does with the firmware's current box: draw a box the display can show
  (`M291` mode 0-3, `MessageBox::IsLegacyType`) when it appears or is replaced (`seq` differs - or the box object, without one),
  leave it alone while it is the same box, drop the menu's highlight before drawing a first one, and take an active box down for
  `null` or a mode the display can't draw (a choice list, a number to type).
- New `DisplayMessageBox` type, `MESSAGE_BOX_MAX_DISPLAY_MODE`, `MenuDisplay.messageBox` and `MenuDisplay.clearHighlighting()`.
- Kept as RRF has them: `S1` (the web interface's "Close" box) shows a *Cancel* button, because the display reads mode bit 1 as
  Cancel and bit 2 as OK; a box that is cleared while the fixed "Mount SD" menu is showing redraws that menu (RRF's `Reload` would
  index below its menu stack).
- The firmware's own box state and what `M292` does to it stay the host's: a host clears the box with `setMessageBox(null)` once
  the `M292` the button sent has been processed.

No dictionary, diagnostics or RRF baseline change.

## 1.29.0 - 2026-09-29

### The offline stepper, five more things a macro test needs

- **Begin at a chosen line.** `SimulationInputs.startLine` (1-based; `withStartLine`), `WalkOptions.startLine` and
  `BuildExecutionOptions.startLine` (0-based). `startLine` on `walkExecution` existed but was only correct for a flat file:
  a block above the start line was still evaluated and run. Now everything above it is skipped without a step or an
  evaluation, a start INSIDE an `if`/`elif`/`else` arm or a `while` body resumes that body as if its condition had held
  (and carries on after the block; a `while` evaluates its condition for later passes and numbers the resumed pass
  `iterations` 0), and a start on an `elif`/`else` line begins the chain at that arm. `findReferencedInputs` takes
  `startLine` too: lines above it are not read, and a `var`/`global` declared above it no longer counts as declared,
  because the walk never runs that declaration - the scenario has to supply it.
- **`M291` parameters written as expressions are evaluated.** `M291 P{"Layer " ^ var.n} S2` used to read as a
  non-blocking box (an expression `P` counted as absent), so the walk never paused on it and never showed its text. RRF reads
  `P`/`R` with `StringParser::GetQuotedString`, whose `{` branch evaluates the expression and appends it as text
  (`AppendAsString`; `StringParser.cpp`, RRF 3.7.0-rc.1, used by `GCodes::DoMessageBox`, `GCodes7.cpp:14`). Under
  `evaluateParams`/`recordEvaluation` the walker now evaluates an `M291` line's `{...}` parameters first
  (`P`, `R`, `S`, `J`, `L`, `H`, `F`, `K`), builds the prompt from them (`parseBlockingMessageBox(cmd, evaluated)`), and records
  the line's evaluation on the step, so the "line as evaluated" view shows `M291 P"Layer 7" S2`. An unresolved path in one of
  them pauses on that path. Values are kept per command, so `G1 F{...} M291 F{...}` cannot cross-contaminate. Number formatting in a
  message is display-grade, not RRF's exact float rendering. **Behaviour change, with tests:** an expression-valued `P` with
  `evaluateParams` on is now a message box; without it, unchanged.
- **`G1 H1` homing moves.** New `EndstopModel` per axis (`InitialMachineState.endstops`, `withEndstop`): `end` (`M574`: low, high,
  none), `min`/`max` (`M208`, RRF's own defaults 0 and 200) and `triggers`. After a `G1 H1` an axis whose endstop triggered is
  put at its minimum or maximum and flagged homed; an axis that doesn't trigger ends at the move's target, not homed - as in RRF
  3.7.0-rc.1 (`DoStraightMove`, and `waitingForSpecialMoveToComplete` in `GCodes4.cpp`, which applies `AxisMaximum`/`AxisMinimum`
  only to `axesToHome & endstopsTriggered`). Without a declared `end` the endstop is at the end the move heads toward. `G1 H2`, `H3`
  and `H4` remain plain moves; an `H` move is never counted as a layer change. `move.axes[n].homed` therefore answers correctly after a
  homing macro's own `G1 H1` moves, not only after `G28`.
- **Named scenarios.** New `stepper/scenarioSet`: a `ScenarioSet` of named `SimulationInputs` with one active, and
  `addScenario`/`duplicateScenario`/`renameScenario`/`deleteScenario`/`selectScenario`/`updateActiveScenario`, plus
  `scenarioSetToJSON`/`scenarioSetFromJSON`. A file's old single scenario (`SimulationInputsJSON`) reads back as a set of one named
  `Default`, so nothing saved is lost.

No RRF baseline change.

## 1.28.0 - 2026-09-29

### 12864 display emulator (`dwc-gcode-core/display/*`)

Everything an editor needs to show what a menu file will look like on a 12864 (ST7920) display, ported from RRF
`3.7.0-rc.2` `src/Display` - the same font tables, kerning, item layout and encoder behaviour, so a preview
matches the real panel pixel for pixel.

- **`Lcd12864`** (`display/lcd`): the 128x64 1-bit frame buffer with RRF's text engine (both 12864 fonts, auto-kerning,
  margins, inverted text, `ClearToMargin`, bitmap rows, lines). The font tables are generated from RRF's own
  `glcd7x11.cpp`/`glcd11x14.cpp` by `scripts/build-lcd-fonts.mjs` (byte count verified against the `LcdFont` header).
- **`resolveMenu`** (`display/menuModel`): a menu file resolved into its items the way `Menu::ParseMenuLine` builds them -
  `R`/`C`/`F` stick from line to line, each item advances the column by its width (measured with the real fonts),
  `files` resets the column and moves the row down, missing parameters take RRF's defaults (`T` = `*`, `L` = `main`).
  Like RRF it **stops at the first error** (`firstError`, no items); `errors` still lists every problem. Also
  `buttonCommand` (`#0` -> the quoted `L` file; bare `menu` -> `menu <L>`).
- **`MenuDisplay`** (`display/menuDisplay`): a running menu against a `MenuHost` (menu files, images, directory
  listings, live values, visibility conditions, a place to send G-code): `start`/`load`/`pop`, `refresh` (incremental
  redraw, the 20 s inactivity and 6 s error timeouts, the fixed "Mount SD" menu), `encoder(clicks | 0)`, `touch(x, y)`,
  `alter` adjustment with RRF's heater/fan/speed limits, `files` browsing, `image` bitmaps, and RRF's "Error loading
  menu" screen. Not ported: M291 message boxes.
- **`display/menuValues`**: the legacy `N<code>` table (`classifyMenuValueCode`), `printf`-style and `h:mm:ss` formatting.
- **Menu diagnostics**: `menu/parse-error` (Bad command / Bad arg letter / Missing string arg - each blanks the whole
  menu in RRF), `menu/buffer-full` (RRF's 2500-byte string buffer), `menu/line-too-long` (RRF splits lines at 119
  characters) and `menu/unknown-value-code` (`***` on the display).

Also fixed: `classifyFile` treated `0:/menu/*.bin` as a text menu file; it is an image (the wiki's own example is
`image L"reprapimg.bin"`), so `.bin` joins `.img`/`.xbm`/`.bmp` as `menu-image`.

Behaviour change, with a test: **`MenuError.column` is now consistently a column in the line as written.** "Bad command"
and "Unknown command" used to count from the command word (ignoring leading whitespace) while the other two counted
from the start of the line. The new `MenuError.rrfColumn` is the column RRF's own error screen shows (counted from
the command word). Unindented lines are unchanged.

## 1.27.0 - 2026-09-28

### Offline stepper as a testable scenario (`dwc-gcode-core/stepper/simulation`)

For stepping through system files and macros (`homeall.g`, `pause.g`, `config.g`, ...), not print files: the
stepper can now be set up before it runs, and shows what each step did.

- **Starting state.** `createState({ initial })` / `InitialMachineState`: axis positions, homed axes, tool,
  feedrate, `G91`/`M83`. A macro that moves relative to "wherever the head is" now has somewhere to be.
- **Axes beyond X/Y/Z.** `MachineState` gains `extraAxes`, `axisLetters` (the `move.axes[]` order) and
  `homedExtra`, tracked for `U V W A B C D` through `G0`-`G3`, `G28`, `G92` and `M584`. A move naming an axis
  declares it (a single file has no `config.g` to say which exist). New `axisPosition()`/`axisHomed()`.
  `move.axes[n].homed`/`.userPosition` now index into `axisLetters`, and `move.axes[n].letter` is answered.
- **Preset values.** `walkExecution` takes `initialGlobals` / `initialVars`, so a macro that reads a `global`
  declared in `config.g` can be walked (and `exists(global.x)` follows whether it was given).
- **Each line as evaluated.** `walkExecution({ recordEvaluation: true })` puts `evaluation` (every `{...}`
  parameter, an `if`/`while` outcome, the assignment a `var`/`global`/`set` made, an `echo`/`abort`/`M117`
  expression, with their spans), `variables` (the `var`/`global` values after the step, shared between steps
  that didn't change them) and `iteration` (RRF's `iterations`) on each step. It implies `evaluateParams`, and
  additionally evaluates an `echo`/`abort` expression and a `{...}` string argument; an `echo` whose text isn't
  a clean expression (`echo >"file" "text"`) is skipped, not failed.
- **`stepper/simulation`**: `SimulationInputs` (start state, path values, globals, vars, message-box answers) with
  `simulationInputsToJSON`/`FromJSON` and `runSimulation`; `renderEvaluatedLine` (`G1 X{var.a + 5}` -> `G1 X105`,
  `if var.a > 5` -> `... -> true`); `axisReadouts` (position, delta, changed per axis); `variableChanges`;
  `findReferencedInputs` (the object-model paths, `param.*` and undeclared globals a file reads, so they can be
  offered before the run instead of paused on one at a time).
- `buildExecutionIndex`'s fourth argument accepts a `BuildExecutionOptions` object as well as the old version
  string.
- `parseSimulatedValueInput` also reads `null`, arrays (`[1, 2]`) and quoted strings (`"12"` is the string).

Behaviour changes, each with a test:

- **A value the caller supplies now beats the tracked one.** `buildExecutionIndex` used to answer
  `move.axes[n].homed`/`userPosition` and `state.currentTool` from tracked state without asking the caller; it
  now asks first and falls back to tracked state only on `UnresolvedPathError`. "Pretend the machine is not
  homed here" is a scenario a user has to be able to test. A resolver that throws anything other than
  `UnresolvedPathError` now propagates instead of being bypassed.
- `G28 U` (an extra-axis letter and no X/Y/Z) no longer counts as a bare `G28` that homes X, Y and Z.

## 1.26.0 - 2026-09-28

### STM32 `board.txt` parser (`dwc-gcode-core/files/boardTxt`)

`parseBoardTxt(text, options?)` reads the STM32 firmware's `0:/sys/board.txt` the way its own loader does -
a port of `BoardConfig::GetConfigKeys` (`gloomyandy/RepRapFirmware` `v3.7-dev` `2660444`,
`src/Hardware/TGBTC/BoardConfig.cpp:1488-1728`), with the 75-key table (`BOARD_TXT_KEYS`, `:81-204`) and
`ClearConfig`'s defaults (`boardTxtDefaults()`, `:207-295`). It returns the effective `values` (pins as
`"A.13"`, `null` = NoPin), each line's `assignments`, and `problems` with line numbers - the mistakes RRF
reports only on USB serial, or not at all.

What it reproduces, because a plain `key=value` reader gets each wrong: a value ends at the first character
outside `[A-Za-z0-9._]` (unless quoted), so `-1` reads as empty; a `{ }` list is valid only for pin and
driver-type keys, writes just the entries it names, and is discarded whole when it has too many entries, a bad
separator or no `}` on the line (an empty `{}` writes nothing); `uint8`/`uint16` values wrap (`256` reads as
`0`) because RRF's clamp comes after the narrowing; a single enum value is case-sensitive but a list entry is
lowercased first; `StringToPin` reads a digit prefix into a byte (`a.1x` is `A.1`, `a256` is `A.0`); a string of
32 characters or more is silently not set; lines over 255 characters split; a UTF-8 byte-order mark makes line 1
"Missing equals". `board` is ignored in `board.txt` but honoured in `rrfboot.txt` (`restricted: false`), and
`base` layers one file over another as the firmware does.

`test/corpus/rrfboot/` holds the 48 real `rrfboot.txt` files from `gloomyandy/RRFBuild` (same grammar); each
must parse with no problems.

**Behaviour change in `classifyFile`:** `board.txt` in `0:/sys` (or given bare) is now
`{ kind: "board-config", syntax: "text" }` (was `other`); `FileKind` gains `"board-config"`. It is never
stamped. `docs/invocation-table.md` no longer lists board.txt as out of scope - `docs/tasks/README.md`
decision 3 covers every non-G-code SD-card file except firmware and plugin files.

## 1.25.0 - 2026-09-28

### RRF baseline moved to 3.7.0-rc.2

`RRF_BASELINE` and `package.json`'s `rrf.baseline` are `3.7.0-rc.2`. The rc.1 -> rc.2 triage
(`docs/rrf-triage/3.7.0-rc.1..3.7.0-rc.2.md`: 64 RRF commits, 29 in watched files, plus 10 wiki `Gcodes.md`
commits) is closed. Every citation was either moved to rc.2 with its cited lines proved byte-identical at
both tags (1073 of them) or re-cited by hand against rc.2, and the entries whose handler changed were
re-read (`reviewed: "3.7.0-rc.2"` marks them; the rest keep `"3.7.0-rc.1"` because diffing every line that
reads a parameter - `gb.Seen`, `MustSee`, `TryGet*`, `Get*`, `parser.Get*Param` - across the 64 commits
finds no other one changed). Nothing else in the tree moved: `GCodeBuffer/` (the tokeniser,
expression parser, meta commands) is byte-identical between the two tags.

#### What changed between rc.1 and rc.2 that a user's files can hit

Each is a `ChangeEvent` (`changesBetween` / `impactOf` report it in either direction) with the RRF commit
and the lines it was read from. Versions are the `Version.h` string at the commit: `3.7.0-rc.1+N` is a
dev build between the two tags, `3.7.0-rc.2` the tag itself.

- **`M955` and `M956` must give `P`** (`m955-p-required`, `m956-p-required`, from `3.7.0-rc.1+1`). Before,
  an omitted `P` meant accelerometer 0; now RRF stops with a missing-parameter error, so an existing
  `M955 C"spi.cs1+spi.cs2" I10` needs `P0`. `P` may also be 0-9 (0 only on a board without CAN
  expansion) - `m955-p-uncapped` already said so; it never said `P` had become mandatory.
- **The accelerometer moved in the object model.** `boards[].accelerometer` and its five members are gone at
  rc.2; `sensors.accelerometers[]` (`orientation`, `points`, `port`, `resolution`, `runs`, `samplingRate`) is
  new, indexed by the `M955` `P` number. A macro reading `boards[0].accelerometer.runs` is flagged with
  where the data went.
- **`M970` (and `M970.1`/`.2`/`.3`) exist on CAN-expansion-capable main boards without local phase stepping**
  (`m970-*-can-expansion-boards`, `3.7.0-rc.1+3`), acting on CAN-connected drivers.
- **`M201 T`** warns when it cannot take effect (`m201-t-warnings`): a board without third-order motion, or
  CAN-connected drivers; before, silently ignored.
- **`M569 C`** applies the TPFD, FD3 and DISFDCC bits on TMC2240/TMC51xx drivers (`m569-c-more-chopconf-bits`).
- **`M303` without `F`** tunes with the fan at 0.8 PWM, not 0.7 (`m303-f-default`, `3.7.0-rc.1+2`).
- **`M959`**: the expansion board itself now switches its heaters off after losing time sync for the
  timeout, 10 s by default (`m959-expansion-enforces-timeout`).
- **Heater feedforward (`M309`)** was reworked (`m309-extrusion-feedforward-reworked`): boost dropped on
  non-printing extruder moves, the PWM-too-high fault check allows for it, remote fan feedforward fixed.
- **`M581.1` triggers whose condition holds a string literal hung RRF** until `3.7.0-rc.1+3`
  (`m581-1-string-literal-hang`).
- **Five-bar SCARA (`M669 K5`)** is its own kinematics type (`m669-five-bar-own-kinematics-type`).
- **Object-model values under unchanged paths**: `boards[].drivers[].config.direction` is a boolean;
  `move.extruders[].percentCurrent`/`percentStstCurrent` read the wrong drive before; `heat.heaters[].extrPwmBoost`
  reports the boost last applied.
- **preFlight's `; layer_count = N`** is read by the file-info parser (`fileinfo-preflight-layer-count`,
  changelog-only: it has no command to match).
- Reviewed and found to have **no effect on files**: the board-temperature event text and pause path
  (already in `files/events.ts`, now re-cited), `M201`/`M669` reply wording, CAN message framing, the
  `io8.in` ADC channel on 6HC/6XD (still `PinCapability::read`), FTP/network socket fixes, recursive
  directory delete, pause/fast-pause motion fixes, and the version bump itself.

#### New API surface

- `ChangeEventTarget`'s `parameter` form takes `whenAbsent`: the event concerns a line that does **not** give
  the letter. `"upgrade"` (a parameter RRF now insists on) matches only when the file is moving to the
  version that requires it; `true` (a default that changed) matches either way. `impactOf` flags the command.
  `targetKey` keeps such an event apart from the present-parameter events on the same letter.
- `ParamSpec.requiredSince`: `dictionary/missing-required` waits for that version (`M955`/`M956` `P`:
  `3.7.0-rc.1+1`).
- `ParamSpec.valuesLocalOnlyVia`: `values` is checked only when the named port parameter is on the main
  board (`M308` `Y`, below).
- `ObjectModelPathEntry.note`: where a removed path's data went. The generated `removed` event carries it.
- `scripts/rebase-citations.mjs`: moves `RRF <from> <file>:<lines>` citations to `<to>` where the cited
  lines are proved unchanged (line numbers remapped through the diff), and lists the rest. 1073 moved this
  time; the 9 it could not were re-cited by hand.

### Fixed

Each of these is a deliberate behaviour change with a test that failed before it.

- **Object-model `removed` events were dated one tracked version too early**, so `changesBetween`/`impactOf`
  (which select `(from, to]`) missed the very upgrade that crosses a removal: `boards[].bootloaderFileName`
  was never reported moving from 3.6.3, and `boards[].accelerometer` would not have been from rc.1. They are
  now dated at the first tracked version without the path. `objectModelChanges` (which reports "removed
  after") is unchanged.
- **The expression parser stopped after one dotted name following an index**: `boards[0].accelerometer.runs`
  parsed as `boards[0].accelerometer` (leaving `.runs` unparsed) and `boards[0].drivers[0].config.direction` as
  `boards[].drivers[].config`, so the real path was never checked. It now follows every name and index, as
  RRF's own `ParseIdentifierExpression` does. This makes `objectModel/unknown-path` and `impactOf` see
  paths they used to truncate; `fans[0].thermostatic.heaters[0]` is now (correctly) reported unknown from
  3.7.0-beta.1, where `heaters` was replaced by `sensors` - a test had asserted the opposite only because the
  path was being truncated to `fans[].thermostatic`.
- **`M959 B<n>` without `T` was flagged as missing `T`.** RRF reads `T` only `if (gb.Seen('T'))` and otherwise
  reports the board's timeout (`ExpansionManager.cpp`, the same at rc.1). `T` is now 3-65535, `B` 1-126.
- **`M569`'s `C`, `F`, `B`, `V`, `H` and `Y` were reported as unknown parameters.** They were left out as
  "raw TMC tuning", but RRF reads all six (`Move2.cpp` `ConfigureLocalDriverBasicParameters`), so
  `M569 P0.0 S1 D3 V2000` was flagged. A bare hex `C0x1d5` is still reported: RRF's tokeniser starts a
  parameter at every letter (`FindParameters`), so it declares `X` and `D` - write `C{0x1d5}` or decimal.
- **`M955` had no `Q`, `R` or `S`, and `M956` no `F`.** Added with ranges (`Q` 500000-10000000, `R` 0-16,
  `S` 0-9999), cited. `M201` now lists `T` (since 3.7.0-alpha.2; absent at 3.6.3).
- **`M303`'s `F` range was 0-1; RRF takes 0.1-1** (`MinTuningFanPwm`).
- **`M308` `Y` was checked against the main board's list of sensor type names even for a sensor on another CAN
  board** (`P"123.dummy"`). RRF builds a `RemoteSensor` there without looking at the type name
  (`TemperatureSensor.cpp:219`), so the wiki's new `Y"board-temp"` example was flagged as invalid.
- `files/events.ts`: the expansion-reconnect `P=0` raise site was cited at the wrong line after the move; the
  `M957`/`SysFileExists` line references were re-read at rc.2.

### Known, not changed

- **Roughly 40% of the dictionary's `RRF <tag> <file>:<lines>` citations name lines a few away from the code
  they describe**, and did at rc.1 before this move (measured with `gb.Seen('X')`-style tokens against the
  cited lines: 296 of 721 at rc.1, 298 of 732 at rc.2). The rebase preserved each citation's accuracy, it did
  not improve it. Only the entries this move touched were re-cited against exact lines.
- The expansion-board raise sites of the two board-temperature events were read at Duet3Expansion
  `3.7-dev@806ef34` (2026-09-25): that repository has no `3.7.0-rc.2` tag.

## 1.24.0 - 2026-09-28

### Fixed

- **Object model: an element of an array was reported as not existing.** `sensors.probes[0].offsets[0]`
  (and `heat.heaters[0]`, `tools[0].heaters[0]`, `move.axes[0].workplaceOffsets[2]`,
  `heat.bedHeaterMapping[0][1]`, `sensors.probes[0]`, `volumes[0]`, ...) normalise to `<array path>[]`,
  which neither `documentation.json` nor RRF's tables list separately - so `objectModel/unknown-path`
  flagged every use. Each `OBJECT_MODEL_PATHS` entry now records `array` (how many times its value can be
  indexed, derived from the `Duet3D/ObjectModel` source's own types) and `objectModelPath` accepts
  `<path>[]`/`<path>[][]` up to that depth; `state.status[0]` (a string) and one index too many stay
  unknown. A path used with an index also now gets its deprecation/`since`/`until` (`heat.bedHeaters[0]`
  reports the deprecation).
- **Object model: paths RRF really has were missing or read as removed.** Added `seqs` and its 17
  members (`RepRap.cpp` table 5 - RRF-only, absent from the npm package, present at 3.6.3 and rc.1),
  `boards[].drivers[].closedLoop.currentFraction.avg`/`.max` and `.positionError.max`/`.rms`
  (`DriverData.cpp`), and `boards[].drivers[].config`. Seven paths declared in the ObjectModel source but
  left out of rc.1's `documentation.json` (`boards[].drivers[].status`, `.closedLoop`,
  `move.keepout[].active`, four `boards[].directDisplay.screen.*`) were recorded as *removed after 3.6.3*;
  they exist at both ends, so `objectModelChanges` no longer reports them as removed.
  `OBJECT_MODEL_PATHS` is 732 paths (was 709).
- **`M98 P"macro.g" A1 B2 ...` no longer reports `A`, `B`... as unknown parameters.** RRF hands every
  parameter but `P` to the macro as `param.<letter>` (`StringParser::AddParameters`); the new
  `CommandSpec.macroParameters` says so, and `G32` (parameters go to `bed.g`) and the codes RRF has no
  `case` for (`M301`, `M304`, `M573`, `M650`, `M651`, `M900` - now also `unimplemented: true`) get the
  same. Their pass-through letters are not shape-checked either. `M98 R1` (no `P`) is unchanged.
- **`M671`, `M571`, `M918` were "reviewed" with an empty parameter list**, so every real use flagged every
  parameter. `M671` now has X and Y (1-4 colon-separated coordinates each, required together, as RRF's
  "Specify 1, 2, 3 or 4 X and Y coordinates" reply enforces), S, P and F; `M571` has P and S; `M918` has
  P (0-3), E, C, R and F. Each cited to source.
- **`M569.9` was described as a Duet closed-loop tuning command; Duet3D's RRF has no `M569.9`** (both its
  local and CAN handlers fall to "not supported"). It is the STM32 fork's set/report of a smart driver's
  type (T, 0-10), sense resistor (R, ohms) and maximum current (S, amps) - now in the dictionary with
  `platforms: ["stm32"]`, cited to `gloomyandy/RepRapFirmware` v3.7-dev and v3.6-dev.
- `files/kinds.ts`: `filament-error.g` was documented as "defined but never invoked". It is - through the
  event system. And the custom-code filename pattern no longer accepts `T<n>.g` (`TryMacroFile` is
  only reached for G and M codes).

### Added

- **Event handler macros** - `files/events.ts` (`dwc-gcode-core/files/events`): `EVENT_TYPES` lists all
  thirteen RRF `EventType`s with their macro filename (`heater-fault.g`, `driver-stall.g`,
  `filament-error.g`, ...), what `D`/`B`/`P`/`S` mean for each, its default action when the macro is
  absent, log level, and whether RRF ever raises it itself; `eventForMacro`/`eventByType`. Every event
  macro now classifies as `system-macro` (`role`: its basename). `board-temperature-warning.g` and
  `board-over-temperature.g` are RRF 3.7.0-rc.2 (`since`), past this package's `RRF_BASELINE`; the baseline
  itself is not moved. `M957 E"<type>"` is a call to the event's macro in `project.calls` (`via: "M957"`).
  The wiki's `Events.md` is wrong about `expansion-reconnect`'s `P` and omits four event types - see
  `docs/wiki-discrepancies.md`.
- **User-defined G/M codes** - `files/customCodes.ts` (`dwc-gcode-core/files/customCodes`):
  `customCodeOfFile`, `customCodesOf` (a folder listing -> the codes it defines), `macroFileForCode`,
  `reachesMacroFile` (would RRF run `/sys/<code>.g` for this command? true for a code with no `case` and
  for a fractional form of a number RRF doesn't take fractions of - `sys/M104.g` never runs), and
  `commandDispatch`. `DiagnoseOptions.customCodes` and `Project.customCodes` (from `/sys/*.g`) silence
  `dictionary/unknown-command` for a code whose macro exists and skip judging its parameters;
  `project.calls` gains `via: "custom-code"` edges (only when the file exists - RRF has its own
  fallback, so a missing one is not `project/missing-macro-file`). The unknown-command lookup also no
  longer accepts a same-named file outside `/sys`, or `M600.g` as defining `M600.1`.
- **Platform-specific commands** - `FirmwarePlatform` (`"duet" | "stm32"`), `CommandSpec.platforms`/
  `ParamSpec.platforms`, `DiagnoseOptions.platform` (or the mainboard named in `boards`; `platformOfBoard`
  in `pins/tables`), and the rule `dictionary/not-available-on-platform` (never raised when the platform
  isn't known).
- `Project.customCodes`; `ProjectCall.via` values `"custom-code"` and `"M957"`.

## 1.23.0 - 2026-09-23

### Fixed

- `execute.ts`'s `walkExecution` no longer throws on a `param.*` reference (a macro-call argument,
  e.g. `{param.X}`) - it now pauses and asks for a value via the same `resolvePath` mechanism an
  unresolved object-model path already uses, instead of hard-erroring the whole walk.
- `walkExecution` gains an opt-in `WalkOptions.evaluateParams` that evaluates a line's own `{...}`
  parameters (not just `if`/`while` conditions and blocking `M291` fields), exposed per-step as
  `ExecutionStep.resolvedParams`. `machineState.ts`'s `applyG`/`applyM` now use a resolved value over
  a missing literal for X/Y/Z/E/F and M486's S. `stepper/executionIndex.ts`'s `buildExecutionIndex`
  now always enables this, so a stepped file with `{...}`-valued parameters (including `param.X`) now
  shows correct per-line state instead of silently treating the parameter as absent.

## 1.22.0 - 2026-09-23

### Added

- Reviewed dictionary entries for the last 43 draft commands, completing the dictionary: M606,
  M650/M651 (unimplemented), M655, the delta/kinematics family (M665-M675), the removed 3D-scanner
  block M750-M756, M851, M905, M913/M915/M916/M917, M929, the CAN/height-following family
  M951-M954/M957/M959, the phase-stepping family M970/M970.1-.3, and M997-M999 - cited against
  `RRF 3.7.0-rc.1`. **280 reviewed (was 237), 0 still draft-only** - every command in this
  dictionary is now cited against real RRF source, so the diagnostics engine no longer silently
  skips parameter checks on any command.

## 1.21.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M581/M581.1 (trigger config), M582 (check trigger), M585
  (probe-tool axis offset), M587.1/M587.2 (WiFi scan), M591 (filament monitor), M592 (nonlinear
  extrusion), and the multiple-motion-system family M594-M599 - cited against `RRF 3.7.0-rc.1`.
  237 reviewed (was 223), 43 still draft-only.

## 1.20.0 - 2026-09-23

### Added

- Reviewed dictionary entries for the M569.x fractional family (M569.2, M569.3/.4/.8/.9, M569.7),
  M570, M571, M573 (removed), M576, M577, M579 - cited against `RRF 3.7.0-rc.1`. 223 reviewed
  (was 211), 57 still draft-only.

## 1.19.0 - 2026-09-23

### Added

- Reviewed dictionary entries for the scanning-Z-probe subcommand family (M558.1-.4), M559/M560
  (binary file-write open), M561, M562, M564 - cited against `RRF 3.7.0-rc.1`. 211 reviewed
  (was 202), 69 still draft-only.

## 1.18.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M470-M472 (SD file/directory create/rename/delete), M503 (list
  config.g), M505/M505.1 (sys/web folder path), M555 (firmware emulation type), M556 (X/Y/Z-only
  axis-skew compensation) - cited against `RRF 3.7.0-rc.1`. 202 reviewed (was 194), 78 still
  draft-only.

## 1.17.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M374-M376 (height map save/load/taper), M401/M402 (Z probe
  deploy/retract), M404 (filament-width-sensor diameter), M409 (object model query), M425 (backlash
  compensation), M450 (report printer mode) - cited against `RRF 3.7.0-rc.1`. 194 reviewed
  (was 185), 86 still draft-only.

## 1.16.0 - 2026-09-23

### Added

- Reviewed dictionary entries for the M260/M261 I2C-Modbus-UART-dispenser family (M260, M260.1-.4,
  M261, M261.1-.2) - cited against `RRF 3.7.0-rc.1`. 185 reviewed (was 177), 95 still draft-only.

## 1.15.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M290, M300, M303, M305, M309. M301/M304 also reviewed as
  genuinely unimplemented in this RRF version (no dispatcher case at all - falls through to a
  user macro or "unsupported command"), the same treatment `G32`'s existing entry already gives a
  fully macro-delegated command. 177 reviewed (was 170), 103 still draft-only.

## 1.14.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M141, M144, M150 (LED strips), M191, M200, M201.1, M206, M226 -
  cited against `RRF 3.7.0-rc.1`. 170 reviewed (was 162), 110 still draft-only.

## 1.13.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M92 (steps/mm) and the M101-M122 diagnostic/control range
  (M101-M103, M108, M110-M115, M118, M119-M122) - cited against `RRF 3.7.0-rc.1`. 162 reviewed
  (was 147), 118 still draft-only.

## 1.12.0 - 2026-09-23

### Added

- Reviewed dictionary entries for 25 more M-code drafts: M2-M5, M17/M18, the SD file family
  (M20-M23, M26-M30, M32, M36/M36.1/M36.2, M37-M39), M42, and M80/M81 - cited against
  `RRF 3.7.0-rc.1`. 147 reviewed (was 122), 133 still draft-only.

## 1.11.0 - 2026-09-23

### Added

- Reviewed dictionary entries for all 24 G-code drafts (`G11`, `G17`-`G20`, `G38.2`-`G38.5`,
  `G53`-`G59.3`, `G60`, `G68`, `G69`, `G93`, `G94`), cited against `RRF 3.7.0-rc.1`. First batch of
  the 182 remaining `@duet3d/monacotokens` drafts, which the diagnostics engine silently skips
  parameter checks on (see 1.9.2's own note on `M280`). 122 reviewed (was 98), 158 still draft-only.

## 1.10.0 - 2026-09-23

### Added

- `stepper/*` — the offline conditional-execution stepper's model layer (`MachineState` tracking,
  `buildExecutionIndex`/`resolveKnownPath`, the pure halves of the simulated-value and message-box
  resolvers, `splitCommands`), extracted from `duet-gcode-postprocessor` so a second consumer
  (`Flexible-Layouts`) can build the same feature without duplicating it. `buildExecutionIndex` now
  takes the document as a plain string rather than a CodeMirror `Text` (this package takes zero
  runtime dependencies); the two override modules export only their pure resolver logic, since their
  original `localStorage`-backed persistence stays host-side. See `src/version.ts`'s own doc comment
  for the full detail.

## 1.9.2 - 2026-09-22

### Fixed

- `M280` was still a `@duet3d/monacotokens` draft entry (no `reviewed` field), so
  `dictionary/*`'s parameter-level diagnostics rules deliberately stayed silent on it
  (`src/diagnostics/rules.ts`: "a draft entry's parameter list is a heuristic, not a fact") — e.g.
  `M280 K5`, `M280 Start` and `M280 P5` all reported zero issues despite each being invalid. Promoted
  to a reviewed entry cited against `RRF 3.7.0-rc.1 GCodes2.cpp:2842-2865` (`case 280: // Servos`):
  `P` (GPIO/servo port index, `unsigned`) and `S` (angle/pulse-width, `number`) are both required —
  `gb.GetLimitedUIValue('P', MaxGpOutPorts)` and `gb.MustSee('S')` respectively, neither guarded by a
  prior `Seen` check. `P`'s upper bound (`MaxGpOutPorts`) is a board-specific runtime constant, not a
  fixed value this static dictionary can encode, so out-of-range port numbers still need live
  object-model validation against the connected machine — not covered by this fix.

## 1.9.1 - 2026-09-22

### Fixed

- `expr/evaluate.ts`'s unary case never handled `#` (length/count) — `expr/parse.ts` has always parsed
  it correctly, but the evaluator silently fell into the generic numeric-unary path: `#anArray` threw
  a confusing "must be a number" error instead of returning its count, and `#5` silently evaluated to
  `5` (treating `#` as a no-op) instead of the real RRF error a non-string/array operand should be.
  Cited against `ApplyLengthOperator` (`ExpressionParser.cpp:1589`): a string's length, or an array's
  element count, anything else is an error.

## 1.9.0 - 2026-09-22

### Added

- `messageBox.ts`'s `BlockingMessageBox` gains a `"choice"` kind for `M291`'s `S4` (multiple choice):
  `K`'s expression (real RRF's own `gb.GetExpression()` — often a literal array, but it can reference
  a variable) is parsed but deliberately left UNEVALUATED, since evaluating it needs a live
  `EvalContext` this module doesn't have. `execute.ts`'s `walkExecution` evaluates it with the walk's
  own `var`/`global` scope before ever pausing — the same way an `if` condition already is — producing
  a final `{ mode: "choice", choices: string[], ... }` prompt once resolved. `input` after answering
  one is the chosen 0-based index (this package's own convention — real RRF's `m291Result` is simply
  "whatever M292's own `R` expression sends back", with no canonical index-vs-string rule of its own).

### Fixed

- An `S4` box previously matched neither "supported" nor "clean error": `parseBlockingMessageBox`
  returned `null` for it (indistinguishable from a genuinely non-blocking box), so the walker treated
  the line as an ordinary no-op step and any LATER read of `input`/`result` silently got stale data
  left over from whatever came before, rather than a signal that anything had been skipped. A missing
  `K` (`gb.MustSee('K')` in real RRF) is now a genuine parse error on the returned expression, not a
  silent `null`, either.

## 1.8.0 - 2026-09-22

### Added

- `messageBox.ts`: `parseBlockingMessageBox(cmd)` parses an `M291` command into a structured prompt —
  cited against RRF's real `GCodes::DoMessageBox` (`GCodes7.cpp`) and `MessageBoxLimits::
  GetIntegerLimits`/`GetFloatLimits` (`MessageBox.cpp`). Covers the blocking modes `S2`/`S3` (OK /
  OK+Cancel) and `S5`/`S6`/`S7` (integer/float/string value entry, with `L`/`H`/`F` limits and
  default). Returns `null` for the non-blocking modes (`S0`/`S1`, including when `S` is omitted — RRF's
  own default), for `S4` (multiple choice from a `K`-array — a documented gap, not yet supported), and
  for a `P`/`R` whose value is an RRF expression rather than a literal string.
- `execute.ts`'s `walkExecution` now pauses on a blocking `M291` exactly like an unresolved
  object-model path: `WalkOptions.resolveMessageBox` answers it, or throws the new
  `UnresolvedMessageBoxError` to defer (mirroring `UnresolvedPathError`), pausing the walk with a new
  `"message-box"` `WalkOutcome` carrying the parsed prompt. Cancelling an `S3` box aborts the walk by
  default — RRF's own default behaviour (`shouldAbort` unless the command's `J2`) — matching the
  existing `abort` meta-keyword handling exactly.
- `expr/evaluate.ts`'s `result`/`input`/`line`/`iterations` named constants are implemented via a new
  optional `EvalContext.resolveExecutionConstant`. `execute.ts` always supplies a working
  implementation (all four are cheap and unconditionally trackable): `result` is 0 after an accepted
  message box or -1 after a cancelled one that didn't abort; `input` is the entered/chosen value from
  the last blocking `M291`; `line` is the current 1-based source line; `iterations` is the innermost
  enclosing `while` loop's 0-based pass count (an error, not a crash, when read outside any loop).

## 1.7.0 - 2026-09-22

### Added

- `execute.ts`'s `WalkOptions.onStep?(step)` — called synchronously, in order, immediately after each
  step is recorded (including the last one before a step-budget error), before `walkExecution` itself
  returns. Lets a caller maintain its own state incrementally as the walk proceeds instead of only
  being able to replay `WalkOutcome.steps` after the whole walk finishes — added for
  `duet-gcode-postprocessor`'s offline stepper, so a `resolvePath` can answer `move.axes[n].homed` from
  a `G28` it already walked past rather than always prompting the user for it.

## 1.6.0 - 2026-09-22

### Added

- `expr/evaluate.ts`: `vector(n, fill)`, `take(arrayOrString, n)`, `drop(arrayOrString, n)`,
  `find(string, charOrSubstring)` — cited against RRF's own `Function::vector`/`EvaluateTake`/
  `EvaluateDrop`/`SetFindResult` (`ExpressionParser.cpp`). `exists(path)` — special-cased the same way
  real RRF's own parser special-cases it (a different code path, taken BEFORE the argument is
  evaluated normally): true for a declared `var`/`global` regardless of its current value, or for an
  object-model path when the new optional `EvalContext.pathExists` is supplied; a clean "not
  supported" error for an object-model path when it isn't.
- `execute.ts`'s `WalkOptions` gains `objectModelVersion?: string` — when given, every concrete
  object-model path a condition references is checked against `objectmodel/schema.ts` before
  `resolvePath` is even called; an unknown path (typo, or added/removed at that RRF version) is a hard
  `"error"`, not a `"paused"` (asking a caller to guess a value for a path that doesn't exist doesn't
  make sense). Also backs `exists()` above.
- `execute.ts`'s `walkExecution` now properly block-scopes `var` (a fresh scope frame per `if`/`elif`/
  `else`-arm or `while`-iteration body, popped when it ends) instead of one flat map for the whole
  file — a `var` declared inside a block no longer leaks past where it should go out of scope, and
  correctly shadows an outer `var` of the same name without corrupting it. `global` is unaffected (not
  block-scoped in RRF either).

### Fixed

- `walkExecution`'s `if`/`elif`/`else` chain scan wrongly swept a fresh, independent `if` into the
  PREVIOUS `if`'s chain whenever it started immediately after the previous arm's own body ended (its
  line-adjacency check didn't also require the continuing arm's keyword to be `elif`/`else`). Once the
  earlier arm had already resolved true, the new `if`'s own condition was silently never evaluated and
  its body never ran.
- An undefined-variable read from a condition (e.g. `if var.neverDeclared > 0`) threw a plain `Error`
  instead of `EvalError`, which `evaluateExpression`'s own catch doesn't convert — it crashed
  `walkExecution` outright instead of returning the documented `{status:"error"}` outcome. (Every
  earlier test only exercised the "`set` on an undefined variable" path, which never reaches this code
  at all — a plain read from a condition was untested until the block-scoping tests added here.)

## 1.5.1 - 2026-09-22

### Fixed

- `execute.ts`'s `walkExecution` now includes comment lines in its `steps`, not just commands — found
  integrating this release into `duet-gcode-postprocessor`, whose own `MachineState` derivation reads
  layer/feature info straight out of slicer comments (e.g. `;LAYER_CHANGE`), the same way RRF's real
  file reader passes over every physical line regardless of whether it dispatches a command. Blank
  lines remain excluded from `steps` — they carry no content a caller could ever use, and this
  package's own line-splitting (`document.ts`'s `splitLines`) already adds one trailing blank line to
  almost every real file, which would otherwise show up as a spurious extra step at the end of nearly
  everything.

## 1.5.0 - 2026-09-22

### Added

- `expr/evaluate.ts`: a practical-subset RRF expression evaluator over the AST `expr/parse.ts` only
  ever parsed (that module's own doc comment: "never evaluates anything"). Comparisons, short-circuit
  `&&`/`||`/`&`/`|`, arithmetic, `^` as concatenation (not exponentiation — see its own doc comment),
  the ternary (lazy on the untaken branch), and the deterministic math functions (`abs`, `floor`,
  `ceil`, `round`, `sqrt`, `square`, trig, `mod`, `pow`, `atan2`, `max`/`min`, `isnan`). Deliberately
  leaves out anything needing file IO, entropy, wall-clock time or macro-call parameters (`fileread`,
  `fileexists`, `random`, `datetime`, `exists`, `find`, `take`, `drop`, `vector`, `param.*`) as clean
  "not supported" errors rather than guessing. Object-model paths and undefined variables resolve
  through a caller-supplied `EvalContext`; a path whose value genuinely isn't known yet (a live sensor
  reading, an input pin) throws `UnresolvedPathError`, a distinct, catchable outcome from a plain
  `EvalError`, so a caller can tell "ask for a value" apart from "this expression is wrong".
- `execute.ts`'s `walkExecution`: determines a document's REAL execution order — which `if`/`elif`/
  `else` arm actually runs, how many times a `while` body repeats, `break`/`continue`/`abort` — using
  the evaluator above together with `document.ts`'s existing `blocks` tree, instead of a flat
  top-to-bottom line walk. A pure, single-pass, synchronous function: given a `resolvePath` that
  throws `UnresolvedPathError` for a value it doesn't have, it pauses exactly at the condition that
  needed it and reports everything executed up to that point; re-running with a `resolvePath` that now
  answers that path picks up from the top and gets further. `while` loops are capped at
  `maxIterationsPerLoop` (default 10 000) — RRF itself has none (`GCodeBuffer::RestartFrom` re-seeks
  the file every iteration), but an offline simulator can't inherit that unboundedness without risking
  a hang.

## 1.4.0 - 2026-09-21

### Added

- `ParamSpec.listLength` (`src/dictionary/schema.ts`): the element counts RRF's own array reader
  (`StringParser::CheckArrayLength`) actually accepts for a `list: true` parameter, when the valid
  count is a genuinely closed set - RRF throws `"array too long for parameter"` past a fixed-size
  array. Applied to `M950`'s spindle-form `L` (1-2 values) and `K` (1-3 values), then a further batch
  found by triaging the audit script's own new category against real source: `G31`'s `T` (1-2),
  `M106`'s `T` (1-2, padded), `M307`'s `K`/`C` (1-2 each), `M558`'s `H` (1-2, padded) and `F` (1-3,
  padded), `M569`'s `T` (exactly `4` - the one confirmed EXACT-count case, `Move2.cpp`'s own "bad
  timing parameter" check, not a range), `M572`'s `S` (1-2), and `M593`'s `H`/`T` (1-4 each,
  `MaxImpulses - 1`). A handful of remaining candidates were checked and deliberately left alone: any
  capped only by a large board-resource constant (`MaxSensors`, `MaxTools`, `MaxDriversPerAxis`) isn't
  a meaningfully "closed" set in the same sense; `M569.1`'s `E` was inconclusive (its real bound lives
  behind a CAN-message marshalling layer this pass didn't fully trace) and left unset rather than
  guessed.
- Two new diagnostic rules (task 17, Part B, Step 8), completing the pin-name infrastructure:
  `project/pin-already-used` (error) fires when the same physical pin is claimed unconditionally by
  more than one site anywhere in the project - cited directly to `IoPort::Allocate`'s own
  `portUsedBy`/`"Pin '%s' is not free"` check, a real RRF runtime error, not a style preference.
  `project/unknown-pin-name` (warning) fires when a pin name doesn't match any known alias (or, for a
  community board, the port.pin fallback) on a board named in the new `DiagnoseOptions.boards` -
  skipped entirely when no board is named for that pin's address, never guessed. Running the new rule
  against task 13's own `fff-basic` fixture immediately found a real, previously-undetected bug in the
  fixture itself: `M574 Y1 S1 P"io1.in"` (an endstop) and `M558 K0 C"^io1.in"` (a Z-probe) claimed the
  same physical pin with two different roles - confirmed real RRF would reject this exact config
  (`IoPort::Allocate`'s conflict check only allows a second claim when it's the SAME `temporaryInput`
  role) - fixed by moving the Z-probe to its own pin.
- `project.ts`'s symbol tracker now has a `"pin"` type: every reviewed `kind: "pin"` parameter site
  becomes a `"pin"` symbol, generically off the dictionary (the same approach `"axis"` already uses)
  rather than a hand-listed set of commands. Identity mirrors RRF's own `IoPort::Allocate` (confirmed
  unchanged between the mainline and the community/TGBTC fork): leading `!`/`^`/`*` modifiers are
  stripped, a leading `<digits>.` is a CAN-address prefix (default `0`), and `"nil"`/`"NoPin"` is never
  tracked at all (frees a pin, never a conflict). New `ProjectOptions.boards` (CAN address -> board
  id) resolves a pin alias through that board's own table first, so two different alias spellings for
  the same physical pin (e.g. `lcdsck`/`sck`) collapse to one symbol; without a board mapping for an
  address, falls back to raw normalised-string comparison rather than refusing to track the pin.
- New `dwc-gcode-core/pins/*` subpaths (root-exported too): `BOARD_PIN_TABLES`/`lookupPinName`
  (`pins/tables`) and `parsePortPin` (`pins/portPin`) - task 17 Part B's pin-name infrastructure.
  `lookupPinName(boardId, name)` resolves a G-code pin name against a specific board's real pin
  table, board-family matching rules included: case-insensitive and `_`/`-`-tolerant, falling back to
  the generic `PA1`/`PA_1`/`PA.1`/`A1`/`A_1`/`A.1` port.pin syntax, for community boards; case-
  sensitive with NO port.pin fallback at all for official Duet boards - confirmed by reading the
  mainline's complete `LookupPinName` (`Config/Pins.cpp`) end to end, it has no numeric fallback path,
  so `PA1`-style typing genuinely doesn't work on a real Duet board. `BOARD_PIN_TABLES` covers 48
  community boards (BTT/FLY/Formbot/FYSETC/LDO) plus 6 official Duet mainboards (`Pins_FMDC.h` not
  yet included - real conditional compilation in its `PinTable[]` this generator doesn't resolve yet).
- `scripts/build-pin-tables-rrfpins.mjs` generates `src/pins/communityBoards.ts` from every
  `rrfpins.txt` in the gloomyandy/RRFBuild repo (48 boards, 1805 pins total) - the real, per-board pin
  list the STM32 "TGBTC" firmware fork loads at boot. Merges a physical pin's aliases across multiple
  lines of one board's own file into a single entry (a real board can legitimately spell the same wire
  two different ways under two unrelated names - confirmed and cited in task 17's own Findings).
- `scripts/build-pin-tables-duet.mjs` generates `src/pins/duetBoards.ts` (266 pins across 6 boards)
  from each official mainboard's own compiled `PinTable[]` (`RepRapFirmware/src/Config/Pins_*.h`) - a
  narrow, purpose-built parser rather than a general C++ one, since only one field (`pinNames`, always
  last) actually needs reading. Resolves a board-specific named-constant `pinNames` field
  (`ModbusTxPinName`) and strips the leading `!` "hardware inverted" marker RRF itself treats as
  invisible to what a user types (`Pins_Duet3Mini.h`'s own doc comment). `canonicalName` is each pin's
  own first listed alias, not a derived chip address - `Pins_DuetNG.h` has real virtual/expander pins
  (a DueX board, an SX1509B I2C GPIO expander) with no physical chip pin address at all.
- `M308`'s `Y` (sensor type), `M593`'s `P` (input shaper type), and `M569.1`'s `Y` (magnetic encoder
  chip) now have a `values` enum in `dictionary/commands.json`, cited fresh from RRF source
  (`Heating/Sensors/*.h`'s self-registering `SensorTypeDescriptor` list; `Movement/AxisShaper.h`'s
  `NamedEnum`; Duet3Expansion's `AbsoluteRotaryEncoder.h`'s `NamedEnum`), closing a real gap: a typo
  like `M308 S0 Y"thermstor"` previously validated as any other string and was never flagged.
- `ParamSpec.valueMatch` (`src/dictionary/schema.ts`): `"exact"` (default, RRF's usual `NamedEnum`/
  `strcmp` string enums) or `"reduced"` (RRF's `ReducedStringEquals` - case-insensitive, `-`/`_`
  ignored on either side, confirmed from `RRFLibraries/src/General/StringFunctions.cpp` - used only
  by M308's `Y`, since `TemperatureSensor::Create` is the one command in the dictionary so far that
  matches this way instead of the stricter `NamedEnum`).
- `M575`'s `F` (serial parity) now has `values` (`0`/`1`/`2`) - `Platform::HandleM575`'s
  `GetLimitedUIValue('F', 3)` throws for anything else, it doesn't clamp.
- `M569.6`'s `V` (tuning manoeuvre) now has `values` - a genuinely non-contiguous set (`1`-`4` plus an
  undocumented `64`, found in `ClosedLoop::ProcessM569Point6`'s own `switch`), so `range` couldn't have
  expressed this even as a fallback.
- `scripts/audit-dictionary.mjs` (task 17, Decision 2): a repeatable sweep of every reviewed
  command's parameters for two real gap shapes - a `kind: "string"` parameter with no `values` list,
  and a description that already says "required when X" in prose without `required` reflecting it.
  Surfaces candidates for a human to verify against RRF source, doesn't apply anything itself.
- `ParamSpec.required` (`src/dictionary/schema.ts`) can now be a same-line condition on one companion
  letter (`{ ifLetterPresent, valueOneOf?, valueNot? }`), not just a flat boolean - applied to four
  real, RRF-source-verified cases: `M569.1`'s `C` (required when `T` is `1` or `2`), `M593`'s `H`
  (required when `P` is `"custom"`), `M586.4`'s `T` (required when `W` is given), and `M589`'s `P`/`I`
  (required when `S` is given and isn't `"*"`). `M586`'s `H` (a genuine two-condition case - `P`
  selects MQTT AND `S1` enables it) deliberately stays `required: "unknown"` rather than being forced
  into the single-letter shape. `M572`'s `L` (a list-length condition on `S`) and `M950`'s `T` (a
  multi-form, two-letter condition) join `M586`'s `H` for the same reason.

### Documentation

- `M106`'s `T`/`H`/`B`/`L`/`X`/`C` all said "requires P" - re-read `GCodes2.cpp`'s real M106 dispatch:
  `P` isn't actually `gb.MustSee`d at all, and these six are simply never read when `P` is absent
  (`FansManager::ConfigureFan`, which reads them, is only called inside the `seenFanNum` branch) - RRF
  silently ignores them, it doesn't error. Corrected the wording; deliberately did NOT add a
  `required` condition, since that mechanism is for a real RRF-thrown error, not a silent no-op.
- **`M575`'s `S` (channel mode) description was wrong**: it said "0 raw, 1 PanelDue, 2 Duet3D device
  mode" - RRF's real `auxModes[]` table has 8 entries, not 3, and index 0/1 are both PanelDue variants
  (not "raw"). Now has the real 8-value `values` list, each cited to the table's own inline comment.

### Fixed

- **`project.ts` never recognised a `+`-joined multi-pin value** (e.g. `M574 Y1 S1 P"io2.in+io3.in"`,
  two endstop pins OR'd together for one axis) - it tracked the whole string as one nonsense "pin"
  rather than two separate ones, so `project/pin-already-used`/`project/unknown-pin-name` couldn't
  check either pin correctly. `+`-joining is a real, pervasive RRF convention
  (`IoPort::AssignPort(s)`, `Hardware/IoPorts.cpp`) confirmed at multiple real call sites, not just
  M574: `M558`'s `C` (up to 2 pins), `M955`'s `C` (exactly 2), `M950`'s fan form `C` (up to 2 -
  control + tacho), and `M308`'s `P` for a DHT sensor specifically (2 - every other sensor type is
  single-pin only). `pinSymbolSites` now splits on `+` for every `kind: "pin"` value, tracking each
  segment as its own independent pin claim/lookup.
- **The CAN-address prefix on a `+`-joined multi-pin value was being re-parsed per segment instead of
  once for the whole value** - so `M950 F0 C"!1.out3+out3.tach"` (a fan's control pin on expansion
  board 1, plus its tacho pin, which has no prefix of its own since it inherits board 1 from the
  value's own front) was wrongly tracking the tacho pin as being on the mainboard instead. Confirmed
  directly, not assumed, at four real call sites (`FansManager::ConfigureFanPort`,
  `Heat::ConfigureHeater`, `Accelerometers::ConfigureAccelerometer`, `EndstopsManager::HandleM558`):
  each calls `IoPort::RemoveBoardAddress` exactly once on the raw string, before any `+`-awareness, to
  decide whether the WHOLE device is local or remote. `M574` is the one confirmed exception -
  `SwitchEndstop::Configure` has its own hand-rolled loop that parses each `+`-segment's address
  independently (a dual-Z axis can genuinely have endstops on two different expansion boards).
- **`M950`'s spindle-form `K` (PWM values) was modelled with the LED form's own `kind`/`list`/`range`
  only** (`kind: "unsigned"`, `list: false`, `range: 0-5`) - a real, pre-existing bug: a genuinely
  valid spindle value like `K0.1:0.9` was wrongly flagged as `dictionary/wrong-kind` (decimals aren't
  "unsigned") and the colon-list was never even split. `K` is genuinely bimodal (LED: single integer
  colour-order 0-5; spindle: 1-3 colon-separated PWM floats 0.0-1.0) - broadened to `kind: "number"`,
  `list: true`, `listLength: [1,2,3]`, keeping `range: 0-5` (still correctly enforced only for the
  LED form's single-value case). Also corrected the description, which was missing the spindle form's
  1-value ("max alone") case entirely.
- **`dictionary/value-out-of-range` never matched a quoted string enum value at all**: `LexedParam
  .value` keeps quotes verbatim, so a real `M593 P"zvd"` was compared against the dictionary's
  unquoted `"zvd"` and always failed - this was invisible until this release's first `kind: "string"`
  `values` entries existed to expose it (`G29`'s `S`/`M143`'s `A`/`M500`'s `P`, the only prior
  `values` users, are all numeric, where quoting never applied). Fixed by unquoting a `kind: "string"`
  value before comparing.
- **`M143`'s `C` (heater monitor trigger) description listed a value ("2 sensor reading error") that
  doesn't exist in RRF's real enum** (`HeaterMonitorTrigger`: `Disabled=-1`, `TemperatureExceeded=0`,
  `TemperatureTooLow=1` only) - found by `scripts/audit-dictionary.mjs`'s numeric-enum sweep, then
  confirmed against `Heater::ConfigureMonitor`/`HeaterMonitor.h` directly. Now has `values` (`-1..1`).
- **`M574`'s `S` (endstop input type) description had the wrong meaning for values 1 and 2** ("1
  active-high pin, 2 active-low pin" - polarity is actually set by the `P` pin name's own `!` modifier,
  not by `S`). The real meanings, confirmed against `EndstopDefs.h`'s `NamedEnum(EndStopType, ...)`:
  `1`=switch-type input pin, `2`=the configured Z probe used as this axis's endstop. Also now flags `S0`
  as invalid - RRF explicitly rejects it ("endstop type 0 is no longer supported"), it isn't just an
  undocumented value. Now has `values` (`1..5`).
- **`M308 S<n>` (and `M950 H<n>`) were unconditionally treated as "defining" the sensor/heater**, even
  on a line that only reconfigures one that must already exist. RRF only (re)creates a sensor when
  `Y` is also seen on the same `M308` line (`Heat::ConfigureSensor`'s `if (gb.Seen('Y'))`), and only
  (re)creates a heater when `M950`'s `C` is also seen (`Heat::ConfigureHeater`'s `if (gb.Seen('C'))`) -
  a plain `M308 S0 A"renamed"` or `M950 H0 Q100` never created anything. `project.ts`'s `SymbolRule
  .role` can now be a same-line condition (`{ ifLetterPresent, else }`) instead of only a flat
  `"define" | "use"`; this also means `project/undefined-symbol` now correctly flags a sensor/heater
  that's reconfigured but was never actually created anywhere in the project - the "required, optional
  or not needed" distinction the M308 report originally asked for.

## 1.3.1 - 2026-09-17

### Fixed

- **`dictionary/wrong-kind` false positive**: a `kind: "number"` parameter's value in scientific
  notation (e.g. `M308`'s `C7.06e-8` Steinhart-Hart coefficient) was wrongly flagged as not looking
  like a number. `lex.ts`'s own tokeniser already accepted it correctly (its `NUMBER_RE` supports
  `[eE][+-]?digits`) - only this diagnostic's own, independently-drifted copy of the shape check
  didn't. Confirmed directly against RRF source (`RRFLibraries/src/General/NumericConverter.cpp`'s
  `Accumulate`) that this is generic float grammar every `kind: "number"` parameter accepts (via
  `ReadFloatValue` → `SafeStrtof`), not something specific to M308 - and confirmed the fix does NOT
  extend to integer-shaped kinds (`integer`/`unsigned`/`heaterNumber`/`fanNumber`/`sensorNumber`/
  `probeNumber`/`toolNumber`), since RRF reads those through a separate integer parser
  (`ReadUIValue`/`ReadIValue`) that never accepts an exponent. `looksLikeKind` now reuses `lex.ts`'s
  own `NUMBER_RE` (newly exported) for the `"number"` case specifically, instead of a second copy, so
  the two can't drift apart again.

## 1.3.0 - 2026-09-16

### Added

- `M586.4`, `M587`, `M588`, `M589` dictionary entries (`dictionary/commands.json`) - MQTT client
  configuration, WiFi network add/list, WiFi network forget, and access-point configuration. `M587`/
  `M588`/`M589` were "reviewed" with entirely empty parameter lists before this (every real use
  flagged every parameter as unknown); `M586.4` didn't exist at all. Found while migrating
  `dwc-config-backup-core`'s own hand-maintained redaction table onto this dictionary. Cited to
  `Networking/ESP8266WiFi/WiFiInterface.cpp` (`WiFiInterface::HandleWiFiCode`) and
  `Networking/MQTT/MqttClient.cpp` (`MqttClient::Configure`).

### Changed

- **Dictionary fix**: `M586`'s `P` parameter description wrongly said MQTT was protocol `3` - it's
  actually `4` (`NetworkDefs.h`'s `NetworkProtocol` enum: `HttpProtocol = 0, FtpProtocol = 1,
  TelnetProtocol = 2, MulticastDiscoveryProtocol = 3, MqttProtocol = 4`); `3` is multicast discovery.
  Found while adding `M586.4`'s own entry and cross-checking the constant this entry only named
  informally before.

## 1.2.0 - 2026-09-16

### Added

- `M569.1`, `M569.5`, `M569.6` dictionary entries (`dictionary/commands.json`) - closed-loop driver
  configuration (encoder/PID gains/error thresholds), data collection, and calibration/tuning
  manoeuvres. Entirely absent before this - found while migrating `ClosedLoopTuningPlugin` onto this
  package. Cited to `Duet3Expansion`'s own `ClosedLoop/ClosedLoop.cpp` (the actual parameter-reading
  implementation, since these sub-commands only ever execute on a CAN-connected closed-loop driver
  board, not the mainboard - `RepRapFirmware`'s own `ClosedLoop.cpp` only handles M569.5's initial
  G-code parsing before forwarding a pre-built CAN message) and `CANlib`'s shared `EncoderType` enum.

## 1.1.0 - 2026-09-16

### Added

- `formatStampLine(stamp)` (`src/stamp.ts`, root-exported): formats one stamp as its exact `;`-comment
  line, with no document parsing or insertion logic - for a caller that builds output as a stream and
  can never hold a whole file in memory to hand `writeStamp` (found while adopting the stamp in
  `duet-gcode-postprocessor`, whose chunked Blob read/write pipeline is built specifically to never
  materialise a whole large file as one JS string). `writeStamp` itself is unchanged and remains the
  right choice whenever the whole file text is already in memory.
- `StampInput` (`src/stamp.ts`, root-exported): the fields needed to write a stamp, factored out of
  `writeStamp`'s and `formatStampLine`'s previously-duplicated inline parameter type.

## 1.0.0 - 2026-09-16

First published release. Every task in `docs/tasks/README.md`'s queue (05-16) is done - the lexer,
document model, expressions, file kinds, the stamp, the command dictionary, the object-model schema,
release/change tracking (`changesBetween`/`impactOf`), the project model, diagnostics, compare, and
hardening (performance, fuzzing, packaging). From this version on, a breaking API change needs a major
version bump like any other published package - `docs/tasks/README.md`'s decision 5 ("API breaks are
allowed") applied only pre-1.0, while no plugin had released against this package yet.

### Added

- `targetKey(target)` (`src/releases/schema.ts`, root-exported): a stable string key for what a
  `ChangeEventTarget` refers to, independent of version/kind/description. Backs `impactOf`'s handling
  of a target that changes more than once within one query range (see Changed below).
- `lexLines(chunks, options)` (`src/lex.ts`, root and `/lex` subpath): `lexLine` over a stream of raw
  text chunks - splits on `"\n"` only, carrying a partial line across a chunk boundary exactly once,
  so a consumer scanning a huge print file can read it in bounded-size pieces (a `Blob`/`File`'s own
  chunked read) instead of materialising the whole thing as one JS string first. The benefit is a
  bounded working set, not speed: lexing 200 MB takes the same ~7 s either way, but `lexLines` holds
  ~26 MB when fed 64 KB pieces versus ~181 MB when handed the whole file (roughly the retained string
  itself), and the chunked figure stays flat as the file grows. See `docs/performance.md`, which
  reports the synthetic generator's own cost separately so it isn't misattributed to the library.
- `compareDocuments`/`compareProjects`/`diffText` (`src/compare.ts`, new `dwc-gcode-core/compare`
  subpath, root-exported): semantic diff by an **identity key** derived from the dictionary's own
  defining parameters (`M563` by `P`, `M950` by whichever of `H`/`F`/`J`/`P`/`S`/`R`/`E` is present,
  `M308` by `S`, `M558` by `K`, `M955` by `P`, `M584`/`M574` per axis letter, `G10` by its own
  `toolSettings`/`workplace` dispatch form) so a reordered `config.g`, or one split across included
  files, reads as `changed`/`moved`, not wholesale `removed`+`added`. A command with no identity rule
  (`G90`, a bare `G1`, ...) matches by position within its own file instead. `events` on a change name
  the real task-12 `CHANGES` entries that explain it, when a `fromVersion`/`toVersion` range is given.
  `diffText` is a separate, byte-faithful LCS line diff for callers that want the textual view too.
  Validated against task 13's own project fixtures (each self-compares to zero changes; a targeted
  edit produces exactly the one expected finding) - see `docs/tasks/15-compare.md`'s Findings for the
  real nuance found while writing `M584`'s rule (`R`/`S` apply per-invocation, not per-axis-forever)
  and the scope limits documented rather than silently assumed away (no data exists to cite which
  commands are "order-sensitive" for cross-file moves; positional matching isn't block-scoped).
- `diagnoseDocument`/`diagnoseProject` (`src/diagnostics/diagnose.ts`, new `dwc-gcode-core/
  diagnostics/*` subpaths, root-exported): 25 cited rules across syntax, structure, dictionary,
  project, release, menu, data and object-model categories (`RULES`), each `Diagnostic` carrying an
  absolute `{file, line, start, end}` span and its own `sources`. `diagnoseDocument` checks lexer/
  document errors, line length, checksums, a macro-invoking command sharing a line, a capitalised
  meta keyword, unknown/wrong-kind/out-of-range/missing-required/not-yet-available/deprecated/
  wrong-machine-mode dictionary parameters, unknown/deprecated object-model paths, and task 12's
  `impactOf` release findings (when a `stampedVersion` is given); `diagnoseProject` adds undefined/
  duplicate resource symbols, `mustFollow` order dependencies, missing macro files, menu-file errors
  (unknown command, missing `menu`/`image` target) and height-map load errors. `toMonacoMarkers`
  (`src/diagnostics/monaco.ts`) converts to Monaco's own 1-based line/column `IMarkerData` shape (no
  Monaco import). `docs/diagnostics.md` is generated from `RULES` by `npm run docs:diagnostics`. See
  `docs/tasks/14-diagnostics.md`'s Findings for what's deliberately not implemented and why (RRF's
  5-digit CRC16 checksum form; a menu's "missing required parameter", which RRF itself doesn't error
  on; machine-mode/command-since/`mustFollow` dictionary rules, real but not yet exercisable against
  any currently-reviewed dictionary entry).
- `loadProject` (`src/project.ts`, new `dwc-gcode-core/project` subpath, root-exported): the
  machine's whole SD-card configuration as one graph - `Project.calls` (which file invokes which
  other file: `M98`, `G28`/homing, tool-change `tfree`/`tpre`/`tpost` with their real fallback order,
  `M701`/`M702`/`M703`, `G29`/`G32`, pause/resume/cancel/stop, `M501`/`M502`, `M581` - every route
  cited in the new `docs/invocation-table.md`, read from RRF 3.7.0-rc.1 source directly) and
  `Project.symbols` (definitions and uses of tools, heaters, sensors, fans, axes, endstops, probes,
  accelerometers, spindles, extruders, drivers, globals and filaments, each `{ file, line, start,
  end, conditional, dynamic }`). Static analysis only - a definition inside an `if`/`while` is
  `conditional: true`, a resource number written as an expression is `dynamic: true`, neither ever
  resolved further. Fixture SD trees for FFF, CNC and laser machines in `test/corpus/projects/`.
- `changesBetween`/`impactOf` (`src/releases/changes.ts`/`impact.ts`, new
  `dwc-gcode-core/releases/*` subpaths, root-exported): a versioned catalogue of RRF syntax,
  command, parameter and object-model changes (`ChangeEvent`), queryable in either direction
  (upgrade/downgrade), and `impactOf(doc, from, to)` matches those events against a real
  `GcodeDocument` (commands, parameters, object-model paths in expressions, and the `array-literal`/
  `array-concat` expression syntax features) to find what a specific file actually uses that changed.
  Built from `scripts/rrf-triage.mjs`'s rebuilt output for the `GCodeBuffer`/`GCodes dispatch`
  subsystems (146 commits, `docs/rrf-triage/3.6.3..3.7.0-rc.1.md`) plus every `dictionary/
  commands.json` and `src/objectmodel/schema.ts` entry with a `since`/`until`/`deprecated` field -
  the rest of the triage (19 subsystems + the wiki) is deferred, see `docs/tasks/12-release-model.md`.
  `firmware.ts`'s `FEATURES` is now a thin view over this store (`arrayConcatOperator`'s date is
  corrected from a conservative guess to the exact commit's real tag, `3.7.0-beta.1`); its version
  comparison engine moved to the new internal `versionCompare.ts` to avoid an import cycle.
- `objectModelPath`/`objectModelChanges` (`src/objectmodel/schema.ts`, generated, new
  `dwc-gcode-core/objectmodel/schema` subpath, also root-exported) and `OBJECT_MODEL_VERSIONS`/
  `OBJECT_MODEL_BASELINE` (`src/objectmodel/versions.ts`): whether an object-model path (`heat.
  heaters[].current`, `move.axes[].homed`, ...) exists, since/until which RRF release, and whether
  it's deprecated - 709 paths tracked across 5 RRF releases (`3.6.3`, `3.7.0-beta.1`/`beta.2`/
  `beta.3`/`3.7.0-rc.1`; `3.7.0-alpha.2` is a known RRF tag with no usable object-model source and is
  flagged `hasData: false`, not silently guessed). `scripts/build-om-schema.mjs` builds this from
  `@duet3d/objectmodel`'s own `documentation.json`/`deprecations.json` where they exist, and - for
  `3.6.3`, whose npm package predates `documentation.json` entirely - directly from `Duet3D/
  ObjectModel`'s own TypeScript source at the matching git tag, validated to reproduce 691/691 of
  `3.7.0-rc.1`'s real, published paths exactly (see `docs/tasks/11-object-model-schema.md`'s
  Findings for the full validation and the polymorphic-dispatch/subclass-union handling it needed).

- `COMMANDS`/`commandSpec` (`src/dictionary/commands.ts`, generated, new
  `dwc-gcode-core/dictionary/commands` and `dwc-gcode-core/dictionary/schema` subpaths — not
  re-exported from the root: `ParamKind` there collides by name with `lex.ts`'s own): a versioned,
  RRF-source-cited dictionary of what each command's parameters are — letter, kind, whether it takes
  a colon list or an expression, required-ness, value enums, deprecation. 280 commands known; 93
  reviewed against RRF 3.7.0-rc.1 source (every command a real slicer or config.g uses, "tier 1" —
  see `docs/tasks/10-dictionary.md`), the rest drafted from `@duet3d/monacotokens` pending review
  (tracked in `dictionary/coverage.json`). `dictionary/commands.json` is the hand-maintained, cited
  source of truth; `scripts/build-dictionary.mjs` merges it with the bootstrapped drafts and
  generates the `.ts`.
- `src/commands/toolParams.ts`'s `TOOL_PARAM_COMMANDS` is now derived from the dictionary's own
  reviewed `toolNumber`-kind parameters instead of hand-maintained, and is now more complete (adds
  `M104`/`M109`'s `T` and `M207`'s `P`, both real tool numbers the old hand-curated table omitted).
  `commands/g10.ts` now reads its non-`L` letter list from the dictionary too, rather than a second
  hardcoded copy.

- `parseDocument`/`serializeDocument` (`src/document.ts`, new `dwc-gcode-core/document` subpath): a
  lossless, byte-exact-round-trip whole-file G-code document built on `lexLine` — per-line machine
  mode (`M451`/`M452`/`M453`), Fanuc/LaserWeb continuation lines resolved against the last `G0`-`G3`
  command, and the `if`/`elif`/`else`/`while`/`break`/`continue` block tree (siblings per keyword, not
  one node per chain), plus structural diagnostics: `elif-without-if`, `else-without-if`,
  `else-after-else`, `break-outside-loop`, `continue-outside-loop`, `mixed-indentation`,
  `t-not-alone`. See `docs/tasks/06-document-model.md`.
- `applyEdits`/`editSetParam`/`editRemoveParam`/`editReplaceLine`/`editInsertLines`/`editRemoveLine`
  (`document.ts`) and `TextEdit`/`UnsafeEditError`: edit primitives that work in absolute document
  offsets, so several edits can be composed and applied together.
- `resolveFanucContinuation` (`lex.ts`): given a `"fields"`-kind line and the previous `G0`-`G3`
  command, resolves what RRF would read it as in laser/CNC mode.
- `parseExpression` (`src/expr/parse.ts`, new `dwc-gcode-core/expr/parse` subpath — also re-exported
  from the root): a tolerant, never-throwing parser for RRF's `{...}` expression syntax — full
  operator precedence (including the ternary and `^`'s real behaviour, general concatenation rather
  than exponentiation), object-model paths (indices normalised to `[]`), `var.`/`global.`/`param.`
  variable references, function calls (all 31 real functions, generated from source — see
  `src/expr/tables.ts` / `scripts/build-expr-tables.mjs`), the 8 named constants, array literals,
  hex/binary/decimal number literals and quoted-string/character literals. `document.ts`'s
  `expressionsOfLine` finds every `{...}` parameter and the expression part of `if`/`elif`/`while`/
  `var`/`global`/`set`/`echo`/`abort` lines on a given document line.
- `classifyFile` (`src/files/kinds.ts`, new `dwc-gcode-core/files/*` subpath — also re-exported from
  the root): classifies any SD-card path into RRF's own file roles (`config`, `system-macro` with a
  role like `"bed"`/`"home"`/`"tpre"`, `filament-config`/`-load`/`-unload`, `print-file`, `menu`,
  `menu-image`, `height-map`, `probe-points`, `event-log`, `accelerometer-data`, `other`, or
  `out-of-scope`), each row cited in `docs/file-kinds.md` — read from RRF 3.7.0-rc.1 source, not the
  wiki or guessed from extensions.
- `parseMenu` (`src/files/menu.ts`): a tolerant parser for 12864-display menu files
  (`Display/Menu.cpp`'s `Menu::ParseMenuLine`, read end to end) — all six commands, every parameter
  letter including the RRF-3.5+ `V{...}`/`N{...}` expression forms, and `A"..."` action strings split
  into G-code/`menu <name>`/`return` parts (the G-code part lexed with this package's own `lexLine`).
- `parseHeightMap` (`src/files/heightmap.ts`): parses `heightmap.csv`, all three historical label-
  line formats (`Movement/BedProbing/Grid.cpp`'s `GridDefinition::HeightMapLabelLines`), reporting
  RRF's own loader errors with the same row/column numbering. Never stamped (task 09) — the loader
  requires an exact first line.
- `readStamp`/`writeStamp`/`stampable`/`recheckReasons` (`src/stamp.ts`, new `dwc-gcode-core/stamp`
  subpath, root-exported) and `CORE_VERSION` (`src/version.ts`, new `dwc-gcode-core/version`
  subpath): the file-checked-against-version stamp the user asked for — one `;` comment recording
  the RRF version, the checking plugin's id and version, this package's own version, and a
  timestamp. Coexists with the post-processor's own `; postprocessed-by:` line; throws
  `StampNotAllowedError` for a file kind that must never be stamped (`heightmap.csv`/
  `probePoints.csv` most importantly — verified against `HeightMap::LoadFromFile` directly).
  Documented in the README under "The stamp".

- `lexLine` (`src/lex.ts`), the new primary lexing entry point, faithful to RRF's
  `StringParser::FindParameters`/`DecodeCommand`/`Put` (3.7.0-rc.1): several commands per line,
  parameters split at every letter (not whitespace), the `E`-after-a-digit exponent exception,
  `'`-escaped lowercase axis parameters, `(...)` bracketed comments in CNC mode (spliced out, not
  just truncated), `*NN` checksums, and whole-line string arguments for `M23`/`M28`/`M30`/`M32`/
  `M36`/`M38`/`M117` (`STRING_ARGUMENT_COMMANDS`). See `docs/tasks/05-lexer.md`.
- `MachineMode` (`"fff" | "laser" | "cnc"`), threaded through `lexLine` via `LexOptions`.

### Changed

- **Behaviour fix (`impactOf`)**: a target that changed more than once inside one queried version
  range used to produce one finding PER change, including ones already superseded by a later change
  before the query's own destination version. Real case: M955's `P` is capped to 0 at `3.7.0-rc.1`,
  then uncapped again at `3.7.0-rc.1+1` - checking a file across `3.7.0-beta.3` → `3.7.0-rc.1+1` (a
  single upgrade skipping the intermediate `rc.1`, a normal thing for a user to do) used to warn about
  the capping even though it no longer applies at the destination. `impactOf` now collapses a chain of
  same-target events down to the one closest to the destination version (latest when upgrading, since
  that's what's actually true on arrival; earliest when downgrading, since crossing back below it undoes
  everything after it at once) before matching against the document. `changesBetween` is unchanged - it
  still returns the full, uncollapsed history, for anyone who wants the complete audit trail rather than
  "does my file need attention right now". Root cause: the two M955 events didn't share a comparable
  target at all (one was `behaviour`-typed, the other `parameter`-typed) - fixed alongside, see
  `docs/tasks/12-release-model.md`'s Findings.
- **Behaviour fix (`lex.ts`, and everything built on it)**: a `'`-escaped axis parameter's own `start`
  pointed at the letter rather than at the `'`, contradicting `LexedParam.start`'s own documented
  contract, and the `'` was additionally counted as part of the PRECEDING parameter's value. Two real
  consequences, both fixed: `removeParam("G1 'a10 X5", "a")` (and `editRemoveParam`) returned
  `"G1 ' X5"` — an orphaned quote RRF can't parse — and `paramNumber(parseParams("G1 X5 'a10"), "X")`
  read `X` as `"5 '"` instead of `5`. A parameter's span now covers its whole token, and a value now
  stops at the next token's start rather than the next letter.
- **Behaviour fix (`diagnostics`)**: `syntax/checksum-mismatch` measured its digit count to the end of
  the line instead of across the checksum's own span, so any checksummed line with anything after the
  checksum — a trailing `;` comment, or just trailing whitespace — silently skipped validation
  entirely. Ordinary host-mode output has exactly that shape.
- **Behaviour fix (`project.ts`)**: `M950 P<n>` (the plain GPIO-output form) defined no symbol at all,
  while `M950 S<n>` did — but RRF's `Platform::ConfigurePort` indexes one `gpoutPorts` array from
  either letter (`Platform.cpp:4123-4132`), differing only in the servo flag. Both now define the same
  `gpout` symbol, so a genuinely duplicated port is also catchable by `project/duplicate-definition`.
- **`diffText` no longer allocates without bound**: it now trims the common head and tail before
  building its LCS table, and refuses tables over `MAX_DIFF_CELLS` (16M cells / 64 MB) with a new
  `DiffTooLargeError` rather than quietly allocating gigabytes — `Int32Array` storage sits outside
  V8's heap, so `--max-old-space-size` never stopped it and a browser tab would simply die. A
  5,000-line config with a handful of edited lines went from ~614 ms to ~3 ms as a side effect.
- **Packaging fix**: the bare `import ... from "dwc-gcode-core"` root specifier failed to resolve
  under a legacy `moduleResolution: "node"` TypeScript build (confirmed against a real DWC 3.6 build,
  resonance-lab's own dual DWC 3.6/3.7 target) even though every documented subpath already worked.
  The real cause (found by direct experiment against a reproducing fixture, not assumed): `package.
  json`'s own `typesVersions` wildcard also matches the ROOT specifier under classic resolution,
  rewriting it to `dist/` with no filename, which fails and shadows the perfectly good top-level
  `types`/`main` fields - not an `exports`/`require`-condition issue, both of which were tested and
  ruled out directly. Fixed with a second fallback candidate in the same wildcard entry
  (`["dist/*", "dist/index.d.ts"]`); a regression here now fails CI (`test/packaging/legacy/`,
  `npm run test:packaging`). See README's "Legacy webpack/CJS builds" section for the full story.
- **Dictionary fix**: `M950`'s reviewed entry was missing `T`/`B`/`Q` for the heater form entirely -
  RRF's `Heat::ConfigureHeater` (`Heat.cpp:562-571`) requires a `T` (sensor number) and optionally
  reads `B`/`Q` whenever `M950 H<n> C"..."` creates a new heater, so every real `M950 H0 C"..." T0`
  line (found while running task 14's diagnostics against task 13's own fixtures) was wrongly
  flagged as using an unknown `T` parameter. Added, cited, `src/dictionary/commands.ts` regenerated.
- **Dictionary fixes (task 12's full triage closure)**: cross-checking every reviewed command against
  all 366 RRF commits and 138 wiki commits in `3.6.3..3.7.0-rc.1` surfaced real gaps that were flagging
  legitimate config.g/print-file syntax as unknown or wrong-kind. `M106` gained its thermostatic-fan
  form (`T`/`H`/`B`/`L`/`X`) and `C` (fan name) - a high-value fix given M106's near-universal use.
  `M308` gained universal (`A`/`U`/`V`) and thermistor-specific (`T`/`B`/`C`/`R`/`L`/`H`) parameters -
  thermistors are its most common sensor type. `M950`'s `T` now covers all three sub-forms it silently
  serves (heater sensor number, LED strip type, spindle type); `K` similarly covers LED colour order
  vs. spindle PWM array (same letter, unrelated meaning); new `L` (spindle RPM range) and `U` (LED max
  length); `B`'s `since` corrected from an initially-wrong `3.7.0-beta.1` to `3.7.0-beta.2`, caught by
  the wiki directly contradicting the dictionary's own claim. `M574` gained `E`'s `since` date and `S5`
  (encoder stall detection). `M558` gained `V`/`U` (load cell scale/preload window) and a note on `P`
  type `3`'s removal. `M575` gained `F` (serial parity) and `C` (RS485 direction port). `M584` gained
  `P` (visible axis count). `M116`'s `P` gained its colon-list-since-beta.3 note. `M569`'s `R` gained
  its `-1` value (and its `kind` was corrected from `boolean01` to `integer`, since `boolean01` would
  have flagged `R-1` as wrong-kind) and a new `U` (TMC current-scaler override). `M906` gained `T`
  (idle timeout). `M593` gained `L` (accepted but a deliberate no-op since 3.6.0). Every fix has a
  regression test in `test/diagnostics.test.ts`; see `docs/tasks/12-release-model.md`'s Findings for
  the full citation trail, including the `git describe --tags --contains`-is-unreliable-for-dating
  methodological finding the wiki cross-check surfaced.
- **Behaviour fix**: `tokenise`/`parseParams` previously read `G90 G1 X10` as one command (`G90`)
  with bogus params `G=1 X=10`; they now correctly see only `G90`'s own (empty) parameter list —
  `G1 X10` is a second command, invisible to these single-command, now-deprecated views. Use
  `lexLine` to see every command on a line.
- **Behaviour fix**: `parseParams("M117 Hello World")` no longer misreads the message as parameters
  `H="ello"`/`W="orld"`; `M117` (and the other `STRING_ARGUMENT_COMMANDS`) now correctly yield no
  parameters at all under the deprecated views — use `lexLine`'s `stringArgument` field instead.
- **Behaviour fix**: `paramNumberList(parseParams("M568 P0 S200:x:150"), "S")` now returns `[200]`,
  not `[200, 150]` — a bare letter inside what looks like a colon list is a genuinely new parameter
  to RRF's own `FindParameters`, not a harmless non-numeric element; the old test asserted the wrong
  thing (see `docs/tasks/05-lexer.md`'s Findings).
- `tokenise` and `parseParams` (in `lex.ts` and `params.ts` respectively) are now thin,
  `@deprecated` first-command-only views over `lexLine`, re-implemented on it rather than carrying
  their own parsing logic.
- **Behaviour fix (`edit.ts`)**: `parseLines("N10 M92 E420")[0].code` used to be `"N10"` (its own
  hand-rolled parser didn't know to skip a line number); it's `"M92"` now.
- **Behaviour fix (`edit.ts`)**: `setParam("M572 D0 S{global.pa}", "S", "0.05")` used to silently
  append a duplicate `S` (`"M572 D0 S{global.pa} S0.05"`) — its regex only matched numeric/colon-list
  values, so it never found the existing `S{global.pa}` at all. `setParam` on an existing expression
  parameter now throws `UnsafeEditError` (re-exported from `document.ts`) instead. The same rewrite
  also fixes a related, previously-latent bug: an existing STRING-valued parameter (`C"^spi.cs1"`)
  used to be unfindable by the same regex and would also have gained a silent duplicate — it's found
  and replaced correctly now.
- `edit.ts`'s own hand-rolled parser (`parseLine`/`maskQuoted`/a local `parseParams`) is deleted,
  replaced by `lexLine`. `edit.ts`'s public API and `test/edit.test.ts` are unchanged apart from the
  two fixes above and their new tests.

### Internal

- `MetaKeyword`/`metaKeywordOf`/`META_KEYWORDS` moved from `meta.ts` into a new, unexported
  `src/metaKeywords.ts`, to let `lex.ts` recognise a meta-command line without an import cycle with
  `meta.ts`. Both modules still export/re-export `MetaKeyword` from their own public surface;
  behaviour is unchanged.
- `leadingIndent` moved from a private function in `meta.ts` into `src/chars.ts`, shared with
  `lex.ts`. Behaviour is unchanged.
