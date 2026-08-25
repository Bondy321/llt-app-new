'use strict';

/** @typedef {(source: Buffer) => any} SharpFactory */

const loadSharp = () => require('sharp');
/** @type {SharpFactory | null} */
let testSharpFactory = null;

/**
 * @param {Buffer} sourceBuffer
 * @param {{ sharpFactory?: SharpFactory }} [options]
 */
const createPhotoVariantBuffers = async (sourceBuffer, { sharpFactory = testSharpFactory || loadSharp() } = {}) => {
  const [viewerBuffer, thumbnailBuffer] = await Promise.all([
    sharpFactory(sourceBuffer).rotate().resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(),
    sharpFactory(sourceBuffer).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer(),
  ]);
  return { viewerBuffer, thumbnailBuffer };
};

/** @param {SharpFactory} sharpFactory */
const setSharpFactoryForTests = (sharpFactory) => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Sharp overrides are test-only');
  testSharpFactory = sharpFactory;
};

module.exports = { createPhotoVariantBuffers, loadSharp, setSharpFactoryForTests };
