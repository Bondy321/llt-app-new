'use strict';

// A revision orders changes within one installation/session/principal. It never
// authorizes adopting another session or moving a passenger to another tour.
const sameSessionIdentity = (left, right) => Boolean(left && right
  && left.sessionId === right.sessionId && left.principalId === right.principalId
  && left.principalType === right.principalType && left.driverId === right.driverId
  && left.issuedAtMs === right.issuedAtMs);

const classifySessionTransition = (expected, next, { allowDriverAssignment = false } = {}) => {
  if (!sameSessionIdentity(expected, next)) return 'invalid';
  if (next.sessionRevision < expected.sessionRevision) return 'stale';
  const sameAssignment = next.tourId === expected.tourId;
  if (next.sessionRevision === expected.sessionRevision) {
    return sameAssignment && next.expiresAtMs === expected.expiresAtMs ? 'duplicate' : 'invalid';
  }
  if (!sameAssignment && !(allowDriverAssignment && next.principalType === 'driver')) return 'invalid';
  return 'advance';
};

const sessionOwnsScope = (session, scope) => Boolean(session && scope
  && session.sessionId === scope.sessionId && session.principalType === scope.role
  && session.principalId === scope.principalId && session.tourId === scope.tourId);

module.exports = { sameSessionIdentity, classifySessionTransition, sessionOwnsScope };
