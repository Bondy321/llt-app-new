'use strict';

const { defineSecret } = require('firebase-functions/params');

const expoAccessTokenSecret = defineSecret('EXPO_ACCESS_TOKEN');

/** @type {any} */
let expoConstructor = null;
/** @type {any} */
let expoClient = null;

const loadExpoConstructor = () => {
  if (!expoConstructor) ({ Expo: expoConstructor } = require('expo-server-sdk'));
  return expoConstructor;
};

const getExpoPushClient = () => {
  if (!expoClient) {
    const Expo = loadExpoConstructor();
    let accessToken = null;
    try {
      accessToken = expoAccessTokenSecret.value() || null;
    } catch (_error) {
      // Local tests and pre-deployment function discovery do not expose secret values.
      accessToken = null;
    }
    if (String(process.env.REQUIRE_EXPO_ACCESS_TOKEN || '').trim().toLowerCase() === 'true' && !accessToken) {
      const error = new Error('Expo enhanced push security is enabled but EXPO_ACCESS_TOKEN is unavailable');
      error.code = 'EXPO_ACCESS_TOKEN_MISSING';
      throw error;
    }
    expoClient = new Expo(accessToken ? { accessToken } : undefined);
  }
  return expoClient;
};

/** @param {unknown} token */
const isExpoPushToken = (token) => loadExpoConstructor().isExpoPushToken(token);

module.exports = {
  expoAccessTokenSecret,
  getExpoPushClient,
  isExpoPushToken,
};
