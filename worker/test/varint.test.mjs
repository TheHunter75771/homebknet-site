// VarInt encoding and decoding, checked against hand-written bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeVarInt, decodeVarInt, ProtocolError } from '../src/minecraft.js';

const bytes = (...b) => Uint8Array.from(b);

// Values from the protocol docs plus the edges of the 32-bit range.
const KNOWN = [
  [0, [0x00]],
  [1, [0x01]],
  [2, [0x02]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [255, [0xff, 0x01]],
  [767, [0xff, 0x05]],
  [25565, [0xdd, 0xc7, 0x01]],
  [2097151, [0xff, 0xff, 0x7f]],
  [2147483647, [0xff, 0xff, 0xff, 0xff, 0x07]],
  [-1, [0xff, 0xff, 0xff, 0xff, 0x0f]],
  [-2147483648, [0x80, 0x80, 0x80, 0x80, 0x08]],
];

test('encodes known values to the documented bytes', () => {
  for (const [value, expected] of KNOWN) assert.deepEqual([...encodeVarInt(value)], expected, `encode ${value}`);
});

test('decodes known bytes to their values and sizes', () => {
  for (const [value, b] of KNOWN) assert.deepEqual(decodeVarInt(Uint8Array.from(b)), { value, size: b.length }, `decode ${b}`);
});

test('round-trips a sweep of values', () => {
  const values = [3, 63, 64, 129, 16383, 16384, 65535, 65536, 1 << 21, (1 << 28) - 1, 1 << 28, -2, -128, -65536, -(2 ** 31) + 1];
  for (const v of values) {
    const b = encodeVarInt(v);
    assert.ok(b.length >= 1 && b.length <= 5);
    assert.deepEqual(decodeVarInt(b), { value: v, size: b.length });
  }
});

test('refuses to encode anything that is not a 32-bit integer', () => {
  for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 31, -(2 ** 31) - 1, 2 ** 32, '1', null, undefined, 1n]) {
    assert.throws(() => encodeVarInt(bad), RangeError, `encode ${String(bad)}`);
  }
});

test('decodes at an offset and ignores bytes after the VarInt', () => {
  assert.deepEqual(decodeVarInt(bytes(0x99, 0xdd, 0xc7, 0x01, 0x42), 1), { value: 25565, size: 3 });
});

test('asks for more data when the VarInt is cut off', () => {
  assert.equal(decodeVarInt(bytes()), null);
  assert.equal(decodeVarInt(bytes(0x80)), null);
  assert.equal(decodeVarInt(bytes(0xff, 0xff)), null);
  assert.equal(decodeVarInt(bytes(0xff, 0xff, 0xff, 0xff)), null);
  assert.equal(decodeVarInt(bytes(0x01), 1), null);
});

test('rejects an over-long VarInt (a 6th byte)', () => {
  assert.throws(() => decodeVarInt(bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0x01)), ProtocolError);
  assert.throws(() => decodeVarInt(bytes(0x80, 0x80, 0x80, 0x80, 0x80)), ProtocolError, 'continuation bit on the 5th byte');
  assert.throws(() => decodeVarInt(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00)), ProtocolError);
});

test('rejects a 5th byte that sets bits above 32', () => {
  for (const last of [0x10, 0x1f, 0x40, 0x7f]) {
    assert.throws(() => decodeVarInt(bytes(0xff, 0xff, 0xff, 0xff, last)), ProtocolError, `5th byte 0x${last.toString(16)}`);
  }
});

test('accepts non-minimal encodings within 5 bytes, as the game does', () => {
  assert.deepEqual(decodeVarInt(bytes(0x80, 0x00)), { value: 0, size: 2 });
  assert.deepEqual(decodeVarInt(bytes(0x81, 0x80, 0x80, 0x80, 0x00)), { value: 1, size: 5 });
});

test('rejects input that is not a byte array or a bad offset', () => {
  assert.throws(() => decodeVarInt([0x01]), TypeError);
  assert.throws(() => decodeVarInt('a'), TypeError);
  assert.throws(() => decodeVarInt(bytes(0x01), -1), RangeError);
  assert.throws(() => decodeVarInt(bytes(0x01), 0.5), RangeError);
});
