const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampPagerIndex,
  resolvePagerIndexFromOffset,
} = require('../services/imageViewerPagerState');

test('clampPagerIndex keeps initial pager indexes inside the photo range', () => {
  assert.equal(clampPagerIndex(2, 5), 2);
  assert.equal(clampPagerIndex(-4, 5), 0);
  assert.equal(clampPagerIndex(99, 5), 4);
  assert.equal(clampPagerIndex('bad-index', 5), 0);
  assert.equal(clampPagerIndex(1, 0), 0);
});

test('resolvePagerIndexFromOffset maps settled FlatList offsets to page indexes', () => {
  assert.equal(resolvePagerIndexFromOffset({ offsetX: 0, pageWidth: 390, photoCount: 4 }), 0);
  assert.equal(resolvePagerIndexFromOffset({ offsetX: 390, pageWidth: 390, photoCount: 4 }), 1);
  assert.equal(resolvePagerIndexFromOffset({ offsetX: 775, pageWidth: 390, photoCount: 4 }), 2);
  assert.equal(resolvePagerIndexFromOffset({ offsetX: 5000, pageWidth: 390, photoCount: 4 }), 3);
});

test('resolvePagerIndexFromOffset handles invalid dimensions without throwing', () => {
  assert.equal(resolvePagerIndexFromOffset({ offsetX: 390, pageWidth: 0, photoCount: 4 }), 0);
  assert.equal(resolvePagerIndexFromOffset({ offsetX: 390, pageWidth: Number.NaN, photoCount: 4 }), 0);
});
