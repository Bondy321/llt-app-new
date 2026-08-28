'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require(path.resolve(__dirname, '../../database.rules.json')).rules;

const EXPECTED_DRIVER_BRANCH_WRITERS = [
  'chats/$tourId/lastRead/$principalId/.write',
  'chats/$tourId/messages/$messageId/.write',
  'chats/$tourId/messages/$messageId/reactions/$emoji/$id/.write',
  'chats/$tourId/presence/$id/.write',
  'chats/$tourId/typing/$id/.write',
  'chat_presence_sessions/$scope/$appSessionId/.write',
  'chat_typing_sessions/$scope/$appSessionId/.write',
  'content_reports/$reportId/.write',
  'driver_location_sessions/$sourceKey/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/hotelCompletion/$hotelId/state/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/hotelCompletion/$hotelId/updatedAtMs/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/category/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/createdAtMs/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/issueId/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/revision/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/schemaVersion/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/severity/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/status/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/statusUpdatedAtMs/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/statusUpdatedBy/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/summary/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/issues/$issueId/updatedAtMs/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/packRevision/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/pickupStops/$pickupId/state/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/pickupStops/$pickupId/updatedAtMs/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/revisionAcknowledged/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/schemaVersion/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/serviceCompletion/$serviceId/state/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/serviceCompletion/$serviceId/updatedAtMs/.write',
  'driver_tour_pack_actions/$departureKey/$driverId/updatedAtMs/.write',
  'drivers/$driverId/authUid/.write',
  'drivers/$driverId/lastActive/.write',
  'group_tour_photos/$tourId/$photoId/caption/.write',
  'group_tour_photos/$tourId/$photoId/captionEditedBy/.write',
  'group_tour_photos/$tourId/$photoId/captionUpdatedAt/.write',
  'internal_chats/$tourId/lastRead/$principalId/.write',
  'internal_chats/$tourId/messages/$messageId/.write',
  'internal_chats/$tourId/presence/$id/.write',
  'internal_chats/$tourId/typing/$id/.write',
  'notification_read_state/$tourId/$principalId/$noticeId/.write',
  'tour_manifests/$tourId/bookings/$bookingRef/.write',
  'tours/$tourId/driverLocation/.write',
  'tours/$tourId/driver_itinerary/.write',
  'tours/$tourId/itinerary/.write',
  'tours/$tourId/liveTracking/$userId/.write',
].sort();

const getRuleAtPath = (rulePath) => rulePath
  .split('/')
  .reduce((node, segment) => node?.[segment], rules);

const collectReviewedDriverBranchWriters = () => EXPECTED_DRIVER_BRANCH_WRITERS.map((rulePath) => ({
  path: rulePath,
  expression: getRuleAtPath(rulePath),
}));

test('explicit inventory resolves every reviewed driver-branch write authority', () => {
  const found = collectReviewedDriverBranchWriters();
  assert.equal(found.length, 45, 'driver branch inventory changed without an authority review');
  for (const { path: rulePath, expression } of found) {
    assert.equal(typeof expression, 'string', `${rulePath} is missing from the explicit driver branch inventory`);
  }
});

test('every driver branch directly binds complete active-session authority', () => {
  const requiredFragments = [
    "auth != null",
    "app_sessions/' + auth.uid + '/status').val() === 'active'",
    "app_sessions/' + auth.uid + '/authUid').val() === auth.uid",
    "app_sessions/' + auth.uid + '/principalType').val() === 'driver'",
    "app_sessions/' + auth.uid + '/expiresAtMs').val() > now",
    "app_sessions/' + auth.uid + '/driverId').isString()",
    "users/' + auth.uid + '/driverId').isString()",
    "users/' + auth.uid + '/driverId').val() === root.child('app_sessions/' + auth.uid + '/driverId').val()",
    "app_sessions/' + auth.uid + '/tourId')",
    "driver_login_policy/v1/schemaVersion').val() === 1",
    "driverLoginPolicyGeneration').val() === root.child('driver_login_policy/v1/generation').val()",
    "/authUid').val() === auth.uid",
    "tour_manifests/",
    "assigned_drivers/",
  ];

  for (const { path: rulePath, expression } of collectReviewedDriverBranchWriters()) {
    for (const fragment of requiredFragments) {
      assert.ok(expression.includes(fragment), `${rulePath} omits required driver authority: ${fragment}`);
    }
    assert.match(expression, /root\.child\('drivers\/'[^;]+\.exists\(\)/, `${rulePath} must require a valid driver record`);
  }
});

test('every driver session write requires strict policy authority and no active assignment transition', () => {
  const found = collectReviewedDriverBranchWriters();
  assert.equal(found.length, 45, 'driver write inventory changed without a strict-policy review');

  const requiredFragments = [
    "driver_login_policy/v1/schemaVersion').val() === 1",
    "driver_login_policy/v1/enforceSingleDevice').isBoolean()",
    "driver_login_policy/v1/generation').isNumber()",
    "driver_login_policy/v1/generation').val() >= 0",
    "app_sessions/' + auth.uid + '/driverLoginPolicyGeneration').val() === root.child('driver_login_policy/v1/generation').val()",
  ];
  const forbiddenFragments = [
    "!root.child('driver_login_policy/v1').exists()",
    "!root.child('app_sessions/' + auth.uid + '/driverLoginPolicyGeneration').exists()",
  ];
  const assignmentFenceFragments = [
    "!root.child('driver_assignment_active/v1').child($driverId).child('transitionId').exists()",
    "!root.child('driver_assignment_active/v1').child(root.child('app_sessions/' + auth.uid + '/driverId').val()).child('transitionId').exists()",
  ];

  for (const { path: rulePath, expression } of found) {
    for (const fragment of requiredFragments) {
      assert.ok(expression.includes(fragment), `${rulePath} omits strict driver policy authority: ${fragment}`);
    }
    for (const fragment of forbiddenFragments) {
      assert.ok(!expression.includes(fragment), `${rulePath} retains legacy policy compatibility: ${fragment}`);
    }
    const matchingFences = assignmentFenceFragments.filter((fragment) => expression.includes(fragment));
    assert.equal(
      matchingFences.length,
      1,
      `${rulePath} must fence its exact driver while driver_assignment_active/v1/{driverId}/transitionId exists`,
    );
  }
});

test('legacy projection writes are gated only by explicit rollout while raw cleanup queries stay indexed', () => {
  assert.equal(rules.tours['.write'], false);
  assert.equal(typeof rules.tours.$tourId['.write'], 'string');
  assert.ok(rules.tours.$tourId['.write'].includes("newData.child('driverLocation').val() === data.child('driverLocation').val()"));
  assert.equal(rules.chats['.write'], false);
  assert.equal(rules.internal_chats['.write'], false);
  assert.equal(rules.driver_location_projection_state['.write'], false);
  assert.equal(rules.chat_status_projection_state['.write'], false);

  for (const projectionRule of [
    rules.tours.$tourId.driverLocation,
    rules.chats.$tourId.typing.$id,
    rules.chats.$tourId.presence.$id,
    rules.internal_chats.$tourId.typing.$id,
    rules.internal_chats.$tourId.presence.$id,
  ]) {
    assert.equal(typeof projectionRule['.write'], 'string');
    assert.ok(!projectionRule['.write'].includes("!data.child('projectionRevision').exists()"));
    assert.ok(projectionRule['.write'].includes("!root.child('live_state_rollout/v1').exists()"));
    assert.ok(projectionRule['.write'].includes("live_state_rollout/v1/phase').val() === 'compatibility'"));
    assert.ok(projectionRule['.validate'].includes("!newData.child('projectionRevision').exists()"));
  }

  assert.deepEqual(rules.driver_location_sessions['.indexOn'], ['cleanupAtMs', 'tourId', 'appSessionId']);
  assert.equal(rules.driver_location_pickups['.write'], false);
  assert.equal(rules.driver_location_pickups.$tourId['.write'], false);
  assert.deepEqual(rules.driver_location_pickups['.indexOn'], ['expiresAtMs']);
  assert.ok(rules.driver_location_pickups.$tourId['.validate'].includes("newData.child('assignmentRevision').isNumber()"));
  assert.ok(rules.driver_location_pickups.$tourId['.validate'].includes("!newData.child('authUid').exists()"));
  assert.ok(rules.driver_location_pickups.$tourId['.validate'].includes("!newData.child('appSessionId').exists()"));
  assert.deepEqual(rules.chat_presence_sessions.$scope['.indexOn'], ['tourActorKey', 'expiresAtMs']);
  assert.deepEqual(rules.chat_typing_sessions.$scope['.indexOn'], ['tourActorKey', 'expiresAtMs']);

  const liveLocationValidation = rules.driver_location_sessions.$sourceKey['.validate'];
  assert.match(liveLocationValidation, /hasChildren\(\[[^\]]*'accuracy'[^\]]*\]\)/);
  assert.ok(liveLocationValidation.includes("newData.child('accuracy').isNumber()"));
  assert.ok(!liveLocationValidation.includes("!newData.child('accuracy').exists()"));
});

test('driver login and assignment coordination roots are explicit server-only contracts', () => {
  const unindexedPrivateRoots = [
    'driver_login_claim_reservations',
    'driver_assignment_locks',
    'driver_assignment_idempotency',
    'driver_assignment_transition_queue',
    'driver_assignment_active',
  ];
  for (const rootName of unindexedPrivateRoots) {
    assert.equal(rules[rootName]['.read'], false, `${rootName} must remain client-private`);
    assert.equal(rules[rootName]['.write'], false, `${rootName} must remain server-owned`);
    assert.equal(rules[rootName]['.indexOn'], undefined, `${rootName} has no scheduled child query`);
  }

  for (const rootName of ['driver_assignment_transitions', 'driver_assignment_retention']) {
    assert.equal(rules[rootName]['.read'], false, `${rootName} must remain client-private`);
    assert.equal(rules[rootName]['.write'], false, `${rootName} must remain server-owned`);
    assert.deepEqual(rules[rootName].v1['.indexOn'], ['expiresAtMs']);
  }

  assert.equal(rules.app_session_role_claim_jobs['.read'], false);
  assert.equal(rules.app_session_role_claim_jobs['.write'], false);
  assert.deepEqual(rules.app_session_role_claim_jobs.v1['.indexOn'], ['createdAtMs', 'expiresAtMs']);
});

test('canonical assignment fields have no granting client ancestor or leaf', () => {
  assert.equal(rules.drivers['.write'], false);
  assert.equal(rules.tour_manifests['.write'], false);
  assert.equal(rules.users['.write'], false);

  const driverParentWrite = rules.drivers.$driverId['.write'];
  assert.equal(typeof driverParentWrite, 'string');
  for (const field of ['currentTourId', 'currentTourCode', 'assignments', 'assignmentRevision']) {
    assert.ok(
      driverParentWrite.includes(`newData.child('${field}').val() === data.child('${field}').val()`),
      `safe driver profile writes must preserve ${field}`,
    );
  }

  const userParentWrite = rules.users.$userId['.write'];
  assert.equal(typeof userParentWrite, 'string');
  assert.ok(userParentWrite.includes("newData.child('driverAssignedTourId').val() === data.child('driverAssignedTourId').val()"));

  const tourParentWrite = rules.tours.$tourId['.write'];
  for (const field of ['driverId', 'driverName', 'driverPhone', 'driverAssignmentRevision']) {
    assert.ok(
      tourParentWrite.includes(`newData.child('${field}').val() === data.child('${field}').val()`),
      `safe tour metadata writes must preserve ${field}`,
    );
  }

  for (const rule of [
    rules.tours.$tourId.driverName,
    rules.tours.$tourId.driverPhone,
    rules.tours.$tourId.driverId,
    rules.tour_manifests.$tourId.assigned_drivers.$driverId,
    rules.tour_manifests.$tourId.assigned_driver_codes.$driverId,
    rules.users.$userId.driverAssignedTourId,
  ]) {
    assert.equal(rule['.write'], false);
  }
});

test('normal web clients contain no direct canonical assignment update map', () => {
  const root = path.resolve(__dirname, '../..');
  const assignmentService = fs.readFileSync(
    path.join(root, 'web-admin/src/features/tours/data/tourDriverAssignmentService.js'),
    'utf8',
  );
  const driverPanel = fs.readFileSync(
    path.join(root, 'web-admin/src/features/drivers/components/driverManagementPanels.jsx'),
    'utf8',
  );
  const publicTourService = fs.readFileSync(path.join(root, 'web-admin/src/services/tourService.js'), 'utf8');

  for (const source of [assignmentService, driverPanel]) {
    assert.doesNotMatch(source, /`tours\/\$\{[^}]+\}\/driver(?:Id|Name|Phone|AssignmentRevision)`/);
    assert.doesNotMatch(source, /`drivers\/\$\{[^}]+\}\/(?:currentTourId|currentTourCode|assignments|assignmentRevision)/);
    assert.doesNotMatch(source, /`tour_manifests\/\$\{[^}]+\}\/assigned_driver/);
    assert.doesNotMatch(source, /`users\/\$\{[^}]+\}\/driverAssignedTourId`/);
  }
  assert.doesNotMatch(publicTourService, /buildDriverAssignmentUpdates/);
});

test('live-state rollout and terminal warnings are explicit server-owned contracts', () => {
  assert.equal(rules.live_state_rollout['.read'], false);
  assert.equal(rules.live_state_rollout['.write'], false);
  assert.equal(rules.operations_terminal_warnings['.write'], false);
  assert.equal(typeof rules.operations_terminal_warnings['.read'], 'string');
  assert.deepEqual(
    rules.operations_terminal_warnings.v1['.indexOn'],
    ['status', 'jobType', 'retainUntilMs', 'createdAtMs'],
  );

  for (const projectionRule of [
    rules.tours.$tourId.driverLocation,
    rules.chats.$tourId.typing.$id,
    rules.chats.$tourId.presence.$id,
    rules.internal_chats.$tourId.typing.$id,
    rules.internal_chats.$tourId.presence.$id,
  ]) {
    assert.ok(projectionRule['.write'].includes("!root.child('live_state_rollout/v1').exists()"));
    assert.ok(projectionRule['.write'].includes("live_state_rollout/v1/phase').val() === 'compatibility'"));
  }
});
