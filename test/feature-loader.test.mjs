import assert from 'node:assert/strict';
import test from 'node:test';
import { FeatureLoader } from '../src/ui/feature-loader.js';

test('feature loads share one successful singleton while invocations are independent', async () => {
  const loader = new FeatureLoader();
  let calls = 0;
  const factory = async () => ({ instance: ++calls });
  const [first, second] = await Promise.all([loader.load('capture', factory), loader.load('capture', factory)]);
  assert.equal(first, second);
  assert.equal(await loader.load('capture', factory, true), first);
  assert.equal(calls, 1);
});
test('a transport failure waits for one explicit retry', async () => {
  const loader = new FeatureLoader();
  let calls = 0;
  const factory = async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch dynamically imported module');
    return 'ready';
  };
  await assert.rejects(loader.load('capture', factory));
  assert.equal(loader.canRetry('capture'), true);
  await assert.rejects(loader.load('capture', factory));
  assert.equal(calls, 1);
  assert.equal(await loader.load('capture', factory, true), 'ready');
  assert.equal(calls, 2);
  assert.equal(loader.canRetry('capture'), false);
});
test('persistent transport failure has no third attempt', async () => {
  const loader = new FeatureLoader();
  let calls = 0;
  const factory = async () => {
    calls++;
    throw new TypeError('error loading dynamically imported module');
  };
  await assert.rejects(loader.load('capture', factory));
  await assert.rejects(loader.load('capture', factory, true));
  await assert.rejects(loader.load('capture', factory, true));
  assert.equal(calls, 2);
  assert.equal(loader.canRetry('capture'), false);
});
test('cached evaluation failure requires reload even when its message mentions a network', async () => {
  const loader = new FeatureLoader();
  let calls = 0;
  const factory = () => {
    calls++;
    throw new Error('network failed during module evaluation');
  };
  await assert.rejects(loader.load('capture', factory));
  await assert.rejects(loader.load('capture', factory, true));
  assert.equal(calls, 1);
  assert.equal(loader.canRetry('capture'), false);
});
test('independent features do not share failure or retry state', async () => {
  const loader = new FeatureLoader();
  await assert.rejects(loader.load('capture', () => Promise.reject(new TypeError('Load failed'))));
  assert.equal(await loader.load('palette', () => 'palette'), 'palette');
  assert.equal(loader.canRetry('capture'), true);
  assert.equal(loader.canRetry('palette'), false);
});

test('a retained CSS preload failure cannot retry into an unstyled dialog', async () => {
  const loader = new FeatureLoader();
  let calls = 0;
  const factory = () => {
    calls++;
    throw new Error('Unable to preload CSS for stale.css');
  };
  await assert.rejects(loader.load('settings', factory));
  await assert.rejects(loader.load('settings', factory, true));
  assert.equal(calls, 1);
  assert.equal(loader.canRetry('settings'), false);
});
