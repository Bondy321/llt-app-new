'use strict';

const contract = require('./passengerTripContract');
const functions = require('./passengerTripFunctions');
const signals = require('./passengerTripSignals');
const snapshot = require('./passengerTripSnapshot');

module.exports = {
  ...contract,
  ...functions,
  ...signals,
  ...snapshot,
};
