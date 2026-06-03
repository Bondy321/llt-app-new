#!/usr/bin/env node

/**
 * Maintenance utility:
 * Converts legacy ISO/numeric-string broadcast chat timestamps to epoch millis.
 *
 * Defaults to dry-run. Use --apply after reviewing the summary.
 */

const {
  getOptionValue,
  isPlainObject,
  parseBooleanFlag,
  parsePositiveInteger,
  trimString,
} = require('./scriptUtils');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURS = 24 * 14;
const ISO_TIMESTAMP_WITH_ZONE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;

const loadFirebaseAdmin = () => {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin;
};

const parseArgs = (argv = []) => {
  const dryRunFlag = getOptionValue(argv, 'dry-run');
  let dryRun = true;

  if (argv.includes('--apply')) {
    dryRun = false;
  } else if (argv.includes('--dry-run')) {
    dryRun = true;
  } else if (dryRunFlag !== null) {
    dryRun = !['false', '0', 'no'].includes(dryRunFlag.trim().toLowerCase());
  }

  const parsedHours = Number(getOptionValue(argv, 'hours'));
  const hours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : DEFAULT_HOURS;

  return {
    dryRun,
    hours,
    tourId: trimString(getOptionValue(argv, 'tourId')),
    limit: parsePositiveInteger(getOptionValue(argv, 'limit'), { defaultValue: null, max: 5000 }),
    allowFullScan: parseBooleanFlag(argv, 'allow-full-scan', false),
  };
};

const parseTimestamp = (timestamp) => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;

  const trimmed = trimString(timestamp);
  if (!trimmed) return null;

  if (NUMERIC_PATTERN.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }

  const isoMatch = ISO_TIMESTAMP_WITH_ZONE_PATTERN.exec(trimmed);
  if (isoMatch) {
    const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond = '0', rawMs = '0'] = isoMatch;
    if (!isValidIsoDateTimeParts({
      year: Number(rawYear),
      month: Number(rawMonth),
      day: Number(rawDay),
      hour: Number(rawHour),
      minute: Number(rawMinute),
      second: Number(rawSecond),
      millisecond: Number(rawMs.padEnd(3, '0')),
    })) {
      return null;
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const isValidIsoDateTimeParts = ({
  year,
  month,
  day,
  hour,
  minute,
  second,
  millisecond,
}) => {
  if (
    month < 1 || month > 12
    || hour < 0 || hour > 23
    || minute < 0 || minute > 59
    || second < 0 || second > 59
    || millisecond < 0 || millisecond > 999
  ) {
    return false;
  }

  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return (
    candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day
    && candidate.getUTCHours() === hour
    && candidate.getUTCMinutes() === minute
    && candidate.getUTCSeconds() === second
    && candidate.getUTCMilliseconds() === millisecond
  );
};

const isBroadcastMessage = (message = {}) => {
  if (message.messageType === 'ADMIN_BROADCAST' || message.source === 'web_admin') {
    return true;
  }

  return typeof message.text === 'string' && message.text.toUpperCase().startsWith('ANNOUNCEMENT:');
};

const buildBroadcastTimestampUpdatePlan = (chats = {}, options = {}) => {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cutoffMs = nowMs - ((Number.isFinite(options.hours) ? options.hours : DEFAULT_HOURS) * HOUR_MS);
  const targetTourId = trimString(options.tourId);
  const limit = Number.isFinite(options.limit) ? options.limit : null;
  const scopedChats = targetTourId ? { [targetTourId]: { messages: chats || {} } } : chats;
  const updates = {};
  const samplePaths = [];
  let scanned = 0;
  let broadcastMessages = 0;
  let normalized = 0;
  let skippedAlreadyNumeric = 0;
  let skippedUnparseable = 0;
  let skippedOlderThanCutoff = 0;
  let skippedByLimit = 0;

  for (const [tourId, tourData] of Object.entries(scopedChats || {})) {
    const messages = isPlainObject(tourData?.messages) ? tourData.messages : {};

    for (const [messageId, message] of Object.entries(messages)) {
      scanned += 1;
      if (!isBroadcastMessage(message)) continue;
      broadcastMessages += 1;

      if (limit !== null && normalized >= limit) {
        skippedByLimit += 1;
        continue;
      }

      const timestampMs = parseTimestamp(message.timestamp);
      if (!Number.isFinite(timestampMs)) {
        skippedUnparseable += 1;
        continue;
      }

      if (timestampMs < cutoffMs) {
        skippedOlderThanCutoff += 1;
        continue;
      }

      if (typeof message.timestamp === 'number') {
        skippedAlreadyNumeric += 1;
        continue;
      }

      const path = `chats/${tourId}/messages/${messageId}/timestamp`;
      updates[path] = timestampMs;
      normalized += 1;

      if (samplePaths.length < 10) {
        samplePaths.push(path);
      }
    }
  }

  return {
    updates,
    summary: {
      scanned,
      broadcastMessages,
      normalized,
      skippedAlreadyNumeric,
      skippedUnparseable,
      skippedOlderThanCutoff,
      skippedByLimit,
      updatesPrepared: Object.keys(updates).length,
      samplePaths,
    },
  };
};

const validateOptions = (options = {}) => {
  if (options.dryRun === false && !options.allowFullScan && !options.tourId) {
    throw new Error('Refusing to apply across all chat broadcasts without --tourId or --allow-full-scan');
  }
};

const run = async (options = {}, deps = {}) => {
  const dryRun = options.dryRun !== false;
  validateOptions({ ...options, dryRun });

  const admin = deps.admin || loadFirebaseAdmin();
  const db = deps.db || admin.database();
  const rootPath = options.tourId ? `chats/${options.tourId}/messages` : 'chats';
  const snapshot = await db.ref(rootPath).once('value');
  const chats = snapshot.val() || {};
  const { updates, summary } = buildBroadcastTimestampUpdatePlan(chats, options);

  if (!dryRun && Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  return {
    success: true,
    mode: dryRun ? 'dry-run' : 'apply',
    hours: Number.isFinite(options.hours) ? options.hours : DEFAULT_HOURS,
    tourId: options.tourId || null,
    ...summary,
  };
};

const main = async (argv = process.argv.slice(2), deps = {}) => {
  const options = parseArgs(argv);
  const result = await run(options, deps);
  console.log(JSON.stringify(result, null, 2));
  return result;
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  buildBroadcastTimestampUpdatePlan,
  isBroadcastMessage,
  main,
  parseArgs,
  parseTimestamp,
  run,
  validateOptions,
};
