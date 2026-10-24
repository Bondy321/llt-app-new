'use strict';

// One queue per physical adapter, shared by navigation, session issuance and
// cleanup. A dispatched native batch cannot be cancelled: cleanup must follow
// its acknowledgement, and cannot report success before then.
const boundaries = new WeakMap();
const CLEANUP_KEY = '@LLT:localSessionCleanup:v1';
const boundaryFor = (storage) => {
  if (!boundaries.has(storage)) boundaries.set(storage, { tail: Promise.resolve(), generation: 0, blocked: false });
  return boundaries.get(storage);
};
const serializeLocalSessionWrite = (storage, operation) => {
  const state = boundaryFor(storage);
  const result = state.tail.catch(() => {}).then(operation);
  state.tail = result;
  return result;
};
const guardedLocalSessionWrite = (storage, operation) => {
  const state = boundaryFor(storage);
  const generation = state.generation;
  return serializeLocalSessionWrite(storage, async () => {
    if (state.blocked || state.generation !== generation || await storage.getItem?.(CLEANUP_KEY)) return false;
    await operation();
    return true;
  });
};
const blockLocalSessionWrites = (storage) => {
  const state = boundaryFor(storage);
  state.blocked = true;
  state.generation += 1;
};
const openLocalSessionWrites = (storage) => {
  const state = boundaryFor(storage);
  state.blocked = false;
  state.generation += 1;
};
const localSessionWritesBlocked = storage => boundaryFor(storage).blocked;
module.exports = { localSessionWritesBlocked, CLEANUP_KEY, serializeLocalSessionWrite, guardedLocalSessionWrite,
  blockLocalSessionWrites, openLocalSessionWrites };
