'use strict';

const { loadSharp: loadSharpDefault } = require('../../infrastructure/storage/mediaProcessor');
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const imageError = () => Object.assign(new Error('Upload must be a valid, single-frame supported image within the decoded image limits.'), { code: 'INVALID_IMAGE' });

const validateImageMetadata = (metadata, expected) => {
  if (metadata.format !== expected || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
    || metadata.width < 1 || metadata.height < 1 || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION
    || metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages || 1) !== 1
    || (expected === 'heif' && metadata.compression && metadata.compression !== 'hevc')) throw imageError();
};

// Lazy loading keeps native codec initialization out of unrelated cold workers.
// stats() forces a complete decode; trusting metadata alone accepts truncated data.
async function validateDecodedImage(body, contentType, { loadSharp = loadSharpDefault } = {}) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_IMAGE_BYTES) throw imageError();
  const allowedFormats = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heif' };
  const expected = allowedFormats[contentType];
  if (!expected) throw imageError();
  let image;
  try {
    image = loadSharp()(body, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true, failOn: 'warning', animated: false });
    const metadata = await image.metadata();
    validateImageMetadata(metadata, expected);
    await image.stats();
    return { width: metadata.width, height: metadata.height, format: metadata.format };
  } catch { throw imageError(); }
  finally { image?.destroy?.(); }
}
module.exports = { validateDecodedImage, MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION, MAX_IMAGE_BYTES };
