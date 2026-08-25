'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');

/** @type {(...args: any[]) => Promise<any>} */
const deleteStoragePrefixes = async ({ bucket = admin.storage().bucket(), prefixes = [] }) => {
  let deleted = 0;
  for (const prefix of [...new Set(prefixes.filter(Boolean))]) {
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map(async (/** @type {any} */ file) => {
      await file.delete({ ignoreNotFound: true });
      deleted += 1;
    }));
  }
  return deleted;
};

/** @type {(...args: any[]) => Promise<any>} */
const deleteStoragePaths = async ({ bucket = admin.storage().bucket(), paths = [] }) => {
  const uniquePaths = [...new Set(paths.filter(/** @param {unknown} path */ (path) => typeof path === 'string' && path.trim()))];
  await Promise.all(uniquePaths.map(/** @param {string} path */ (path) => bucket.file(path).delete({ ignoreNotFound: true })));
  return uniquePaths.length;
};


module.exports = { deleteStoragePaths, deleteStoragePrefixes };
