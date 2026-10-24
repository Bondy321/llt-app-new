'use strict';

// Synthetic, in-process adapter workload. No Firebase/project credentials or
// network provider is used. SDK semantics have a separate loopback suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-llt-launch-scale' });
const { createNotificationRetentionMemoryDb } = require('../tests/helpers/notificationRetentionMemoryDb');
const { createNotificationJobRecord, enqueueNotificationJob } = require('../functions/src/domains/notifications/notificationJobs');
const { runNotificationJob } = require('../functions/src/domains/notifications/notificationWorker');
const { processDueNotificationReceipts, retryDueNotificationAttempts } = require('../functions/src/domains/notifications/notificationReceipts');
const { enumerateNotificationAudiencePage } = require('../functions/src/domains/notifications/notificationAudienceEnumerators');
const { classifyNotificationRetentionEligibility, RETENTION_MS } = require('../functions/src/domains/notification-retention/public');
const { QUEUE_ROOTS, loadFairDueQueueEntries, claimQueueEntry } = require('../functions/src/domains/notifications/notificationQueues');
const denyNetwork = () => { throw new Error('LIVE_NETWORK_FORBIDDEN_IN_SYNTHETIC_WORKLOAD'); };
global.fetch = denyNetwork;
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
require('node:net').Socket.prototype.connect = denyNetwork;

const scenario = process.argv.find(value => value.startsWith('--scenario='))?.split('=')[1] || 'launch';
const recipients = { normal: 100, launch: 60_000, reconnect: 6_000 }[scenario];
if (!recipients) throw new Error('Use --scenario=normal|launch|reconnect');
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9);
const NOW = 1_800_000_000_000;
const metrics = { reads: 0, transactions: 0, writes: 0, readBytes: 0, writeBytes: 0,
  maxReadBytes: 0, maxWriteBytes: 0, maxQueryRecords: 0, peakHeapBytes: 0, peakResidentBytes: 0, providerMessages: 0,
  providerRequests: 0, receiptsRequested: 0, errors: 0, oldestObservedQueueAgeMs: 0 };
const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null));
const recordBytes = (kind, value) => {
  const size = bytes(value); metrics[`${kind}Bytes`] += size;
  const maximum = kind === 'read' ? 'maxReadBytes' : 'maxWriteBytes'; metrics[maximum] = Math.max(metrics[maximum], size);
};
const instrument = (db) => ({ ref(refPath = '') {
  const actual = db.ref(refPath);
  const proxy = new Proxy(actual, { get(target, key) {
    if (key === 'transaction') return async callback => {
      metrics.transactions += 1;
      return target.transaction(current => { recordBytes('read', current); const next = callback(current);
        if (next !== undefined) { metrics.writes += 1; recordBytes('write', next); } return next; });
    };
    if (key === 'once' || key === 'get') return async (...args) => {
      metrics.reads += 1; const value = await target[key](...args); recordBytes('read', value.val()); return value;
    };
    if (key === 'set' || key === 'update') return async value => { metrics.writes += 1; recordBytes('write', value); return target[key](value); };
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => { const result = target[key](...args); return result === target ? proxy : result; };
  } });
  return proxy;
} });

const data = { notification_devices: {}, notification_consents: {}, notification_marketing_audience: { v1: { day_trips: {} } } };
for (let index = 0; index < 60_000; index += 1) {
  const uid = `synthetic_${String(index).padStart(5, '0')}`;
  const eligible = index < recipients;
  data.notification_devices[uid] = { schemaVersion: 1, authUid: uid, registrationRevision: 1,
    permissionState: 'granted', status: 'active', pushToken: `ExponentPushToken[synthetic${index}]`,
    operationalTourId: `tour_${Math.floor(index / 75)}`, operationalEligible: false,
    marketingEligible: eligible, marketingPreferences: { day_trips: eligible } };
  data.notification_consents[uid] = { registrationRevision: 1, marketingPreferences: { day_trips: eligible } };
  if (eligible) data.notification_marketing_audience.v1.day_trips[uid] = { schemaVersion: 1, registrationRevision: 1 };
}
const store = createNotificationRetentionMemoryDb(data);
const db = instrument(store);
const latencies = { fanout: [], receipt: [], retry: [] };
const measure = async (kind, operation) => {
  const started = performance.now(); const result = await operation(); latencies[kind].push(performance.now() - started);
  metrics.peakHeapBytes = Math.max(metrics.peakHeapBytes, process.memoryUsage().heapUsed);
  metrics.peakResidentBytes = Math.max(metrics.peakResidentBytes, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
  for (const query of store.queryLog) metrics.maxQueryRecords = Math.max(metrics.maxQueryRecords, query.returned);
  store.queryLog.length = 0; store.transactionLog.length = 0; store.updateLog.length = 0;
  return result;
};
let providerSequence = 0; const failedTokens = new Set(); const sentTokens = new Set();
const expo = {
  chunkPushNotifications: messages => Array.from({ length: Math.ceil(messages.length / 100) }, (_, index) => messages.slice(index * 100, index * 100 + 100)),
  sendPushNotificationsAsync: async messages => {
    assert.ok(messages.length <= 100); metrics.providerRequests += 1;
    if (scenario === 'reconnect' && messages.some(message => !failedTokens.has(message.to))) {
      for (const message of messages) failedTokens.add(message.to);
      const error = Object.assign(new Error('Synthetic definite throttling'), { statusCode: 429 }); metrics.errors += 1; throw error;
    }
    for (const message of messages) { assert.ok(!sentTokens.has(message.to), 'no duplicate provider submission'); sentTokens.add(message.to); }
    metrics.providerMessages += messages.length;
    return messages.map(() => ({ status: 'ok', id: `synthetic_ticket_${++providerSequence}` }));
  },
  getPushNotificationReceiptsAsync: async ids => { assert.ok(ids.length <= 1000); metrics.receiptsRequested += ids.length;
    return Object.fromEntries(ids.map(id => [id, { status: 'ok' }])); },
};
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;

const main = async () => {
  const started = performance.now(); let simulatedNow = NOW;
  const job = createNotificationJobRecord({ notificationType: 'future_tour_category_broadcast', sourceType: 'future_tour_category_broadcast',
    sourceId: `synthetic_${scenario}`, audienceType: 'marketing', categoryKey: 'day_trips',
    presentation: { title: 'Synthetic campaign', body: 'Never sent to a provider' },
    navigation: { broadcastId: 'synthetic_campaign' }, nowMs: NOW, expiresAtMs: NOW + 86400000 });
  await db.ref('category_broadcasts/day_trips/synthetic_campaign').set({ deliveryJobId: job.jobId });
  await enqueueNotificationJob({ db, job });
  let pages = 0;
  while (!store.data.notification_jobs_v2[job.jobId].fanoutCompletedAtMs) {
    const due = await loadFairDueQueueEntries(db, 'fanout', simulatedNow, 30);
    assert.equal(due.length, 1);
    const [key] = due[0]; const claim = await claimQueueEntry(db.ref(`${QUEUE_ROOTS.fanout}/${key}`), simulatedNow);
    assert.equal(claim.claimed, true);
    await measure('fanout', () => runNotificationJob({ db, jobId: job.jobId, nowMs: simulatedNow, expo, providerClock: () => simulatedNow,
      queueKey: key, queueVersion: claim.entry.version, queueOwnerId: claim.ownerId, queueLeaseExpiresAtMs: claim.entry.lease.expiresAtMs }));
    simulatedNow += 2000; pages += 1;
    if (pages % 100 === 0) process.stderr.write(`Synthetic ${scenario}: ${pages} bounded pages completed\n`);
    assert.ok(pages <= Math.ceil(recipients / 100) + 2);
  }
  if (scenario === 'reconnect') {
    for (let cycle = 0; cycle < 100 && Number(store.data.notification_jobs_v2[job.jobId].counts.retrying || 0); cycle += 1) {
      simulatedNow += 60000;
      await measure('retry', () => retryDueNotificationAttempts({ db, nowMs: simulatedNow, expo, providerClock: () => simulatedNow }));
      if ((cycle + 1) % 25 === 0) process.stderr.write(`Synthetic ${scenario}: ${cycle + 1} retry sweeps completed\n`);
    }
    assert.equal(store.data.notification_jobs_v2[job.jobId].counts.retrying, 0);
  }
  simulatedNow += 15 * 60000;
  for (let cycle = 0; cycle < 200 && Number(store.data.notification_jobs_v2[job.jobId].counts.receiptPending || 0); cycle += 1) {
    const queued = await loadFairDueQueueEntries(db, 'receipt', simulatedNow, 1000);
    for (const [, entry] of queued) metrics.oldestObservedQueueAgeMs = Math.max(metrics.oldestObservedQueueAgeMs, simulatedNow - entry.dueAtMs);
    await measure('receipt', () => processDueNotificationReceipts({ db, nowMs: simulatedNow, expo }));
    if ((cycle + 1) % 25 === 0) process.stderr.write(`Synthetic ${scenario}: ${cycle + 1} receipt sweeps completed; ${store.data.notification_jobs_v2[job.jobId].counts.receiptPending} pending\n`);
    simulatedNow += 60000;
  }
  const final = store.data.notification_jobs_v2[job.jobId];
  assert.equal(final.status, 'provider_accepted'); assert.equal(final.counts.eligible, recipients);
  assert.equal(final.counts.retrying, 0); assert.equal(final.counts.receiptPending, 0); assert.equal(final.counts.receiptAccepted, recipients);
  assert.equal(store.data.category_broadcasts.day_trips.synthetic_campaign.deliveryStatus, final.status);
  assert.equal(Object.keys(store.data[QUEUE_ROOTS.receipt] || {}).length, 0);
  assert.equal(Object.keys(store.data[QUEUE_ROOTS.retry] || {}).length, 0);
  const eligible = classifyNotificationRetentionEligibility({ job: final, nowMs: final.completedAtMs + RETENTION_MS + 1 });
  assert.equal(eligible.eligible, true);
  const tourMetrics = {};
  const smallTour = await enumerateNotificationAudiencePage({ db, job: { audienceContract: 'indexed_v1', audienceType: 'tour', tourId: 'tour_123' }, metrics: tourMetrics });
  assert.equal(smallTour.candidates.length, 75); assert.equal(tourMetrics.rtdbQueries, 1);
  const result = { scenario, synthetic: true, productionNetworkCalls: 0, runtime: process.version,
    population: 60000, eligibleRecipients: recipients, concurrentPreparation: 10, pageSize: 100,
    workloadAssumption: 'One indexed campaign, 800 tours of 75 installations; no real users or cloud throughput claim',
    targets: { maxPageCandidates: 100, maxProviderMessagesPerRequest: 100, duplicateSubmissions: 0,
      accountingConverged: true, completionBefore24HourExpiry: true, fanoutPageP95Ms: 5000, retrySweepP95Ms: 10000,
      peakHeapBytes: 1024 ** 3, virtualCompletionMs: { normal: 1800000, launch: 14400000, reconnect: 7200000 }[scenario] },
    completedPages: pages, simulatedCompletionMs: simulatedNow - NOW, wallDurationMs: performance.now() - started,
    metrics, latencyMs: Object.fromEntries(Object.entries(latencies).map(([kind, values]) => [kind, {
      samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: Math.max(0, ...values),
    }])), finalCounts: final.counts, sourceStatus: final.status, retentionEligible: eligible.eligible,
    smallTour: { candidates: smallTour.candidates.length, queries: tourMetrics.rtdbQueries },
    caveat: 'In-process transactional adapter; byte figures are serialized application payloads, not billed network traffic. Cloud latency, contention, quotas and capacity require isolated deployed verification.' };
  result.targetResults = {
    fanoutP95: result.latencyMs.fanout.p95 < result.targets.fanoutPageP95Ms,
    retryP95: !result.latencyMs.retry.samples || result.latencyMs.retry.p95 < result.targets.retrySweepP95Ms,
    sampledPeakHeap: metrics.peakHeapBytes < result.targets.peakHeapBytes,
    virtualCompletion: result.simulatedCompletionMs < result.targets.virtualCompletionMs,
  };
  assert.ok(result.simulatedCompletionMs < 86400000);
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  assert.ok(Object.values(result.targetResults).every(Boolean), 'A predeclared local or virtual target was missed; inspect measured JSON');
};
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
