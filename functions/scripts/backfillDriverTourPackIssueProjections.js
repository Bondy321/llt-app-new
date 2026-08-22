#!/usr/bin/env node

const { buildDriverTourPackActionProjectionUpdates } = require('../lib/driverTourPackOperations');

const parseArgs = (argv = []) => ({
  apply: argv.includes('--apply'),
  allowFullScan: argv.includes('--allow-full-scan'),
});

async function buildMigrationUpdates({ actions = {}, packs = {}, legacyIssues = {} } = {}) {
  const updates = {};
  for (const [departureKey, drivers] of Object.entries(actions || {})) {
    for (const [driverId, afterActions] of Object.entries(drivers || {})) {
      Object.assign(updates, buildDriverTourPackActionProjectionUpdates({
        departureKey,
        driverId,
        pack: packs?.[departureKey] || null,
        beforeActions: null,
        afterActions,
        updatedAtMs: Date.now(),
      }));
      for (const issueId of Object.keys(afterActions?.issues || {})) {
        const legacy = legacyIssues?.[issueId];
        if (legacy?.departureKey === departureKey && legacy?.driverId === driverId && legacy?.issueId === issueId) {
          updates[`driver_tour_pack_issues/${issueId}`] = null;
        }
      }
    }
  }
  return updates;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.apply && !options.allowFullScan) throw new Error('Apply mode requires --allow-full-scan after reviewing a dry run.');
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.database();
  const [actions, packs, legacyIssues] = await Promise.all([
    db.ref('driver_tour_pack_actions').once('value'),
    db.ref('driver_tour_packs').once('value'),
    db.ref('driver_tour_pack_issues').once('value'),
  ]);
  const updates = await buildMigrationUpdates({ actions: actions.val(), packs: packs.val(), legacyIssues: legacyIssues.val() });
  if (options.apply && Object.keys(updates).length) await db.ref('/').update(updates);
  process.stdout.write(`${JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', updateCount: Object.keys(updates).length }, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; });

module.exports = { buildMigrationUpdates, parseArgs };
