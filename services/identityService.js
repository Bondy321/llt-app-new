const resolveTrimmedString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const REALTIME_KEY_INVALID_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/;
const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;

const isRealtimeKeySegment = (value) => {
  const trimmed = resolveTrimmedString(value);
  return Boolean(trimmed && !REALTIME_KEY_INVALID_PATTERN.test(trimmed));
};

const toRealtimeKeySegment = (value) => {
  const trimmed = resolveTrimmedString(value);
  if (!trimmed) return null;

  return trimmed.replace(
    REALTIME_KEY_INVALID_GLOBAL_PATTERN,
    (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`,
  );
};

const resolveRealtimeActorId = ({ authUid = null, principalId = null } = {}) => {
  const normalizedAuthUid = resolveTrimmedString(authUid);
  if (isRealtimeKeySegment(normalizedAuthUid)) {
    return normalizedAuthUid;
  }

  const normalizedPrincipalId = resolveTrimmedString(principalId);
  if (!normalizedPrincipalId) {
    return null;
  }

  return isRealtimeKeySegment(normalizedPrincipalId)
    ? normalizedPrincipalId
    : toRealtimeKeySegment(normalizedPrincipalId);
};

const resolveDriverId = ({ bookingData = {}, identityBinding = {} } = {}) => (
  resolveTrimmedString(bookingData?.driverId)
  || resolveTrimmedString(bookingData?.id)
  || resolveTrimmedString(identityBinding?.driverId)
);

const resolveStablePassengerId = ({ bookingData = {}, identityBinding = {} } = {}) => (
  resolveTrimmedString(identityBinding?.stablePassengerId)
  || resolveTrimmedString(bookingData?.stablePassengerId)
);

const isDriverIdentity = ({ bookingData = {}, identityBinding = {} } = {}) => {
  if (bookingData?.isDriver === true) return true;

  const bookingId = resolveTrimmedString(bookingData?.id);
  if (bookingId && bookingId.toUpperCase().startsWith('D-')) return true;

  const bindingType = resolveTrimmedString(identityBinding?.principalType);
  return bindingType === 'driver';
};

const getCanonicalIdentity = ({ authUser = null, bookingData = {}, identityBinding = {} } = {}) => {
  const authUid = resolveTrimmedString(authUser?.uid);
  const driverIdentity = isDriverIdentity({ bookingData, identityBinding });

  if (driverIdentity) {
    const driverId = resolveDriverId({ bookingData, identityBinding });
    const principalId = driverId ? `driver:${driverId}` : (authUid || 'anonymous');
    return {
      principalId,
      principalType: 'driver',
      authUid,
      driverId: driverId || null,
      stablePassengerId: null,
    };
  }

  const stablePassengerId = resolveStablePassengerId({ bookingData, identityBinding });
  const principalId = stablePassengerId || authUid || resolveTrimmedString(bookingData?.id) || 'anonymous';

  return {
    principalId,
    principalType: stablePassengerId ? 'passenger' : 'anonymous',
    authUid,
    driverId: null,
    stablePassengerId,
  };
};

const resolveAuthScopedUserId = ({ canonicalIdentity = null, authUser = null } = {}) => {
  const canonicalAuthUid = resolveTrimmedString(canonicalIdentity?.authUid);
  if (canonicalAuthUid) {
    return canonicalAuthUid;
  }

  return resolveTrimmedString(authUser?.uid);
};

module.exports = {
  getCanonicalIdentity,
  resolveAuthScopedUserId,
  resolveRealtimeActorId,
  isRealtimeKeySegment,
  toRealtimeKeySegment,
};
