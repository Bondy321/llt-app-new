const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

const originalLoad = Module._load;
const firebaseEnvKeys = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_DATABASE_URL',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
];

const validFirebaseEnv = {
  EXPO_PUBLIC_FIREBASE_API_KEY: `AIza${'a'.repeat(32)}`,
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'loch-lomond-travel.firebaseapp.com',
  EXPO_PUBLIC_FIREBASE_DATABASE_URL: 'https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app',
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'loch-lomond-travel',
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: 'loch-lomond-travel.firebasestorage.app',
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '500767842880',
  EXPO_PUBLIC_FIREBASE_APP_ID: '1:500767842880:web:b27b5630eed50e6ea4f5a5',
};

const restoreFirebaseEnv = (backup) => {
  firebaseEnvKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(backup, key)) {
      process.env[key] = backup[key];
    } else {
      delete process.env[key];
    }
  });
};

const clearFirebaseModuleCache = () => {
  Object.keys(require.cache).forEach((cacheKey) => {
    if (cacheKey.endsWith(`${path.sep}firebase.js`) || cacheKey.endsWith('/firebase.js')) {
      delete require.cache[cacheKey];
    }
  });
};

test.after(() => {
  Module._load = originalLoad;
});

const loadFirebaseWithMocks = ({ missingConfig = false, placeholderConfig = false } = {}) => {
  const calls = { goOnline: 0, goOffline: 0 };

  Module._load = function mocked(request, parent, isMain) {
    if (request === 'firebase/compat/app') {
      const compat = {
        apps: [],
        initializeApp: () => ({ _delegate: { appId: 'app' } }),
        app: () => ({ _delegate: { appId: 'app' } }),
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

    if (request === 'firebase/auth') {
      const authState = { currentUser: null };
      return {
        getAuth: () => authState,
        getReactNativePersistence: () => ({ type: 'react-native' }),
        initializeAuth: () => authState,
        onAuthStateChanged: (_auth, callback) => {
          callback(authState.currentUser);
          return () => {};
        },
        signInAnonymously: async () => ({ user: { uid: 'u1', metadata: {} } }),
      };
    }

    if (request === 'firebase/database') {
      return { getDatabase: () => ({}) };
    }

    if (request === '@react-native-async-storage/async-storage') {
      return { __esModule: true, default: {} };
    }

    if (request.endsWith('/services/persistenceProvider.js')) {
      return { createPersistenceProvider: () => ({ mode: 'memory', getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }) };
    }

    return originalLoad(request, parent, isMain);
  };

  const envBackup = {};
  firebaseEnvKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      envBackup[key] = process.env[key];
    }
    delete process.env[key];
  });

  Object.assign(process.env, validFirebaseEnv);
  if (placeholderConfig) {
    process.env.EXPO_PUBLIC_FIREBASE_API_KEY = '@firebase_api_key';
  } else if (missingConfig) {
    process.env.EXPO_PUBLIC_FIREBASE_API_KEY = '';
  }

  let firebaseModule;
  try {
    clearFirebaseModuleCache();
    firebaseModule = require('../firebase');
  } finally {
    restoreFirebaseEnv(envBackup);
  }
  return { firebaseModule, calls };
};

test('firebase exposes init health when required config is missing', () => {
  const { firebaseModule } = loadFirebaseWithMocks({ missingConfig: true });
  assert.equal(firebaseModule.firebaseInitHealth.hasError, true);
  assert.equal(firebaseModule.firebaseInitHealth.initialized, false);
  assert.equal(firebaseModule.auth, null);
});

test('firebase exposes init health when required config still contains placeholders', () => {
  const { firebaseModule } = loadFirebaseWithMocks({ placeholderConfig: true });
  assert.equal(firebaseModule.firebaseInitHealth.hasError, true);
  assert.equal(firebaseModule.firebaseInitHealth.initialized, false);
  assert.equal(firebaseModule.auth, null);
  assert.deepEqual(firebaseModule.firebaseInitHealth.missingConfig.missingFields, ['apiKey']);
  assert.match(firebaseModule.firebaseInitHealth.errorMessage, /placeholder/);
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
