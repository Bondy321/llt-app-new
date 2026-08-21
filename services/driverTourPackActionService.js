const { createPersistenceProvider } = require('./persistenceProvider');
const driverTourPackService = require('./driverTourPackService');
const offlineSyncService = require('./offlineSyncService');

const CACHE_PREFIX = 'driver_tour_pack_actions_v1';
const ACTION_TYPE = 'DRIVER_TOUR_PACK_ACTION';
const PICKUP_STATES = Object.freeze(['PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED']);
const COMPLETION_STATES = Object.freeze(['PENDING', 'COMPLETED', 'SKIPPED']);
const ISSUE_CATEGORIES = Object.freeze(['delay', 'vehicle', 'pickup', 'passenger', 'hotel', 'supplier', 'accessibility', 'other']);
const ISSUE_SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
const ISSUE_STATUSES = Object.freeze(['open', 'acknowledged', 'resolved']);
const MAX_ISSUES = 100;
const ISSUE_ID_PATTERN = /^issue_(00[1-9]|0[1-9][0-9]|100)$/;
const CHANGE_SECTIONS = Object.freeze(['status', 'tour', 'pickups', 'passengers', 'seats', 'timeline', 'hotels', 'services', 'coach', 'contacts', 'itineraries', 'coverage', 'quality']);
const safeId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[.#$/\[\]\x00-\x1f\x7f]/.test(value);
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const isNetworkError = (value) => /network|offline|timeout|timed out|unavailable|disconnect|transport/i.test(String(value || ''));
const defaultDatabase = () => require('../firebase').realtimeDb;

function normalizeScope(input = {}) {
  return driverTourPackService.normalizeScope(input);
}

function queueScope(scope) {
  return {
    tourId: scope.tourId,
    principalId: `driver:${scope.driverId}`,
    role: 'driver',
    authUid: scope.authUid,
    cacheOwnerId: scope.driverId,
  };
}

function cacheKey(scope) {
  return `${CACHE_PREFIX}_${encodeURIComponent(scope.authUid)}_${encodeURIComponent(scope.driverId)}_${encodeURIComponent(scope.departureKey)}`;
}

function normalizeStateRecord(value, allowedStates) {
  return Object.fromEntries(Object.entries(object(value) ? value : {}).flatMap(([id, item]) => (
    safeId(id) && object(item) && allowedStates.includes(item.state) && Number.isSafeInteger(item.updatedAtMs)
      ? [[id, { state: item.state, updatedAtMs: item.updatedAtMs }]]
      : []
  )));
}

function normalizeIssue(issueId, raw) {
  if (!safeId(issueId) || !object(raw)) return null;
  const summary = clean(raw.summary);
  if (raw.schemaVersion !== 1 || raw.issueId !== issueId || !summary || summary.includes('@')
    || !ISSUE_CATEGORIES.includes(raw.category) || !ISSUE_SEVERITIES.includes(raw.severity)
    || !ISSUE_STATUSES.includes(raw.status) || !Number.isSafeInteger(raw.revision)
    || !Number.isSafeInteger(raw.createdAtMs) || !Number.isSafeInteger(raw.updatedAtMs)
    || !Number.isSafeInteger(raw.statusUpdatedAtMs)) return null;
  return {
    schemaVersion: 1,
    issueId,
    category: raw.category,
    severity: raw.severity,
    status: raw.status,
    summary,
    revision: raw.revision,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
    statusUpdatedAtMs: raw.statusUpdatedAtMs,
    statusUpdatedBy: raw.statusUpdatedBy === 'operations' ? 'operations' : 'driver',
  };
}

function normalizeActions(value) {
  const raw = object(value) ? value : {};
  return {
    schemaVersion: raw.schemaVersion === 1 ? 1 : 1,
    packRevision: Number.isSafeInteger(raw.packRevision) ? raw.packRevision : 0,
    revisionAcknowledged: Number.isSafeInteger(raw.revisionAcknowledged) ? raw.revisionAcknowledged : 0,
    updatedAtMs: Number.isSafeInteger(raw.updatedAtMs) ? raw.updatedAtMs : 0,
    pickupStops: normalizeStateRecord(raw.pickupStops, PICKUP_STATES),
    serviceCompletion: normalizeStateRecord(raw.serviceCompletion, COMPLETION_STATES),
    hotelCompletion: normalizeStateRecord(raw.hotelCompletion, COMPLETION_STATES),
    issues: Object.fromEntries(Object.entries(object(raw.issues) ? raw.issues : {}).flatMap(([issueId, issue]) => {
      const normalized = normalizeIssue(issueId, issue);
      return normalized ? [[issueId, normalized]] : [];
    })),
  };
}

function normalizeChange(value, scope) {
  if (!object(value) || value.schemaVersion !== 1 || value.departureKey !== scope.departureKey
    || value.tourId !== scope.tourId || !Number.isSafeInteger(value.revision)) return null;
  const source = Array.isArray(value.changedSections)
    ? value.changedSections
    : Object.entries(object(value.changedSections) ? value.changedSections : {}).filter(([, enabled]) => enabled === true).map(([key]) => key);
  return {
    schemaVersion: 1,
    changeId: clean(value.changeId, 160),
    departureKey: value.departureKey,
    tourId: value.tourId,
    revision: value.revision,
    previousRevision: Number.isSafeInteger(value.previousRevision) ? value.previousRevision : 0,
    changedSections: [...new Set(source.filter((section) => CHANGE_SECTIONS.includes(section)))],
    critical: value.critical === true,
    requiresAcknowledgement: value.requiresAcknowledgement === true,
    createdAtMs: Number.isSafeInteger(value.createdAtMs) ? value.createdAtMs : 0,
  };
}

function operationKey(payload) {
  return `${payload.departureKey}:${payload.driverId}:${payload.kind}:${payload.targetId || 'root'}`;
}

function applyOptimistic(actionsInput, payload, timestamp) {
  const actions = normalizeActions(actionsInput);
  const next = { ...actions, schemaVersion: 1, packRevision: payload.packRevision, updatedAtMs: timestamp };
  if (payload.kind === 'acknowledge') next.revisionAcknowledged = payload.packRevision;
  if (payload.kind === 'pickup') next.pickupStops = { ...actions.pickupStops, [payload.targetId]: { state: payload.state, updatedAtMs: timestamp } };
  if (payload.kind === 'service') next.serviceCompletion = { ...actions.serviceCompletion, [payload.targetId]: { state: payload.state, updatedAtMs: timestamp } };
  if (payload.kind === 'hotel') next.hotelCompletion = { ...actions.hotelCompletion, [payload.targetId]: { state: payload.state, updatedAtMs: timestamp } };
  if (payload.kind === 'issue') next.issues = { ...actions.issues, [payload.targetId]: payload.issue };
  return next;
}

function validatePayload(payload) {
  const scope = normalizeScope(payload);
  if (!scope.ok || payload.driverId !== scope.driverId || payload.tourId !== scope.tourId
    || !Number.isSafeInteger(payload.packRevision) || payload.packRevision < 1) return { valid: false, error: 'Driver action scope is invalid' };
  if (!['acknowledge', 'pickup', 'service', 'hotel', 'issue'].includes(payload.kind)) return { valid: false, error: 'Driver action kind is invalid' };
  if (payload.kind === 'pickup' && (!safeId(payload.targetId) || !PICKUP_STATES.includes(payload.state))) return { valid: false, error: 'Pickup progress is invalid' };
  if (['service', 'hotel'].includes(payload.kind) && (!safeId(payload.targetId) || !COMPLETION_STATES.includes(payload.state))) return { valid: false, error: 'Completion state is invalid' };
  if (payload.kind === 'issue' && (!ISSUE_ID_PATTERN.test(payload.targetId) || !normalizeIssue(payload.targetId, payload.issue))) return { valid: false, error: 'Issue report is invalid' };
  return { valid: true, scope };
}

function createDriverTourPackActionService({
  queue = offlineSyncService,
  db = null,
  getDatabase = defaultDatabase,
  storage = createPersistenceProvider({ namespace: 'LLT_DRIVER_TOUR_PACK_ACTIONS', preferredStorage: 'async-storage', allowMemoryFallback: process.env.NODE_ENV === 'test' }),
  now = () => Date.now(),
} = {}) {
  const database = () => db || getDatabase?.();
  const readCache = async (scopeInput) => {
    const scope = normalizeScope(scopeInput);
    if (!scope.ok) return { success: false, error: scope.reason };
    try {
      const raw = await storage.getItemAsync(cacheKey(scope));
      if (!raw) return { success: true, data: { actions: normalizeActions(null), change: null } };
      const parsed = JSON.parse(raw);
      return { success: true, data: { actions: normalizeActions(parsed.actions), change: normalizeChange(parsed.change, scope), cachedAtMs: parsed.cachedAtMs || null } };
    } catch (error) { return { success: false, error: error?.message || String(error) }; }
  };
  const writeCache = async (scope, actions, change) => {
    const entry = { actions: normalizeActions(actions), change: normalizeChange(change, scope), cachedAtMs: now() };
    await storage.setItemAsync(cacheKey(scope), JSON.stringify(entry));
    return entry;
  };
  const purge = async (scopeInput) => {
    const scope = normalizeScope(scopeInput);
    if (!scope.ok) return { success: false, error: scope.reason };
    try { await storage.deleteItemAsync(cacheKey(scope)); return { success: true, data: { purged: true } }; }
    catch (error) { return { success: false, error: error?.message || String(error) }; }
  };
  const subscribe = (scopeInput, onChange, onError) => {
    const scope = normalizeScope(scopeInput);
    const activeDb = database();
    if (!scope.ok || !activeDb?.ref) { onError?.(new Error(scope.reason || 'Driver action database unavailable')); return () => {}; }
    const actionRef = activeDb.ref(`driver_tour_pack_actions/${scope.departureKey}/${scope.driverId}`);
    const changeRef = activeDb.ref(`driver_tour_pack_changes/${scope.departureKey}/latest`);
    let active = true; let actionsReady = false; let changeReady = false;
    let actions = normalizeActions(null); let change = null;
    const emit = () => {
      if (!active || !actionsReady || !changeReady) return;
      writeCache(scope, actions, change).catch(onError);
      onChange?.({ actions, change, source: 'remote' });
    };
    const fail = (error) => { if (active) onError?.(error); };
    const onActions = (snapshot) => { actions = normalizeActions(snapshot?.val?.()); actionsReady = true; emit(); };
    const onLatestChange = (snapshot) => { change = normalizeChange(snapshot?.val?.(), scope); changeReady = true; emit(); };
    actionRef.on('value', onActions, fail); changeRef.on('value', onLatestChange, fail);
    return () => { active = false; actionRef.off?.('value', onActions); changeRef.off?.('value', onLatestChange); };
  };
  const submitDirect = async (payload, dbOverride) => {
    const validation = validatePayload(payload);
    const activeDb = dbOverride || database();
    if (!validation.valid) return { success: false, error: validation.error };
    if (!activeDb?.ref) return { success: false, error: 'Driver action service unavailable' };
    const stamp = Number.isSafeInteger(payload.clientUpdatedAtMs) ? payload.clientUpdatedAtMs : now();
    const root = `driver_tour_pack_actions/${payload.departureKey}/${payload.driverId}`;
    const update = { schemaVersion: 1, packRevision: payload.packRevision, updatedAtMs: stamp };
    if (payload.kind === 'acknowledge') update.revisionAcknowledged = payload.packRevision;
    if (payload.kind === 'pickup') update[`pickupStops/${payload.targetId}`] = { state: payload.state, updatedAtMs: stamp };
    if (payload.kind === 'service') update[`serviceCompletion/${payload.targetId}`] = { state: payload.state, updatedAtMs: stamp };
    if (payload.kind === 'hotel') update[`hotelCompletion/${payload.targetId}`] = { state: payload.state, updatedAtMs: stamp };
    if (payload.kind === 'issue') Object.entries(payload.issue).forEach(([field, value]) => {
      update[`issues/${payload.targetId}/${field}`] = value;
    });
    try { await activeDb.ref(root).update(update); return { success: true, data: { queued: false, updatedAtMs: stamp } }; }
    catch (error) { return { success: false, error: error?.message || String(error), code: error?.code || null }; }
  };
  const enqueue = (payload) => queue.enqueueAction({
    id: `driver-pack:${operationKey(payload)}`,
    type: ACTION_TYPE,
    tourId: payload.tourId,
    createdAt: new Date(payload.clientUpdatedAtMs || now()).toISOString(),
    payload,
    scope: queueScope(payload),
    attempts: 0,
    status: 'queued',
  });
  const submit = async (scopeInput, operation, { online = true } = {}) => {
    const scope = normalizeScope(scopeInput);
    if (!scope.ok) return { success: false, error: scope.reason };
    const stamp = now();
    const cached = await readCache(scope);
    const issueIds = new Set(Object.keys(cached.data?.actions?.issues || {}));
    const nextIssueId = Array.from({ length: MAX_ISSUES }, (_, index) => `issue_${String(index + 1).padStart(3, '0')}`)
      .find((issueId) => !issueIds.has(issueId));
    const targetId = operation.kind === 'issue'
      ? (ISSUE_ID_PATTERN.test(operation.targetId || '') ? operation.targetId : nextIssueId)
      : operation.targetId;
    if (operation.kind === 'issue' && !targetId) return { success: false, error: 'The issue limit for this departure has been reached' };
    const issue = operation.kind === 'issue' ? {
      schemaVersion: 1,
      issueId: targetId,
      category: ISSUE_CATEGORIES.includes(operation.category) ? operation.category : 'other',
      severity: ISSUE_SEVERITIES.includes(operation.severity) ? operation.severity : 'warning',
      status: 'open',
      summary: clean(operation.summary),
      revision: operation.packRevision,
      createdAtMs: stamp,
      updatedAtMs: stamp,
      statusUpdatedAtMs: stamp,
      statusUpdatedBy: 'driver',
    } : null;
    const payload = {
      authUid: scope.authUid,
      driverId: scope.driverId,
      departureKey: scope.departureKey,
      tourId: scope.tourId,
      packRevision: operation.packRevision,
      kind: operation.kind,
      ...(targetId ? { targetId } : {}),
      ...(operation.state ? { state: operation.state } : {}),
      ...(issue ? { issue } : {}),
      clientUpdatedAtMs: stamp,
    };
    const validation = validatePayload(payload);
    if (!validation.valid) return { success: false, error: validation.error };
    const optimistic = applyOptimistic(cached.data?.actions, payload, stamp);
    const direct = online ? await submitDirect(payload) : { success: false, error: 'Offline' };
    if (direct.success) {
      await writeCache(scope, optimistic, cached.data?.change).catch(() => {});
      return { ...direct, data: { ...direct.data, actions: optimistic, issueId: issue?.issueId || null } };
    }
    if (online && !isNetworkError(direct.error)) return direct;
    const queued = await enqueue(payload);
    if (!queued.success) return queued;
    await writeCache(scope, optimistic, cached.data?.change).catch(() => {});
    return { success: true, data: { queued: true, actions: optimistic, issueId: issue?.issueId || null } };
  };
  return { cacheKey, enqueue, normalizeScope, purge, readCache, submit, submitDirect, subscribe, writeCache };
}

const service = createDriverTourPackActionService();
module.exports = {
  ACTION_TYPE,
  CACHE_PREFIX,
  CHANGE_SECTIONS,
  COMPLETION_STATES,
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUE_ID_PATTERN,
  MAX_ISSUES,
  PICKUP_STATES,
  applyOptimistic,
  createDriverTourPackActionService,
  normalizeActions,
  normalizeChange,
  normalizeIssue,
  normalizeScope,
  operationKey,
  validatePayload,
  ...service,
};
