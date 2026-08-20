'use strict';

const { OAuth2Client } = require('google-auth-library');

const DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT = 'llt-dashboard-sync-runner@llt-management-dashboard.iam.gserviceaccount.com';
const DEFAULT_DRIVER_TOUR_PACK_AUDIENCE = 'https://europe-west1-loch-lomond-travel.cloudfunctions.net/ingestDriverTourPacks';
const MAX_BEARER_TOKEN_LENGTH = 16_384;

function validateDriverTourPackHttpRequest(request, { maxBodyBytes = 2_000_000 } = {}) {
  if (request?.get?.('origin') || request?.headers?.origin) {
    return { valid: false, status: 403, code: 'BROWSER_ORIGIN_FORBIDDEN' };
  }
  if (request?.method !== 'POST') return { valid: false, status: 405, code: 'METHOD_NOT_ALLOWED' };
  const contentType = request?.get?.('content-type') || request?.headers?.['content-type'] || '';
  if (!String(contentType).toLowerCase().startsWith('application/json')) {
    return { valid: false, status: 415, code: 'JSON_REQUIRED' };
  }
  if (request?.rawBody?.length > maxBodyBytes) return { valid: false, status: 413, code: 'BODY_TOO_LARGE' };
  return { valid: true };
}

class ManagementOidcError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = 'ManagementOidcError';
    this.code = code;
    this.status = status;
  }
}

async function verifyManagementOidcRequest(request, {
  audience = process.env.DRIVER_TOUR_PACK_AUDIENCE || DEFAULT_DRIVER_TOUR_PACK_AUDIENCE,
  expectedEmail = process.env.DRIVER_TOUR_PACK_CALLER_SERVICE_ACCOUNT || DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT,
  client = new OAuth2Client(),
} = {}) {
  if (!audience || !expectedEmail) throw new ManagementOidcError('OIDC_CONFIGURATION_INVALID', 'OIDC verification is not configured.', 500);
  const token = extractBearerToken(request);
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken: token, audience });
  } catch {
    throw new ManagementOidcError('OIDC_TOKEN_INVALID', 'The Google OIDC token is invalid.');
  }
  const payload = ticket?.getPayload?.() || {};
  if (payload.email !== expectedEmail || payload.email_verified !== true) {
    throw new ManagementOidcError('OIDC_CALLER_FORBIDDEN', 'The authenticated caller is not authorized.', 403);
  }
  if (!payload.sub || !['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) {
    throw new ManagementOidcError('OIDC_CLAIMS_INVALID', 'The Google OIDC claims are incomplete.');
  }
  return {
    subject: payload.sub,
    email: payload.email,
    audience,
  };
}

function extractBearerToken(request) {
  const rawHeader = request?.get?.('authorization')
    || request?.headers?.authorization
    || request?.headers?.Authorization
    || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(rawHeader).trim());
  if (!match || match[1].length > MAX_BEARER_TOKEN_LENGTH) {
    throw new ManagementOidcError('OIDC_TOKEN_MISSING', 'A Google OIDC bearer token is required.');
  }
  return match[1];
}

module.exports = {
  DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT,
  DEFAULT_DRIVER_TOUR_PACK_AUDIENCE,
  ManagementOidcError,
  validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest,
  extractBearerToken,
};
