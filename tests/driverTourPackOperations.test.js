const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDriverTourPackActionProjectionUpdates,
  buildDriverTourPackProgress,
  changedSectionNames,
  summarizeDriverTourPackChange,
} = require('../functions/lib/driverTourPackOperations');

const basePack = () => ({
  departureKey: '2026-09-10::5001D_1',
  tourId: '5001D_1',
  status: 'active',
  revision: 4,
  tour: { endDateISO: '2026-09-11', days: 2 },
  pickups: { p1: { dateISO: '2026-09-10', time: '08:00', name: 'Glasgow', address: 'Station', sequence: 0 } },
  passengers: {}, seats: {},
  timeline: { e1: { type: 'pickup', dateISO: '2026-09-10', time: '08:00', sequence: 0 } },
  hotels: { h1: { arrivalDateISO: '2026-09-10', nights: '1' } },
  services: { s1: { dateISO: '2026-09-10', time: '14:00' } },
  coach: {}, contacts: {}, itineraries: {}, coverage: {}, quality: {},
});

test('semantic change summary ignores publication metadata and classifies timing changes as critical', () => {
  const before = basePack();
  const metadataOnly = { ...before, publishedAtMs: 20, generatedAtMs: 10, expiresAtMs: 30 };
  assert.deepEqual(changedSectionNames(before, metadataOnly), []);
  assert.equal(summarizeDriverTourPackChange(before, metadataOnly), null);

  const after = basePack();
  after.revision = 5;
  after.pickups = { p1: { ...after.pickups.p1, time: '08:30' } };
  const summary = summarizeDriverTourPackChange(before, after, { eventId: 'event-1', createdAtMs: 123 });
  assert.deepEqual(summary.changedSections, ['pickups']);
  assert.equal(summary.critical, true);
  assert.equal(summary.requiresAcknowledgement, true);
  assert.equal(summary.previousRevision, 4);
  assert.equal(summary.revision, 5);
});

test('non-timing content changes notify without forcing critical acknowledgement', () => {
  const before = basePack();
  const after = basePack();
  after.revision = 5;
  after.itineraries = { client: { title: 'Plan', text: 'Updated detail' } };
  const summary = summarizeDriverTourPackChange(before, after, { createdAtMs: 456 });
  assert.deepEqual(summary.changedSections, ['itineraries']);
  assert.equal(summary.critical, false);
  assert.equal(summary.requiresAcknowledgement, false);
});

test('progress projection contains aggregates only and indexes structured issues', () => {
  const pack = basePack();
  const actions = {
    updatedAtMs: 500,
    revisionAcknowledged: 4,
    pickupStops: { p1: { state: 'COMPLETED' } },
    serviceCompletion: { s1: { state: 'SKIPPED' } },
    hotelCompletion: { h1: { state: 'COMPLETED' } },
    issues: {
      issue_safe: {
        category: 'vehicle', severity: 'critical', status: 'open', summary: 'Warning light is on',
        revision: 4, createdAtMs: 400, updatedAtMs: 400,
      },
    },
  };
  const progress = buildDriverTourPackProgress({
    departureKey: pack.departureKey, driverId: 'D-ONE', pack, actions, updatedAtMs: 600,
  });
  assert.deepEqual(progress, {
    schemaVersion: 1, departureKey: pack.departureKey, tourId: pack.tourId, driverId: 'D-ONE',
    packRevision: 4, revisionAcknowledged: 4, acknowledgementCurrent: true,
    pickupTotal: 1, pickupArrived: 0, pickupCompleted: 1, pickupSkipped: 0,
    serviceTotal: 1, serviceCompleted: 0, serviceSkipped: 1,
    hotelTotal: 1, hotelCompleted: 1, hotelSkipped: 0,
    openIssueCount: 1, criticalIssueCount: 1, updatedAtMs: 600,
  });
  assert.equal(JSON.stringify(progress).includes('Warning light'), false);

  const updates = buildDriverTourPackActionProjectionUpdates({
    departureKey: pack.departureKey,
    driverId: 'D-ONE',
    pack,
    beforeActions: {},
    afterActions: actions,
    updatedAtMs: 600,
  });
  assert.equal(updates[`driver_tour_pack_issues/issue_safe`].summary, undefined);
  assert.equal(updates[`driver_tour_pack_issues/issue_safe`].departureKey, pack.departureKey);
  assert.equal(JSON.stringify(updates[`driver_tour_pack_issues/issue_safe`]).includes('Warning light'), false);
});

test('action projection removes progress and issue indexes with action deletion', () => {
  const pack = basePack();
  const updates = buildDriverTourPackActionProjectionUpdates({
    departureKey: pack.departureKey,
    driverId: 'D-ONE',
    pack,
    beforeActions: { issues: { old_issue: { summary: 'Old' } } },
    afterActions: null,
  });
  assert.equal(updates[`driver_tour_pack_progress/${pack.departureKey}/D-ONE`], null);
  assert.equal(updates['driver_tour_pack_issues/old_issue'], null);
});
