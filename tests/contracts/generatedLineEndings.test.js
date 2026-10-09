'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesGeneratedSource } = require('../../scripts/contracts/generateContracts');

test('generated contracts remain verifiable after Windows checkout without hiding source changes', () => {
  const expected = 'const signature = "line\\r\\n";\nconst version = 1;\n';
  assert.equal(matchesGeneratedSource(expected, expected), true);
  assert.equal(matchesGeneratedSource(expected.replaceAll('\n', '\r\n'), expected), true);
  assert.equal(matchesGeneratedSource(expected.replace('version = 1', 'version = 2'), expected), false);
  assert.equal(matchesGeneratedSource(expected.replace('line\\r\\n', 'line\\n'), expected), false);
});
