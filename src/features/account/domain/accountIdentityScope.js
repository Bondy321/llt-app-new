const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;

const safeRealtimeKey = (value, fallback = 'anonymous') => {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const source = raw || fallback;
  return source.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`,
  );
};

const toRealtimeKeySegment = (value) => safeRealtimeKey(value, '').replace(/^_+|_+$/g, '');

const addIdentity = (set, value) => {
  if (typeof value !== 'string') return;
  const normalized = value.trim();
  if (normalized) set.add(normalized);
};

const collectIdentityValues = ({ authUid, canonicalIdentity, bookingData, identityBinding }) => {
  const identities = new Set();
  addIdentity(identities, authUid);
  addIdentity(identities, canonicalIdentity?.principalId);
  addIdentity(identities, canonicalIdentity?.stablePassengerId);
  addIdentity(identities, canonicalIdentity?.authUid);
  addIdentity(identities, bookingData?.stablePassengerId);
  addIdentity(identities, bookingData?.privatePhotoOwnerId);
  addIdentity(identities, identityBinding?.stablePassengerId);
  addIdentity(identities, identityBinding?.authUid);

  const driverId = typeof bookingData?.id === 'string' && bookingData.id.trim().toUpperCase().startsWith('D-')
    ? bookingData.id.trim().toUpperCase()
    : null;
  if (driverId) {
    addIdentity(identities, driverId);
    addIdentity(identities, `driver:${driverId}`);
  }
  return [...identities];
};

const collectPrivatePhotoOwnerIds = ({ canonicalIdentity, bookingData, identityBinding }) => {
  const ownerIds = new Set();
  addIdentity(ownerIds, canonicalIdentity?.stablePassengerId);
  addIdentity(ownerIds, bookingData?.stablePassengerId);
  addIdentity(ownerIds, bookingData?.privatePhotoOwnerId);
  addIdentity(ownerIds, identityBinding?.stablePassengerId);
  return [...ownerIds];
};

const getDriverId = (bookingData) => {
  const value = typeof bookingData?.id === 'string' ? bookingData.id.trim().toUpperCase() : '';
  return value.startsWith('D-') ? value : null;
};

const getPassengerBookingRef = (bookingData) => {
  const value = typeof bookingData?.id === 'string' ? bookingData.id.trim().toUpperCase() : '';
  return value && !value.startsWith('D-') ? safeRealtimeKey(value, '') : null;
};

module.exports = {
  addIdentity,
  collectIdentityValues,
  collectPrivatePhotoOwnerIds,
  getDriverId,
  getPassengerBookingRef,
  safeRealtimeKey,
  toRealtimeKeySegment,
};
