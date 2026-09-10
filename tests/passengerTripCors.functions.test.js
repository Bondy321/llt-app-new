'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('../functions/node_modules/express');

process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-passenger-trip-cors' });
process.env.PASSENGER_APP_ALLOWED_ORIGINS = [
  'https://passenger-production.example.test',
  'https://passenger-staging.example.test',
].join(',');

const {
  createPassengerTripSnapshotFunction,
} = require('../functions/src/domains/passenger-trip/passengerTripFunctions');

const AUTH_UID = 'passenger-auth-uid';
const PRINCIPAL_ID = `pax_v2_${'a'.repeat(32)}`;
const SESSION_ID = `sess_v1_${'b'.repeat(32)}`;
const BOOKING_REF = 'BOOK123';
const TOUR_ID = '5112D_8';
const PRODUCTION_ORIGIN = 'https://passenger-production.example.test';
const STAGING_ORIGIN = 'https://passenger-staging.example.test';
const DEVELOPMENT_ORIGIN = 'http://localhost:8081';

const allowedAccess = {
  allowed: true,
  principalId: PRINCIPAL_ID,
  tourId: TOUR_ID,
  session: { sessionId: SESSION_ID },
};

const validSnapshot = {
  schemaVersion: 1,
  scope: {
    authUid: AUTH_UID,
    principalId: PRINCIPAL_ID,
    bookingRef: BOOKING_REF,
    tourId: TOUR_ID,
    sessionId: SESSION_ID,
  },
  checkedAtMs: 1_789_000_000_000,
  parts: {
    booking: { status: 'value', version: 'c'.repeat(64), data: { pickupTime: '08:30' } },
  },
};

const startEndpoint = async ({ authorizeRequest, verifySession } = {}) => {
  const handler = createPassengerTripSnapshotFunction({
    dbFactory: () => ({}),
    authorizeRequest: authorizeRequest || (async ({ req }) => ({
      success: true,
      uid: AUTH_UID,
      authorization: req.headers.authorization,
      appCheck: req.headers['x-firebase-appcheck'],
    })),
    verifySession: verifySession || (async () => allowedAccess),
    ensureNoAccountDeletion: async () => true,
    ensureNoPassengerDeletion: async () => true,
    clock: () => validSnapshot.checkedAtMs,
    snapshotReader: async () => validSnapshot,
  });
  const app = express();
  app.use(express.json());
  app.use(handler);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/getPassengerTripSnapshot`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
};

const requestBody = {
  expectedSessionId: SESSION_ID,
  parts: ['booking'],
  versions: {},
};

test('real Firebase wrapper completes allowed browser preflight before authentication', async () => {
  let authorizationCalls = 0;
  const endpoint = await startEndpoint({
    authorizeRequest: async () => {
      authorizationCalls += 1;
      return { success: true, uid: AUTH_UID };
    },
  });
  try {
    const response = await fetch(endpoint.url, {
      method: 'OPTIONS',
      headers: {
        Origin: DEVELOPMENT_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-firebase-appcheck',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), DEVELOPMENT_ORIGIN);
    assert.match(response.headers.get('access-control-allow-methods') || '', /POST/u);
    const allowedHeaders = (response.headers.get('access-control-allow-headers') || '').toLowerCase();
    for (const header of ['authorization', 'content-type', 'x-firebase-appcheck']) {
      assert.match(allowedHeaders, new RegExp(`(?:^|,)\\s*${header}(?:,|$)`, 'u'));
    }
    assert.equal(authorizationCalls, 0);
  } finally {
    await endpoint.close();
  }
});

test('allowed configured production origin can read an authorized POST response', async () => {
  let observedHeaders = null;
  const endpoint = await startEndpoint({
    authorizeRequest: async ({ req }) => {
      observedHeaders = req.headers;
      return { success: true, uid: AUTH_UID };
    },
  });
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        Origin: PRODUCTION_ORIGIN,
        Authorization: 'Bearer browser-token',
        'Content-Type': 'application/json',
        'x-firebase-appcheck': 'browser-app-check-token',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), PRODUCTION_ORIGIN);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.deepEqual(await response.json(), validSnapshot);
    assert.equal(observedHeaders.authorization, 'Bearer browser-token');
    assert.equal(observedHeaders['x-firebase-appcheck'], 'browser-app-check-token');
  } finally {
    await endpoint.close();
  }
});

test('allowed configured staging origin can read structured session errors', async () => {
  const endpoint = await startEndpoint({
    verifySession: async () => ({ allowed: false, reason: 'SESSION_INACTIVE' }),
  });
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        Origin: STAGING_ORIGIN,
        Authorization: 'Bearer browser-token',
        'Content-Type': 'application/json',
        'x-firebase-appcheck': 'browser-app-check-token',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), STAGING_ORIGIN);
    assert.deepEqual(await response.json(), { success: false, reason: 'SESSION_EXPIRED' });
  } finally {
    await endpoint.close();
  }
});

test('denied browser origin receives no CORS grant and never reaches authentication', async () => {
  let authorizationCalls = 0;
  const endpoint = await startEndpoint({
    authorizeRequest: async () => {
      authorizationCalls += 1;
      return { success: true, uid: AUTH_UID };
    },
  });
  try {
    const preflight = await fetch(endpoint.url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-firebase-appcheck',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        Authorization: 'Bearer browser-token',
        'Content-Type': 'application/json',
        'x-firebase-appcheck': 'browser-app-check-token',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), { success: false, reason: 'ORIGIN_NOT_ALLOWED' });
    assert.equal(authorizationCalls, 0);
  } finally {
    await endpoint.close();
  }
});

test('allowed origin can read a structured outer authentication failure', async () => {
  const endpoint = await startEndpoint({
    authorizeRequest: async ({ res }) => {
      res.status(401).json({ success: false, reason: 'APP_CHECK_REQUIRED' });
      return null;
    },
  });
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        Origin: PRODUCTION_ORIGIN,
        Authorization: 'Bearer browser-token',
        'Content-Type': 'application/json',
        'x-firebase-appcheck': 'invalid-browser-app-check-token',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), PRODUCTION_ORIGIN);
    assert.deepEqual(await response.json(), { success: false, reason: 'APP_CHECK_REQUIRED' });
  } finally {
    await endpoint.close();
  }
});

test('origin-absent native transport remains compatible', async () => {
  const endpoint = await startEndpoint();
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer native-token',
        'Content-Type': 'application/json',
        'x-firebase-appcheck': 'native-app-check-token',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), validSnapshot);
  } finally {
    await endpoint.close();
  }
});
