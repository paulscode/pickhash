'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const market = require('../market');
const quote = require('../quote');

const poisoned = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mrr/poisoned/rig-search.json'), 'utf8'));

// The rig owner is an untrusted third party; every rig string can be attacker-authored.
// Our safety model: carry these strings RAW through the whole data path and let the UI
// render them with x-text (which sets textContent, neutralizing markup) — never x-html.
// These tests pin both halves of that model.

test('hostile rig strings pass through normalize + packer VERBATIM (no server-side HTML)', () => {
  const rigs = market.normalizeSearchPage(poisoned).rigs;
  const evil = rigs.find((r) => r.id === '900001');
  assert.equal(evil.name, '<img src=x onerror=alert(1)>');       // unchanged, not escaped/stripped
  assert.equal(evil.owner, "<script>alert('owner')</script>");
  assert.match(evil.region, /<svg onload=alert\(2\)>/);

  // Through the packer, the same raw strings reach the quote breakdown (rendered via x-text).
  const packed = quote.pack(quote.candidates(rigs, { endpointDiff: null }), { compute: 'budget', targetTh: 1, durationHours: 3 });
  const row = packed.rigs.find((r) => r.id === '900001');
  assert.ok(row, 'the poisoned rig is packable when its difficulty range accepts the pool');
  assert.equal(row.name, '<img src=x onerror=alert(1)>');
  assert.equal(row.owner, "<script>alert('owner')</script>");
});

test('the frontend never binds untrusted data with x-html / innerHTML sinks', () => {
  const dir = path.join(__dirname, '../../frontend');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  // Match the attribute/directive usage, not the word in explanatory comments.
  assert.equal(/x-html\s*=/.test(html), false, 'no x-html binding in the template');
  assert.equal(/['"]x-html['"]/.test(js), false, 'no x-html directive registered in app.js');
  // The only innerHTML use is clearing the QR container to an empty string (a constant).
  const innerHtmlAssignments = (js.match(/\.innerHTML\s*=\s*[^;]+/g) || []);
  assert.ok(innerHtmlAssignments.every((s) => /=\s*''/.test(s)), `unexpected innerHTML sink: ${innerHtmlAssignments.join(' | ')}`);
});

test('no <template x-for> inside <svg> (the Alpine CSP build cannot scope a loop var there)', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const html = raw.replace(/<!--[\s\S]*?-->/g, '');   // strip comments (they aren't rendered)
  const svgs = html.match(/<svg[\s\S]*?<\/svg>/g) || [];
  const offending = svgs.filter((s) => /x-for/.test(s));
  assert.equal(offending.length, 0, 'x-for inside <svg> throws "Undefined variable" at runtime — build the geometry server-side and render axis labels as HTML');
});

test('no x-model writes through a dotted path (the Alpine CSP build drops the write)', () => {
  // The CSP build evaluates expressions without eval and cannot assign to a member
  // expression such as f.value. Reading still works, so the input shows what was typed
  // while the model keeps its old value, and a save posts that old value. This is how
  // every Settings row silently failed to save (issues #1, #17). Bind with :value and
  // call a component method on @input/@change instead (setField in app.js).
  const raw = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const html = raw.replace(/<!--[\s\S]*?-->/g, '');
  // Any quoting, any modifiers (x-model.debounce.500ms), and bracket access too.
  const dotted = html.match(/x-model[\w.-]*\s*=\s*(["'])(?:(?!\1).)*[.[](?:(?!\1).)*\1/g) || [];
  assert.deepEqual(dotted, [], 'dotted x-model bindings never write under the Alpine CSP build');
  // The same fault written by hand in a handler: a property assignment or ++/--.
  const handlers = [...html.matchAll(/(?:@[\w.:-]+|x-on:[\w.:-]+|x-init|x-effect)\s*=\s*(["'])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
  const assigning = handlers.filter((h) => /[\w$\]]\s*(?:\.[\w$]+|\[[^\]]*\])\s*(?:[-+*/%]?=)(?!=)|\+\+|--/.test(h));
  assert.deepEqual(assigning, [], 'property assignments in handlers throw under the Alpine CSP build; call a component method');
});

test('the owner-message thread binds the untrusted username + message via x-text', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  // The two attacker-authored fields render via x-text; the global no-x-html guard above forbids
  // any x-html anywhere, so the thread cannot be an injection vector.
  assert.match(html, /x-text="m\.message"/, 'owner message body bound via x-text');
  assert.match(html, /x-text="m\.username"/, 'owner username bound via x-text');
});
