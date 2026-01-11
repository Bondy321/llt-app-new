// firebase.js - Enhanced Firebase Configuration with Persistent Auth
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/database';
import { getStorage } from 'firebase/storage';
import { getDatabase } from 'firebase/database';
import { createPersistenceProvider } from './services/persistenceProvider';

// Initialize a resilient persistence layer for auth/session state.
const authStorage = createPersistenceProvider({ namespace: 'LLT_AUTH' });

// Production-safe logging - only logs in development mode
const IS_PRODUCTION = process.env.EXPO_PUBLIC_APP_ENV === 'production';
const devLog = (...args) => { if (!IS_PRODUCTION) console.log(...args); };
const devWarn = (...args) => { if (!IS_PRODUCTION) console.warn(...args); };
const devError = (...args) => { if (!IS_PRODUCTION) console.error(...args); };

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

class AuthPersistence {
  constructor() {
    this.AUTH_KEY = 'LLT_authUser';
    this.TOKEN_KEY = 'LLT_authToken';
    devLog(`[AuthPersistence] Using storage mode: ${authStorage.mode}`);
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
        devLog(`[AuthPersistence] Auth state saved (${authStorage.mode})`);
      } else {
        await authStorage.deleteItemAsync(this.AUTH_KEY);
      }
    } catch (error) {
      devError(`[AuthPersistence] Error saving auth state via ${authStorage.mode}:`, error);
    }
  }

  async getStoredAuthState() {
    try {
      const stored = await authStorage.getItemAsync(this.AUTH_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      devError(`[AuthPersistence] Error retrieving auth state via ${authStorage.mode}:`, error);
      return null;
    }
  }

  async clearAuthState() {
    try {
      await authStorage.deleteItemAsync(this.AUTH_KEY);
      await authStorage.deleteItemAsync(this.TOKEN_KEY);
    } catch (error) {
      devError(`[AuthPersistence] Error clearing auth state via ${authStorage.mode}:`, error);
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

try {
  if (!firebase.apps.length) {
    app = firebase.initializeApp(firebaseConfig);
    devLog('Firebase initialized successfully');
  } else {
    app = firebase.app();
    devLog('Firebase already initialized');
  }

  // Initialize services
  auth = firebase.auth();
  db = firebase.firestore();
  const modularApp = app._delegate || app;
  storage = getStorage(modularApp, 'gs://loch-lomond-travel.firebasestorage.app');
  realtimeDb = firebase.database();
  realtimeDbModular = getDatabase(modularApp);

  // Configure auth persistence
  // Use NONE because we manage persistence via custom authStorage/AuthPersistence
  auth.setPersistence(firebase.auth.Auth.Persistence.NONE)
    .then(() => {
      devLog('Firebase persistence enabled');
    })
    .catch((error) => {
      devError('Error setting persistence:', error);
    });

  // Enable Firestore offline persistence
  db.enablePersistence({ synchronizeTabs: true })
    .then(() => {
      devLog('Firestore offline persistence enabled');
    })
    .catch((err) => {
      if (err.code === 'unimplemented') {
        devLog('Firestore persistence not available in this environment');
      } else {
        devError('Firestore persistence error:', err);
      }
    });

  // Enable Realtime Database offline persistence
  realtimeDb.goOffline();
  realtimeDb.goOnline();
  devLog('Realtime Database configured');

} catch (error) {
  devError('Firebase initialization error:', error);
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
      devError('Error in auth state listener:', error);
    }
  });
};

// Set up global auth state observer (guarded to avoid crashing when Firebase fails to init)
if (auth?.onAuthStateChanged) {
  auth.onAuthStateChanged(async (user) => {
    devLog('Global auth state changed:', user ? 'authenticated' : 'null');

    // Save auth state
    await authPersistence.saveAuthState(user);

    // Notify all listeners
    notifyAuthStateListeners(user);
  });
} else {
  devError('Firebase auth is not available; skipping auth state listener setup');
}

// Enhanced auth functions
const authHelpers = {
  async signInAnonymouslyPersistent() {
    try {
      devLog('Attempting anonymous sign in...');
      
      // Check if we have a stored auth state
      const storedAuth = await authPersistence.getStoredAuthState();
      
      if (storedAuth && auth.currentUser) {
        devLog('Using existing auth session');
        return auth.currentUser;
      }
      
      // Sign in anonymously
      const result = await auth.signInAnonymously();
      devLog('Anonymous sign in successful');
      
      // Save the auth state
      await authPersistence.saveAuthState(result.user);
      
      return result.user;
    } catch (error) {
      devError('Anonymous sign in error:', error.code || 'unknown');
      throw error;
    }
  },

  async ensureAuthenticated() {
    if (auth.currentUser) {
      return auth.currentUser;
    }
    
    return this.signInAnonymouslyPersistent();
  },

  onAuthStateChanged(callback) {
    authStateListeners.push(callback);
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

// Network state monitoring
let isOnline = true;

const updateNetworkState = (online) => {
  isOnline = online;
  if (!realtimeDb) {
    devWarn('Realtime Database is not available; skipping network state sync');
    return;
  }

  if (online) {
    devLog('Network connected - syncing data');
    realtimeDb.goOnline();
  } else {
    devLog('Network disconnected - using offline mode');
    realtimeDb.goOffline();
  }
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
  isOnline
};