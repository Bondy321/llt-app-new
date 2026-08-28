#!/usr/bin/env node
'use strict';

const POLICY_PATH = 'driver_login_policy/v1';

const buildMaterializedOffPolicy = ({ nowMs = Date.now() } = {}) => ({
  schemaVersion: 1,
  enforceSingleDevice: false,
  generation: 0,
  revision: 1,
  updatedAtMs: nowMs,
  transitionPhase: 'stable',
});

const validateStrictRulesPreflightPolicy = (value) => {
  const reasons = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reasons.push('POLICY_MISSING_OR_NOT_OBJECT');
    return { ready: false, reasons };
  }
  if (value.schemaVersion !== 1) reasons.push('POLICY_SCHEMA_INVALID');
  if (value.enforceSingleDevice !== false) reasons.push('POLICY_NOT_EXPLICITLY_OFF');
  if (value.generation !== 0) reasons.push('POLICY_GENERATION_NOT_ZERO');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) reasons.push('POLICY_REVISION_INVALID');
  if (!Number.isSafeInteger(value.updatedAtMs) || value.updatedAtMs <= 0) reasons.push('POLICY_TIMESTAMP_INVALID');
  if (value.transitionPhase !== 'stable'
    || value.transitionId || value.transitionStage || value.targetEnforceSingleDevice !== undefined) {
    reasons.push('POLICY_TRANSITION_NOT_STABLE');
  }
  return { ready: reasons.length === 0, reasons };
};

const readArg = (argv, name) => (argv.find((item) => item.startsWith(`--${name}=`)) || '')
  .slice(name.length + 3).trim();

const parseArgs = (argv = []) => ({
  apply: argv.includes('--apply'),
  materialize: argv.includes('--materialize'),
  projectId: readArg(argv, 'project'),
  databaseURL: readArg(argv, 'database-url'),
  confirmProject: readArg(argv, 'confirm-project'),
});

const run = async ({ admin, options, nowMs = Date.now() }) => {
  const db = admin.database();
  const ref = db.ref(POLICY_PATH);
  const beforeSnapshot = await ref.once('value');
  const before = beforeSnapshot.val();
  const preflight = validateStrictRulesPreflightPolicy(before);
  if (!options.materialize) {
    if (!preflight.ready) {
      const error = new Error(`Strict-rules preflight failed: ${preflight.reasons.join(', ')}`);
      error.code = 'STRICT_RULES_PREFLIGHT_FAILED';
      throw error;
    }
    return { mode: 'preflight', ready: true, policy: { ...before } };
  }
  if (before !== null && before !== undefined) {
    if (!preflight.ready) {
      throw new Error(`Refusing to replace existing unsafe policy: ${preflight.reasons.join(', ')}`);
    }
    return { mode: options.apply ? 'apply' : 'dry-run', changed: false, ready: true, policy: { ...before } };
  }
  const planned = buildMaterializedOffPolicy({ nowMs });
  if (!options.apply) return { mode: 'dry-run', changed: false, wouldCreate: true, policy: planned };
  const projectId = admin.app().options.projectId || process.env.GCLOUD_PROJECT || '';
  if (!projectId || options.confirmProject !== projectId) {
    throw new Error(`Refusing apply: pass --confirm-project=${projectId || '<project-id>'}`);
  }
  const result = await ref.transaction((current) => current ?? planned, undefined, false);
  const policy = result.snapshot.val();
  const after = validateStrictRulesPreflightPolicy(policy);
  if (!after.ready) throw new Error(`Materialized policy failed verification: ${after.reasons.join(', ')}`);
  return { mode: 'apply', changed: result.committed === true, ready: true, policy };
};

const closeAdminApps = async (admin) => Promise.all((admin.apps || []).filter(Boolean)
  .map((app) => typeof app.delete === 'function' ? app.delete() : Promise.resolve()));

const main = async ({ admin, argv = process.argv.slice(2) }) => {
  const options = parseArgs(argv);
  const projectId = options.projectId || process.env.GCLOUD_PROJECT || 'loch-lomond-travel';
  if (!admin.apps.length) admin.initializeApp({
    projectId,
    databaseURL: options.databaseURL || process.env.FIREBASE_DATABASE_URL
      || `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`,
  });
  try {
    const result = await run({ admin, options });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeAdminApps(admin);
  }
};

if (require.main === module) {
  const admin = require('firebase-admin');
  main({ admin }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  POLICY_PATH,
  buildMaterializedOffPolicy,
  closeAdminApps,
  main,
  parseArgs,
  run,
  validateStrictRulesPreflightPolicy,
};
