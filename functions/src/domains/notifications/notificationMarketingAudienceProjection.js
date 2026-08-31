'use strict';

// @ts-check

const { onValueWritten } = require('firebase-functions/v2/database');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { TOUR_NOTIFICATION_CATEGORY_KEYS } = require('./notificationPolicy');
const {
  MARKETING_AUDIENCE_ROOT,
  buildMarketingAudienceUpdates,
  readPositiveRevision,
} = require('./notificationMarketingAudience');

/** @param {any} snapshot */
const snapshotValue = (snapshot) => snapshot?.exists?.() ? snapshot.val() : null;

/** @param {{ db: any, authUid: string, beforeDevice?: any, afterDevice?: any }} input */
// eslint-disable-next-line complexity -- compare-safe projection handles create, mutation, revocation and deletion
const projectNotificationMarketingAudience = async (input) => {
  const { db, authUid, beforeDevice = null, afterDevice = null } = input;
  const [deviceSnapshot, consentSnapshot, tombstoneSnapshot] = await Promise.all([
    db.ref(`notification_devices/${authUid}`).once('value'),
    db.ref(`notification_consents/${authUid}`).once('value'),
    db.ref(`notification_device_tombstones/${authUid}`).once('value'),
  ]);
  const device = deviceSnapshot.val();
  const consent = consentSnapshot.val();
  const tombstone = tombstoneSnapshot.val();
  const sourceRevision = Math.max(
    Number(beforeDevice?.registrationRevision || 0),
    Number(afterDevice?.registrationRevision || 0),
    Number(device?.registrationRevision || 0),
    Number(tombstone?.registrationRevision || 0),
  );
  const canonicalRevision = readPositiveRevision(device?.registrationRevision);
  const canonical = tombstone?.permanent !== true
    && canonicalRevision
    ? {
      ...device,
      marketingPreferences: Object.fromEntries(TOUR_NOTIFICATION_CATEGORY_KEYS.map((categoryKey) => [
        categoryKey,
        device?.marketingPreferences?.[categoryKey] === true
          && consent?.marketingPreferences?.[categoryKey] === true,
      ])),
    }
    : null;
  const desired = buildMarketingAudienceUpdates({ authUid, device: canonical });
  let changed = 0;
  for (const categoryKey of TOUR_NOTIFICATION_CATEGORY_KEYS) {
    const path = `${MARKETING_AUDIENCE_ROOT}/${categoryKey}/${authUid}`;
    const next = desired[path];
    let wrote = false;
    await db.ref(path).transaction((current) => {
      const currentRevision = Number(current?.registrationRevision || 0);
      if (currentRevision > sourceRevision) return current;
      if (next && currentRevision > Number(next.registrationRevision || 0)) return current;
      if (next && Number(next.registrationRevision) !== canonicalRevision) return current;
      wrote = JSON.stringify(current || null) !== JSON.stringify(next || null);
      return next;
    }, undefined, false);
    if (wrote) changed += 1;
  }
  return { changed, registrationRevision: canonicalRevision || sourceRevision || 0 };
};

const projectNotificationMarketingAudienceOnDeviceWrite = onValueWritten({
  ref: '/notification_devices/{authUid}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  retry: true,
  maxInstances: 10,
}, async (event) => projectNotificationMarketingAudience({
  db: admin.database(),
  authUid: event.params.authUid,
  beforeDevice: snapshotValue(event.data.before),
  afterDevice: snapshotValue(event.data.after),
}));

const projectNotificationMarketingAudienceOnConsentWrite = onValueWritten({
  ref: '/notification_consents/{authUid}',
  region: 'europe-west1',
  instance: 'loch-lomond-travel-default-rtdb',
  retry: true,
  maxInstances: 10,
}, async (event) => projectNotificationMarketingAudience({
  db: admin.database(),
  authUid: event.params.authUid,
}));

module.exports = {
  projectNotificationMarketingAudience,
  projectNotificationMarketingAudienceOnConsentWrite,
  projectNotificationMarketingAudienceOnDeviceWrite,
};
