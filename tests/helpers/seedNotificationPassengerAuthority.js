'use strict';

// Positive notification fixtures model the same private booking authorization
// established by login. Negative tests revoke these records after fixture setup.
const seedNotificationPassengerAuthority = data => {
  for (const [uid, session] of Object.entries(data.app_sessions || {})) {
    if (session.principalType !== 'passenger') continue;
    data.users ||= {}; data.users[uid] ||= {}; data.bookings ||= {};
    const profile = data.users[uid];
    profile.bookingRef ??= `SYNTHETIC-${uid}`;
    profile.stablePassengerId ??= session.principalId;
    profile.identityVersion ??= 'pax_v2';
    profile.principalType ??= 'passenger';
    data.bookings[profile.bookingRef] ??= { tourId: session.tourId };
    data.passenger_identity_security ||= {};
    data.passenger_identity_security[profile.bookingRef] ??= { deviceAuthorizationVersion: 2,
      passengerPrincipalId: session.principalId, authorizedAuthUids: { [uid]: true } };
    const participant = data.tours?.[session.tourId]?.participants?.[uid];
    if (participant) participant.userId ??= uid;
  }
};

module.exports = { seedNotificationPassengerAuthority };
