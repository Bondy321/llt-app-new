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
    console.log(`[AuthPersistence] Using storage mode: ${authStorage.mode}`);
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
        console.log(`[AuthPersistence] Auth state saved (${authStorage.mode})`);
      } else {
        await authStorage.deleteItemAsync(this.AUTH_KEY);
      }
    } catch (error) {
      console.error(`[AuthPersistence] Error saving auth state via ${authStorage.mode}:`, error);
    }
  }

  async getStoredAuthState() {
    try {
      const stored = await authStorage.getItemAsync(this.AUTH_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error(`[AuthPersistence] Error retrieving auth state via ${authStorage.mode}:`, error);
      return null;
    }
  }

  async clearAuthState() {
    try {
      await authStorage.deleteItemAsync(this.AUTH_KEY);
      await authStorage.deleteItemAsync(this.TOKEN_KEY);
    } catch (error) {
      console.error(`[AuthPersistence] Error clearing auth state via ${authStorage.mode}:`, error);
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
    console.log('Firebase initialized successfully');
  } else {
    app = firebase.app();
    console.log('Firebase already initialized');
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
      console.log('Firebase persistence enabled');
    })
    .catch((error) => {
      console.error('Error setting persistence:', error);
    });

  // Configure Firestore settings
  // Note: IndexedDB persistence is not supported in React Native
  // Firestore will use memory cache which is appropriate for mobile apps
  // where data synchronization happens automatically when online
  db.settings({
    cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED,
    merge: true
  });
  console.log('Firestore configured with memory cache (persistence not available in React Native)');

  // Enable Realtime Database offline persistence
  realtimeDb.goOffline();
  realtimeDb.goOnline();
  console.log('Realtime Database configured');

} catch (error) {
  console.error('Firebase initialization error:', error);
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
      console.error('Error in auth state listener:', error);
    }
  });
};

// Set up global auth state observer (guarded to avoid crashing when Firebase fails to init)
if (auth?.onAuthStateChanged) {
  auth.onAuthStateChanged(async (user) => {
    if (__DEV__) {
      console.log('Global auth state changed');
    }

    // Save auth state
    await authPersistence.saveAuthState(user);

    // Notify all listeners
    notifyAuthStateListeners(user);
  });
} else {
  console.error('Firebase auth is not available; skipping auth state listener setup');
}

// Enhanced auth functions
const authHelpers = {
  async signInAnonymouslyPersistent() {
    try {
      if (__DEV__) {
        console.log('Attempting anonymous sign in...');
      }
      
      // Check if we have a stored auth state
      const storedAuth = await authPersistence.getStoredAuthState();
      
      if (storedAuth && auth.currentUser) {
        if (__DEV__) {
          console.log('Using existing auth session');
        }
        return auth.currentUser;
      }
      
      // Sign in anonymously
      const result = await auth.signInAnonymously();
      if (__DEV__) {
        console.log('Anonymous sign in successful');
      }
      
      // Save the auth state
      await authPersistence.saveAuthState(result.user);
      
      return result.user;
    } catch (error) {
      console.error('Anonymous sign in error:', error);
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
    console.warn('Realtime Database is not available; skipping network state sync');
    return;
  }

  if (online) {
    console.log('Network connected - syncing data');
    realtimeDb.goOnline();
  } else {
    console.log('Network disconnected - using offline mode');
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
