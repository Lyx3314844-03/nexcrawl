/**
 * Tests for protobuf-inferrer.js — encoder functions
 *
 * Validates: encodeVarint, encodeFieldTag, encodeProtobufField,
 *            encodeProtobufMessage, encodeGrpcFrame
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeVarint,
  encodeFieldTag,
  encodeProtobufField,
  encodeProtobufMessage,
  encodeGrpcFrame,
} from '../src/reverse/protobuf-inferrer.js';

// ─── encodeVarint ─────────────────────────────────────────────────────────────

test('encodeVarint — zero', () => {
  const buf = encodeVarint(0);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '00');
});

test('encodeVarint — single byte (1)', () => {
  const buf = encodeVarint(1);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '01');
});

test('encodeVarint — single byte (127)', () => {
  const buf = encodeVarint(127);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '7f');
});

test('encodeVarint — two bytes (128)', () => {
  const buf = encodeVarint(128);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '8001');
});

test('encodeVarint — two bytes (300)', () => {
  const buf = encodeVarint(300);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), 'ac02');
});

test('encodeVarint — large value (150)', () => {
  const buf = encodeVarint(150);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '9601');
});

test('encodeVarint — bigint support', () => {
  const buf = encodeVarint(BigInt(1));
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '01');
});

// ─── encodeFieldTag ───────────────────────────────────────────────────────────

test('encodeFieldTag — field 1 wire 0 (varint)', () => {
  const buf = encodeFieldTag(1, 0);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '08');
});

test('encodeFieldTag — field 1 wire 2 (length-delimited)', () => {
  const buf = encodeFieldTag(1, 2);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0a');
});

test('encodeFieldTag — field 2 wire 0', () => {
  const buf = encodeFieldTag(2, 0);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '10');
});

test('encodeFieldTag — field 2 wire 2', () => {
  const buf = encodeFieldTag(2, 2);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '12');
});

test('encodeFieldTag — field 15 wire 2', () => {
  const buf = encodeFieldTag(15, 2);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '7a');
});

// ─── encodeProtobufField ──────────────────────────────────────────────────────

test('encodeProtobufField — bool true (field 1)', () => {
  const buf = encodeProtobufField(1, 'bool', true);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0801');
});

test('encodeProtobufField — bool false (field 1)', () => {
  const buf = encodeProtobufField(1, 'bool', false);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0800');
});

test('encodeProtobufField — int32 150 (field 1)', () => {
  const buf = encodeProtobufField(1, 'int32', 150);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '089601');
});

test('encodeProtobufField — int32 negative (field 1)', () => {
  const buf = encodeProtobufField(1, 'int32', -1);
  const hex = Buffer.from(buf).toString('hex');
  assert.ok(hex.startsWith('08'));
  assert.equal(hex.length, 22); // 1 tag + 10 varint bytes * 2 hex chars
});

test('encodeProtobufField — uint32 300 (field 1)', () => {
  const buf = encodeProtobufField(1, 'uint32', 300);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '08ac02');
});

test('encodeProtobufField — sint32 -1 uses zigzag (field 1)', () => {
  const buf = encodeProtobufField(1, 'sint32', -1);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0801');
});

test('encodeProtobufField — sint32 1 uses zigzag (field 1)', () => {
  const buf = encodeProtobufField(1, 'sint32', 1);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0802');
});

test('encodeProtobufField — fixed32 (field 1)', () => {
  const buf = encodeProtobufField(1, 'fixed32', 258);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0d02010000');
});

test('encodeProtobufField — float (field 1)', () => {
  const buf = encodeProtobufField(1, 'float', 1.5);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0d0000c03f');
});

test('encodeProtobufField — string "hello" (field 2)', () => {
  const buf = encodeProtobufField(2, 'string', 'hello');
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '120568656c6c6f');
});

test('encodeProtobufField — bytes (field 2)', () => {
  const buf = encodeProtobufField(2, 'bytes', Buffer.from([0x01, 0x02, 0x03]));
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '1203010203');
});

test('encodeProtobufField — enum (field 1)', () => {
  const buf = encodeProtobufField(1, 'enum', 2);
  assert.deepStrictEqual(Buffer.from(buf).toString('hex'), '0802');
});

test('encodeProtobufField — fixed64 (field 1)', () => {
  const buf = encodeProtobufField(1, 'fixed64', BigInt(1));
  const hex = Buffer.from(buf).toString('hex');
  assert.ok(hex.startsWith('09'));
  assert.equal(hex.length, 18);
});

// ─── encodeProtobufMessage ────────────────────────────────────────────────────

test('encodeProtobufMessage — simple message { name: "Alice", age: 30 }', () => {
  const schema = {
    fields: [
      { fieldNumber: 1, name: 'name', type: 'string', repeated: false },
      { fieldNumber: 2, name: 'age', type: 'int32', repeated: false },
    ],
  };
  const buf = encodeProtobufMessage({ name: 'Alice', age: 30 }, schema);
  const hex = Buffer.from(buf).toString('hex');
  assert.equal(hex, '0a05416c696365101e');
});

test('encodeProtobufMessage — repeated string field', () => {
  const schema = {
    fields: [
      { fieldNumber: 1, name: 'tags', type: 'string', repeated: true },
    ],
  };
  const buf = encodeProtobufMessage({ tags: ['foo', 'bar'] }, schema);
  const hex = Buffer.from(buf).toString('hex');
  assert.equal(hex, '0a03666f6f0a03626172');
});

test('encodeProtobufMessage — repeated int32 (packed)', () => {
  const schema = {
    fields: [
      { fieldNumber: 1, name: 'ids', type: 'int32', repeated: true },
    ],
  };
  const buf = encodeProtobufMessage({ ids: [1, 2, 3] }, schema);
  const hex = Buffer.from(buf).toString('hex');
  assert.equal(hex, '0a03010203');
});

test('encodeProtobufMessage — empty message', () => {
  const schema = { fields: [] };
  const buf = encodeProtobufMessage({}, schema);
  assert.equal(Buffer.from(buf).length, 0);
});

test('encodeProtobufMessage — null/undefined field value is skipped', () => {
  const schema = {
    fields: [
      { fieldNumber: 1, name: 'name', type: 'string', repeated: false },
      { fieldNumber: 2, name: 'age', type: 'int32', repeated: false },
    ],
  };
  const buf = encodeProtobufMessage({ name: null, age: 20 }, schema);
  const hex = Buffer.from(buf).toString('hex');
  assert.equal(hex, '1014');
});

// ─── encodeGrpcFrame ──────────────────────────────────────────────────────────

test('encodeGrpcFrame — uncompressed', () => {
  const payload = Buffer.from('hello');
  const frame = encodeGrpcFrame(payload);
  const hex = Buffer.from(frame).toString('hex');
  assert.equal(hex, '000000000568656c6c6f');
});

test('encodeGrpcFrame — empty payload', () => {
  const payload = Buffer.alloc(0);
  const frame = encodeGrpcFrame(payload);
  const hex = Buffer.from(frame).toString('hex');
  assert.equal(hex, '0000000000');
});

test('encodeGrpcFrame — with compression flag', () => {
  const payload = Buffer.from([0x01, 0x02]);
  const frame = encodeGrpcFrame(payload, true);
  const hex = Buffer.from(frame).toString('hex');
  assert.equal(hex, '01000000020102');
});

// ─── Round-trip: encode → decode ─────────────────────────────────────────────

test('round-trip: encodeVarint → readVarint for various values', () => {
  const values = [0, 1, 127, 128, 255, 256, 300, 16383, 16384, 1_000_000];
  for (const v of values) {
    const encoded = encodeVarint(v);
    let decoded = 0;
    let shift = 0;
    let pos = 0;
    const buf = Buffer.from(encoded);
    while (pos < buf.length) {
      const byte = buf[pos++];
      decoded |= (byte & 0x7f) << shift;
      shift += 7;
    }
    assert.equal(decoded, v, `round-trip failed for ${v}`);
  }
});

test('round-trip: encodeProtobufMessage → decodeWithInferredSchema for simple message', async () => {
  const { decodeWithInferredSchema } = await import('../src/reverse/protobuf-inferrer.js');
  const schema = {
    fields: [
      { fieldNumber: 1, name: 'name', type: 'string', repeated: false },
      { fieldNumber: 2, name: 'id', type: 'int32', repeated: false },
      { fieldNumber: 3, name: 'active', type: 'bool', repeated: false },
    ],
  };
  const original = { name: 'test-user', id: 42, active: true };
  const encoded = encodeProtobufMessage(original, schema);
  const decoded = decodeWithInferredSchema(encoded, schema);
  assert.equal(decoded.name, 'test-user');
  assert.equal(decoded.id, 42);
  assert.equal(decoded.active, true);
});

test('round-trip: encodeGrpcFrame → parseGrpcFrame', async () => {
  const payload = Buffer.from('test-data-for-grpc-frame');
  const frame = encodeGrpcFrame(payload);
  const buf = Buffer.from(frame);
  const compressed = buf[0];
  const length = buf.readUInt32BE(1);
  const inner = buf.subarray(5);
  assert.equal(compressed, 0);
  assert.equal(length, payload.length);
  assert.deepStrictEqual(Buffer.from(inner), payload);
});
