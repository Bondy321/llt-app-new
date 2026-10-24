'use strict';

// @ts-check

// Shared by every fanout and retry instance. Two adjacent wall-clock seconds
// count together: boundary reservations stay below Expo's 600/project/second.
// Callers may dispatch only before expiresAtMs with a fresh wall clock; delayed
// transaction acknowledgements consume capacity but cannot send late bursts.
// Marketing cannot consume the 200-message operational reserve.
const PROJECT_BUDGET = 500;
const MARKETING_BUDGET = 300;
const reserveProviderBudget = async ({ db, count, marketing = false, nowMs = Date.now() }) => {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('Invalid provider batch');
  const second = Math.floor(nowMs / 1000);
  let granted = false;
  const result = await db.ref('notification_provider_budget/expo_v1').transaction((current) => {
    granted = false;
    const buckets = Object.fromEntries(Object.entries(current?.buckets || {})
      .filter(([key]) => Number(key) >= second - 1));
    // A clock moving backwards cannot discard a reservation made in the future.
    if (Object.keys(buckets).some((key) => Number(key) > second)) return undefined;
    const total = Object.values(buckets).reduce((sum, bucket) => sum + Number(bucket.total || 0), 0);
    const campaigns = Object.values(buckets).reduce((sum, bucket) => sum + Number(bucket.marketing || 0), 0);
    if (total + count > PROJECT_BUDGET || (marketing && campaigns + count > MARKETING_BUDGET)) return undefined;
    const bucket = buckets[second] || { total: 0, marketing: 0 };
    buckets[second] = { total: bucket.total + count, marketing: bucket.marketing + (marketing ? count : 0) };
    granted = true;
    return { schemaVersion: 1, buckets };
  }, undefined, false);
  return { granted: Boolean(result.committed && granted), expiresAtMs: (second + 1) * 1000, retryAtMs: (second + 2) * 1000 };
};

module.exports = { PROJECT_BUDGET, MARKETING_BUDGET, reserveProviderBudget };
