'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const endpoint = require('../endpoint');

test('parses every reasonable paste of a stratum endpoint', () => {
  const H = 'example-tunnel.example.com';
  // bare host + separate port
  assert.deepEqual(endpoint.parse(H, '26596'), { host: H, port: 26596 });
  // host:port pasted together, port field empty -> embedded port used
  assert.deepEqual(endpoint.parse(`${H}:26596`, ''), { host: H, port: 26596 });
  // full stratum+tcp:// url, no separate port
  assert.deepEqual(endpoint.parse(`stratum+tcp://${H}:26596`, null), { host: H, port: 26596 });
  // scheme + host, port from the field
  assert.deepEqual(endpoint.parse(`stratum+tcp://${H}`, '26596'), { host: H, port: 26596 });
  // a stratum+ssl scheme is also stripped
  assert.deepEqual(endpoint.parse(`stratum+ssl://${H}:443`, ''), { host: H, port: 443 });
  // an embedded port wins over the port field
  assert.deepEqual(endpoint.parse(`${H}:26596`, '3000'), { host: H, port: 26596 });
  // trailing slash / whitespace tolerated
  assert.deepEqual(endpoint.parse(`  stratum+tcp://${H}:26596/  `, ''), { host: H, port: 26596 });
});

test('handles IPv4 and bracketed IPv6', () => {
  assert.deepEqual(endpoint.parse('85.203.40.167:23335', ''), { host: '85.203.40.167', port: 23335 });
  assert.deepEqual(endpoint.parse('[2001:db8::1]:3333', ''), { host: '2001:db8::1', port: 3333 });
  assert.deepEqual(endpoint.parse('[2001:db8::1]', '3333'), { host: '2001:db8::1', port: 3333 });
});

test('missing port yields null (caller validates), bare host preserved', () => {
  assert.deepEqual(endpoint.parse('host.example', ''), { host: 'host.example', port: null });
  assert.deepEqual(endpoint.parse('', ''), { host: '', port: null });
});

test('isBlockedIp: blocks link-local/metadata/multicast/unspecified, allows loopback + RFC1918', () => {
  // Never a valid stratum target — refused so the probe can't be aimed at them.
  assert.equal(endpoint.isBlockedIp('169.254.169.254'), true, 'cloud metadata');
  assert.equal(endpoint.isBlockedIp('169.254.1.1'), true, 'link-local');
  assert.equal(endpoint.isBlockedIp('0.0.0.0'), true, 'unspecified');
  assert.equal(endpoint.isBlockedIp('224.0.0.1'), true, 'multicast');
  assert.equal(endpoint.isBlockedIp('::'), true, 'ipv6 unspecified');
  assert.equal(endpoint.isBlockedIp('fe80::1'), true, 'ipv6 link-local');
  assert.equal(endpoint.isBlockedIp('ff02::1'), true, 'ipv6 multicast');
  assert.equal(endpoint.isBlockedIp('::ffff:169.254.169.254'), true, 'ipv4-mapped metadata (dotted)');
  // Embedded-v4 IPv6 wrappings the kernel routes to IPv4 must not dodge the filter by notation.
  assert.equal(endpoint.isBlockedIp('::ffff:a9fe:a9fe'), true, 'ipv4-mapped metadata (hex)');
  assert.equal(endpoint.isBlockedIp('::a9fe:a9fe'), true, 'v4-compat metadata (hex)');
  assert.equal(endpoint.isBlockedIp('64:ff9b::a9fe:a9fe'), true, 'NAT64 metadata');
  assert.equal(endpoint.isBlockedIp('64:ff9b::169.254.169.254'), true, 'NAT64 metadata (dotted)');
  assert.equal(endpoint.isBlockedIp('2002:a9fe:a9fe::'), true, '6to4 metadata');
  assert.equal(endpoint.isBlockedIp('fd00:ec2::254'), true, 'AWS IPv6 IMDS');
  assert.equal(endpoint.isBlockedIp('0.1.2.3'), true, '0.0.0.0/8');
  // Legitimate local endpoints (a LAN HashGG/Datum/miner) stay allowed.
  assert.equal(endpoint.isBlockedIp('127.0.0.1'), false, 'loopback ok');
  assert.equal(endpoint.isBlockedIp('192.168.1.50'), false, 'RFC1918 ok');
  assert.equal(endpoint.isBlockedIp('10.0.0.5'), false, 'RFC1918 ok');
  assert.equal(endpoint.isBlockedIp('1.2.3.4'), false, 'public ok');
  assert.equal(endpoint.isBlockedIp('::1'), false, 'ipv6 loopback ok');
  assert.equal(endpoint.isBlockedIp('fd00::1'), false, 'legit ULA ok (not the AWS metadata prefix)');
});

test('resolvePinnedIp: returns the literal for an allowed IP, null for a blocked IP', async () => {
  assert.equal(await endpoint.resolvePinnedIp('127.0.0.1'), '127.0.0.1', 'loopback literal passes through');
  assert.equal(await endpoint.resolvePinnedIp('192.168.5.5'), '192.168.5.5', 'RFC1918 literal passes');
  assert.equal(await endpoint.resolvePinnedIp('169.254.169.254'), null, 'metadata literal -> null');
  assert.equal(await endpoint.resolvePinnedIp('::ffff:a9fe:a9fe'), null, 'hex v4-mapped metadata -> null');
  assert.equal(await endpoint.resolvePinnedIp(''), null, 'empty -> null');
});
