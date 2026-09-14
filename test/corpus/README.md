# `rrf-command-codes.json`

Every `code` field from `@duet3d/monacotokens`' `dist/gcodes/gcodes.json`, at the version matching
this package's `RRF_BASELINE` (`../../src/rrf.ts`). Not a runtime dependency — this is a snapshot used
only by `../dictionary.test.ts`, so a plugin using this package doesn't pull in the dictionary too.

To refresh after moving `RRF_BASELINE`:

```bash
npm install --no-save @duet3d/monacotokens@<new-baseline-matching-range>
node -e "
const fs = require('fs');
const data = require('@duet3d/monacotokens/dist/gcodes/gcodes.json');
fs.writeFileSync('test/corpus/rrf-command-codes.json', JSON.stringify(data.map(e => e.code).sort(), null, '\t') + '\n');
"
npm uninstall @duet3d/monacotokens
```

Then run `npm test` and read the diff of any new or changed entries before committing — a change here
is either a new command to fold into `commands/`'s citations, or nothing.
