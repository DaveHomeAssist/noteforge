import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowState } from '../src/core/window-state.js';
import { NavigationController } from '../src/utils/navigation.js';

function backend(raw = null) {
  return {
    raw,
    writes: 0,
    getItem() {
      return this.raw;
    },
    setItem(_key, value) {
      this.raw = value;
      this.writes++;
    },
  };
}

test('window state restores on reload but does not share navigation across windows', () => {
  const a = backend();
  const b = backend();
  const first = new WindowState({}, { storage: () => a });
  const second = new WindowState({}, { storage: () => b });
  first.set({ recentNoteIds: ['a'], workspace: { version: 1, activePane: 'secondary' } });
  second.set({ recentNoteIds: ['b'] });
  const reopened = new WindowState({}, { storage: () => a });
  assert.deepEqual(reopened.get('recentNoteIds'), ['a']);
  assert.equal(reopened.get('workspace').activePane, 'secondary');
  assert.deepEqual(second.get('recentNoteIds'), ['b']);
  assert.throws(() => first.set({ themeMode: 'dark' }), /Invalid window state field/);
});

test('legacy layout seeds one window without mutating shared config or retaining references', () => {
  const shared = { recentNoteIds: ['legacy'], themeMode: 'dark' };
  const store = backend();
  const state = new WindowState(shared, { storage: () => store });
  shared.recentNoteIds.push('later');
  assert.deepEqual(state.get('recentNoteIds'), ['legacy']);
  const recent = state.get('recentNoteIds');
  recent.push('detached');
  assert.deepEqual(state.get('recentNoteIds'), ['legacy']);
  state.set({ recentNoteIds: ['new'] });
  assert.deepEqual(shared.recentNoteIds, ['legacy', 'later']);
  assert.equal(JSON.parse(store.raw).values.themeMode, undefined);
  assert.deepEqual(new WindowState(shared, { storage: () => store }).get('recentNoteIds'), ['new']);
});

test('unreadable or future session state remains intact while navigation continues in memory', () => {
  for (const raw of ['{', JSON.stringify({ version: 2, values: {} }), JSON.stringify({ version: 1, values: [] })]) {
    const store = backend(raw);
    const warnings = [];
    const state = new WindowState({}, { storage: () => store, onUnavailable: (message) => warnings.push(message) });
    assert.equal(state.set({ recentNoteIds: ['a'] }), false);
    assert.equal(state.set({ recentNoteIds: ['b'] }), false);
    assert.deepEqual(state.get('recentNoteIds'), ['b']);
    assert.equal(store.raw, raw);
    assert.equal(store.writes, 0);
    assert.equal(warnings.length, 1);
  }
});

test('denied session storage does not send navigation into shared durable configuration', () => {
  const full = backend();
  full.setItem = () => {
    throw new Error('Quota exceeded');
  };
  const retained = new WindowState({}, { storage: () => full });
  assert.equal(retained.set({ recentNoteIds: ['retained'] }), false);
  assert.deepEqual(retained.get('recentNoteIds'), ['retained']);
  const warnings = [];
  const state = new WindowState(
    {},
    {
      storage: () => {
        throw new Error('Denied');
      },
      onUnavailable: (message) => warnings.push(message),
    },
  );
  let sharedWrites = 0;
  const controller = new NavigationController(
    {
      getNote: (id) => ({ id }),
      setConfig() {
        sharedWrites++;
      },
    },
    { saveRecent: (recentNoteIds) => state.set({ recentNoteIds }) },
  );
  controller.recordOpen('a');
  controller.recordOpen('b');
  controller.prune((id) => id !== 'a');
  assert.deepEqual(state.get('recentNoteIds'), ['b']);
  assert.equal(sharedWrites, 0);
  assert.equal(warnings.length, 1);
});
