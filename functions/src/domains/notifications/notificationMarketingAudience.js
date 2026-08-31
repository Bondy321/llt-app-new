'use strict';

// @ts-check

const { TOUR_NOTIFICATION_CATEGORY_KEYS } = require('./notificationPolicy');

const MARKETING_AUDIENCE_ROOT = 'notification_marketing_audience/v1';

/** @param {any} value */
const readPositiveRevision = (value) => (
  Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null
);

/** @param {any} value */
const isValidMarketingAudienceMembership = (value) => Boolean(
  value && value.schemaVersion === 1 && readPositiveRevision(value.registrationRevision)
);

/** @param {{ authUid: string, device: any }} input */
const buildMarketingAudienceUpdates = ({ authUid, device }) => {
  const revision = readPositiveRevision(device?.registrationRevision);
  const eligible = device?.marketingEligible === true
    && device?.status === 'active'
    && typeof device?.pushToken === 'string'
    && device.pushToken.trim().length > 0
    && revision;
  return Object.fromEntries(TOUR_NOTIFICATION_CATEGORY_KEYS.map((categoryKey) => [
    `${MARKETING_AUDIENCE_ROOT}/${categoryKey}/${authUid}`,
    eligible && device?.marketingPreferences?.[categoryKey] === true
      ? { schemaVersion: 1, registrationRevision: revision }
      : null,
  ]));
};

/** @param {{ db: any, authUid: string, device: any }} input */
const persistMarketingAudienceForDevice = async ({ db, authUid, device }) => {
  await db.ref().update(buildMarketingAudienceUpdates({ authUid, device }));
};

/** @param {{ db: any, authUid: string, registrationRevision: number }} input */
const removeMarketingAudienceForRevision = async ({ db, authUid, registrationRevision }) => {
  const expected = readPositiveRevision(registrationRevision);
  if (!expected) return 0;
  let removedCount = 0;
  for (const categoryKey of TOUR_NOTIFICATION_CATEGORY_KEYS) {
    let removed = false;
    await db.ref(`${MARKETING_AUDIENCE_ROOT}/${categoryKey}/${authUid}`).transaction((current) => {
      if (!current || Number(current.registrationRevision || 0) > expected) return current;
      removed = true;
      return null;
    }, undefined, false);
    if (removed) removedCount += 1;
  }
  return removedCount;
};

module.exports = {
  MARKETING_AUDIENCE_ROOT,
  buildMarketingAudienceUpdates,
  isValidMarketingAudienceMembership,
  persistMarketingAudienceForDevice,
  readPositiveRevision,
  removeMarketingAudienceForRevision,
};
