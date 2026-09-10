'use strict';

// @ts-check

const { getRuntimeEnvironment } = require('../../config/runtimeConfig');

const LOCAL_PASSENGER_APP_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/u;

/** @param {unknown} value */
const normalizeConfiguredOrigins = (value) => String(value || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => {
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      return parsed.origin === origin && ['http:', 'https:'].includes(parsed.protocol);
    } catch (_error) {
      return false;
    }
  });

/** @param {unknown} origin @param {unknown} [configuredOrigins] */
const isAllowedPassengerAppOrigin = (
  origin,
  configuredOrigins = getRuntimeEnvironment().PASSENGER_APP_ALLOWED_ORIGINS,
) => {
  if (!origin) return true;
  if (typeof origin !== 'string' || origin.trim() !== origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_error) {
    return false;
  }
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) return false;
  return LOCAL_PASSENGER_APP_ORIGIN.test(origin)
    || normalizeConfiguredOrigins(configuredOrigins).includes(origin);
};

/** @param {unknown} [configuredOrigins] */
const getPassengerAppCorsOrigins = (
  configuredOrigins = getRuntimeEnvironment().PASSENGER_APP_ALLOWED_ORIGINS,
) => Object.freeze([
  ...normalizeConfiguredOrigins(configuredOrigins),
  LOCAL_PASSENGER_APP_ORIGIN,
]);

module.exports = {
  LOCAL_PASSENGER_APP_ORIGIN,
  getPassengerAppCorsOrigins,
  isAllowedPassengerAppOrigin,
  normalizeConfiguredOrigins,
};
