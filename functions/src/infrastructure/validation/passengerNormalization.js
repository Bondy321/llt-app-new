'use strict';

// @ts-check

/** @param {unknown} value @param {number} [maxLength] */
const cleanPassengerString = (value, maxLength = 500) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

/** @param {unknown} bookingRef */
const normalizeBookingRef = (bookingRef) => (
  typeof bookingRef === 'string' ? bookingRef.trim().toUpperCase() : ''
);

/** @param {unknown} email */
const normalizeEmail = (email) => (
  typeof email === 'string' ? email.trim().toLowerCase() : ''
);

module.exports = { cleanPassengerString, normalizeBookingRef, normalizeEmail };
