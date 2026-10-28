// Keeps desktop/src/main/relay.js in sync with the canonical server/relay.js.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../../server/relay.js');
const dst = path.join(__dirname, '../src/main/relay.js');
if (fs.existsSync(src)) fs.copyFileSync(src, dst);
