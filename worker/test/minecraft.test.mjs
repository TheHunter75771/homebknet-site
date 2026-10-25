// Server List Ping: packet bytes, response parsing, and every way a server can answer badly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHandshake, STATUS_REQUEST, parseStatusFrame, readStatusJson, pingMinecraft,
  ProtocolError, encodeVarInt, MAX_RESPONSE_BYTES,
} from '../src/minecraft.js';
import { enc, concat, statusFrame, REAL_STATUS, chunk, fakeSocket, fakeConnect } from './helpers/fakes.mjs';

const HOST = 'game.homebknet.us';
const PORT = 25565;

// ---- packets ----------------------------------------------------------------

test('handshake bytes for game.homebknet.us:25565, protocol -1, next state status', () => {
  const expected = [
    0x1b, //                          frame length 27
    0x00, //                          packet id: handshake
    0xff, 0xff, 0xff, 0xff, 0x0f, //  protocol version -1
    0x11, ...enc('game.homebknet.us'), // host, 17 bytes
    0x63, 0xdd, //                    port 25565, big-endian
    0x01, //                          next state: status
  ];
  assert.deepEqual([...buildHandshake(HOST, PORT)], expected);
});

test('handshake bytes with protocol 767', () => {
  assert.deepEqual([...buildHandshake(HOST, PORT, 767)], [0x18, 0x00, 0xff, 0x05, 0x11, ...enc(HOST), 0x63, 0xdd, 0x01]);
});

test('status request is a one-byte packet', () => {
  assert.deepEqual([...STATUS_REQUEST], [0x01, 0x00]);
});

test('handshake refuses bad hosts and ports', () => {
  for (const host of ['', 'bad host', 'x:1', '-leading-dash', 'a'.repeat(254), 'game.homebknet.us/', 42, null]) {
    assert.throws(() => buildHandshake(host, PORT), RangeError, `host ${String(host)}`);
  }
  for (const port of [0, -1, 65536, 1.5, '25565', NaN]) {
    assert.throws(() => buildHandshake(HOST, port), RangeError, `port ${String(port)}`);
  }
});

// ---- frames -------------------------------------------------------------------

test('a frame parses only once all of it has arrived', () => {
  const frame = statusFrame(REAL_STATUS);
  for (let i = 0; i < frame.length; i += 97) assert.equal(parseStatusFrame(frame.subarray(0, i)), null, `prefix ${i}`);
  assert.equal(parseStatusFrame(frame.subarray(0, frame.length - 1)), null);
  assert.equal(parseStatusFrame(frame), JSON.stringify(REAL_STATUS));
});

test('an oversize length is refused from the prefix alone', () => {
  assert.throws(() => parseStatusFrame(encodeVarInt(70000)), ProtocolError);
  assert.throws(() => parseStatusFrame(encodeVarInt(MAX_RESPONSE_BYTES)), ProtocolError, 'prefix + body over the cap');
  assert.throws(() => parseStatusFrame(encodeVarInt(-5)), ProtocolError, 'negative length');
  assert.throws(() => parseStatusFrame(Uint8Array.of(0x00)), ProtocolError, 'zero length');
});

test('malformed frames are refused', () => {
  const s = enc('{}');
  const cases = {
    'wrong packet id': concat(Uint8Array.of(1 + 1 + s.length, 0x01, s.length), s),
    'string longer than the packet': concat(Uint8Array.of(1 + 1 + s.length, 0x00, s.length + 4), s),
    'string shorter than the packet': concat(Uint8Array.of(1 + 1 + s.length + 2, 0x00, s.length), s, Uint8Array.of(0x20, 0x20)),
    'string length cut off': Uint8Array.of(0x02, 0x00, 0x80),
    'packet id over-long': Uint8Array.of(0x06, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00),
    'invalid UTF-8': Uint8Array.of(0x04, 0x00, 0x02, 0xc3, 0x28),
  };
  for (const [name, bytes] of Object.entries(cases)) assert.throws(() => parseStatusFrame(bytes), ProtocolError, name);
});

// ---- status JSON ----------------------------------------------------------------

test('reads players, max and version from a real-shaped status', () => {
  assert.deepEqual(readStatusJson(JSON.stringify(REAL_STATUS)), { state: 'online', players: 2, maxPlayers: 20, version: '26.1.2' });
});

test('validates each field on its own', () => {
  const read = (o) => readStatusJson(JSON.stringify(o));
  const cases = [
    [{ players: { online: -1, max: 20 } }, null, 20],
    [{ players: { online: 2.5, max: 20 } }, null, 20],
    [{ players: { online: '2', max: '20' } }, null, null],
    [{ players: { online: 2, max: 1e9 } }, 2, null],
    [{ players: { online: 100001, max: 100000 } }, null, 100000],
    [{ players: { online: 0, max: 0 } }, 0, 0],
    [{ players: { online: 25, max: 20 } }, 25, 20],
    [{ players: 'lots' }, null, null],
    [{ players: [1, 2] }, null, null],
    [{}, null, null],
  ];
  for (const [doc, players, maxPlayers] of cases) {
    const r = read(doc);
    assert.equal(r.state, 'online', JSON.stringify(doc));
    assert.equal(r.players, players, JSON.stringify(doc));
    assert.equal(r.maxPlayers, maxPlayers, JSON.stringify(doc));
  }
  assert.equal(read({ version: { name: '§c§lPaper §r1.21.4' } }).version, 'Paper 1.21.4');
  assert.equal(read({ version: { name: '  26.1.2\n' } }).version, '26.1.2');
  assert.equal(read({ version: { name: 'x'.repeat(32) } }).version, 'x'.repeat(32));
  assert.equal(read({ version: { name: 'x'.repeat(33) } }).version, null);
  for (const ok of ['26.1.2', 'Paper 1.21.4', '1.21.4-pre1+build_5', 'Fabric 26.1.2']) {
    assert.equal(read({ version: { name: ok } }).version, ok, ok);
  }
  for (const bad of ['<b>evil</b>', 'Paper (1.21)', '1.21 & up', 'v"1"', 'x;y', 'https://example.com/', '\u00e9t\u00e9 1.2', '\ud83c\udfac 1.2', '\t']) {
    assert.equal(read({ version: { name: bad } }).version, null, JSON.stringify(bad));
  }
  assert.equal(read({ version: { name: '\u202e\u0007' } }).version, null);
  assert.equal(read({ version: { name: 767 } }).version, null);
  assert.equal(read({ version: '26.1.2' }).version, null);
});

test('non-object JSON is not a status', () => {
  for (const text of ['[]', '"online"', '42', 'null', 'true', '{"players":', '']) {
    assert.throws(() => readStatusJson(text), ProtocolError, text);
  }
});

// ---- the ping ---------------------------------------------------------------------

async function ping(script, opts = {}) {
  const made = [];
  const connect = fakeConnect(() => { const s = fakeSocket(script); made.push(s); return s.socket; });
  const started = Date.now();
  const r = await pingMinecraft({ connect, hostname: HOST, port: PORT, timeoutMs: 80, ...opts });
  return { r, ms: Date.now() - started, connect, log: made[0] && made[0].log };
}

test('a real server answers: online, with the exact bytes sent and the socket closed', async () => {
  const { r, connect, log } = await ping({ steps: [statusFrame(REAL_STATUS)] });
  assert.deepEqual(r, { state: 'online', players: 2, maxPlayers: 20, version: '26.1.2' });
  assert.deepEqual(connect.calls, [{ address: { hostname: HOST, port: PORT }, options: { secureTransport: 'off', allowHalfOpen: false } }]);
  assert.deepEqual(log.written.map((b) => [...b]), [[...buildHandshake(HOST, PORT), ...STATUS_REQUEST]]);
  assert.equal(log.closeCalls, 1);
});

test('a response split across many reads still parses', async () => {
  const { r } = await ping({ steps: chunk(statusFrame(REAL_STATUS), 7) }, { timeoutMs: 2000 });
  assert.equal(r.state, 'online');
  assert.equal(r.players, 2);
});

test('stray bytes after a complete frame are ignored', async () => {
  const { r } = await ping({ steps: [concat(statusFrame(REAL_STATUS), Uint8Array.of(0x09, 0x01, 1, 2, 3))] });
  assert.equal(r.state, 'online');
});

test('ArrayBuffer chunks are accepted', async () => {
  const f = statusFrame(REAL_STATUS);
  const { r } = await ping({ steps: [f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)] });
  assert.equal(r.state, 'online');
});

test('nothing comes back: offline', async () => {
  const cases = {
    'connection refused': { opened: 'reject' },
    'reset while sending': { write: 'reject' },
    'closed without a byte': { steps: ['eof'] },
    'reset before a byte': { steps: ['reset'] },
  };
  for (const [name, script] of Object.entries(cases)) {
    const { r, log } = await ping(script);
    assert.deepEqual(r, { state: 'offline', players: null, maxPlayers: null, version: null }, name);
    assert.equal(log.closeCalls, 1, `${name}: socket closed`);
  }
});

test('the PC is asleep (SYN never answered): offline at the timeout', async () => {
  const { r, ms, log } = await ping({ opened: 'hang' }, { timeoutMs: 60 });
  assert.equal(r.state, 'offline');
  assert.ok(ms >= 55 && ms < 1000, `took ${ms} ms`);
  assert.equal(log.closeCalls, 1);
});

test('connected but no reply within the timeout: offline', async () => {
  const { r, log } = await ping({ steps: ['hang'] }, { timeoutMs: 60 });
  assert.equal(r.state, 'offline');
  assert.equal(log.closeCalls, 1);
});

test('something answered but not a usable status: unknown', async () => {
  const frame = statusFrame(REAL_STATUS);
  const cases = {
    'truncated then closed': { steps: [frame.subarray(0, 400), 'eof'] },
    'reset mid-response': { steps: [frame.subarray(0, 400), 'reset'] },
    'stalls mid-response': { steps: [frame.subarray(0, 400), 'hang'] },
    'an HTTP server on the port': { steps: [enc('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'), 'eof'] },
    'over-long VarInt garbage': { steps: [Uint8Array.from({ length: 16 }, () => 0xff)] },
    'invalid JSON in a valid frame': { steps: [statusFrame('{"version":')] },
    'a JSON array': { steps: [statusFrame('[1,2,3]')] },
    'invalid UTF-8': { steps: [Uint8Array.of(0x04, 0x00, 0x02, 0xc3, 0x28)] },
    'not bytes at all': { steps: ['a string'] },
  };
  for (const [name, script] of Object.entries(cases)) {
    const { r, log } = await ping(script, { timeoutMs: 80 });
    assert.deepEqual(r, { state: 'unknown', players: null, maxPlayers: null, version: null }, name);
    assert.equal(log.closeCalls, 1, `${name}: socket closed`);
  }
});

test('an oversize response is refused at once, without reading it', async () => {
  const declared = concat(encodeVarInt(70000), Uint8Array.of(0x00));
  const { r, ms, log } = await ping({ steps: [declared, 'hang'] }, { timeoutMs: 2000 });
  assert.equal(r.state, 'unknown');
  assert.ok(ms < 500, `took ${ms} ms`);
  assert.equal(log.reads, 1);
  assert.equal(log.closeCalls, 1);
});

// Builds a frame of exactly `total` bytes.
function frameOfSize(total) {
  const base = { version: { name: '26.1.2' }, players: { max: 20, online: 2 }, pad: '' };
  for (let pad = total - 40; pad > 0; pad--) {
    base.pad = 'a'.repeat(pad);
    const f = statusFrame(base);
    if (f.length === total) return f;
    if (f.length < total) break;
  }
  throw new Error(`no frame of ${total} bytes`);
}

test('the 64 KiB cap is exact', async () => {
  const atCap = frameOfSize(MAX_RESPONSE_BYTES);
  assert.equal(atCap.length, 65536);
  const ok = await ping({ steps: chunk(atCap, 16384) }, { timeoutMs: 2000 });
  assert.equal(ok.r.state, 'online');
  assert.equal(ok.r.players, 2);

  const over = frameOfSize(MAX_RESPONSE_BYTES + 1);
  const bad = await ping({ steps: chunk(over, 16384) }, { timeoutMs: 2000 });
  assert.equal(bad.r.state, 'unknown');
});

test('more than the cap in one read is cut at the cap', async () => {
  // Declares a frame exactly at the cap, then sends more than the cap in a single read.
  const head = concat(encodeVarInt(MAX_RESPONSE_BYTES - 3), Uint8Array.of(0x05)); // packet id 5: not a status
  const { r, log } = await ping({ steps: [concat(head, new Uint8Array(MAX_RESPONSE_BYTES + 100))] }, { timeoutMs: 2000 });
  assert.equal(r.state, 'unknown');
  assert.equal(log.reads, 1);
});

test('the Worker failing to create the socket: unknown', async () => {
  const connect = () => { throw new TypeError('connect() is not available'); };
  const r = await pingMinecraft({ connect, hostname: HOST, port: PORT, timeoutMs: 80 });
  assert.equal(r.state, 'unknown');
});

test('a bad configured address never reaches connect()', async () => {
  const connect = fakeConnect(() => fakeSocket().socket);
  await assert.rejects(pingMinecraft({ connect, hostname: 'not a host', port: PORT }), RangeError);
  assert.equal(connect.calls.length, 0);
});
