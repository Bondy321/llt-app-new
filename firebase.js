// firebase.js - Enhanced Firebase Configuration with Persistent Auth
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/database';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getStorage } from 'firebase/storage';
import { getDatabase } from 'firebase/database';
import {
  getAuth,
  getReactNativePersistence,
  initializeAuth,
  onAuthStateChanged,
  signInAnonymously,
} from 'firebase/auth';
import { createPersistenceProvider } from './services/persistenceProvider.js';

// Initialize a resilient persistence layer for auth/session state.
const authStorage = createPersistenceProvider({ namespace: 'LLT_AUTH' });
const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';
const formatFirebaseError = (error) => error?.message || String(error || 'Unknown error');
const firebaseDebugLog = (...args) => {
  if (IS_DEV) {
    console.log(...args);
  }
};
const firebaseWarnLog = (...args) => {
  if (IS_DEV) {
    console.warn(...args);
  }
};
const firebaseErrorLog = (...args) => {
  if (IS_DEV) {
    console.error(...args);
  }
};

// Firebase configuration - credentials loaded from environment variables
// See .env.example for required environment variables
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID
};

const REQUIRED_FIREBASE_CONFIG_FIELDS = [
  'apiKey',
  'authDomain',
  'databaseURL',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

const FIREBASE_CONFIG_FIELD_ENV_MAP = {
  apiKey: 'EXPO_PUBLIC_FIREBASE_API_KEY',
  authDomain: 'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  databaseURL: 'EXPO_PUBLIC_FIREBASE_DATABASE_URL',
  projectId: 'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  storageBucket: 'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  appId: 'EXPO_PUBLIC_FIREBASE_APP_ID',
};

const FIREBASE_PLACEHOLDER_VALUE_PATTERNS = [
  /^@[\w.-]+$/,
  /^your[_-]/i,
  /your[_-].*here/i,
  /placeholder/i,
  /replace_with/i,
  /^undefined$/i,
  /^null$/i,
];

const isUsableFirebaseConfigValue = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  const normalized = value.trim();
  return !FIREBASE_PLACEHOLDER_VALUE_PATTERNS.some((pattern) => pattern.test(normalized));
};

const getMissingFirebaseConfigFields = (config) => {
  return REQUIRED_FIREBASE_CONFIG_FIELDS.filter((field) => {
    return !isUsableFirebaseConfigValue(config?.[field]);
  });
};

const buildMissingConfigDetails = (missingFields) => ({
  reason: 'MISSING_FIREBASE_CONFIG',
  missingFields,
  requiredEnvVars: missingFields.map((field) => FIREBASE_CONFIG_FIELD_ENV_MAP[field] || field),
  action:
    'Populate the missing EXPO_PUBLIC_FIREBASE_* variables with real values before launching the app so Firebase can initialize.',
});

const toStorageBucketUrl = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'gs://loch-lomond-travel.firebasestorage.app';
  }

  const normalized = value.trim();
  return normalized.startsWith('gs://') ? normalized : `gs://${normalized}`;
};

const hasAuthInstance = () => typeof auth === 'object' && auth !== null;

const resolveAuthRestoreReady = () => {
  if (!hasAuthInstance()) {
    return Promise.resolve();
  }

  if (!authRestoreReadyPromise) {
    if (typeof auth.authStateReady === 'function') {
      authRestoreReadyPromise = auth.authStateReady().catch((error) => {
        firebaseWarnLog('Auth state restoration readiness failed:', formatFirebaseError(error));
      });
    } else {
      authRestoreReadyPromise = new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(
          auth,
          () => {
            unsubscribe();
            resolve();
          },
          () => {
            unsubscribe();
            resolve();
          }
        );
      });
    }
  }

  return authRestoreReadyPromise;
};

class AuthPersistence {
  constructor() {
    this.AUTH_KEY = 'LLT_authUser';
    this.TOKEN_KEY = 'LLT_authToken';
    firebaseDebugLog(`[AuthPersistence] Using storage mode: ${authStorage.mode}`);
  }

  async saveAuthState(user) {
    try {
      if (user) {
        const authData = {
          uid: user.uid,
          isAnonymous: user.isAnonymous,
          createdAt: user.metadata.creationTime,
          lastSignIn: user.metadata.lastSignInTime,
          savedAt: new Date().toISOString()
        };
        await authStorage.setItemAsync(this.AUTH_KEY, JSON.stringify(authData));
        firebaseDebugLog(`[AuthPersistence] Auth state saved (${authStorage.mode})`);
      } else {
        await authStorage.deleteItemAsync(this.AUTH_KEY);
      }
    } catch (error) {
      firebaseErrorLog(`[AuthPersistence] Error saving auth state via ${authStorage.mode}:`, formatFirebaseError(error));
    }
  }

  async getStoredAuthState() {
    try {
      const stored = await authStorage.getItemAsync(this.AUTH_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      firebaseErrorLog(`[AuthPersistence] Error retrieving auth state via ${authStorage.mode}:`, formatFirebaseError(error));
      return null;
    }
  }

  async clearAuthState() {
    try {
      await authStorage.deleteItemAsync(this.AUTH_KEY);
      await authStorage.deleteItemAsync(this.TOKEN_KEY);
    } catch (error) {
      firebaseErrorLog(`[AuthPersistence] Error clearing auth state via ${authStorage.mode}:`, formatFirebaseError(error));
    }
  }
}

// Initialize Firebase
let app;
let auth;
let db;
let storage;
let realtimeDb;
let realtimeDbModular;
let firebaseInitializationError = null;
let authRestoreReadyPromise = null;
const firebaseInitHealth = {
  attempted: false,
  initialized: false,
  hasError: false,
  errorMessage: null,
  missingConfig: null,
};

try {
  firebaseInitHealth.attempted = true;
  const missingConfigFields = getMissingFirebaseConfigFields(firebaseConfig);
  if (missingConfigFields.length > 0) {
    const missingConfig = buildMissingConfigDetails(missingConfigFields);
    firebaseInitializationError = new Error(
      `Missing or placeholder required Firebase config: ${missingConfigFields.join(', ')}`
    );
    firebaseInitHealth.missingConfig = missingConfig;
    firebaseInitHealth.hasError = true;
    firebaseInitHealth.errorMessage = firebaseInitializationError.message;
    firebaseWarnLog(
      '[Firebase] Initialization skipped because required configuration is missing.',
      missingConfig
    );
  }

  if (firebaseInitializationError) {
    throw firebaseInitializationError;
  }

  if (!firebase.apps.length) {
    app = firebase.initializeApp(firebaseConfig);
    firebaseDebugLog('Firebase initialized successfully');
  } else {
    app = firebase.app();
    firebaseDebugLog('Firebase already initialized');
  }

  // Initialize services
  db = firebase.firestore();
  // Keep one compat app boundary while using modular SDK where RN benefits (storage/realtime typed access).
  // This avoids creating two Firebase app instances and keeps auth/firestore callers stable.
  const modularApp = app._delegate || app;

  try {
    auth = initializeAuth(modularApp, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
    firebaseDebugLog('Firebase auth configured with React Native persistence');
  } catch (authInitError) {
    auth = getAuth(modularApp);
    firebaseWarnLog(
      'Firebase auth already initialized; reusing existing instance.',
      formatFirebaseError(authInitError)
    );
  }

  storage = getStorage(modularApp, toStorageBucketUrl(firebaseConfig.storageBucket));
  realtimeDb = firebase.database();
  realtimeDbModular = getDatabase(modularApp);

  // Configure Firestore settings
  // Note: IndexedDB persistence is not supported in React Native
  // Firestore will use memory cache which is appropriate for mobile apps
  // where data synchronization happens automatically when online
  db.settings({
    cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED,
    merge: true
  });
  firebaseDebugLog('Firestore configured with memory cache (persistence not available in React Native)');

  // Realtime DB connectivity is controlled by updateNetworkState; do not force offline/online churn at startup.
  firebaseDebugLog('Realtime Database configured');
  firebaseInitHealth.initialized = true;

} catch (error) {
  firebaseInitializationError = error;
  auth = null;
  db = null;
  storage = null;
  realtimeDb = null;
  realtimeDbModular = null;
  firebaseInitHealth.initialized = false;
  firebaseInitHealth.hasError = true;
  firebaseInitHealth.errorMessage = error?.message || 'Unknown Firebase initialization error';
  firebaseErrorLog('Firebase initialization error:', formatFirebaseError(error));
}

// Create auth persistence instance
const authPersistence = new AuthPersistence();

// Enhanced auth state observer
let authStateListeners = [];

const notifyAuthStateListeners = (user) => {
  authStateListeners.forEach(listener => {
    try {
      listener(user);
    } catch (error) {
      firebaseErrorLog('Error in auth state listener:', formatFirebaseError(error));
    }
  });
};

// Set up global auth state observer (guarded to avoid crashing when Firebase fails to init)
if (hasAuthInstance()) {
  onAuthStateChanged(auth, async (user) => {
    if (IS_DEV) {
      firebaseDebugLog('Global auth state changed');
    }

    // Save auth state
    await authPersistence.saveAuthState(user);

    // Notify all listeners
    notifyAuthStateListeners(user);
  });
} else {
  firebaseErrorLog('Firebase auth is not available; skipping auth state listener setup');
}

const assertAuthAvailable = (actionName) => {
  if (auth) {
    return;
  }

  const baseMessage = `Firebase auth is unavailable; cannot ${actionName}.`;
  const reason = firebaseInitializationError?.message;
  throw new Error(reason ? `${baseMessage} ${reason}` : baseMessage);
};

// Enhanced auth functions
const authHelpers = {
  async signInAnonymouslyPersistent() {
    try {
      assertAuthAvailable('sign in anonymously');

      if (IS_DEV) {
        firebaseDebugLog('Attempting anonymous sign in...');
      }

      await resolveAuthRestoreReady();

      if (auth.currentUser) {
        if (IS_DEV) {
          firebaseDebugLog('Using existing auth session');
        }
        return auth.currentUser;
      }

      // Sign in anonymously
      const result = await signInAnonymously(auth);
      if (IS_DEV) {
        firebaseDebugLog('Anonymous sign in successful');
      }
      
      // Save the auth state
      await authPersistence.saveAuthState(result.user);
      
      return result.user;
    } catch (error) {
      firebaseErrorLog('Anonymous sign in error:', formatFirebaseError(error));
      throw error;
    }
  },

  async ensureAuthenticated() {
    assertAuthAvailable('ensure authentication');

    await resolveAuthRestoreReady();

    if (auth.currentUser) {
      return auth.currentUser;
    }
    
    return this.signInAnonymouslyPersistent();
  },

  onAuthStateChanged(callback) {
    if (!auth) {
      firebaseWarnLog('Firebase auth is not available; auth state listener will be inert');
      return () => {};
    }

    authStateListeners.push(callback);
    resolveAuthRestoreReady().finally(() => {
      if (!authStateListeners.includes(callback)) return;
      try {
        callback(auth.currentUser || null);
      } catch (error) {
        firebaseErrorLog('Error in auth state listener:', formatFirebaseError(error));
      }
    });

    return () => {
      authStateListeners = authStateListeners.filter(l => l !== callback);
    };
  },

  async getStoredUserId() {
    const stored = await authPersistence.getStoredAuthState();
    return stored?.uid || null;
  },

  async clearAuthData() {
    await authPersistence.clearAuthState();
  }
};

const getCurrentAppCheckToken = async () => {
  try {
    const appCheckInstance = app?.appCheck?.();
    if (!appCheckInstance?.getToken) {
      return null;
    }

    const result = await appCheckInstance.getToken(false);
    return typeof result?.token === 'string' ? result.token : null;
  } catch (error) {
    firebaseWarnLog('Unable to retrieve App Check token:', formatFirebaseError(error));
    throw error;
  }
};

// Network state monitoring
let isOnline = true;
let lastRealtimeDbOnlineState = null;

const updateNetworkState = (online) => {
  isOnline = online;
  if (!realtimeDb) {
    firebaseWarnLog('Realtime Database is not available; skipping network state sync');
    return;
  }

  if (lastRealtimeDbOnlineState === online) {
    return;
  }

  if (online) {
    firebaseDebugLog('Network connected - syncing data');
    realtimeDb.goOnline();
  } else {
    firebaseDebugLog('Network disconnected - using offline mode');
    realtimeDb.goOffline();
  }

  lastRealtimeDbOnlineState = online;
};

// Export enhanced services
export { 
  firebase, 
  auth,
  db,
  storage,
  realtimeDb,
  realtimeDbModular,
  authHelpers,
  updateNetworkState,
  isOnline,
  getCurrentAppCheckToken,
  firebaseInitHealth
};
