#!/usr/bin/env node

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;

const parseArgs = (argv = []) => {
  const options = { apply: false, allowFullScan: false, limit: DEFAULT_LIMIT };
  argv.forEach((arg) => {
    if (arg === '--apply') options.apply = true;
    if (arg === '--allow-full-scan') options.allowFullScan = true;
    if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (Number.isSafeInteger(parsed) && parsed > 0) options.limit = Math.min(parsed, MAX_LIMIT);
    }
  });
  return options;
};

const parseDateOnly = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  let year;
  let month;
  let day;
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (match) [, day, month, year] = match.map(Number);
  else {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) return null;
    [, year, month, day] = match.map(Number);
  }
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? ms : null;
};

const buildUpdates = (tours, limit) => {
  const updates = {};
  const invalidTourIds = [];
  let scanned = 0;
  let indexed = 0;
  let unchanged = 0;

  for (const [tourId, tour] of Object.entries(tours || {})) {
    scanned += 1;
    const startDateEpochMs = parseDateOnly(tour?.startDate);
    const endDateEpochMs = parseDateOnly(tour?.endDate || tour?.startDate);
    if (startDateEpochMs === null || endDateEpochMs === null || endDateEpochMs < startDateEpochMs) {
      invalidTourIds.push(tourId);
      continue;
    }
    if (tour.startDateEpochMs === startDateEpochMs && tour.endDateEpochMs === endDateEpochMs) {
      unchanged += 1;
      continue;
    }
    if (indexed >= limit) continue;
    updates[`tours/${tourId}/startDateEpochMs`] = startDateEpochMs;
    updates[`tours/${tourId}/endDateEpochMs`] = endDateEpochMs;
    indexed += 1;
  }
  return { updates, summary: { scanned, indexed, unchanged, invalidTourIds, capped: indexed >= limit } };
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.apply && !options.allowFullScan) {
    throw new Error('Apply mode reads the complete tours root. Re-run with --apply --allow-full-scan after reviewing a dry run.');
  }
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  const database = admin.database();
  const snapshot = await database.ref('tours').once('value');
  const { updates, summary } = buildUpdates(snapshot.val() || {}, options.limit);
  if (options.apply && Object.keys(updates).length) await database.ref().update(updates);
  process.stdout.write(`${JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', ...summary }, null, 2)}\n`);
  if (summary.invalidTourIds.length) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, parseDateOnly, buildUpdates };
