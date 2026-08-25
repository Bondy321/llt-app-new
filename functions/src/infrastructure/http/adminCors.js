'use strict';

// @ts-check

const { getRuntimeEnvironment } = require('../../config/runtimeConfig');

const DEFAULT_ADMIN_PORTAL_ORIGINS = new Set([
  'https://loch-lomond-travel-admin.web.app',
  'https://loch-lomond-travel-admin.firebaseapp.com',
]);

/** @param {unknown} origin @param {unknown} [configuredOrigins] */
const isAllowedAdminOrigin = (
  origin,
  configuredOrigins = getRuntimeEnvironment().ADMIN_PORTAL_ALLOWED_ORIGINS,
) => {
  if (!origin) return true;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(String(origin));
  } catch (_error) {
    return false;
  }
  if (parsedOrigin.origin !== origin || !['http:', 'https:'].includes(parsedOrigin.protocol)) return false;
  if (parsedOrigin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)) return true;
  const extraOrigins = String(configuredOrigins || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return DEFAULT_ADMIN_PORTAL_ORIGINS.has(parsedOrigin.origin) || extraOrigins.includes(parsedOrigin.origin);
};

/** @param {any} req @param {any} res */
const applyAuthenticatedCors = (req, res) => {
  const requestOrigin = typeof req.headers?.origin === 'string' ? req.headers.origin.trim() : '';
  const allowed = isAllowedAdminOrigin(requestOrigin);
  if (requestOrigin && allowed) res.set('Access-Control-Allow-Origin', requestOrigin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '3600');
  return allowed;
};

module.exports = { applyAuthenticatedCors, isAllowedAdminOrigin };
