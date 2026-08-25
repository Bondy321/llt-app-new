'use strict';

// @ts-check

/** @param {unknown} key */
const isValidFirebaseKey = (key) => (
  typeof key === 'string'
  && key.length > 0
  && key.length <= 768
  && !/[.#$\/[\]\x00-\x1F\x7F]/u.test(key)
);

module.exports = { isValidFirebaseKey };
