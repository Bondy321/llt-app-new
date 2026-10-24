'use strict';

const { tourPublicationReadGrants } = require('../../functions/lib/tourPublicationRules');

// Exact reviewed AND constraints: never remove an unrecognized wrapper or OR grant.
const REVIEWED_AUTHORITY_CONSTRAINTS = Object.freeze([
  "(auth != null && (auth.lltSessionIssuer === true || auth.lltNotificationIssuer === true || auth.lltTourPublisher === true || auth.lltMediaPublisher === true || ((auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users').child(auth.uid).val() === true) && auth.token.firebase.sign_in_second_factor === 'totp') || (root.child('app_session_authority').child(auth.uid).child('schemaVersion').val() === 1 && root.child('app_session_authority').child(auth.uid).child('state').val() === 'committed' && root.child('app_session_authority').child(auth.uid).child('epoch').isString() && root.child('app_session_authority').child(auth.uid).child('epoch').val().matches(/^[a-f0-9]{48}$/) && root.child('app_session_authority').child(auth.uid).child('sessionId').val() === root.child('app_sessions').child(auth.uid).child('sessionId').val() && (root.child('app_sessions').child(auth.uid).child('principalType').val() !== 'passenger' || (root.child('passenger_identity_security').child(root.child('users').child(auth.uid).child('bookingRef').val()).child('deviceAuthorizationVersion').val() === 2 && root.child('passenger_identity_security').child(root.child('users').child(auth.uid).child('bookingRef').val()).child('authorizedAuthUids').child(auth.uid).val() === true && root.child('passenger_identity_security').child(root.child('users').child(auth.uid).child('bookingRef').val()).child('passengerPrincipalId').val() === root.child('app_sessions').child(auth.uid).child('principalId').val() && root.child('tours').child(root.child('app_sessions').child(auth.uid).child('tourId').val()).child('participants').child(auth.uid).child('schemaVersion').val() === 2 && root.child('tours').child(root.child('app_sessions').child(auth.uid).child('tourId').val()).child('participants').child(auth.uid).child('sessionId').val() === root.child('app_sessions').child(auth.uid).child('sessionId').val() && root.child('tours').child(root.child('app_sessions').child(auth.uid).child('tourId').val()).child('participants').child(auth.uid).child('principalId').val() === root.child('app_sessions').child(auth.uid).child('principalId').val())))))",
  "(auth == null || auth.lltSessionIssuer === true || root.child('app_sessions').child(auth.uid).child('principalType').val() !== 'driver' || (root.child('driver_device_authorizations').child(auth.uid).child('schemaVersion').val() === 1 && root.child('driver_device_authorizations').child(auth.uid).child('state').val() === 'active' && root.child('driver_device_authorizations').child(auth.uid).child('sessionId').val() === root.child('app_sessions').child(auth.uid).child('sessionId').val() && root.child('driver_device_authorizations').child(auth.uid).child('driverId').val() === root.child('app_sessions').child(auth.uid).child('driverId').val() && root.child('driver_staff_policy').child(root.child('app_sessions').child(auth.uid).child('driverId').val()).child('schemaVersion').val() === 1 && root.child('driver_device_authorizations').child(auth.uid).child('generation').isString() && root.child('driver_device_authorizations').child(auth.uid).child('generation').val().matches(/^[a-f0-9]{48}$/) && root.child('driver_staff_policy').child(root.child('app_sessions').child(auth.uid).child('driverId').val()).child('generation').val() === root.child('driver_device_authorizations').child(auth.uid).child('generation').val() && root.child('app_session_authority').child(auth.uid).child('state').val() === 'committed' && root.child('app_session_authority').child(auth.uid).child('sessionId').val() === root.child('app_sessions').child(auth.uid).child('sessionId').val() && root.child('app_sessions').child(auth.uid).child('driverLoginPolicyGeneration').isNumber() && root.child('driver_login_policy/v1/generation').val() === root.child('app_sessions').child(auth.uid).child('driverLoginPolicyGeneration').val()))"
]);

const closesOuterGrantAt = (value, end) => {
  let depth = 0;
  let quote = null;
  let regex = false;
  let characterClass = false;
  let previous = '';
  for (let index = 0; index <= end; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (regex) {
      if (char === '\\') index += 1;
      else if (char === '[') characterClass = true;
      else if (char === ']') characterClass = false;
      else if (char === '/' && !characterClass) regex = false;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '/' && previous === '(') regex = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index === end;
      if (depth < 0) return false;
    }
    if (!/\s/.test(char)) previous = char;
  }
  return false;
};

const unwrapReviewedAuthorityConstraints = value => {
  if (typeof value !== 'string') return value;
  let grant = value;
  for (const constraint of REVIEWED_AUTHORITY_CONSTRAINTS) {
    const prefix = `${constraint} && (`;
    if (!grant.startsWith(prefix) || !grant.endsWith(')')) continue;
    const wrapped = grant.slice(prefix.length - 1);
    if (closesOuterGrantAt(wrapped, wrapped.length - 1)) grant = wrapped.slice(1, -1);
  }
  return grant;
};

const unwrapReviewedServerReadGrant = (value, path) => {
  const reviewed = tourPublicationReadGrants().find(entry => entry.path.join('/') === path.join('/'));
  if (!reviewed || typeof value !== 'string') return value;
  const suffix = `) || (${reviewed.predicate})`;
  if (!value.startsWith('(') || !value.endsWith(suffix)) return value;
  if (!closesOuterGrantAt(value, value.length - suffix.length)) return value;
  return value.slice(1, -suffix.length);
};

const unwrapReviewedServerValidation = value => {
  let validation = value;
  for (const marker of ['lltMediaPublisher', 'lltNotificationIssuer', 'lltTourPublisher', 'lltSessionIssuer']) {
    const prefix = `(auth != null && auth.${marker} === true) || (`;
    if (typeof validation !== 'string' || !validation.startsWith(prefix) || !validation.endsWith(')')) continue;
    const wrapped = validation.slice(prefix.length - 1);
    if (closesOuterGrantAt(wrapped, wrapped.length - 1)) validation = wrapped.slice(1, -1);
  }
  return validation;
};

const assertOrdinaryRuleDenied = (assert, expression, label) => {
  for (const auth of [null, { uid: 'ordinary', token: {} },
    { uid: 'ordinary', token: { admin: true, lltSessionIssuer: true, firebase: { sign_in_second_factor: 'totp' } } }]) {
    assert.equal(typeof expression === 'boolean' ? expression : Function('auth', `return (${expression});`)(auth), false, label);
  }
};
module.exports = { unwrapReviewedAuthorityConstraints, unwrapReviewedServerReadGrant, unwrapReviewedServerValidation, assertOrdinaryRuleDenied };
