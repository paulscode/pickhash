'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validSubdomain } = require('../duckdns');

// The suggested DuckDNS name is generated in the frontend. Pull that one method out of app.js
// and run it here, so a change to either side (the generator, or the backend's validator) that
// makes suggestions unregistrable fails a test rather than a user.
function suggester() {
  const js = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
  const m = /suggestDuckdnsSub\(\) \{([\s\S]*?)\n    \},/.exec(js);
  assert.ok(m, 'suggestDuckdnsSub() not found in app.js');
  // eslint-disable-next-line no-new-func
  return new Function('crypto', m[1]);
}

test('the suggested DuckDNS name is one the backend will accept, every time', () => {
  const fn = suggester();
  const { webcrypto } = require('node:crypto');
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const self = {};
    fn.call(self, webcrypto);
    assert.match(self.duckdnsSub, /^[a-z][a-z0-9]{9}$/, self.duckdnsSub);
    assert.ok(validSubdomain(self.duckdnsSub), `backend rejects suggested name ${self.duckdnsSub}`);
    seen.add(self.duckdnsSub);
  }
  assert.ok(seen.size > 490, 'suggestions are not random enough');
});
