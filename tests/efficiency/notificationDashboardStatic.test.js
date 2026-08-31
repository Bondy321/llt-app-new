'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('notification worker delegates discovery to the explicit scoped enumerator', () => {
  const worker = read('functions/src/domains/notifications/notificationWorker.js');
  const enumerators = read('functions/src/domains/notifications/notificationAudienceEnumerators.js');

  assert.match(worker, /enumerateNotificationAudiencePage\(\{\s*db,\s*job,/u);
  assert.doesNotMatch(worker, /loadNotificationAudiencePage\(/u);
  assert.match(enumerators, /orderByChild\('operationalTourId'\)/u);
  assert.match(enumerators, /notification_devices\/\$\{authUid\}/u);
  assert.match(enumerators, /limitToFirst\(pageSize \+ 1\)/u);
  assert.match(enumerators, /mapWithBoundedConcurrency/u);
});

test('indexed notification delivery retains canonical authority rereads', () => {
  const authority = read('functions/src/domains/notifications/notificationAudiencePage.js');

  for (const requiredPath of [
    'notification_devices/${authUid}',
    'notification_device_tombstones/${authUid}',
    'notification_consents/${authUid}',
    'app_sessions/${authUid}',
    'tours/${tourId}/participants/${authUid}',
    'tour_manifests/${tourId}/assigned_drivers',
  ]) {
    assert.match(authority, new RegExp(requiredPath.replace(/[${}]/g, '\\$&'), 'u'));
  }
});

test('projection mode is composed only from hard-bounded projection queries', () => {
  const projectionService = read('web-admin/src/services/dashboardProjectionService.js');
  const dashboard = read('web-admin/src/components/Dashboard.jsx');

  assert.match(projectionService, /DASHBOARD_TOUR_LIMIT\s*=\s*500/u);
  assert.match(projectionService, /limitToFirst\(plan\.limitToFirst\)/u);
  assert.match(projectionService, /limitToLast\(plan\.limitToLast\)/u);
  assert.doesNotMatch(projectionService, /ref\(database,\s*['"](?:tours|tour_manifests|drivers|broadcasts|globalSafetyAlerts)['"]\)/u);
  assert.match(dashboard, /rolloutPhase === 'legacy' \|\| rolloutPhase === 'shadow'/u);
  assert.match(dashboard, /rolloutPhase === 'projection' \|\| rolloutPhase === 'shadow'/u);
});

test('common projection triggers are leaf scoped rather than whole-root projectors', () => {
  const functions = read('functions/src/domains/admin-dashboard/dashboardProjectionFunctions.js');

  for (const expectedPath of [
    '/tour_manifests/{tourId}/bookings/{bookingRef}',
    '/tour_manifests/{tourId}/assigned_drivers/{driverId}',
    '/tour_manifests/{tourId}/assigned_driver_codes/{driverId}',
    '/tours/{tourId}/participants/{authUid}',
    '/tours/{tourId}/safetyAlerts/{eventId}',
    '/broadcasts/{tourId}/{broadcastId}',
  ]) {
    assert.ok(functions.includes(expectedPath), `missing narrow trigger ${expectedPath}`);
  }
  assert.doesNotMatch(functions, /ref:\s*['"]\/(?:tours|tour_manifests|drivers|broadcasts|globalSafetyAlerts)['"]/u);
});

test('new high-cardinality paths do not create unbounded Promise.all work', () => {
  const sources = [
    'functions/src/domains/notifications/notificationAudienceEnumerators.js',
    'functions/src/domains/notifications/notificationMarketingAudience.js',
    'functions/src/domains/notifications/notificationMarketingAudienceProjection.js',
    'functions/src/domains/admin-dashboard/dashboardProjectionFunctions.js',
    'web-admin/src/services/dashboardProjectionService.js',
  ].map(read).join('\n');

  assert.doesNotMatch(
    sources,
    /Promise\.all\(\s*(?:candidates|devices|users|tours|drivers|bookings|records|items)\.map\(/u,
  );
});
