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
