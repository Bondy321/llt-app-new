'use strict';

const {
  distributedLoginRateLimiter,
  getTrustedRequestNetworkKey,
} = require('./passengerLoginSecurity');

module.exports = { distributedLoginRateLimiter, getTrustedRequestNetworkKey };
