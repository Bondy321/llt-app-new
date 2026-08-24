'use strict';

const { createOpaquePassengerId, isOpaquePassengerId } = require('./passengerIdentity');

const LEGACY_ID_PATTERN = /^pax_v1:/;
const LEGACY_KEY_PATTERN = /^pax_v1:/;
const REWRITE_ROOTS = Object.freeze([
  'chats',
  'group_tour_photos',
  'private_tour_photos',
  'content_reports',
  'globalSafetyAlerts',
  'notification_read_state',
  'notification_read_migration_requests',
  'tours',
  'logs',
  'ops_alerts',
]);
const BOOKING_SECURITY_FIELDS = Object.freeze([
  'passengerPrincipalId',
  'passengerIdentityVersion',
  'passengerIdentityIssuedAtMs',
  'authorizedAuthUid',
  'loginDeviceBoundAtMs',
  'loginLocked',
  'loginLockReason',
]);

const encodeRealtimeKey = (value, { encodeAt = false } = {}) => String(value).replace(
  encodeAt ? /[.#$\/\[\]@\x00-\x1F\x7F]/g : /[.#$\/\[\]\x00-\x1F\x7F]/g,
  (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`,
);

const decodeRealtimeKey = (value) => String(value).replace(/_([0-9A-F]{2})_/gi, (_, hex) => (
  String.fromCharCode(Number.parseInt(hex, 16))
));

const extractLegacyIdentityCandidates = (value) => {
  const candidates = new Set();
  const collectCandidates = (text) => {
    String(text).split(/[\/\\?&#=]/).forEach((segment) => {
      if (!/pax_v1(?::|_)/i.test(segment)) return;
      const start = segment.search(/pax_v1(?::|_)/i);
      const suffix = segment.slice(start);
      candidates.add(suffix);
      candidates.add(suffix.replace(/\.(?:jpe?g|png|webp|heic)$/i, ''));
    });
  };
  collectCandidates(value);
  try {
    collectCandidates(decodeURIComponent(value));
  } catch (_) {
    // Malformed percent encoding is left for the final audit to reject.
  }
  return candidates;
};

const collectExactLegacyIdentities = (value, output = new Set()) => {
  if (typeof value === 'string') {
    extractLegacyIdentityCandidates(value).forEach((candidate) => output.add(candidate));
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectExactLegacyIdentities(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  Object.entries(value).forEach(([key, item]) => {
    extractLegacyIdentityCandidates(key).forEach((candidate) => output.add(candidate));
    collectExactLegacyIdentities(item, output);
  });
  return output;
};

const buildLegacyIdentityAliases = ({ bookingRef, email } = {}) => {
  const normalizedBookingRef = typeof bookingRef === 'string' ? bookingRef.trim().toUpperCase() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedBookingRef || !normalizedEmail) return [];
  const raw = `pax_v1:${normalizedBookingRef}:${normalizedEmail}`;
  return [...new Set([
    raw,
    encodeRealtimeKey(raw),
    encodeRealtimeKey(raw, { encodeAt: true }),
    raw.replace(/[^a-zA-Z0-9._-]/g, '_'),
  ])];
};

const buildIdentityPlan = ({
  bookingIdentities = {},
  passengerIdentitySecurity = {},
  createId = createOpaquePassengerId,
} = {}) => {
  const identities = {};
  const aliasMap = new Map();
  Object.entries(bookingIdentities || {}).forEach(([bookingKey, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const bookingRef = String(value.bookingRef || bookingKey || '').trim().toUpperCase();
    const existingSecurity = passengerIdentitySecurity?.[bookingKey];
    const opaqueId = isOpaquePassengerId(existingSecurity?.passengerPrincipalId)
      ? existingSecurity.passengerPrincipalId
      : (isOpaquePassengerId(value.passengerPrincipalId) ? value.passengerPrincipalId : createId());
    identities[bookingKey] = { bookingRef, opaqueId };
    buildLegacyIdentityAliases({ bookingRef, email: value.email }).forEach((alias) => {
      aliasMap.set(alias, opaqueId);
    });
  });
  return { identities, aliasMap };
};

const replaceIdentityText = (value, aliasMap) => {
  if (typeof value !== 'string') return value;
  if (aliasMap.has(value)) return aliasMap.get(value);
  if (!/pax_v1(?::|_|%3A)/i.test(value)) return value;
  const candidates = extractLegacyIdentityCandidates(value);
  let rewritten = value;
  for (const legacy of candidates) {
    const opaque = aliasMap.get(legacy);
    if (!opaque) continue;
    if (rewritten.includes(legacy)) rewritten = rewritten.split(legacy).join(opaque);
    const encodedLegacy = encodeURIComponent(legacy);
    if (rewritten.includes(encodedLegacy)) {
      rewritten = rewritten.split(encodedLegacy).join(encodeURIComponent(opaque));
    }
  }
  return rewritten;
};

const rewriteIdentityReferences = (value, aliasMap) => {
  if (typeof value === 'string') return replaceIdentityText(value, aliasMap);
  if (Array.isArray(value)) return value.map((item) => rewriteIdentityReferences(item, aliasMap));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    replaceIdentityText(key, aliasMap),
    rewriteIdentityReferences(item, aliasMap),
  ]));
};

const containsLegacyIdentity = (value) => {
  if (typeof value === 'string') return /pax_v1(?::|_|%3A)/i.test(value);
  if (Array.isArray(value)) return value.some(containsLegacyIdentity);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    LEGACY_KEY_PATTERN.test(key) || containsLegacyIdentity(key) || containsLegacyIdentity(item)
  ));
};

const buildDatabaseMigration = ({ snapshot = {}, nowMs = Date.now(), createId } = {}) => {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const issueOpaqueId = createId || createOpaquePassengerId;
  const { identities, aliasMap } = buildIdentityPlan({
    bookingIdentities: source.booking_identities,
    passengerIdentitySecurity: source.passenger_identity_security,
    createId: issueOpaqueId,
  });
  const discoveredLegacyIds = collectExactLegacyIdentities(source);
  const opaqueByCanonicalLegacyId = new Map();
  discoveredLegacyIds.forEach((legacyId) => {
    if (aliasMap.has(legacyId)) return;
    const decodedLegacyId = decodeRealtimeKey(legacyId);
    const canonicalLegacyId = LEGACY_ID_PATTERN.test(decodedLegacyId) ? decodedLegacyId : legacyId;
    const opaqueId = opaqueByCanonicalLegacyId.get(canonicalLegacyId) || issueOpaqueId();
    opaqueByCanonicalLegacyId.set(canonicalLegacyId, opaqueId);
    if (LEGACY_ID_PATTERN.test(decodedLegacyId)) {
      const separator = decodedLegacyId.indexOf(':', 'pax_v1:'.length);
      if (separator >= 0) {
        const bookingRef = decodedLegacyId.slice('pax_v1:'.length, separator);
        const email = decodedLegacyId.slice(separator + 1);
        if (bookingRef && email) {
          buildLegacyIdentityAliases({ bookingRef, email }).forEach((alias) => aliasMap.set(alias, opaqueId));
        }
      }
    }
    aliasMap.set(legacyId, opaqueId);
  });
  const next = { ...source };
  next.booking_identities = { ...(source.booking_identities || {}) };
  next.passenger_identity_security = { ...(source.passenger_identity_security || {}) };

  Object.entries(identities).forEach(([bookingKey, plan]) => {
    const matchingAuthUids = Object.entries(source.users || {})
      .filter(([, profile]) => String(profile?.bookingRef || '').trim().toUpperCase() === plan.bookingRef)
      .map(([authUid]) => authUid);
    const existingIdentity = next.booking_identities[bookingKey] || {};
    const existingSecurity = next.passenger_identity_security[bookingKey] || {};
    const existingAuthorizedAuthUid = [
      existingSecurity.authorizedAuthUid,
      existingIdentity.authorizedAuthUid,
    ].find((value) => typeof value === 'string' && value.trim());
    const isLocked = existingSecurity.loginLocked === true
      || existingIdentity.loginLocked === true
      || (!existingAuthorizedAuthUid && matchingAuthUids.length > 1);
    const authorizedAuthUid = isLocked
      ? null
      : (existingAuthorizedAuthUid || (matchingAuthUids.length === 1 ? matchingAuthUids[0] : null));
    next.passenger_identity_security[bookingKey] = {
      passengerPrincipalId: plan.opaqueId,
      passengerIdentityVersion: 'pax_v2',
      passengerIdentityIssuedAtMs: existingSecurity.passengerIdentityIssuedAtMs
        || existingIdentity.passengerIdentityIssuedAtMs
        || nowMs,
      ...(authorizedAuthUid ? { authorizedAuthUid } : {}),
      ...(Number(existingSecurity.loginDeviceBoundAtMs || existingIdentity.loginDeviceBoundAtMs) > 0
        ? { loginDeviceBoundAtMs: Number(existingSecurity.loginDeviceBoundAtMs || existingIdentity.loginDeviceBoundAtMs) }
        : {}),
      ...(isLocked
        ? {
          loginLocked: true,
          loginLockReason: existingSecurity.loginLockReason
            || existingIdentity.loginLockReason
            || 'ambiguous_legacy_bindings',
        }
        : {}),
    };
    const credentialIdentity = { ...existingIdentity };
    BOOKING_SECURITY_FIELDS.forEach((field) => delete credentialIdentity[field]);
    next.booking_identities[bookingKey] = credentialIdentity;
  });

  REWRITE_ROOTS.forEach((root) => {
    if (source[root] !== undefined) next[root] = rewriteIdentityReferences(source[root], aliasMap);
  });

  next.users = Object.fromEntries(Object.entries(source.users || {}).map(([authUid, profile]) => {
    if (!profile || typeof profile !== 'object') return [authUid, profile];
    const currentIds = [
      profile.stablePassengerId,
      profile.stablePassengerKey,
      profile.privatePhotoOwnerId,
      profile.privatePhotoOwnerKey,
    ];
    const opaqueId = currentIds.map((value) => replaceIdentityText(value, aliasMap)).find(isOpaquePassengerId);
    if (!opaqueId) return [authUid, profile];
    const migrated = {
      ...rewriteIdentityReferences(profile, aliasMap),
      stablePassengerId: opaqueId,
      stablePassengerKey: opaqueId,
      privatePhotoOwnerId: opaqueId,
      privatePhotoOwnerKey: opaqueId,
      privatePhotoOwnerType: 'opaque_passenger',
      identityVersion: 'pax_v2',
      lastUpdated: nowMs,
    };
    delete migrated.normalizedPassengerEmail;
    return [authUid, migrated];
  }));

  next.identity_bindings = rewriteIdentityReferences(source.identity_bindings || {}, aliasMap);
  next.identity_bindings_meta = Object.fromEntries(Object.entries(
    rewriteIdentityReferences(source.identity_bindings_meta || {}, aliasMap),
  ).filter(([principalId]) => isOpaquePassengerId(principalId)).map(([principalId, meta]) => [
    principalId,
    { identityVersion: 'pax_v2', lastSeenAt: Number(meta?.lastSeenAt) || nowMs },
  ]));

  next.tour_access_grants = null;
  next.booking_access_grants = null;

  const affectedAuthUids = Object.entries(next.users || {})
    .filter(([, profile]) => isOpaquePassengerId(profile?.stablePassengerId))
    .map(([authUid]) => authUid);
  const lockedBookingCount = Object.values(next.passenger_identity_security || {})
    .filter((identity) => identity?.loginLocked === true).length;
  const bookingSecurityResidueCount = Object.values(next.booking_identities || {})
    .filter((identity) => BOOKING_SECURITY_FIELDS.some((field) => identity?.[field] !== undefined)).length;
  const securityRecordCount = Object.keys(next.passenger_identity_security || {}).length;
  const legacyRemaining = REWRITE_ROOTS.filter((root) => containsLegacyIdentity(next[root]))
    .concat(containsLegacyIdentity(next.users) ? ['users'] : [])
    .concat(containsLegacyIdentity(next.identity_bindings) ? ['identity_bindings'] : [])
    .concat(containsLegacyIdentity(next.identity_bindings_meta) ? ['identity_bindings_meta'] : []);

  return {
    next,
    identities,
    aliasMap,
    affectedAuthUids,
    lockedBookingCount,
    bookingSecurityResidueCount,
    securityRecordCount,
    discoveredLegacyIdentityCount: discoveredLegacyIds.size,
    legacyRemaining,
  };
};

const listStorageMoves = ({ files = [], aliasMap }) => files.flatMap((file) => {
  const name = typeof file === 'string' ? file : file?.name;
  if (typeof name !== 'string'
    || (!name.startsWith('private_tour_photos/') && !name.startsWith('group_tour_photos/'))) return [];
  const rewritten = replaceIdentityText(name, aliasMap);
  return rewritten !== name ? [{ source: name, destination: rewritten }] : [];
});

module.exports = {
  BOOKING_SECURITY_FIELDS,
  REWRITE_ROOTS,
  buildDatabaseMigration,
  buildIdentityPlan,
  buildLegacyIdentityAliases,
  containsLegacyIdentity,
  collectExactLegacyIdentities,
  decodeRealtimeKey,
  extractLegacyIdentityCandidates,
  encodeRealtimeKey,
  listStorageMoves,
  replaceIdentityText,
  rewriteIdentityReferences,
};
