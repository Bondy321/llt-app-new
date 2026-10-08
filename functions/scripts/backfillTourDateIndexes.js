#!/usr/bin/env node
'use strict';

const { deriveTourDateIndexUpdate, parseDateOnly, reconcileTourDateIndexes } = require('../lib/tourDateIndex');
const { selectSnapshotPage } = require('../src/infrastructure/database/rtdbQueryOrder');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const parseArgs = (argv = []) => {
  const options = { apply: false, limit: DEFAULT_LIMIT, pageSize: DEFAULT_PAGE_SIZE, afterKey: '', projectId: '', databaseUrl: '', confirmProject: '', confirmDatabase: '' };
  const names = { project: 'projectId', 'database-url': 'databaseUrl', 'confirm-project': 'confirmProject', 'confirm-database': 'confirmDatabase', 'after-key': 'afterKey' };
  for (const arg of argv) {
    if (arg === '--apply') { options.apply = true; continue; }
    // Retained for older invocations; this script no longer full-scans.
    if (arg === '--allow-full-scan') continue;
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, name, value] = match;
    if (name === 'limit' || name === 'page-size') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
      options[name === 'limit' ? 'limit' : 'pageSize'] = Math.min(parsed, name === 'limit' ? MAX_LIMIT : MAX_PAGE_SIZE);
    } else if (names[name]) options[names[name]] = value.trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

const validateTarget = (options) => {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(options.projectId)) throw new Error('Provide an explicit valid --project');
  let url;
  try { url = new URL(options.databaseUrl); } catch { throw new Error('Provide an explicit --database-url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !['', '/'].includes(url.pathname)
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.(?:firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname)) {
    throw new Error('Database URL must be an exact HTTPS Realtime Database instance URL');
  }
  const databaseId = url.hostname.split('.')[0];
  if (databaseId !== options.projectId && !databaseId.startsWith(`${options.projectId}-`)) {
    throw new Error('Database instance does not match the explicit project');
  }
  if (options.afterKey && /[.#$/[\]\u0000-\u001f\u007f]/.test(options.afterKey)) throw new Error('Invalid --after-key');
  const databaseUrl = url.origin;
  if (options.apply && (options.confirmProject !== options.projectId || options.confirmDatabase !== databaseUrl)) {
    throw new Error('Apply requires --confirm-project and --confirm-database matching the explicit target exactly');
  }
  return { projectId: options.projectId, databaseURL: databaseUrl };
};

const isValidTourDates = (tour) => {
  const start = parseDateOnly(tour?.startDate);
  const end = parseDateOnly(tour?.endDate || tour?.startDate);
  return start !== null && end !== null && end >= start;
};

// Compatibility pure planner; the limit counts examined records, including
// unchanged/invalid records. Malformed dates also remove stale indexes.
const buildUpdates = (tours, limit = DEFAULT_LIMIT) => {
  const updates = {};
  const entries = Object.entries(tours || {});
  const invalidTourIds = [];
  let indexed = 0; let cleared = 0; let unchanged = 0;
  const selected = entries.slice(0, limit);
  for (const [tourId, tour] of selected) {
    const valid = isValidTourDates(tour);
    if (!valid) invalidTourIds.push(tourId);
    const update = deriveTourDateIndexUpdate(tour);
    if (!update) { unchanged += 1; continue; }
    if (valid) indexed += 1; else cleared += 1;
    for (const [field, value] of Object.entries(update)) updates[`tours/${tourId}/${field}`] = value;
  }
  const hasMore = entries.length > selected.length;
  return { updates, summary: { scanned: selected.length, indexed, cleared, unchanged, invalidTourIds, capped: hasMore, nextCursor: hasMore ? selected.at(-1)?.[0] || null : null } };
};

async function runBackfill({ database, options }) {
  const summary = { mode: options.apply ? 'apply' : 'dry-run', scanned: 0, indexed: 0, cleared: 0, unchanged: 0, invalid: 0, missing: 0, pageCount: 0, hasMore: false, nextCursor: null, complete: false };
  let afterKey = options.afterKey || '';
  do {
    const pageSize = Math.min(options.pageSize, options.limit - summary.scanned);
    let query = database.ref('tours').orderByKey();
    if (afterKey) query = query.startAfter(afterKey);
    const snapshot = await query.limitToFirst(pageSize + 1).once('value');
    const page = selectSnapshotPage(snapshot, pageSize);
    summary.pageCount += 1;
    for (const [tourId, scannedTour] of page.entries) {
      let current = scannedTour;
      let changed = Boolean(deriveTourDateIndexUpdate(current));
      if (options.apply) {
        const result = await reconcileTourDateIndexes(database.ref(`tours/${tourId}`));
        changed = result.committed;
        current = result.snapshot?.val?.();
      }
      summary.scanned += 1;
      if (!current) summary.missing += 1;
      else {
        const valid = isValidTourDates(current);
        if (!valid) summary.invalid += 1;
        if (changed) summary[valid ? 'indexed' : 'cleared'] += 1;
        else summary.unchanged += 1;
      }
    }
    afterKey = page.lastKey || afterKey;
    summary.hasMore = page.hasMore;
    summary.nextCursor = page.hasMore ? afterKey : null;
  } while (summary.hasMore && summary.scanned < options.limit);
  summary.complete = !summary.hasMore;
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = validateTarget(options);
  const admin = require('firebase-admin');
  const app = admin.initializeApp(target, 'tour-date-index-backfill');
  try {
    const summary = await runBackfill({ database: app.database(), options });
    process.stdout.write(`${JSON.stringify({ ...target, ...summary }, null, 2)}\n`);
    if (summary.invalid || summary.hasMore) process.exitCode = 2;
  } finally { await app.delete(); }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, parseDateOnly, buildUpdates, validateTarget, runBackfill };
