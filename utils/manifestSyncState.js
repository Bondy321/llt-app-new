const VALID_SYNC_STATES = new Set(['queued', 'syncing', 'failed', 'synced']);

const normalizeSyncState = (value) => {
  if (typeof value !== 'string') return 'synced';
  const normalized = value.trim().toLowerCase();
  return VALID_SYNC_STATES.has(normalized) ? normalized : 'synced';
};

const getBookingSyncState = (bookingSyncState, bookingId) => {
  if (!bookingSyncState || !bookingId) return 'synced';
  return normalizeSyncState(bookingSyncState[bookingId]);
};

module.exports = {
  normalizeSyncState,
  getBookingSyncState,
};

