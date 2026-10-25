/*
 * Minecraft: Java Edition Server List Ping, the status exchange the multiplayer screen uses.
 *
 *   client -> server  Handshake        [len][0x00][VarInt protocol][String host][u16 port][VarInt 1]
 *   client -> server  Status request   [len][0x00]
 *   server -> client  Status response  [len][0x00][String json]
 *
 * Every frame starts with a VarInt length; a String is a VarInt byte length plus UTF-8.
 * The socket factory is passed in (cloudflare:sockets `connect` in production, fakes in tests),
 * so nothing here depends on the runtime.
 *
 * Result states:
 *   online   a well-formed status response arrived
 *   offline  nothing came back: refused, reset, closed, or no first byte within the timeout
 *            (the game PC is often asleep, which looks exactly like this)
 *   unknown  something answered but not with a usable status response (truncated, oversize,
 *            garbage, stalled mid-response), or the Worker itself failed to open the socket
 */

export const PROTOCOL_ANY = -1; // "whatever you are": the server replies with its own version
export const MAX_RESPONSE_BYTES = 64 * 1024; // whole response frame, length prefix included
export const PING_TIMEOUT_MS = 4000;
export const MAX_PLAYERS = 100000;
export const MAX_VERSION_CHARS = 32;

const MAX_VARINT_BYTES = 5;
const NEXT_STATE_STATUS = 1;
const MAX_HOST_BYTES = 255;
const TIMED_OUT = Symbol('timed out');

export const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const result = (state, players = null, maxPlayers = null, version = null) => ({ state, players, maxPlayers, version });
const OFFLINE = () => result('offline');
const UNKNOWN = () => result('unknown');

// ---- VarInt -------------------------------------------------------------------

// Signed 32-bit integer to Minecraft VarInt bytes (7 bits per byte, little end first,
// negatives as their unsigned 32-bit two's complement, so -1 takes 5 bytes).
export function encodeVarInt(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError('VarInt must be a 32-bit integer');
  }
  let v = value >>> 0;
  const out = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return Uint8Array.from(out);
}

// Reads a VarInt at `offset`. Returns { value, size }, or null when the bytes end before the
// VarInt does (wait for more data). Throws ProtocolError when it runs past 5 bytes or sets
// bits above 32. Non-minimal encodings within 5 bytes are accepted, as the game accepts them.
export function decodeVarInt(bytes, offset = 0) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer');
  let value = 0;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (offset + i >= bytes.length) return null;
    const byte = bytes[offset + i];
    if (i === MAX_VARINT_BYTES - 1 && byte & 0x70) throw new ProtocolError('VarInt is wider than 32 bits');
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return { value: value | 0, size: i + 1 };
  }
  throw new ProtocolError('VarInt is longer than 5 bytes'); // 5th byte still had its continuation bit
}

// ---- packets --------------------------------------------------------------------

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const frame = (body) => concat(encodeVarInt(body.length), body);

export const STATUS_REQUEST = frame(Uint8Array.of(0x00));

export function buildHandshake(hostname, port, protocol = PROTOCOL_ANY) {
  if (typeof hostname !== 'string' || !HOSTNAME_RE.test(hostname)) throw new RangeError('bad hostname');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('bad port');
  const host = new TextEncoder().encode(hostname);
  if (host.length > MAX_HOST_BYTES) throw new RangeError('hostname too long');
  return frame(concat(
    encodeVarInt(0x00),
    encodeVarInt(protocol),
    encodeVarInt(host.length), host,
    Uint8Array.of(port >> 8, port & 0xff),
    encodeVarInt(NEXT_STATE_STATUS),
  ));
}

// Pulls the JSON text out of a status response frame at the start of `buf`.
// Returns null while the frame is incomplete; throws ProtocolError when it can't be one.
export function parseStatusFrame(buf, maxBytes = MAX_RESPONSE_BYTES) {
  const len = decodeVarInt(buf, 0);
  if (len === null) return null;
  if (len.value <= 0 || len.size + len.value > maxBytes) throw new ProtocolError('response length out of bounds');
  const end = len.size + len.value;
  if (buf.length < end) return null;
  const packet = buf.subarray(len.size, end);
  const id = decodeVarInt(packet, 0);
  if (id === null || id.value !== 0x00) throw new ProtocolError('not a status response');
  const strLen = decodeVarInt(packet, id.size);
  if (strLen === null) throw new ProtocolError('string length cut off');
  const start = id.size + strLen.size;
  if (strLen.value < 0 || start + strLen.value !== packet.length) throw new ProtocolError('string does not fill the packet');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(packet.subarray(start));
  } catch {
    throw new ProtocolError('response is not UTF-8');
  }
}

// ---- status JSON ------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function cleanCount(n) {
  return Number.isInteger(n) && n >= 0 && n <= MAX_PLAYERS ? n : null;
}

// Version names can carry section-sign colour codes and anything else a server cares to send.
// Strip the colour codes, then keep it only if it looks like a version: letters, digits, space
// and . + _ -, at most 32 characters. Anything else (markup, symbols, invisible characters) is null.
const VERSION_RE = new RegExp(`^[0-9A-Za-z .+_-]{1,${MAX_VERSION_CHARS}}$`);

export function cleanVersion(name) {
  if (typeof name !== 'string') return null;
  const text = name.replace(/\xa7[\s\S]?/g, '').replace(/\s+/g, ' ').trim();
  return VERSION_RE.test(text) ? text : null;
}

// Any JSON object counts as a live server (the game's own codec makes every field optional);
// each field we report is validated on its own and dropped to null if it's not sane.
export function readStatusJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProtocolError('response is not JSON');
  }
  if (!isObject(data)) throw new ProtocolError('response is not a JSON object');
  const players = isObject(data.players) ? data.players : {};
  const version = isObject(data.version) ? data.version : {};
  return result('online', cleanCount(players.online), cleanCount(players.max), cleanVersion(version.name));
}

// ---- the ping -------------------------------------------------------------------

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new ProtocolError('socket produced something other than bytes');
}

function closeQuietly(socket) {
  try {
    const p = socket && typeof socket.close === 'function' ? socket.close() : null;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // already closed
  }
}

export async function pingMinecraft({ connect, hostname, port, timeoutMs = PING_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES }) {
  const request = concat(buildHandshake(hostname, port), STATUS_REQUEST);

  let socket;
  try {
    socket = connect({ hostname, port }, { secureTransport: 'off', allowHalfOpen: false });
  } catch {
    return UNKNOWN(); // the Worker couldn't even create the socket
  }
  if (socket && socket.closed && typeof socket.closed.catch === 'function') socket.closed.catch(() => {});

  let received = 0;
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });

  const exchange = (async () => {
    try {
      await socket.opened;
      const writer = socket.writable.getWriter();
      await writer.write(request);
      writer.releaseLock();
    } catch {
      return OFFLINE(); // refused, unreachable, reset
    }
    const reader = socket.readable.getReader();
    const buf = new Uint8Array(maxBytes);
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        return received ? UNKNOWN() : OFFLINE(); // reset mid-response vs. reset before it
      }
      if (chunk.done) return received ? UNKNOWN() : OFFLINE(); // truncated vs. closed without a word
      const bytes = toBytes(chunk.value);
      if (bytes.length === 0) continue;
      if (received + bytes.length > maxBytes) {
        // Parse what fits first: a complete frame followed by stray bytes is still a frame.
        buf.set(bytes.subarray(0, maxBytes - received), received);
        received = maxBytes;
        const text = parseStatusFrame(buf, maxBytes);
        if (text === null) throw new ProtocolError('response larger than the cap');
        return readStatusJson(text);
      }
      buf.set(bytes, received);
      received += bytes.length;
      const text = parseStatusFrame(buf.subarray(0, received), maxBytes);
      if (text !== null) return readStatusJson(text);
    }
  })();
  exchange.catch(() => {}); // settled below; this only keeps a late rejection from going unhandled

  try {
    const outcome = await Promise.race([exchange, deadline]);
    if (outcome === TIMED_OUT) return received ? UNKNOWN() : OFFLINE();
    return outcome;
  } catch {
    return UNKNOWN(); // a malformed response, or a fault in this code
  } finally {
    clearTimeout(timer);
    closeQuietly(socket);
  }
}
