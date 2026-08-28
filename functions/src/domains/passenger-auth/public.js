'use strict';

const {
  distributedLoginRateLimiter,
  getTrustedRequestNetworkKey,
} = require('./passengerLoginSecurity');
const { buildPassengerCustomClaims } = require('./passengerRoleClaims');

module.exports = {
  buildPassengerCustomClaims,
  distributedLoginRateLimiter,
  getTrustedRequestNetworkKey,
};
