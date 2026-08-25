'use strict';

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
    expoClient = new Expo();
  }
  return expoClient;
};

/** @param {unknown} token */
const isExpoPushToken = (token) => loadExpoConstructor().isExpoPushToken(token);

module.exports = {
  getExpoPushClient,
  isExpoPushToken,
};
