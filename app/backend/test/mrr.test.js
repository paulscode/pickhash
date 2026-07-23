'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mrr = require('../mrr');

afterEach(() => { delete process.env.MRR_BASE_URL; delete process.env.ALLOW_INSECURE_MRR; });

test('baseUrl: unset -> undefined (client uses its real https default)', () => {
  delete process.env.MRR_BASE_URL;
  assert.equal(mrr.baseUrl(), undefined);
});

test('baseUrl: an https override is returned as-is', () => {
  process.env.MRR_BASE_URL = 'https://mirror.example/api/v2';
  assert.equal(mrr.baseUrl(), 'https://mirror.example/api/v2');
});

test('baseUrl: a plaintext http override is REJECTED (would leak the key + signature)', () => {
  process.env.MRR_BASE_URL = 'http://127.0.0.1:9999';
  assert.throws(() => mrr.baseUrl(), /must be https/);
});

test('baseUrl: http is permitted ONLY behind the explicit ALLOW_INSECURE_MRR test opt-in', () => {
  process.env.MRR_BASE_URL = 'http://127.0.0.1:9999';
  process.env.ALLOW_INSECURE_MRR = '1';
  assert.equal(mrr.baseUrl(), 'http://127.0.0.1:9999');
});
