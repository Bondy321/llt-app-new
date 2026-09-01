#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');

const readArg = (argv, name) => (argv.find((arg) => arg.startsWith(`--${name}=`)) || '')
  .slice(name.length + 3).trim();

const readPositiveInteger = (argv, name, fallback, maximum) => {
  const value = Number(readArg(argv, name));
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
};

const hashOperationalCursor = (value) => value
  ? createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
  : null;

const resolveProjectId = (admin) => String(
  admin?.app?.().options?.projectId || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '',
).trim();

const requireExactProject = ({ admin, confirmProject }) => {
  const projectId = resolveProjectId(admin);
  if (!projectId || confirmProject !== projectId) {
    throw new Error(`Refusing production retention operation: pass --confirm-project=${projectId || '<project-id>'}`);
  }
  return projectId;
};

const formatOperationalError = (error) => {
  const code = typeof error?.code === 'string' ? error.code.trim().toUpperCase() : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'OPERATION_FAILED';
};

const SENSITIVE_OUTPUT_KEY = /(attempt|auth|booking|job|message|navigation|passenger|presentation|recipient|source|token|tour|uid)id$|token|presentation|navigation|message|booking|passenger|recipientuid|authuid/iu;

/**
 * Operational commands emit aggregate evidence only. Cursor-like continuation
 * values are hashed; any accidental identifier/content field is omitted.
 * @param {any} value @param {string} key
 */
const sanitizeOperationalOutput = (value, key = '') => {
  if (value === null || value === undefined) return value;
  if (/cursor/iu.test(key)) return hashOperationalCursor(value);
  if (SENSITIVE_OUTPUT_KEY.test(key) && key !== 'projectId') return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOperationalOutput(entry, key)).filter((entry) => entry !== undefined);
  }
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([childKey, childValue]) => [childKey, sanitizeOperationalOutput(childValue, childKey)])
    .filter(([, childValue]) => childValue !== undefined));
};

const closeAdminApps = async (admin) => {
  for (const app of admin?.apps || []) await app.delete();
};

const runMain = async (runner) => {
  const admin = require('firebase-admin');
  try {
    if (!admin.apps.length) admin.initializeApp();
    const result = await runner(admin);
    process.stdout.write(`${JSON.stringify(sanitizeOperationalOutput(result), null, 2)}\n`);
  } finally {
    await closeAdminApps(admin);
  }
};

module.exports = {
  closeAdminApps,
  formatOperationalError,
  hashOperationalCursor,
  readArg,
  readPositiveInteger,
  requireExactProject,
  resolveProjectId,
  runMain,
  sanitizeOperationalOutput,
};
