'use strict';

const { buildPhotoVariantPaths, parseSourcePhotoPath } = require('./photoVariants');
const { deleteOwnedGroupPhotoRecord } = require('./groupMediaFunctions');
const { deleteOwnedPrivatePhotoRecord } = require('./privateMediaFunctions');

module.exports = {
  cleanupMediaUploadOperation: require('./mediaUploadCleanup').cleanupMediaUploadOperation,
  drainTourMediaForDeletion: require('./tourMediaDeletion').drainTourMediaForDeletion,
  buildPhotoVariantPaths,
  deleteOwnedGroupPhotoRecord,
  deleteOwnedPrivatePhotoRecord,
  parseSourcePhotoPath,
};
