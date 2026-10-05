import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecoveryValue, decodeRecoveryValue } from '../src/core/recovery-archive-codec.js';

async function roundtrip(value) {
  return decodeRecoveryValue(JSON.parse(JSON.stringify(await encodeRecoveryValue(value))));
}

test('recovery graph preserves undefined, numeric edges, sparse arrays, cycles and shared references', async () => {
  const shared = { source: 'exact café 🦊' };
  const source = {
    undefined: undefined,
    nan: NaN,
    positive: Infinity,
    negative: -Infinity,
    zero: -0,
    big: 12345678901234567890n,
    shared,
    again: shared,
    sparse: new Array(4),
  };
  source.self = source;
  source.sparse[2] = undefined;
  const copy = await roundtrip(source);
  assert.deepEqual(copy, source);
  assert.equal(copy.self, copy);
  assert.equal(copy.shared, copy.again);
  assert.equal(0 in copy.sparse, false);
  assert.equal(2 in copy.sparse, true);
});

test('recovery graph preserves date, invalid date, regular expressions and cyclic collections', async () => {
  const source = {
    date: new Date('2026-10-04T00:00:00Z'),
    invalid: new Date(NaN),
    regexp: /source/gi,
    map: new Map(),
    set: new Set(),
  };
  source.map.set(source, source.set);
  source.set.add(source.map);
  source.regexp.lastIndex = 4;
  const copy = await roundtrip(source);
  assert.equal(copy.date.getTime(), source.date.getTime());
  assert.equal(Number.isNaN(copy.invalid.getTime()), true);
  assert.equal(copy.regexp.source, source.regexp.source);
  assert.equal(copy.regexp.flags, source.regexp.flags);
  assert.equal(copy.map.get(copy), copy.set);
  assert.equal(copy.set.has(copy.map), true);
  assert.equal(copy.regexp.lastIndex, 4);
});

test('recovery graph preserves binary view ranges, shared backing buffers, blobs and files', async () => {
  const buffer = new ArrayBuffer(24);
  new Uint8Array(buffer).set([0, 255, 42, 88]);
  const source = {
    buffer,
    bytes: new Uint8Array(buffer, 1, 3),
    data: new DataView(buffer, 2, 7),
    big: new BigInt64Array(buffer, 8, 1),
    blob: new Blob(['exact source'], { type: 'text/plain' }),
    file: new File([new Uint8Array([0, 255])], 'future.bin', { type: 'application/octet-stream', lastModified: 1234 }),
  };
  const copy = await roundtrip(source);
  assert.deepEqual(new Uint8Array(copy.buffer), new Uint8Array(buffer));
  assert.equal(copy.bytes.buffer, copy.buffer);
  assert.equal(copy.data.buffer, copy.buffer);
  assert.equal(copy.big.buffer, copy.buffer);
  assert.equal(copy.data.byteOffset, 2);
  assert.equal(copy.data.byteLength, 7);
  assert.equal(await copy.blob.text(), 'exact source');
  assert.equal(copy.blob.type, 'text/plain');
  assert.equal(copy.file.name, 'future.bin');
  assert.equal(copy.file.lastModified, 1234);
  assert.deepEqual(new Uint8Array(await copy.file.arrayBuffer()), new Uint8Array([0, 255]));
});

test('recovery graph keeps special property names as data without prototype mutation', async () => {
  const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":"source","ref":0,"special":"undefined"}');
  const copy = await roundtrip(source);
  assert.deepEqual(copy, source);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.equal({}.polluted, undefined);
  const nullObject = Object.assign(Object.create(null), { source: 'preserved' });
  assert.deepEqual(await roundtrip(nullObject), nullObject);
});

test('recovery graph fails explicitly on unsupported source and unknown formats', async () => {
  await assert.rejects(encodeRecoveryValue(new Error('saved error')), /Cannot archive source type Error/);
  await assert.rejects(encodeRecoveryValue({ fn() {} }), /Cannot archive source type function/);
  assert.throws(() => decodeRecoveryValue({ encoding: 'future', nodes: [] }), /Unsupported recovery source encoding/);
  assert.throws(
    () => decodeRecoveryValue({ encoding: 'structured-source-v1', nodes: [], root: { ref: 1 } }),
    /Invalid archive reference/,
  );
});

test('recovery graph rejects inherited names as binary constructors', () => {
  assert.throws(
    () =>
      decodeRecoveryValue({
        encoding: 'structured-source-v1',
        root: { ref: 0 },
        nodes: [
          { type: 'view', data: { name: 'constructor', buffer: { ref: 1 }, offset: 0, bytes: 0 } },
          { type: 'buffer', data: '' },
        ],
      }),
    /Unsupported archive array view/,
  );
});
