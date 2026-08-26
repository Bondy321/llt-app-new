#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { Expo } = require('expo-server-sdk');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const readArg = (argv, name) => (argv.find((arg) => arg.startsWith(`--${name}=`)) || '')
  .slice(name.length + 3)
  .trim();

const parseArgs = (argv = []) => {
  const requestedPageSize = Number(readArg(argv, 'page-size'));
  return {
    apply: argv.includes('--apply'),
    disableLegacyFallback: argv.includes('--disable-legacy-fallback'),
    confirmProject: readArg(argv, 'confirm-project'),
    afterUid: readArg(argv, 'after-uid'),
    pageSize: Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0
      ? Math.min(requestedPageSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE,
  };
};

const normalizePermissionState = (value) => {
  const state = String(value || '').trim().toLowerCase();
  return ['granted', 'provisional', 'ephemeral', 'denied', 'blocked', 'unavailable'].includes(state)
    ? state
    : 'unavailable';
};

const normalizeMarketingPreferences = (profile) => Object.fromEntries(
  Object.entries(profile?.preferences?.marketing || {}).map(([key, enabled]) => [key, enabled === true]),
);

const buildNotificationDeviceProjection = ({ authUid, profile, session, nowMs }) => {
  const permissionState = normalizePermissionState(profile?.pushPermissionState);
  const permissionAllowsPush = ['granted', 'provisional', 'ephemeral'].includes(permissionState);
  const legacyToken = typeof profile?.pushToken === 'string' ? profile.pushToken.trim() : '';
  const pushToken = permissionAllowsPush && Expo.isExpoPushToken(legacyToken) ? legacyToken : null;
  const marketingPreferences = normalizeMarketingPreferences(profile);
  const hasMarketingConsent = Object.values(marketingPreferences).some(Boolean);
  const activeSession = Boolean(session
    && session.status === 'active'
    && session.authUid === authUid
    && Number(session.expiresAtMs || 0) > nowMs);
  const operationalEligible = Boolean(pushToken
    && activeSession
    && String(profile?.pushTokenStatus || '').toUpperCase() === 'ACTIVE');
  const marketingEligible = Boolean(pushToken && hasMarketingConsent);
  const updatedAtMs = Number(profile?.pushTokenUpdatedAtMs || nowMs);
  return {
    device: {
      schemaVersion: 1,
      authUid,
      pushToken,
      tokenHash: pushToken ? createHash('sha256').update(pushToken).digest('hex') : null,
      provider: 'expo',
      status: pushToken ? 'active' : (permissionAllowsPush ? 'inactive' : permissionState),
      permissionState,
      permissionCanAskAgain: profile?.pushPermissionCanAskAgain === true,
      operationalEligible,
      operationalTourId: operationalEligible ? session.tourId : null,
      marketingEligible,
      marketingPreferences,
      marketingConsentVersion: 1,
      marketingConsentUpdatedAtMs: Number(profile?.marketingConsentUpdatedAtMs || updatedAtMs),
      appVersion: profile?.appVersion || null,
      appBuild: profile?.appBuild || null,
      platform: profile?.deviceOS || null,
      createdAtMs: updatedAtMs,
      updatedAtMs,
    },
    consent: {
      schemaVersion: 1,
      authUid,
      marketingPreferences,
      consentVersion: 1,
      consentUpdatedAtMs: Number(profile?.marketingConsentUpdatedAtMs || updatedAtMs),
      updatedAtMs,
    },
  };
};

const readUserPage = async ({ db, afterUid, pageSize }) => {
  let query = db.ref('users').orderByKey();
  if (afterUid) query = query.startAfter(afterUid);
  const snapshot = await query.limitToFirst(pageSize + 1).once('value');
  const entries = Object.entries(snapshot.val() || {}).sort(([left], [right]) => left.localeCompare(right));
  const selected = entries.slice(0, pageSize);
  return {
    entries: selected,
    nextCursor: entries.length > pageSize && selected.length ? selected.at(-1)[0] : null,
  };
};

const migratePage = async ({ db, entries, apply, nowMs }) => {
  const summary = { scanned: entries.length, eligibleLegacyTokens: 0, created: 0, preserved: 0 };
  for (const [authUid, profile] of entries) {
    const token = typeof profile?.pushToken === 'string' ? profile.pushToken.trim() : '';
    if (!token) continue;
    summary.eligibleLegacyTokens += 1;
    const session = (await db.ref(`app_sessions/${authUid}`).once('value')).val();
    const projection = buildNotificationDeviceProjection({ authUid, profile, session, nowMs });
    if (!apply) continue;
    let created = false;
    await db.ref(`notification_devices/${authUid}`).transaction((current) => {
      if (current) return;
      created = true;
      return projection.device;
    });
    if (created) {
      summary.created += 1;
      await db.ref(`notification_consents/${authUid}`).transaction((current) => current || projection.consent);
    } else {
      summary.preserved += 1;
    }
  }
  return summary;
};

const run = async ({ admin, options, nowMs = Date.now() }) => {
  const projectId = admin.app().options.projectId || process.env.GCLOUD_PROJECT || '';
  if (options.apply && (!projectId || options.confirmProject !== projectId)) {
    throw new Error(`Refusing apply: pass --confirm-project=${projectId || '<project-id>'}`);
  }
  const db = admin.database();
  const page = await readUserPage({ db, afterUid: options.afterUid, pageSize: options.pageSize });
  const summary = await migratePage({ db, entries: page.entries, apply: options.apply, nowMs });
  const migrationComplete = !page.nextCursor;
  let legacyFallbackEnabled = !options.disableLegacyFallback;
  if (options.disableLegacyFallback && (!options.apply || !migrationComplete)) {
    throw new Error('Legacy fallback can be disabled only after applying the final migration page');
  }
  if (options.apply) {
    const stateResult = await db.ref('notification_migrations/device_registry_v1').transaction((current = {}) => {
      const completed = current.completed === true || migrationComplete;
      return {
        ...current,
        schemaVersion: 1,
        completed,
        legacyFallbackEnabled: current.legacyFallbackEnabled === false || options.disableLegacyFallback
          ? false
          : true,
        lastCursor: page.nextCursor || null,
        updatedAtMs: nowMs,
        ...(completed ? { completedAtMs: Number(current.completedAtMs || nowMs) } : {}),
      };
    });
    legacyFallbackEnabled = stateResult.snapshot.val()?.legacyFallbackEnabled !== false;
  }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    projectId,
    ...summary,
    nextCursor: page.nextCursor,
    legacyFieldsPreserved: true,
    migrationComplete,
    legacyFallbackEnabled,
  };
};

async function main() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  const result = await run({ admin, options: parseArgs(process.argv.slice(2)) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildNotificationDeviceProjection,
  migratePage,
  normalizeMarketingPreferences,
  normalizePermissionState,
  parseArgs,
  readUserPage,
  run,
};
