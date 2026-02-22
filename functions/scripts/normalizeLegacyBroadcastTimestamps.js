#!/usr/bin/env node

/**
 * One-time maintenance script:
 * Converts legacy ISO/string broadcast timestamps to numeric epoch millis.
 *
 * Usage:
 *   FIREBASE_DATABASE_URL="https://<project-id>-default-rtdb.firebaseio.com" \
 *   node functions/scripts/normalizeLegacyBroadcastTimestamps.js --hours=336 --dry-run
 */

const admin = require('firebase-admin');

const HOUR_MS = 60 * 60 * 1000;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    hours: 24 * 14,
    dryRun: false,
  };

  for (const arg of args) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith('--hours=')) {
      const value = Number(arg.split('=')[1]);
      if (Number.isFinite(value) && value > 0) {
        options.hours = value;
      }
    }
  }

  return options;
};

const parseTimestamp = (timestamp) => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;

  if (typeof timestamp === 'string') {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric)) return numeric;

    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
};

const isBroadcastMessage = (message = {}) => {
  if (message.messageType === 'ADMIN_BROADCAST' || message.source === 'web_admin') {
    return true;
  }

  return typeof message.text === 'string' && message.text.toUpperCase().startsWith('ANNOUNCEMENT:');
};

const run = async () => {
  const { hours, dryRun } = parseArgs();
  const cutoffMs = Date.now() - (hours * HOUR_MS);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }

  const db = admin.database();
  const snapshot = await db.ref('chats').once('value');
  const chats = snapshot.val() || {};

  const updates = {};
  let scanned = 0;
  let normalized = 0;

  for (const [tourId, tourData] of Object.entries(chats)) {
    for (const [messageId, message] of Object.entries(tourData?.messages || {})) {
      scanned += 1;
      if (!isBroadcastMessage(message)) continue;

      const timestampMs = parseTimestamp(message.timestamp);
      if (!timestampMs) continue;
      if (timestampMs < cutoffMs) continue;
      if (typeof message.timestamp === 'number') continue;

      updates[`chats/${tourId}/messages/${messageId}/timestamp`] = timestampMs;
      normalized += 1;
    }
  }

  if (dryRun) {
    console.log(JSON.stringify({ scanned, normalized, dryRun: true, hours }, null, 2));
    return;
  }

  if (normalized > 0) {
    await db.ref().update(updates);
  }

  console.log(JSON.stringify({ scanned, normalized, dryRun: false, hours }, null, 2));
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
