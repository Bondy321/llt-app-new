'use strict';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const fs = require('node:fs');
const path = require('node:path');
const {
  RETENTION_ENGINE_PROTOCOL_MANIFEST,
  compiledRetentionProtocol,
} = require('../../functions/src/domains/notification-retention/protocol');
const { buildRetentionDeploymentAttestation } = require(
  '../../functions/src/domains/notification-retention/deploymentAttestation',
);

const pathKeys = (pathName) => String(pathName || '').split('/').filter(Boolean);

const getAtPath = (root, pathName) => pathKeys(pathName)
  .reduce((current, key) => current?.[key], root);

const setAtPath = (root, pathName, value) => {
  const keys = pathKeys(pathName);
  if (!keys.length) throw new Error('Root replacement is not supported by this retention test fake');
  let current = root;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  if (value === null) delete current[keys.at(-1)];
  else current[keys.at(-1)] = clone(value);
};

const childValue = (value, childPath) => pathKeys(childPath)
  .reduce((current, key) => current?.[key], value);

const compareFirebaseValues = (left, right) => {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
};

const snapshotFor = (value, ordered = null) => ({
  val: () => clone(value),
  exists: () => value !== undefined && value !== null
    && (typeof value !== 'object' || Object.keys(value).length > 0),
  forEach: (visitor) => {
    const entries = ordered || Object.entries(value || {});
    for (const [key, childValueAtKey] of entries) {
      if (visitor({ key, val: () => clone(childValueAtKey) }) === true) return true;
    }
    return false;
  },
});

const createNotificationRetentionMemoryDb = (initial = {}, hooks = {}) => {
  const data = clone(initial);
  let rollout = data?.notification_retention_rollout?.v1;
  if (rollout?.preparationComplete === true && ['shadow', 'compactor'].includes(rollout.phase)
    && !rollout.expectedEngineProtocolId && !rollout.retentionEngineProtocolId) {
    Object.assign(rollout, compiledRetentionProtocol());
    rollout.expectedEngineProtocolId = rollout.retentionEngineProtocolId;
  }
  const protocolId = rollout?.expectedEngineProtocolId || rollout?.retentionEngineProtocolId;
  if (protocolId) {
    data.notification_retention ||= {};
    data.notification_retention.v1 ||= {};
  }
  const retentionV1 = data?.notification_retention?.v1;
  if (protocolId && !Object.prototype.hasOwnProperty.call(retentionV1, 'deployment_heartbeats')) {
    const observedAtMs = Number.isSafeInteger(rollout.updatedAtMs) ? rollout.updatedAtMs : 1;
    retentionV1.deployment_heartbeats = {
      [protocolId]: {
        schemaVersion: 1,
        retentionEngineProtocolId: protocolId,
        engineSourceDigest: rollout.engineSourceDigest,
        engineRulesDigest: rollout.engineRulesDigest,
        engineTriggerDigest: rollout.engineTriggerDigest,
        functionName: 'cleanupNotificationDeliveryData',
        region: 'europe-west1',
        sequence: 1,
        observedAtMs,
        expiresAtMs: observedAtMs + (45 * 60 * 1000),
      },
    };
  }
  if (protocolId && !Object.prototype.hasOwnProperty.call(retentionV1, 'deployment_attestations')) {
    const heartbeat = retentionV1.deployment_heartbeats?.[protocolId];
    if (heartbeat) {
      const trigger = RETENTION_ENGINE_PROTOCOL_MANIFEST.trigger;
      const projectId = 'retention-test-project';
      const candidate = buildRetentionDeploymentAttestation({
        projectId,
        rules: fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8'),
        heartbeat,
        nowMs: heartbeat.observedAtMs,
        functionConfig: {
          name: `projects/${projectId}/locations/${trigger.region}/functions/${trigger.functionName}`,
          state: 'ACTIVE',
          environment: 'GEN_2',
          buildConfig: { runtime: trigger.runtime },
          serviceConfig: {
            timeoutSeconds: `${trigger.timeoutSeconds}s`,
            maxInstanceCount: trigger.maxInstances,
            allTrafficOnLatestRevision: true,
            uri: `https://${trigger.functionName}.example.test`,
            serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
          },
        },
        schedulerConfig: {
          name: `projects/${projectId}/locations/${trigger.region}/jobs/${trigger.schedulerJobName}`,
          state: 'PAUSED',
          schedule: trigger.schedule,
          timeZone: trigger.timeZone,
          httpTarget: {
            uri: `https://${trigger.functionName}.example.test`,
            oidcToken: {
              audience: `https://${trigger.functionName}.example.test`,
              serviceAccountEmail: `${projectId}@appspot.gserviceaccount.com`,
            },
          },
        },
      });
      if (candidate.valid) {
        retentionV1.deployment_attestations = {
          [protocolId]: candidate.attestation,
        };
      }
    }
  }
  const queryLog = [];
  const transactionLog = [];
  const updateLog = [];

  const ref = (pathName = '') => {
    const query = {
      orderBy: null,
      startAt: null,
      endAt: null,
      equalTo: null,
      limit: null,
    };
    const api = {
      once: async () => {
        await hooks.beforeOnce?.({ data, pathName, query: clone(query) });
        const raw = getAtPath(data, pathName);
        if (!query.orderBy && query.limit === null) return snapshotFor(raw);
        let entries = Object.entries(raw || {});
        if (query.orderBy?.kind === 'child') {
          const field = query.orderBy.field;
          entries.sort(([leftKey, left], [rightKey, right]) => (
            compareFirebaseValues(childValue(left, field), childValue(right, field))
              || leftKey.localeCompare(rightKey)
          ));
          if (query.equalTo) entries = entries.filter(([, value]) => (
            childValue(value, field) === query.equalTo.value
          ));
          if (query.startAt) entries = entries.filter(([key, value]) => {
            const comparison = compareFirebaseValues(childValue(value, field), query.startAt.value);
            return comparison > 0 || (comparison === 0 && (!query.startAt.key || key >= query.startAt.key));
          });
          if (query.endAt) entries = entries.filter(([key, value]) => {
            const comparison = compareFirebaseValues(childValue(value, field), query.endAt.value);
            return comparison < 0 || (comparison === 0 && (!query.endAt.key || key <= query.endAt.key));
          });
        } else {
          entries.sort(([left], [right]) => left.localeCompare(right));
          if (query.startAt) entries = entries.filter(([key]) => key >= String(query.startAt.value));
          if (query.endAt) entries = entries.filter(([key]) => key <= String(query.endAt.value));
        }
        if (query.limit !== null) entries = entries.slice(0, query.limit);
        queryLog.push({ pathName, query: clone(query), returned: entries.length });
        return snapshotFor(Object.fromEntries(entries), entries);
      },
      get: async () => api.once('value'),
      transaction: async (updater) => {
        await hooks.beforeTransaction?.({ data, pathName });
        const current = clone(getAtPath(data, pathName));
        const next = updater(current);
        const committed = next !== undefined;
        if (committed) setAtPath(data, pathName, next);
        transactionLog.push({ pathName, committed });
        await hooks.afterTransaction?.({ data, pathName, committed, current, next: clone(next) });
        return { committed, snapshot: snapshotFor(committed ? next : current) };
      },
      update: async (patch) => {
        await hooks.beforeUpdate?.({ data, pathName, patch: clone(patch) });
        const updates = Object.entries(patch || {});
        for (const [key, value] of updates) {
          setAtPath(data, pathName ? `${pathName}/${key}` : key, value);
        }
        updateLog.push({ pathName, paths: updates.map(([key]) => pathName ? `${pathName}/${key}` : key) });
        await hooks.afterUpdate?.({ data, pathName, patch: clone(patch) });
      },
      set: async (value) => setAtPath(data, pathName, value),
      remove: async () => setAtPath(data, pathName, null),
      orderByKey: () => { query.orderBy = { kind: 'key' }; return api; },
      orderByChild: (field) => { query.orderBy = { kind: 'child', field }; return api; },
      startAt: (value, key = null) => { query.startAt = { value, key }; return api; },
      startAfter: (value, key = null) => {
        query.startAt = query.orderBy?.kind === 'key'
          ? { value: `${value}\u0000`, key: null }
          : { value, key: key ? `${key}\u0000` : null };
        return api;
      },
      endAt: (value, key = null) => { query.endAt = { value, key }; return api; },
      equalTo: (value) => { query.equalTo = { value }; return api; },
      limitToFirst: (limit) => { query.limit = limit; return api; },
    };
    return api;
  };

  return { data, getAtPath: (pathName) => clone(getAtPath(data, pathName)), queryLog, ref, transactionLog, updateLog };
};

module.exports = { createNotificationRetentionMemoryDb, getAtPath, setAtPath };
