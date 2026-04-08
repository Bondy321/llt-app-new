const resolveTrimmedString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
};
