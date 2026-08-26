'use strict';

// @ts-check

const {
  validateDriverAssignmentResponse,
  validateDriverLoginResponse,
  validatePassengerLoginResponse,
} = require('../contracts/generated/loginResponses');
const { validateResolvedMediaResponse } = require('../contracts/generated/mediaResponses');

/** @param {unknown} value */
const isPassengerLoginResponse = (value) => validatePassengerLoginResponse(value).valid;
/** @param {unknown} value */
const isDriverLoginResponse = (value) => validateDriverLoginResponse(value).valid;
/** @param {unknown} value */
const isDriverAssignmentResponse = (value) => validateDriverAssignmentResponse(value).valid;
/** @param {unknown} value */
const isResolvedMediaResponse = (value) => validateResolvedMediaResponse(value).valid;

module.exports = {
  isDriverAssignmentResponse,
  isDriverLoginResponse,
  isPassengerLoginResponse,
  isResolvedMediaResponse,
};
