#!/usr/bin/env node
'use strict';

const { runCoachTrackingBackfill } = require('../src/domains/admin-dashboard/coachTrackingFunctions');

const readOption = (argv, name) => {
  const entry = argv.find((value) => value.startsWith(`--${name}=`));
  return entry ? entry.slice(name.length + 3).trim() : null;
};

const EXPECTED_PROJECT = 'loch-lomond-travel';
const EXPECTED_DATABASE_URL = 'https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app';

const normalizeDatabaseUrl = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !['', '/'].includes(url.pathname)) return null;
    return url.origin;
  } catch { return null; }
};

const validateApplyTarget = ({ confirmProject, projectId, databaseUrl, emulatorHost }) => {
  if (confirmProject !== EXPECTED_PROJECT || projectId !== EXPECTED_PROJECT) {
    throw new Error('Apply requires --confirm-project=loch-lomond-travel and credentials targeting that exact Firebase project.');
  }
  if (emulatorHost) throw new Error('Apply mode is disabled when FIREBASE_DATABASE_EMULATOR_HOST is set.');
  if (normalizeDatabaseUrl(databaseUrl) !== EXPECTED_DATABASE_URL) {
    throw new Error('Apply requires the exact loch-lomond-travel-default-rtdb instance in europe-west1.');
  }
};

const parseArgs = (argv = []) => ({
  apply: argv.includes('--apply'),
  confirmProject: readOption(argv, 'confirm-project'),
  pageSize: Number(readOption(argv, 'page-size') || 100),
  concurrency: Number(readOption(argv, 'concurrency') || 5),
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const admin = require('firebase-admin');
  try {
    if (!admin.apps.length) admin.initializeApp();
    const projectId = admin.app().options.projectId
      || process.env.GCLOUD_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || '';
    const db = admin.database();
    const databaseUrl = admin.app().options.databaseURL || db.ref().toString();
    if (options.apply) validateApplyTarget({
      confirmProject: options.confirmProject,
      projectId,
      databaseUrl,
      emulatorHost: process.env.FIREBASE_DATABASE_EMULATOR_HOST,
    });
    const result = await runCoachTrackingBackfill({
      db,
      ...options,
      dryRun: !options.apply,
      onProgress: (progress) => process.stdout.write(`${JSON.stringify(progress)}\n`),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.complete) process.exitCode = 2;
  } finally {
    await Promise.all((admin.apps || []).map((app) => app.delete()));
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, validateApplyTarget, normalizeDatabaseUrl };
