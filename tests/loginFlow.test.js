const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OFFLINE_LOGIN_REASON_COPY,
  normalizeLoginFields,
  getLoginInputError,
  createOfflineErrorState,
  resolveLoginIdentity,
} = require('../screens/loginFlow');

test('passenger submit with blank email blocks before validation call', () => {
  const normalized = normalizeLoginFields({ bookingReference: 'abc123', email: '   ' });
  const inputError = getLoginInputError(normalized);

  assert.equal(inputError, 'Please enter the booking email used for this reservation.');
});

test('driver submit does not require email', () => {
  const normalized = normalizeLoginFields({ bookingReference: 'd-bondy', email: '   ' });
  const inputError = getLoginInputError(normalized);

  assert.equal(normalized.isDriverCode, true);
  assert.equal(inputError, null);
});

test('offline passenger login reason EMAIL_MISMATCH maps to inline error copy', () => {
  const state = createOfflineErrorState({ reason: 'EMAIL_MISMATCH' }, (message, options = {}) => ({ message, ...options }));

  assert.equal(state.message, OFFLINE_LOGIN_REASON_COPY.EMAIL_MISMATCH);
  assert.equal(state.reason, 'EMAIL_MISMATCH');
  assert.equal(state.showOfflineActions, true);
});

test('offline passenger login reason EMAIL_NOT_CACHED maps to inline error copy', () => {
  const state = createOfflineErrorState({ reason: 'EMAIL_NOT_CACHED' }, (message, options = {}) => ({ message, ...options }));

  assert.equal(state.message, OFFLINE_LOGIN_REASON_COPY.EMAIL_NOT_CACHED);
  assert.equal(state.reason, 'EMAIL_NOT_CACHED');
  assert.equal(state.showOfflineActions, true);
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
