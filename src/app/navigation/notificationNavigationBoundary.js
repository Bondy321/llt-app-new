'use strict';

// @ts-check

const { validateNotificationPayload } = require('../../shared/contracts/generated/notificationPayload');

/** @param {unknown} value */
const isSafeNotificationNavigationPayload = (value) => validateNotificationPayload(value).valid;

module.exports = { isSafeNotificationNavigationPayload };
