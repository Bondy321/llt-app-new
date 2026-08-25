'use strict';

const path = require('node:path');

const bookingModulesRoot = `${path.sep}services${path.sep}booking${path.sep}`;

module.exports = (servicePath) => {
  delete require.cache[servicePath];
  Object.keys(require.cache).forEach((cacheKey) => {
    if (cacheKey.includes(bookingModulesRoot)) delete require.cache[cacheKey];
  });
};
