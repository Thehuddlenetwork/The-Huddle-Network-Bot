'use strict';
// Gateway and REST behaviour against fakes: identify, heartbeat, resume, intent fallback, rate limits, uploads.
const test = require('node:test');
const assert = require('node:assert');
const { Gateway, INTENTS } = require('../src/discord/gateway');
const { Rest } = require('../src/discord/rest');

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; this.handlers = {}; FakeWS.instances.push(this); }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.readyState = 3; this.closedWith = code; }
  emit(ev, data) { for (const fn of this.handlers[ev] || []) fn(data); }
  serverSend(p) { this.emit('message', { data: JSON.stringify(p) }); }
  serverClose(code) { this.readyState = 3; this.emit('close', { code }); }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('identify, dispatch, heartbeat ack, resume after reconnect', async () => {
  FakeWS.instances = [];
  const rest = { request: async () => ({ url: 'wss://gateway.test' }) };
  const gw = new Gateway({ token: 'T', intents: INTENTS.GUILDS | INTENTS.GUILD_PRESENCES, rest, WebSocketImpl: FakeWS });
  const events = [];
  gw.on('dispatch', (t, d) => events.push([t, d]));
  await gw.connect();
  const ws = FakeWS.instances[0];
  assert.match(ws.url, /^wss:\/\/gateway\.test\/\?v=10&encoding=json$/);
  ws.serverSend({ op: 10, d: { heartbeat_interval: 60000 } });
  const identify = ws.sent.find((p) => p.op === 2);
  assert.ok(identify, 'identify sent');
  assert.strictEqual(identify.d.token, 'T');
  assert.strictEqual(identify.d.intents, INTENTS.GUILDS | INTENTS.GUILD_PRESENCES);
  ws.serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'S1', resume_gateway_url: 'wss://resume.test', user: { id: 'u' }, application: { id: 'a' } } });
  ws.serverSend({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'i1' } });
  assert.deepStrictEqual(events.map((e) => e[0]), ['READY', 'INTERACTION_CREATE']);
  ws.serverSend({ op: 1 });
  assert.deepStrictEqual(ws.sent[ws.sent.length - 1], { op: 1, d: 2 }, 'heartbeat on request carries last seq');

  // Server asks us to reconnect -> resume on the resume URL
  ws.serverSend({ op: 7 });
  await tick(300);
  const ws2 = FakeWS.instances[1];
  assert.match(ws2.url, /^wss:\/\/resume\.test/);
  ws2.serverSend({ op: 10, d: { heartbeat_interval: 60000 } });
  const resume = ws2.sent.find((p) => p.op === 6);
  assert.deepStrictEqual(resume.d, { token: 'T', session_id: 'S1', seq: 2 });
  gw.stop();
});

test('missing Presence Intent falls back instead of crashing', async () => {
  FakeWS.instances = [];
  const rest = { request: async () => ({ url: 'wss://gateway.test' }) };
  const gw = new Gateway({ token: 'T', intents: INTENTS.GUILDS | INTENTS.GUILD_PRESENCES, rest, WebSocketImpl: FakeWS });
  const warns = [];
  gw.on('warn', (m) => warns.push(m));
  await gw.connect();
  FakeWS.instances[0].serverClose(4014);
  await tick(1100);
  assert.strictEqual(warns.length, 1);
  const ws2 = FakeWS.instances[1];
  ws2.serverSend({ op: 10, d: { heartbeat_interval: 60000 } });
  assert.strictEqual(ws2.sent.find((p) => p.op === 2).d.intents, INTENTS.GUILDS);
  gw.stop();
});

test('bad token is fatal with a clear message', async () => {
  FakeWS.instances = [];
  const rest = { request: async () => ({ url: 'wss://gateway.test' }) };
  const gw = new Gateway({ token: 'T', intents: 1, rest, WebSocketImpl: FakeWS });
  let fatal = null;
  gw.on('fatal', (m) => { fatal = m; });
  await gw.connect();
  FakeWS.instances[0].serverClose(4004);
  assert.match(fatal, /DISCORD_TOKEN/);
  gw.stop();
});

test('REST retries after a 429 and sends uploads as multipart', async () => {
  const seen = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const headers = new Map();
    if (first) { first = false; return { status: 429, ok: false, headers: { get: () => null }, json: async () => ({ retry_after: 0.05 }) }; }
    return { status: 200, ok: true, headers: { get: (k) => headers.get(k) || null }, text: async () => JSON.stringify({ id: '1' }) };
  };
  const rest = new Rest({ token: 'T', base: 'https://discord.test/api/v10', fetchImpl });
  const r = await rest.request('POST', '/channels/123456789012345678/messages', { body: { content: 'hi' } });
  assert.deepStrictEqual(r, { id: '1' });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1].init.headers.Authorization, 'Bot T');
  assert.strictEqual(seen[1].init.headers['Content-Type'], 'application/json');

  await rest.request('POST', '/channels/123456789012345678/messages', { body: { content: 'file' }, files: [{ name: 'a.csv', data: Buffer.from('x,y') }] });
  const form = seen[2].init.body;
  assert.ok(form instanceof FormData);
  assert.deepStrictEqual(JSON.parse(form.get('payload_json')).attachments, [{ id: 0, filename: 'a.csv' }]);
  assert.ok(form.get('files[0]'));
});

test('REST surfaces Discord errors', async () => {
  const fetchImpl = async () => ({ status: 403, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: 'Missing Permissions', code: 50013 }) });
  const rest = new Rest({ token: 'T', base: 'https://x', fetchImpl });
  await assert.rejects(rest.request('POST', '/channels/1/messages', { body: {} }), (e) => e.status === 403 && e.code === 50013);
});
