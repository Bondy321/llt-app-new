'use strict';

// @ts-check

const AUDIENCE_ROLLOUT_PATH = 'notification_audience_rollout/v1';
const AUDIENCE_ROLLOUT_PHASES = new Set(['legacy_scan', 'shadow_compare', 'indexed']);

/** @param {any} value */
const normalizeNotificationAudienceRollout = (value) => {
  if (!value || value.schemaVersion !== 1 || !AUDIENCE_ROLLOUT_PHASES.has(value.phase)) {
    return { schemaVersion: 1, phase: 'legacy_scan', revision: 0, fallback: true };
  }
  return {
    schemaVersion: 1,
    phase: value.phase,
    revision: Number.isSafeInteger(Number(value.revision)) && Number(value.revision) >= 1
      ? Number(value.revision)
      : 0,
    fallback: false,
  };
};

/** @param {any} db */
const readNotificationAudienceRollout = async (db) => {
  try {
    return normalizeNotificationAudienceRollout((await db.ref(AUDIENCE_ROLLOUT_PATH).once('value')).val());
  } catch (_error) {
    return normalizeNotificationAudienceRollout(null);
  }
};

module.exports = {
  AUDIENCE_ROLLOUT_PATH,
  AUDIENCE_ROLLOUT_PHASES,
  normalizeNotificationAudienceRollout,
  readNotificationAudienceRollout,
};
