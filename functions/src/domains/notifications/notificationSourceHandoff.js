'use strict';

// @ts-check

/**
 * Durable three-stage producer handoff. A retry repeats idempotent source writes,
 * deterministic enqueue, and status publication in that order.
 * @param {{persistSource: Function, enqueue: Function, publishStatus: Function}} input
 */
const runNotificationSourceHandoff = async ({ persistSource, enqueue, publishStatus }) => {
  await persistSource();
  const result = await enqueue();
  await publishStatus(result);
  return result;
};

module.exports = { runNotificationSourceHandoff };
