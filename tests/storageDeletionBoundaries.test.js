'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteStoragePrefixes } = require('../functions/src/infrastructure/storage/storageDeletion');

test('bounded prefix deletion counts retained sentinels and resumes durable cursor without removing their fences', async () => {
  const records = new Map(Array.from({ length: 7 }, (_, index) => [`photos/${index}`, {
    generation: `generation-${index}`, size: index < 5 ? '0' : '15', metadata: index < 5 ? { cancelled: 'true' } : {},
  }]));
  const removed = [];
  const bucket = { getFiles: async query => {
    const start = query.pageToken || query.startOffset;
    const names = [...records.keys()].sort().filter(name => name.startsWith(query.prefix)
      && (!start || (query.pageToken ? name > start : name >= start)));
    const page = names.slice(0, query.maxResults);
    return [page.map(name => ({ name, metadata: records.get(name),
      delete: async options => { assert.equal(options.ifGenerationMatch, records.get(name).generation); records.delete(name); removed.push(name); },
    })), names.length > page.length ? { pageToken: page.at(-1) } : null];
  } };
  let cursor = null; let pending = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await deleteStoragePrefixes({ bucket, prefixes: ['photos/'], maxObjects: 2, maxPages: 2, cursor,
        onProgress: async value => { cursor = structuredClone(value); } });
      break;
    } catch (error) { assert.equal(error.code, 'STORAGE_CLEANUP_PENDING'); pending += 1; }
  }
  assert.ok(pending > 0); assert.equal(cursor.prefixIndex, 1);
  assert.deepEqual(removed, ['photos/5', 'photos/6']);
  assert.equal(records.size, 5);
});
