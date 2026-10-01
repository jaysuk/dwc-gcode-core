# Handler drift (generated)

`scripts/dictionary-handler-drift.mjs`. STABLE = every release has the same parameter-reading lines. See the script header for what this cannot see.

## G68

3.6.3 -> 3.7.0-beta.3:

- `gb.MustSee('R');`
- `angle = gb.GetFValue();`
- `centreX = gb.GetFValue();`
- `centreY = gb.GetFValue();`
+ `if (gb.Seen('R'))`
+ `const float angle = gb.GetFValue();`
+ `const float centreX = gb.GetFValue();`
+ `const float centreY = gb.GetFValue();`

## M260

3.6.3 -> 3.7.0-alpha.2:

- `auxChannel = gb.GetLimitedUIValue('P', 1, NumSerialChannels) - 1;`
+ `auxChannel = gb.GetLimitedUIValue('P', 1, NumSerialChannels) - FirstAuxChannel;`

## M261

3.6.3 -> 3.7.0-alpha.2:

- `auxChannel = gb.GetLimitedUIValue('P', 1, NumSerialChannels) - 1;`
+ `auxChannel = gb.GetLimitedUIValue('P', 1, NumSerialChannels) - FirstAuxChannel;`

## M568

3.6.3 -> 3.7.0-alpha.7:

- `tool->SetSpindleRpm(gb.GetUIValue(), GetMovementState(gb).currentTool == tool.Ptr());`
+ `tool->SetSpindleRpm(gb, gb.GetUIValue(), GetMovementState(gb).currentTool == tool.Ptr());`

(unresolved callees: ToolOffsetInverseTransform, GCodeException)

## M581

3.6.3 -> 3.7.0-alpha.2:

- `gb.Seen('P');`
+ `if (gb.GetCommandFraction() > 1) { return GCodeResult::errorNotSupported; }`
+ `bool seen = gb.Seen('P');`
+ `switch (gb.GetCommandFraction())`
+ `gb.GetQuotedString(conditionString.GetRef(), false);`

## M585

3.6.3 -> 3.7.0-alpha.3:

- `m585Settings.probingLimit = (gb.Seen('R')) ? ms.coords[m585Settings.axisNumber] + gb.GetDistance()`
+ `m585Settings.probingLimit = (gb.Seen('R')) ? ms.raw.coords[m585Settings.axisNumber] + gb.GetDistance()`

(unresolved callees: GCodeException)

## M970

3.6.3 -> 3.7.0-rc.1:

+ `gb.MustSee('P');`
+ `const DriverId id = gb.GetDriverId();`
+ `if (gb.Seen('S') && !LockAllMovementSystemsAndWaitForStandstill(gb))`
+ `if (d->letter >= 'A' && d->letter <= 'Z' && gb.Seen(d->letter))`
+ `StoreValue(gb.GetUIValue());`
+ `StoreValue(gb.GetIValue());`
+ `StoreValue((uint16_t)min<uint32_t>(gb.GetUIValue(), std::numeric_limits<uint16_t>::max()));`
+ `StoreValue((int16_t)constrain<int32_t>(gb.GetIValue(), std::numeric_limits<int16_t>::min(), std::numeric_limits<int16_t>::max()));`
+ `StoreValue((uint8_t)min<uint32_t>(gb.GetUIValue(), std::numeric_limits<uint8_t>::max()));`
+ `StoreValue((int8_t)constrain<int32_t>(gb.GetIValue(), std::numeric_limits<int8_t>::min(), std::numeric_limits<int8_t>::max()));`
+ `StoreValue(gb.GetFValue());`
+ `StoreValue((float16_t)gb.GetFValue());`
+ `gb.GetQuotedString(str.GetRef());`
+ `gb.GetReducedString(str.GetRef());`
+ `gb.GetUnsignedArray(arr, siz, false);`
+ `gb.GetFloatArray(arr, siz, false);`
+ `if (gb.Seen('S'))`
+ `const unsigned int harmonic = gb.GetLimitedUIValue('S', 1, MaxPhaseCorrectionHarmonic + 1);`
+ `if (gb.Seen('J'))`
+ `const float magnitude = gb.GetLimitedFValue('J', 0.0, 90.0);`
+ `if (gb.Seen('O'))`
+ `entry->phase = (uint16_t)lrintf(gb.GetLimitedFValue('O', 0.0, 360.0) * PhaseUnitsPerDegree) % 4096u;`

3.7.0-rc.1 -> 3.7.0-rc.2:

- `if (gb.Seen('J'))`
- `const float magnitude = gb.GetLimitedFValue('J', 0.0, 90.0);`
- `if (gb.Seen('O'))`
- `entry->phase = (uint16_t)lrintf(gb.GetLimitedFValue('O', 0.0, 360.0) * PhaseUnitsPerDegree) % 4096u;`
+ `const bool seenMagnitude = gb.Seen('J');`
+ `magnitude = gb.GetLimitedFValue('J', 0.0, 90.0);`
+ `const bool seenPhase = gb.Seen('O');`
+ `phase = gb.GetLimitedFValue('O', 0.0, 360.0);`

## Summary

STABLE (19): G0 G1 G2 G3 M109 M150 M25 M309 M36 M567 M571 M588 M600 M601 M665 M666 M673 M73 M997

STABLE INSIDE FOLLOWED TEXT ONLY, callees unresolved (3): M122 M669 M675

DRIFT, read the diffs above (7): G68 M260 M261 M568 M581 M585 M970

No dispatch case at any release (5): M573 M650 M651 M900 T
