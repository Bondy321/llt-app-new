'use strict';

const { hasCurrentDriverAuthority } = require('./driverLocationProjection');

const CHAT_STATUS_SOURCE_SCHEMA_VERSION = 2;
const CHAT_STATUS_PROJECTION_LEASE_MS = 30_000;
const CHAT_TYPING_EXPIRY_MS = 10_000;
const CHAT_SCOPES = new Set(['group', 'internal']);
const CHAT_STATUS_TYPES = new Set(['presence', 'typing']);
const MAX_EXPIRED_CHAT_STATUS_PER_RUN = 100;

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isSafeTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const boundedText = (value, maxLength) => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const normalizeScope = (scope) => scope === 'internal' ? 'internal' : 'group';

function publicRoot(scope) {
  return normalizeScope(scope) === 'internal' ? 'internal_chats' : 'chats';
}

function rawRoot(statusType) {
  if (!CHAT_STATUS_TYPES.has(statusType)) throw new Error('A valid chat status type is required');
  return statusType === 'presence' ? 'chat_presence_sessions' : 'chat_typing_sessions';
}

function isValidChatStatusSource(record, { scope, tourId, actorKey, nowMs }) {
  const normalizedScope = normalizeScope(scope);
  return Boolean(
    isObject(record)
    && record.schemaVersion === CHAT_STATUS_SOURCE_SCHEMA_VERSION
    && record.scope === normalizedScope
    && record.tourId === tourId
    && record.actorKey === actorKey
    && record.tourActorKey === `${tourId}|${actorKey}`
    && boundedText(record.authUid, 128)
    && boundedText(record.appSessionId, 100)
    && boundedText(record.principalId, 100)
    && (record.principalType === 'driver' || record.principalType === 'passenger')
    && record.isDriver === (record.principalType === 'driver')
    && boundedText(record.name, 100)
    && isSafeTimestamp(record.timestamp)
    && isSafeTimestamp(record.expiresAtMs)
    && record.expiresAtMs > nowMs
  );
}

function compareChatStatusSources(left, right) {
  const timestampDelta = Number(right.timestamp) - Number(left.timestamp);
  if (timestampDelta) return timestampDelta;
  return boundedText(right.appSessionId, 100).localeCompare(boundedText(left.appSessionId, 100));
}

function buildChatStatusProjection({ records = [], statusType, nowMs = Date.now() } = {}) {
  if (!CHAT_STATUS_TYPES.has(statusType)) throw new Error('A valid chat status type is required');
  if (!isSafeTimestamp(nowMs)) throw new Error('nowMs must be a non-negative safe integer');
  const first = records
    .filter((record) => isObject(record) && isSafeTimestamp(record.timestamp)
      && isSafeTimestamp(record.expiresAtMs) && record.expiresAtMs > nowMs)
    .sort(compareChatStatusSources)[0];
  if (!first) return null;
  const common = {
    name: boundedText(first.name, 100) || 'Tour Participant',
    isDriver: first.isDriver === true,
  };
  return statusType === 'presence'
    ? { ...common, online: true, lastSeen: first.timestamp }
    : { ...common, timestamp: first.timestamp };
}

function snapshotValue(snapshot) {
  return typeof snapshot?.val === 'function' ? snapshot.val() : null;
}

async function readValue(ref) {
  const snapshot = typeof ref?.get === 'function' ? await ref.get() : await ref.once('value');
  return snapshotValue(snapshot);
}

async function hasCurrentChatAuthority(database, record, nowMs) {
  const session = await readValue(database.ref(`app_sessions/${record.authUid}`));
  const activeSession = Boolean(
    session
    && session.sessionId === record.appSessionId
    && session.authUid === record.authUid
    && session.status === 'active'
    && session.principalType === record.principalType
    && session.principalId === record.principalId
    && session.tourId === record.tourId
    && Number(session.expiresAtMs) > nowMs
  );
  if (!activeSession) return false;
  if (record.principalType === 'driver') {
    const driverId = boundedText(record.principalId, 100).startsWith('driver:')
      ? boundedText(record.principalId, 100).slice('driver:'.length)
      : '';
    return Boolean(driverId) && hasCurrentDriverAuthority(database, { ...record, driverId }, nowMs);
  }
  if (record.scope === 'internal') return false;
  const participant = await readValue(database.ref(`tours/${record.tourId}/participants/${record.authUid}`));
  return Boolean(
    participant
    && participant.sessionId === record.appSessionId
    && participant.principalId === record.principalId
    && Number(participant.sessionExpiresAtMs) > nowMs
  );
}

async function releaseLease(ref, leaseOwner) {
  await ref.transaction((current) => {
    if (!isObject(current) || current.leaseOwner !== leaseOwner) return undefined;
    const next = { ...current };
    delete next.leaseOwner;
    delete next.leaseExpiresAtMs;
    return next;
  }, undefined, false);
}

async function readStatusRecords(database, { statusType, scope, tourId, actorKey }) {
  const tourActorKey = `${tourId}|${actorKey}`;
  let query = database.ref(`${rawRoot(statusType)}/${scope}`).orderByChild('tourActorKey');
  if (typeof query.equalTo === 'function') query = query.equalTo(tourActorKey);
  const value = await readValue(query);
  return Object.entries(isObject(value) ? value : {})
    .filter(([, record]) => record?.tourActorKey === tourActorKey)
    .map(([appSessionId, record]) => ({ appSessionId, record }));
}

async function reconcileChatActorStatus({
  database,
  scope = 'group',
  tourId,
  actorKey,
  nowMs = Date.now(),
  leaseOwner = `chat_status_${nowMs}_${Math.random().toString(36).slice(2, 10)}`,
  validateRecord = hasCurrentChatAuthority,
} = {}) {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const normalizedScope = normalizeScope(scope);
  const normalizedTourId = boundedText(tourId, 100);
  const normalizedActorKey = boundedText(actorKey, 100);
  if (!normalizedTourId || !normalizedActorKey) throw new Error('Tour and actor keys are required');
  const stateRef = database.ref(`chat_status_projection_state/${normalizedScope}/${normalizedTourId}/${normalizedActorKey}`);
  const leaseResult = await stateRef.transaction((current) => {
    const state = isObject(current) ? current : {};
    if (state.leaseOwner && state.leaseOwner !== leaseOwner && Number(state.leaseExpiresAtMs) > nowMs) return undefined;
    return {
      ...state,
      leaseOwner,
      leaseRevision: Number.isSafeInteger(state.leaseRevision) ? state.leaseRevision + 1 : 1,
      leaseExpiresAtMs: nowMs + CHAT_STATUS_PROJECTION_LEASE_MS,
    };
  }, undefined, false);
  if (leaseResult?.committed !== true) {
    const error = new Error('Chat status projection is busy');
    error.code = 'CHAT_STATUS_PROJECTION_BUSY';
    throw error;
  }

  try {
    const [presenceEntries, typingEntries, currentPresence] = await Promise.all([
      readStatusRecords(database, { statusType: 'presence', scope: normalizedScope, tourId: normalizedTourId, actorKey: normalizedActorKey }),
      readStatusRecords(database, { statusType: 'typing', scope: normalizedScope, tourId: normalizedTourId, actorKey: normalizedActorKey }),
      readValue(database.ref(`${publicRoot(normalizedScope)}/${normalizedTourId}/presence/${normalizedActorKey}`)),
    ]);
    const validateEntries = async (entries, statusType) => (await Promise.all(entries.map(async ({ record, appSessionId }) => ({
      record,
      valid: appSessionId === record?.appSessionId
        && isValidChatStatusSource(record, {
          scope: normalizedScope,
          tourId: normalizedTourId,
          actorKey: normalizedActorKey,
          nowMs,
        })
        && await validateRecord(database, record, nowMs, statusType),
    })))).filter(({ valid }) => valid).map(({ record }) => record);
    const [presenceRecords, typingRecords] = await Promise.all([
      validateEntries(presenceEntries, 'presence'),
      validateEntries(typingEntries, 'typing'),
    ]);
    let presence = buildChatStatusProjection({ records: presenceRecords, statusType: 'presence', nowMs });
    const typing = buildChatStatusProjection({ records: typingRecords, statusType: 'typing', nowMs });
    if (!presence && isObject(currentPresence)) {
      presence = {
        name: boundedText(currentPresence.name, 100) || 'Tour Participant',
        isDriver: currentPresence.isDriver === true,
        online: false,
        lastSeen: Math.max(Number(currentPresence.lastSeen) || 0, nowMs),
      };
    }
    const leaseState = snapshotValue(leaseResult.snapshot) || {};
    const finalized = await stateRef.transaction((current) => {
      if (!isObject(current)
        || current.leaseOwner !== leaseOwner
        || current.leaseRevision !== leaseState.leaseRevision) return undefined;
      return {
        revision: Number.isSafeInteger(current.revision) ? current.revision + 1 : 1,
        fingerprint: JSON.stringify({ presence, typing }),
        projectedAtMs: nowMs,
      };
    }, undefined, false);
    if (finalized?.committed !== true) {
      const error = new Error('Chat status projection lease changed before commit');
      error.code = 'CHAT_STATUS_PROJECTION_BUSY';
      throw error;
    }
    const revision = snapshotValue(finalized.snapshot)?.revision;
    const presenceValue = presence
      ? { ...presence, projectionRevision: revision }
      : {
          name: boundedText(currentPresence?.name, 100) || 'Tour Participant',
          isDriver: currentPresence?.isDriver === true,
          online: false,
          lastSeen: Math.max(Number(currentPresence?.lastSeen) || 0, nowMs),
          projectionRevision: revision,
        };
    const typingValue = typing
      ? { ...typing, isTyping: true, projectionRevision: revision }
      : {
          name: boundedText(currentPresence?.name, 100) || 'Tour Participant',
          isDriver: currentPresence?.isDriver === true,
          isTyping: false,
          timestamp: Math.max(0, nowMs - CHAT_TYPING_EXPIRY_MS - 1),
          projectionRevision: revision,
        };
    const writeProjectedValue = async (statusType, value) => database
      .ref(`${publicRoot(normalizedScope)}/${normalizedTourId}/${statusType}/${normalizedActorKey}`)
      .transaction((current) => {
        const currentRevision = Number.isSafeInteger(current?.projectionRevision)
          ? current.projectionRevision
          : 0;
        if (currentRevision >= revision) return undefined;
        return value;
      }, undefined, false);
    await Promise.all([
      writeProjectedValue('presence', presenceValue),
      writeProjectedValue('typing', typingValue),
    ]);
    return { ok: true, scope: normalizedScope, tourId: normalizedTourId, actorKey: normalizedActorKey, revision, presence, typing };
  } catch (error) {
    await releaseLease(stateRef, leaseOwner).catch(() => {});
    throw error;
  }
}

function collectChangedActors(before, after) {
  const unique = new Map();
  for (const record of [before, after]) {
    if (!record) continue;
    const scope = normalizeScope(record.scope);
    const tourId = boundedText(record.tourId, 100);
    const actorKey = boundedText(record.actorKey, 100);
    if (tourId && actorKey) unique.set(`${scope}|${tourId}|${actorKey}`, { scope, tourId, actorKey });
  }
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function reconcileChatStatusSourceChange({ database, before, after, nowMs = Date.now() } = {}) {
  const actors = collectChangedActors(before, after);
  const results = [];
  for (const actor of actors) results.push(await reconcileChatActorStatus({ database, ...actor, nowMs }));
  return { ok: true, actors, results };
}

async function cleanupChatStatusForAppSession({
  database,
  appSessionId,
  expectedTourId = null,
  expectedActorKey = null,
  expectedPrincipalType = null,
  nowMs = Date.now(),
} = {}) {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  const normalizedSessionId = boundedText(appSessionId, 100);
  if (!normalizedSessionId) throw new Error('An app session ID is required');
  const affected = new Map();
  const updates = {};
  for (const scope of CHAT_SCOPES) {
    for (const statusType of CHAT_STATUS_TYPES) {
      const path = `${rawRoot(statusType)}/${scope}/${normalizedSessionId}`;
      const record = await readValue(database.ref(path));
      if (!record || record.appSessionId !== normalizedSessionId) continue;
      updates[path] = null;
      for (const actor of collectChangedActors(record, null)) {
        affected.set(`${actor.scope}|${actor.tourId}|${actor.actorKey}`, actor);
      }
    }
  }
  if (Object.keys(updates).length) await database.ref().update(updates);
  const normalizedExpectedTourId = boundedText(expectedTourId, 100);
  const normalizedExpectedActorKey = boundedText(expectedActorKey, 100);
  if (normalizedExpectedTourId && normalizedExpectedActorKey) {
    const scopes = expectedPrincipalType === 'driver' ? ['group', 'internal'] : ['group'];
    await Promise.all(scopes.map(async (scope) => {
      const [presence, typing] = await Promise.all([
        readValue(database.ref(`${publicRoot(scope)}/${normalizedExpectedTourId}/presence/${normalizedExpectedActorKey}`)),
        readValue(database.ref(`${publicRoot(scope)}/${normalizedExpectedTourId}/typing/${normalizedExpectedActorKey}`)),
      ]);
      if (presence === null && typing === null) return;
      const actor = { scope, tourId: normalizedExpectedTourId, actorKey: normalizedExpectedActorKey };
      affected.set(`${actor.scope}|${actor.tourId}|${actor.actorKey}`, actor);
    }));
  }
  const actors = [...affected.values()];
  for (const actor of actors) await reconcileChatActorStatus({ database, ...actor, nowMs });
  return { ok: true, appSessionId: normalizedSessionId, removed: Object.keys(updates).length, actors };
}

async function cleanupExpiredChatStatusSessions({
  database,
  nowMs = Date.now(),
  limit = MAX_EXPIRED_CHAT_STATUS_PER_RUN,
  reconcileActor = reconcileChatActorStatus,
} = {}) {
  if (!database?.ref) throw new Error('A Realtime Database instance is required');
  if (!isSafeTimestamp(nowMs)) throw new Error('nowMs must be a non-negative safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPIRED_CHAT_STATUS_PER_RUN) {
    throw new Error(`limit must be 1-${MAX_EXPIRED_CHAT_STATUS_PER_RUN}`);
  }
  const branches = [...CHAT_SCOPES].flatMap((scope) => (
    [...CHAT_STATUS_TYPES].map((statusType) => ({ scope, statusType }))
  ));
  const affected = new Map();
  let scanned = 0;
  let removed = 0;
  const branchCandidates = await Promise.all(branches.map(async ({ scope, statusType }) => {
    let query = database.ref(`${rawRoot(statusType)}/${scope}`)
      .orderByChild('expiresAtMs')
      .endAt(nowMs);
    if (typeof query.limitToFirst === 'function') query = query.limitToFirst(limit + 1);
    const candidates = await readValue(query);
    return {
      scope,
      statusType,
      entries: Object.entries(isObject(candidates) ? candidates : {}),
    };
  }));
  const candidateCount = branchCandidates.reduce((total, branch) => total + branch.entries.length, 0);
  const maxBranchCount = branchCandidates.reduce((maximum, branch) => Math.max(maximum, branch.entries.length), 0);
  for (let index = 0; index < maxBranchCount && scanned < limit; index += 1) {
    for (const { scope, statusType, entries } of branchCandidates) {
      if (scanned >= limit) break;
      const entry = entries[index];
      if (!entry) continue;
      const [appSessionId, candidate] = entry;
      scanned += 1;
      if (!isObject(candidate) || Number(candidate.expiresAtMs) > nowMs) continue;
      const result = await database.ref(`${rawRoot(statusType)}/${scope}/${appSessionId}`).transaction((current) => {
        if (!isObject(current)
          || current.appSessionId !== candidate.appSessionId
          || current.timestamp !== candidate.timestamp
          || current.expiresAtMs !== candidate.expiresAtMs
          || Number(current.expiresAtMs) > nowMs) return undefined;
        return null;
      }, undefined, false);
      if (result?.committed !== true) continue;
      removed += 1;
      for (const actor of collectChangedActors(candidate, null)) {
        affected.set(`${actor.scope}|${actor.tourId}|${actor.actorKey}`, actor);
      }
    }
  }
  const actors = [...affected.values()];
  for (const actor of actors) await reconcileActor({ database, ...actor, nowMs });
  const branchMayHaveMore = branchCandidates.some(({ entries }) => entries.length > limit);
  return {
    ok: true,
    scanned,
    removed,
    actors,
    hasMore: candidateCount > scanned || branchMayHaveMore,
  };
}

module.exports = {
  CHAT_STATUS_PROJECTION_LEASE_MS,
  CHAT_STATUS_SOURCE_SCHEMA_VERSION,
  CHAT_TYPING_EXPIRY_MS,
  buildChatStatusProjection,
  cleanupChatStatusForAppSession,
  cleanupExpiredChatStatusSessions,
  collectChangedActors,
  compareChatStatusSources,
  isValidChatStatusSource,
  hasCurrentChatAuthority,
  MAX_EXPIRED_CHAT_STATUS_PER_RUN,
  reconcileChatActorStatus,
  reconcileChatStatusSourceChange,
};
