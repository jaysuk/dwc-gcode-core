# `rrfboot.txt` corpus

The 48 per-board `rrfboot.txt` files from `gloomyandy/RRFBuild` branch `v3.7-dev`, commit
`5f63fdff4f083d8ad7ba22ce74cc398aa517c431` (`boards/<vendor>/<board>/rrfboot.txt`, stored here as
`<vendor>__<board>.txt`), verbatim.

The STM32 firmware embeds one of these in each board's build and reads it with the very same loader as
the user's `0:/sys/board.txt` (`BoardConfig::LoadBoardConfigFromFile`, gloomyandy/RepRapFirmware
`v3.7-dev` `src/Hardware/TGBTC/BoardConfig.cpp:1388`), so they are real files in `board.txt`'s grammar.
`../../boardTxt.test.ts` requires every one to parse with no problems.

To refresh (the file list is the tree's `rrfboot.txt` paths):

```bash
sha=$(gh api repos/gloomyandy/RRFBuild/branches/v3.7-dev --jq .commit.sha)
gh api "repos/gloomyandy/RRFBuild/git/trees/$sha?recursive=1" --jq '.tree[]|select(.path|endswith("rrfboot.txt"))|.path'
gh api "repos/gloomyandy/RRFBuild/contents/<path>?ref=$sha" -H "Accept: application/vnd.github.raw"
```

Then update the commit above, run `npm test`, and read any new problem before adding an exception.
