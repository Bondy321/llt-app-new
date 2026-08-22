const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMigrationUpdates, parseArgs } = require('../functions/scripts/backfillDriverTourPackIssueProjections');
const { buildDriverTourPackIssueProjectionId } = require('../functions/lib/driverTourPackOperations');

test('issue migration creates composite projections and removes only matching legacy collisions', async () => {
  const departureKey = '2026-09-10::TOUR_A';
  const pack = { departureKey, tourId: 'TOUR_A', revision: 1, pickups: {}, services: {}, hotels: {} };
  const issue = { category: 'delay', severity: 'critical', status: 'open', summary: 'Delay', revision: 1, createdAtMs: 10, updatedAtMs: 20 };
  const updates = await buildMigrationUpdates({
    actions: { [departureKey]: { 'D-ONE': { issues: { issue_001: issue } } } },
    packs: { [departureKey]: pack },
    legacyIssues: { issue_001: { issueId: 'issue_001', departureKey, driverId: 'D-ONE' }, issue_002: { issueId: 'issue_002', departureKey: 'OTHER', driverId: 'D-TWO' } },
  });
  const projectionId = buildDriverTourPackIssueProjectionId({ departureKey, driverId: 'D-ONE', issueId: 'issue_001' });
  assert.equal(updates[`driver_tour_pack_issues/${projectionId}`].issueId, 'issue_001');
  assert.equal(updates['driver_tour_pack_issues/issue_001'], null);
  assert.equal(updates['driver_tour_pack_issues/issue_002'], undefined);
  assert.deepEqual(parseArgs([]), { apply: false, allowFullScan: false });
});
