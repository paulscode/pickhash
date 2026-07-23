'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const messaging = require('../messaging');

// The message thread is attacker-authored (owner writes `message`, picks `username`). We carry it
// RAW and render via x-text — never strip/escape server-side. This pins the raw-preservation half
// (the frontend x-text half is pinned by xss.test.js).
test('normalizeThread preserves attacker-authored username/message VERBATIM (no strip/escape)', () => {
  const raw = { rentalid: 5, messages: [
    { username: '<script>alert(1)</script>', message: '<img src=x onerror=alert(2)>', when: 123, is_support: false, is_admin: false },
    { username: 'MRR Support', message: 'x-init="alert(3)" `${constructor}`', when: 124, is_support: true, is_admin: false },
  ] };
  const t = messaging.normalizeThread(raw);
  assert.equal(t.length, 2);
  assert.equal(t[0].username, '<script>alert(1)</script>', 'username unchanged, not escaped/stripped');
  assert.equal(t[0].message, '<img src=x onerror=alert(2)>', 'message unchanged');
  assert.equal(t[0].is_support, false);
  assert.equal(t[1].is_support, true, 'support flag surfaced');
  assert.equal(t[1].message, 'x-init="alert(3)" `${constructor}`', 'Alpine-directive-ish text is inert data, carried raw');
});

test('normalizeThread is null-safe and coerces missing fields', () => {
  assert.deepEqual(messaging.normalizeThread(null), []);
  assert.deepEqual(messaging.normalizeThread({}), []);
  const t = messaging.normalizeThread({ messages: [{}] });
  assert.deepEqual(t, [{ username: '', is_admin: false, is_support: false, when: null, message: '' }]);
});
