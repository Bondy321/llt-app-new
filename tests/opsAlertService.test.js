const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOpsAlertFromCrashSnapshot,
  buildOpsAlertFromLog,
  mergeOpsAlertRecord,
  sanitizeOpsText,
} = require('../services/opsAlertService');

test('buildOpsAlertFromLog creates a sanitized critical alert without raw identifiers', () => {
  const alert = buildOpsAlertFromLog({
    timestamp: '2026-05-28T10:00:00.000Z',
    level: 'FATAL',
    component: 'LoginScreen',
    message: 'Failure for email jane@example.com token=abc123 session_1779960000_rawvalue',
    data: {
      error: 'authUid=QWERTYUIOPASDFGHJKLZXCVBNM12 bookingRef=LLT-12345',
      stack: 'Error: boom\n    at fn (bundle.js:1:2)',
      isFatal: true,
      tourId: '5112D_8',
      role: 'passenger',
    },
    routeUserId: 'QWERTYUIOPASDFGHJKLZXCVBNM12',
    routeSessionId: 'session_1779960000_rawvalue',
    deviceInfo: {
      platform: 'ios',
      version: '18.0',
      model: 'iPhone 16',
    },
  });

  assert.equal(alert.level, 'FATAL');
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.status, 'open');
  assert.equal(alert.tourId, '5112D_8');
  assert.equal(alert.role, 'passenger');
  assert.match(alert.fingerprint, /^opa_[a-z0-9]+$/);
  assert.doesNotMatch(alert.message, /jane@example\.com/);
  assert.doesNotMatch(alert.message, /abc123/);
  assert.doesNotMatch(alert.message, /session_1779960000_rawvalue/);
  assert.doesNotMatch(alert.summary, /QWERTYUIOPASDFGHJKLZXCVBNM12/);
  assert.doesNotMatch(alert.summary, /LLT-12345/);
  assert.doesNotMatch(alert.sessionKey, /session_1779960000_rawvalue/);
});

test('buildOpsAlertFromLog fingerprints repeated sanitized errors consistently', () => {
  const base = {
    timestamp: '2026-05-28T10:00:00.000Z',
    level: 'ERROR',
    component: 'TourHome',
    message: 'Network failure for userId=ABCDEFGHIJKLMNOPQRSTUVWX',
    data: {
      error: 'token=one',
      tourId: 'TOUR_1',
      role: 'driver',
    },
    routeUserId: 'ABCDEFGHIJKLMNOPQRSTUVWX',
    routeSessionId: 'session_1779960000_one',
    deviceInfo: {
      platform: 'android',
      version: '15',
      model: 'Pixel',
    },
  };

  const first = buildOpsAlertFromLog(base);
  const second = buildOpsAlertFromLog({
    ...base,
    timestamp: '2026-05-28T10:05:00.000Z',
    message: 'Network failure for userId=ZZZZZZZZZZZZZZZZZZZZZZZZ',
    data: {
      ...base.data,
      error: 'token=two',
    },
    routeSessionId: 'session_1779960300_two',
  });

  assert.equal(first.fingerprint, second.fingerprint);
});

test('mergeOpsAlertRecord increments counts and reopens resolved recurring alerts', () => {
  const current = {
    fingerprint: 'opa_existing',
    createdAt: '2026-05-28T09:00:00.000Z',
    createdAtMs: 1779958800000,
    lastSeenAt: '2026-05-28T09:00:00.000Z',
    lastSeenAtMs: 1779958800000,
    status: 'resolved',
    count: 2,
    resolvedAtMs: 1779959000000,
    statusUpdatedBy: 'admin',
  };
  const incoming = {
    fingerprint: 'opa_existing',
    createdAt: '2026-05-28T10:00:00.000Z',
    createdAtMs: 1779962400000,
    lastSeenAt: '2026-05-28T10:00:00.000Z',
    lastSeenAtMs: 1779962400000,
    status: 'open',
    count: 1,
  };

  const merged = mergeOpsAlertRecord(current, incoming);

  assert.equal(merged.count, 3);
  assert.equal(merged.status, 'open');
  assert.equal(merged.createdAtMs, current.createdAtMs);
  assert.equal(merged.lastSeenAtMs, incoming.lastSeenAtMs);
  assert.equal(merged.resolvedAtMs, current.resolvedAtMs);
  assert.equal(merged.reopenedAtMs, incoming.lastSeenAtMs);
});

test('buildOpsAlertFromCrashSnapshot summarizes breadcrumbs without raw stack output', () => {
  const alert = buildOpsAlertFromCrashSnapshot({
    reason: 'global_error',
    generatedAt: '2026-05-28T10:00:00.000Z',
    diagnosticsSessionId: { masked: 'di***ab', hash: 'abc123' },
    runtime: {
      platform: 'ios',
      platformVersion: '18.0',
      model: 'iPhone',
    },
    auth: {
      authUid: 'us***99',
    },
    context: {
      role: 'passenger',
      tourId: '5112D_8',
    },
    breadcrumbs: [
      { component: 'TourHome', event: 'refresh_started' },
      { component: 'GlobalError', event: 'unhandled_exception', data: { email: 'guest@example.com' } },
    ],
    extra: {
      error: {
        name: 'TypeError',
        message: 'Cannot read property authUid=ABCDEFGHIJKLMNOPQRSTUVWX',
        stack: 'TypeError: raw stack should be hashed only',
        isFatal: true,
      },
    },
  });

  assert.equal(alert.source, 'crash_diagnostics');
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.crashBreadcrumbSummary.count, 2);
  assert.match(alert.crashBreadcrumbSummary.latest, /GlobalError:unhandled_exception/);
  assert.doesNotMatch(JSON.stringify(alert), /raw stack should be hashed only/);
  assert.doesNotMatch(JSON.stringify(alert), /guest@example\.com/);
});

test('sanitizeOpsText redacts common secret and identity patterns', () => {
  const sanitized = sanitizeOpsText('email=a@example.com Bearer abc.def.ghi ExponentPushToken[abc] session_1_secret uid=ABCDEFGHIJKLMNOPQRSTUVWX');

  assert.doesNotMatch(sanitized, /a@example\.com/);
  assert.doesNotMatch(sanitized, /abc\.def\.ghi/);
  assert.doesNotMatch(sanitized, /ExponentPushToken/);
  assert.doesNotMatch(sanitized, /session_1_secret/);
  assert.doesNotMatch(sanitized, /ABCDEFGHIJKLMNOPQRSTUVWX/);
});
