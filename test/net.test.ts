// The rate-limit key behind Render's proxies (TRUST_PROXY_HOPS=3) and the limiter's memory cap (Codex R7-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { Limiter, addressKey, clientIp } from '../src/net.ts';

const req = (xff: string | undefined, remote = '10.0.0.9') =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as unknown as http.IncomingMessage;

test('three trusted hops: the client is the third address from the right; prepended addresses are ignored', () => {
  // client → proxy A → proxy B → proxy C → app. Each proxy appends what it saw.
  assert.equal(clientIp(req('203.0.113.7, 10.1.0.1, 10.2.0.1'), 3), '203.0.113.7');
  assert.equal(clientIp(req('6.6.6.6, 7.7.7.7, 203.0.113.7, 10.1.0.1, 10.2.0.1'), 3), '203.0.113.7', 'attacker-prepended entries');
  assert.equal(clientIp(req('10.1.0.1, 10.2.0.1'), 3), 'short-chain', 'a chain that did not pass all proxies shares one bucket');
  assert.equal(clientIp(req(undefined), 3), 'short-chain');
  assert.equal(clientIp(req('1.2.3.4', '127.0.0.1'), 0), '127.0.0.1', 'no trusted hops: the socket address, header ignored');
});

test('every spelling of one address is one key', () => {
  assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(addressKey('::FFFF:CB00:7107'), '203.0.113.7');
  assert.equal(addressKey('2001:db8:0:1::5'), addressKey('2001:0db8:0000:0001:ffff:0:0:9'), 'one IPv6 /64');
  assert.equal(addressKey('fe80::1%eth0'), addressKey('fe80::1'));
  assert.equal(addressKey('999.1.1.1'), 'invalid');
  assert.equal(addressKey('1::2::3'), 'invalid');
});

test('the memory cap never renews a budget', () => {
  const l = new Limiter(1, 2);
  const t = 1_000_000;
  assert.ok(l.take('a', t) && l.take('a', t));
  assert.equal(l.take('a', t), false, 'burst spent');
  for (let i = 0; i < 10_000; i++) l.take(`k${i}`, t); // fill the table while 'a' is still refilling
  assert.equal(l.take('a', t), false, 'a was not dropped and re-created with a full burst');
  assert.equal(l.take('fresh-1', t) && l.take('fresh-2', t) && l.take('fresh-3', t), false, 'unseen keys share one overflow bucket');
});
