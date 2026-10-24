'use strict';

// Explicit fixture preparation only: adapters never manufacture missing authority
// during reads, so tests can subsequently revoke/delete any individual root.
const withApprovedStaffSessions = initial => {
  const state = structuredClone(initial);
  for (const [uid, session] of Object.entries(state.app_sessions || {})) {
    if (session.principalType !== 'driver') continue;
    const generation = 'c'.repeat(48);
    state.driver_staff_policy ||= {};
    state.driver_staff_policy[session.driverId] = { schemaVersion: 1, generation };
    state.driver_device_authorizations ||= {};
    state.driver_device_authorizations[uid] = { schemaVersion: 1, state: 'active',
      driverId: session.driverId, sessionId: session.sessionId, generation };
    state.app_session_authority ||= {};
    state.app_session_authority[uid] = { schemaVersion: 1, state: 'committed',
      epoch: 'd'.repeat(48), sessionId: session.sessionId };
  }
  return state;
};

module.exports = { withApprovedStaffSessions };
