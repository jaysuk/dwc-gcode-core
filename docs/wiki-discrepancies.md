# Where the Duet3D wiki and RRF source disagree

Checked while building this package's `commands/` table against RRF 3.7.0-rc.1 source and the
`Duet3D/wiki-content` G-code dictionary (`User_manual/Reference/Gcodes.md`, revision `85e0b768c8`,
2026-09-10). Source decides behaviour here; a discrepancy below is a wiki wording that would mislead
someone who took it as the complete rule. Nothing else checked (`M116`, `M207`, `M309`, `M563`,
`M567`, `M568`, `M106`/`M107`, `M584`, `M585`) turned up a disagreement — each matched source exactly,
version gates included, and is cited inline in `src/commands/*.ts` instead of listed here.

## The wiki's own list of conditional-G-code keywords is missing three of the twelve

**The wiki** (`User_manual/Reference/Gcodes.md`, "Conditional execution, loops, and other command
words"): "Recognised keywords are: **abort echo elif else global if set var while**" — nine words.

**RRF source** (`src/GCodes/GCodeBuffer/StringParser.cpp`'s `ProcessConditionalGCode`, checked at
3.7.0-rc.1) recognises twelve: those same nine, plus `break`, `continue`, and `skip` (`skip` is
consumed and does nothing — a documented no-op, per the same source function's `case 4` — but it is
still real, dispatched meta-command syntax to the firmware, not merely absent from the list by virtue
of being uninteresting).

**Where this is handled correctly already:** `meta.ts`'s `MetaKeyword`/`classifyLine` in this package
list and recognise all twelve, cited to source directly rather than to this wiki section.

**Suggested wiki fix:** add `break`, `continue` and `skip` to the keyword list. The dedicated
`Gcode_meta_commands.md` page documents `abort`/`echo`/loops/blocks/variables individually but does
not appear to enumerate the complete keyword set anywhere either — the summary line quoted above,
on the main G-code reference page, is the closest thing to a canonical list and is the one that
should be corrected.

## `G10`'s two "tool settings" sections each describe a narrower rule than the firmware's

**The wiki**, in two separate `## G10:` sections:

- *Tool Temperature Setting*: "This form of the G10 command is recognised by having a P combined
  with at least an R or S parameter."
- *Set workplace coordinate offset or tool offset*: "This form of the G10 command is recognised by
  having either or both of the L and P parameters."

Read together, these say a `G10` is "tool settings" only when it carries `P`, or `L`, or `P` with
`R`/`S`.

**RRF source** (`src/GCodes/GCodes2.cpp`, `case 10`, checked at 3.7.0-rc.1) says something broader:
with no `L`, the command is tool settings — not a retraction — if it carries **any** of `P`, `R`,
`S`, *or an axis letter*, even alone:

```cpp
bool modifyingTool = gb.Seen('P') || gb.Seen('R') || gb.Seen('S');
for (size_t axis = 0; axis < numVisibleAxes && !modifyingTool; ++axis)
{
	if (gb.Seen(axisLetters[axis])) { modifyingTool = true; }
}
```

So `G10 S200` (temperature, no `P`) and `G10 X5` (an axis offset, no `P` or `L`) are both tool
settings by source, and neither fits either section's stated criterion literally.

**The wiki does state the real rule — elsewhere.** Its own note on command queueing (the same page,
searchable for "at least one P, R, S or axis letter parameter") gives exactly the source's rule. The
two per-form sections just don't repeat it, so a reader who only reads the section for the form
they're using can come away with the narrower, wrong impression — precisely the trap
`duet-gcode-postprocessor`'s `travel.ts` fell into before this package's `g10Form` was written
(see `commands/g10.ts`'s module doc): it read a bare `G10` with no `P` as always a retraction.

**Where this is handled correctly already:** `g10Form()` in this package implements the source rule
directly, citing the queueing note rather than either per-form section. This entry exists so the
gap in the two per-form sections can be reported upstream, and so a future reader of *this* package
doesn't have to re-discover it from source.

**Suggested wiki fix:** add one sentence to each of the two per-form sections — "more precisely, any
of P, R, S or an axis letter with no L" — or a cross-reference to the queueing note's rule.

## `@duet3d/monacotokens` vs source: expression functions and named constants — no discrepancy

Task 07 (`docs/tasks/07-expressions.md`) cross-checked `@duet3d/monacotokens@3.7.0-rc.1`'s
`dist/expressions/expressions.json` against the single authoritative source for both lists — RRF
`3.7.0-rc.1` `src/GCodes/GCodeBuffer/ExpressionParser.cpp`'s two `NamedEnum(...)` macro invocations
(line 80, `NamedConstant`; line 81, `Function`). Both the 31 function names and the 8 constant names
match exactly, in both directions (nothing in one list is missing from the other). Recorded here
because task 07's own house rule requires checking, not because anything was found — a clean result
is still worth writing down so a later task doesn't re-do the same check from scratch.

## `RepRapFirmware/Events.md`: `expansion-reconnect`'s `P` is not always 0, and four event types are unlisted

Checked 2026-09-28 against the wiki's `User_manual/RepRapFirmware/Events.md` (revision `85d5967143`,
2026-09-21) and RRF `3.7.0-rc.1` source (`Platform/Event.cpp`, `CAN/ExpansionManager.cpp`, CANlib's
`RRF3Common.h`). Everything else on that page matched source: the nine macro names (enumerator,
`_` → `-`, `.g`), the `D`/`B`/`P`/`S` parameters, every default action, and every log level. Two things
did not.

**The wiki** (the "Processing events" table, `expansion-reconnect` row): `D` = 0, `P` = 0, `B` = the
board's CAN address.

**RRF source** (`CAN/ExpansionManager.cpp:186`):
`Event::AddEvent(EventType::expansion_reconnect, (buf->msg.announceV1.wasShutDown) ? 3 : 1, src, 0, "")`,
with the source's own comment "P bit 1 tells the event macro whether the board switched its heaters
off". `P` is 0 only in the other branch (`:192`: a board that restarted, or one using the older announce format); a board that lost and
regained time sync without restarting gives `P` = 1, or 3 if it also switched its heaters off. A
`expansion-reconnect.g` written from the wiki's table would never look at `param.P`, and would miss
exactly the case that matters (heaters switched off).

**The wiki** lists nine event types. **RRF source** (`Duet3D/CANlib` `src/RRF3Common.h:326`) declares
eleven at 3.7.0-rc.1, and thirteen at 3.7.0-rc.2 (the wiki's two "RRF 3.7.0-rc.2 and later" rows).
The unlisted ones are `main_board_power_fail`, `mcu_temperature_warning`, `overvoltage` and
`undervoltage`: RRF's own comments say the first is "not currently handled by the event system but is
included here as a placeholder" and the second "is not current used", and no raise site for any of the
four exists in RRF or Duet3Expansion at 3.7.0-rc.1. They are still valid `M957 E"..."` arguments
(`GCodes3.cpp:1366-1372`) and their macros would run, so `files/events.ts` lists them, marked
`raisedAutomatically: false`.

**Where this is handled correctly already:** `files/events.ts` follows source for both.

**Suggested wiki fix:** correct the `expansion-reconnect` `P` cell (0 = board restarted, 1 = lost and
regained sync, 3 = additionally switched heaters off), and say once that the event enumeration also
holds four types that are never raised automatically.

## `Gcodes.md` M955/M956: `P` is listed as required from `3.7.0-RC.1`; RRF made it required at `3.7.0-rc.1+1`

Checked 2026-09-28 against the wiki's `User_manual/Reference/Gcodes.md` (revisions `1c5676c81a`,
2026-09-09, and `6e12aee700`, 2026-09-08) and RRF source at `3.7.0-rc.1` and `3.7.0-rc.2`.

**The wiki** (M955 and M956, tab "RRF 3.7 and later", headed "*RRF 3.7.0-RC.1 and later*"): "**Pnn**
Accelerometer to use (required, currently only P0, see note)", and the note "In 3.7.0-rc.1 it may only
be P0. In 3.7.0-rc.2 and later we will support configuration of more than one accelerometer as a time."

**RRF source, 3.7.0-rc.1** (`Accelerometers/Accelerometers.cpp:275-276` and `:418-419`):
`const bool seenP = gb.Seen('P'); const size_t accelerometerNumber = (seenP) ? gb.GetLimitedUIValue('P', MaxAccelerometers) : 0;`
with `MaxAccelerometers = 1` - `P` is **optional** and defaults to 0.
**RRF source, 3.7.0-rc.2** (`:371-372` and `:551-552`): `gb.MustSee('P'); ... GetLimitedUIValue('P', ActualMaxAccelerometers)`
with `MaxAccelerometers = 10` (`Config/Configuration.h:255`) - `P` is **mandatory**, 0-9 (0 only on a board
built without CAN expansion). It changed in RRF commit `ee3c80b6b2` "Support configuring multiple
accelerometers" (Version.h `3.7.0-rc.1+1`, an untagged dev build), so the "required" the wiki puts under
"RC.1 and later" is only true from that build, and "we will support more than one" is already done.

**Consequence:** a `config.g`/macro written for rc.1 (or earlier) that leaves `P` out - which rc.1 accepts -
stops with a missing-parameter error on rc.2, while one that says `P0` works on both.

**Where this is handled correctly already:** `dictionary/commands.json` marks `M955`/`M956` `P` `required`
with `requiredSince: "3.7.0-rc.1+1"` (so `dictionary/missing-required` stays quiet for an rc.1 target), and
the release events `m955-p-required`/`m956-p-required` flag a `P`-less line moving to rc.2 (not the other way).

**Suggested wiki fix:** say that `P` is optional (default 0) up to and including `3.7.0-rc.1` and required
from `3.7.0-rc.2`, and drop "we will support" for multiple accelerometers.

## `M558`'s probe types: the wiki's "deprecated from 3.7.0" is not in the firmware, and one type it does not mention is gone

Checked 2026-09-30 against the wiki's `Gcodes.md` (current `main`) and RRF source at `3.6.3` and `3.7.0-rc.2`
(`Endstops/EndstopDefs.h`, `EndstopsManager.cpp` `HandleM558`, `LocalZProbe.cpp`, `ZProbe.cpp`).

**The wiki** (M558, `P` list): "P2 ... (*deprecated from RRF 3.7.0*)", "P3 ... (*Not supported from RRF 3.7.0 onward*)",
"P5 ... (*deprecated from RRF 3.7.0 - use P8*)".

**RRF source.** Only P3 changed. `ZProbeType::alternateAnalog` (3) became `alternateAnalog_obsolete` and `HandleM558` now rejects it
with "Invalid Z probe type 3", next to the old obsolete types 4, 6 and 7 (RRF `b28569a1d`, "Removed support for ZProbe type 3", in
`3.7.0-rc.1`). P2 (`dumbModulated`) and P5 (`digital`) are still created and handled at rc.2 with no warning, no reply text and no
"deprecated" comment anywhere in `src/Endstops` - the only diff to their `case` labels is an indent. The wiki's "deprecated" is advice
(P8 is the unfiltered switch most setups want), not a change a config file can run into.

**Where this is handled correctly already:** `m558-p3-removed` (rc.1) flags a `P3` line moving to rc.1 or later, through the new `whenValue`
target (`{ type: "parameter", letter: "P", whenValue: ["3"] }`); nothing is raised for P2/P5 because nothing changed.
The same pass added `m558-p12-load-cell` (beta.3), `m574-s5-encoder-endstop` (rc.1) and `m308-bme68x-added` (alpha.3), all
"added value" events that matter only when a file moves back to an older firmware.

**Suggested wiki fix:** drop "deprecated from RRF 3.7.0" from P2 and P5, or say it is a recommendation; the P3 line is right.

## Smaller wiki claims checked and found consistent (no action)

Each of these was read against source at 3.6.3 and rc.2 during the same pass:

- `M586 T` (TLS): the wiki's "RRF 3.7 and later" is the standalone-mode HTTPS/FTPS/TelnetS support. `M586`'s `T` is already read at
  3.6.3 (`Networking/Network.cpp:585`), so a `T` on the line is not new; the added behaviour is not file-visible as a break.
- `M308 Y"board-temp"`: a tool-board (INDX) sensor type from the expansion-board firmware, not in the main-board source the catalogue
  reads (only the `"boardtemp"` pin name appears in `Config/Pins_Duet3_INDX.h`). Not modelled.
- `M574` type 0: "no longer supported" text is at 3.6.3 already (`EndstopsManager.cpp:385`), not a 3.7 change.
- `M400` re-reading the machine position only after a move that may have stopped short (3.7): changes the position's quantisation,
  nothing a line can contain. Judged not file-visible.
