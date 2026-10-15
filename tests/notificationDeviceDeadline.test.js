const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
require('@babel/register')({ extensions: ['.js'], presets: ['babel-preset-expo'], ignore: [/node_modules/], cache: false });
const originalLoad = Module._load;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const phase of ['revision', 'auth', 'fetch', 'body', 'backoff']) {
  test(`notification total deadline fences a late ${phase} continuation`, async () => {
    const gate = deferred();
    const oldProject = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'demo-deadline';
    Module._load = function load(request, parent, isMain) {
      if (request === '../../firebase') return { auth: { currentUser: { uid: 'fixture-phone',
        getIdToken: async () => phase === 'auth' ? gate.promise : 'fixture-token' } } };
      if (request === './notificationRegistrationRevision') return {
        allocateNotificationRegistrationRevision: async () => phase === 'revision' ? gate.promise : 1 };
      return originalLoad(request, parent, isMain);
    };
    const modulePath = require.resolve('../services/notifications/notificationDeviceApiService');
    delete require.cache[modulePath];
    const { endNotificationDeviceSession } = require(modulePath);
    let requests = 0;
    let signal;
    const response = { ok: phase !== 'backoff', status: phase === 'backoff' ? 409 : 200,
      json: async () => phase === 'body' ? gate.promise : phase === 'backoff'
        ? { success: false, reason: 'SESSION_IN_PROGRESS' } : { success: true } };
    try {
      await assert.rejects(endNotificationDeviceSession({ appSessionId: 'fixture-session' }, {
        timeoutMs: 20, wait: async () => gate.promise,
        fetchFn: async (_url, options) => { requests += 1; signal = options.signal; return phase === 'fetch' ? gate.promise : response; },
      }), error => error.code === 'NOTIFICATION_REQUEST_TIMEOUT');
      const expectedRequests = ['revision', 'auth'].includes(phase) ? 0 : 1;
      assert.equal(requests, expectedRequests);
      if (signal) assert.equal(signal.aborted, true);
      gate.resolve(phase === 'fetch' ? response : phase === 'body' ? { success: true } : phase === 'revision' ? 1 : 'fixture-token');
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
      assert.equal(requests, expectedRequests, 'late completion cannot send another HTTP request');
    } finally {
      Module._load = originalLoad;
      delete require.cache[modulePath];
      if (oldProject === undefined) delete process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
      else process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = oldProject;
    }
  });
}
