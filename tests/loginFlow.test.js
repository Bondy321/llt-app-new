const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OFFLINE_LOGIN_REASON_COPY,
  LOGIN_PRIMARY_LAYOUT_KEYS,
  LOGIN_SUCCESS_INTERSTITIAL_MS,
  getLoginTransitionDurationMs,
  normalizeLoginFields,
  getLoginInputError,
  createOfflineErrorState,
  getReferencePlaceholder,
  shouldShowEmailField,
  resolveLoginIdentity,
} = require('../screens/loginFlow');

test('login screen primary layout remains minimal by default', () => {
  assert.deepEqual(LOGIN_PRIMARY_LAYOUT_KEYS, ['code_input', 'primary_cta', 'mode_hints']);
});

test('login transition interstitial uses expected timing window', () => {
  assert.equal(LOGIN_SUCCESS_INTERSTITIAL_MS >= 1000 && LOGIN_SUCCESS_INTERSTITIAL_MS <= 2000, true);
  assert.equal(getLoginTransitionDurationMs({ alreadyHydrated: false }), LOGIN_SUCCESS_INTERSTITIAL_MS);
  assert.equal(getLoginTransitionDurationMs({ alreadyHydrated: true }) < LOGIN_SUCCESS_INTERSTITIAL_MS, true);
});

test('passenger submit with blank email blocks before validation call', () => {
  const normalized = normalizeLoginFields({ bookingReference: 'abc123', email: '   ' });
  const inputError = getLoginInputError(normalized, { phase: 'submit' });

  assert.equal(inputError, 'Please enter the booking email used for this reservation.');
});

test('driver submit does not require email', () => {
  const normalized = normalizeLoginFields({ bookingReference: 'd-bondy', email: '   ' });
  const inputError = getLoginInputError(normalized, { phase: 'submit' });

  assert.equal(normalized.isDriverCode, true);
  assert.equal(inputError, null);
});

test('email format validation does not flash pre-submit while typing', () => {
  const normalized = normalizeLoginFields({ bookingReference: 'abc123', email: 'invalid' });
  assert.equal(getLoginInputError(normalized, { phase: 'blur', emailTouched: false }), null);
  assert.equal(getLoginInputError(normalized, { phase: 'blur', emailTouched: true }), 'Please enter a valid booking email (for example, name@example.com).');
  assert.equal(getLoginInputError(normalized, { phase: 'submit' }), 'Please enter a valid booking email (for example, name@example.com).');
});

test('normalizeLoginFields trims and lowercases passenger email before validation', () => {
  const normalized = normalizeLoginFields({
    bookingReference: ' abc123 ',
    email: '  Passenger@Example.com  ',
  });

  assert.equal(normalized.trimmedReference, 'abc123');
  assert.equal(normalized.normalizedReference, 'ABC123');
  assert.equal(normalized.normalizedEmail, 'passenger@example.com');
  assert.equal(getLoginInputError(normalized, { phase: 'submit' }), null);
});

test('offline rejection uses headline-first copy and progressive recovery steps', () => {
  const state = createOfflineErrorState({ reason: 'EMAIL_MISMATCH' }, (message, options = {}) => ({ message, ...options }));

  assert.equal(state.message, OFFLINE_LOGIN_REASON_COPY.EMAIL_MISMATCH.headline);
  assert.equal(Array.isArray(state.recoverySteps), true);
  assert.equal(state.recoverySteps.length > 0, true);
});

test('mode hint placeholder and field visibility behavior follow focused hints', () => {
  assert.equal(getReferencePlaceholder('driver').includes('D-'), true);
  assert.equal(shouldShowEmailField({ modeHintFocus: 'driver', normalizedReference: 'D-BONDY' }), false);
  assert.equal(shouldShowEmailField({ modeHintFocus: 'passenger', normalizedReference: '' }), true);
});

test('login success resolves normalized booking reference and identity payload', () => {
  const normalized = normalizeLoginFields({ bookingReference: ' abc123 ', email: 'Passenger@Example.com' });
  const result = {
    valid: true,
    type: 'passenger',
    booking: { id: 'ABC123', name: 'Passenger One' },
  };

  assert.equal(normalized.normalizedReference, 'ABC123');
  assert.deepEqual(resolveLoginIdentity(result), { id: 'ABC123', name: 'Passenger One' });
});
