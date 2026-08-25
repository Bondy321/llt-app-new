'use strict';

// @ts-check

/** @param {unknown} value @param {number} [maxLength] */
const cleanPassengerString = (value, maxLength = 500) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

module.exports = { cleanPassengerString };
