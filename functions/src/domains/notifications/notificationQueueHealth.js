'use strict';

const { loadFairDueQueueEntries } = require('./notificationQueues');
const { log } = require('../../infrastructure/logging/safeLogger');

// Nine indexed reads, at most nine entries. This observes oldest due work;
// it deliberately does not claim a total backlog from a bounded sample.
const recordNotificationQueueHealth = async (db, nowMs = Date.now()) => {
  const queues = {};
  for (const kind of ['fanout', 'retry', 'receipt']) {
    const entries = await loadFairDueQueueEntries(db, kind, nowMs, 3);
    queues[kind] = {};
    for (const lane of ['critical', 'operational', 'marketing']) {
      const entry = entries.find(([, value]) => value.serviceKey?.startsWith(`${lane}~`))?.[1];
      queues[kind][lane] = { hasDueWork: Boolean(entry), oldestDueAgeMs: entry ? Math.max(0, nowMs - Number(entry.dueAtMs)) : 0 };
    }
  }
  log.info('Notification queue health', { schemaVersion: 2, observedAtMs: nowMs, queues });
  return queues;
};

module.exports = { recordNotificationQueueHealth };
