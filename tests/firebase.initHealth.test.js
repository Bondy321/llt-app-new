const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

const originalLoad = Module._load;

test.after(() => {
  Module._load = originalLoad;
});

const loadFirebaseWithMocks = ({ missingConfig = false } = {}) => {
  const calls = { goOnline: 0, goOffline: 0 };

  Module._load = function mocked(request, parent, isMain) {
    if (request === 'firebase/compat/app') {
      const compat = {
        apps: [],
        initializeApp: () => ({ _delegate: { appId: 'app' } }),
        app: () => ({ _delegate: { appId: 'app' } }),
        auth: Object.assign(
          () => ({
            setPersistence: () => Promise.resolve(),
            onAuthStateChanged: () => {},
            currentUser: null,
            signInAnonymously: async () => ({ user: { uid: 'u1', metadata: {} } }),
          }),
          { Auth: { Persistence: { NONE: 'none' } } }
        ),
        firestore: Object.assign(
          () => ({ settings: () => {} }),
          { CACHE_SIZE_UNLIMITED: 1 }
        ),
        database: () => ({
          goOnline: () => { calls.goOnline += 1; },
          goOffline: () => { calls.goOffline += 1; },
          ref: () => ({ on: () => {}, off: () => {}, once: async () => ({ val: () => null }) }),
        }),
      };
      return { __esModule: true, default: compat };
    }

    if (request === 'firebase/compat/auth' || request === 'firebase/compat/firestore' || request === 'firebase/compat/database') {
      return {};
    }

    if (request === 'firebase/storage') {
      return { getStorage: () => ({}) };
    }

    if (request === 'firebase/database') {
      return { getDatabase: () => ({}) };
    }

    if (request.endsWith('/services/persistenceProvider.js')) {
      return { createPersistenceProvider: () => ({ mode: 'memory', getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }) };
    }

    return originalLoad(request, parent, isMain);
  };

  const envBackup = { ...process.env };
  if (missingConfig) {
    process.env.EXPO_PUBLIC_FIREBASE_API_KEY = '';
  } else {
    process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'k';
    process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN = 'd';
    process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL = 'https://db';
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'p';
    process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET = 'bucket';
    process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = 'm';
    process.env.EXPO_PUBLIC_FIREBASE_APP_ID = 'a';
  }

  delete require.cache[require.resolve('../firebase')];
  const firebaseModule = require('../firebase');
  process.env = envBackup;
  return { firebaseModule, calls };
};

test('firebase exposes init health when required config is missing', () => {
  const { firebaseModule } = loadFirebaseWithMocks({ missingConfig: true });
  assert.equal(firebaseModule.firebaseInitHealth.hasError, true);
  assert.equal(firebaseModule.firebaseInitHealth.initialized, false);
  assert.equal(firebaseModule.auth, null);
});

test('updateNetworkState avoids reconnect churn for duplicate connectivity state', () => {
  const { firebaseModule, calls } = loadFirebaseWithMocks({ missingConfig: false });

  const startOnlineCalls = calls.goOnline;
  const startOfflineCalls = calls.goOffline;

  firebaseModule.updateNetworkState(true);
  const afterFirstOnline = calls.goOnline;
  firebaseModule.updateNetworkState(true);
  const afterDuplicateOnline = calls.goOnline;

  firebaseModule.updateNetworkState(false);
  const afterFirstOffline = calls.goOffline;
  firebaseModule.updateNetworkState(false);
  const afterDuplicateOffline = calls.goOffline;

  const onlineDeltaFirst = afterFirstOnline - startOnlineCalls;
  const onlineDeltaDuplicate = afterDuplicateOnline - afterFirstOnline;
  const offlineDeltaFirst = afterFirstOffline - startOfflineCalls;
  const offlineDeltaDuplicate = afterDuplicateOffline - afterFirstOffline;

  assert.ok(onlineDeltaFirst === 0 || onlineDeltaFirst === 1);
  assert.equal(onlineDeltaDuplicate, 0);
  assert.ok(offlineDeltaFirst === 0 || offlineDeltaFirst === 1);
  assert.equal(offlineDeltaDuplicate, 0);
});
