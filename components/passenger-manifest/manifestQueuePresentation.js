const { normalizeSyncState } = require('../../utils/manifestSyncState');
const { normalizeTourId } = require('../../services/tourIdentityService');

export const summarizeManifestQueue = (actions, tourId) => {
  const scopedActions = actions.filter(action => action.type === 'MANIFEST_UPDATE' && normalizeTourId(action.tourId) === tourId);
  const stats = { pending: 0, syncing: 0, failed: 0, total: 0 };
  const statePriority = { synced: 0, queued: 1, syncing: 2, failed: 3 };
  const syncMap = {};
  for (const action of scopedActions) {
    if (action.status === 'syncing') stats.syncing += 1;
    else if (action.status === 'failed') stats.failed += 1;
    else stats.pending += 1;
    stats.total += 1;
    const bookingRef = action.payload?.bookingRef;
    if (!bookingRef) continue;
    const nextState = normalizeSyncState(action.status);
    const currentState = syncMap[bookingRef] || 'synced';
    if (statePriority[nextState] >= statePriority[currentState]) syncMap[bookingRef] = nextState;
  }
  return { stats, syncMap };
};
