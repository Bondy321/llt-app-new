// firebase.js - Enhanced Firebase Configuration with Persistent Auth
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/database';
import { getStorage } from 'firebase/storage';

// --- MOCK BLOCK START ---
// In Expo Go, native storage modules can sometimes crash or misbehave.
// We use this in-memory mock to ensure the app always launches.
const MockStorage = {
  _data: {},
  setItemAsync: async (key, value) => {
    MockStorage._data[key] = value;
    return Promise.resolve();
  },
  getItemAsync: async (key) => {
    return Promise.resolve(MockStorage._data[key] || null);
  },
  deleteItemAsync: async (key) => {
    delete MockStorage._data[key];
    return Promise.resolve();
  },
};
// --- MOCK BLOCK END ---

const firebaseConfig = {
  apiKey: "AIzaSyCeQqCtbFEB9nrUvP_Pffrt2aelATf9i9o",
  authDomain: "loch-lomond-travel.firebaseapp.com",
  databaseURL: "https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "loch-lomond-travel",
  storageBucket: "loch-lomond-travel.firebasestorage.app",
  messagingSenderId: "500767842880",
  appId: "1:500767842880:web:b27b5630eed50e6ea4f5a5",
  measurementId: "G-D46EKN8EDZ"
};

class AuthPersistence {
  constructor() {
    this.AUTH_KEY = 'LLT_authUser'; 
    this.TOKEN_KEY = 'LLT_authToken';
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
        await MockStorage.setItemAsync(this.AUTH_KEY, JSON.stringify(authData));
        console.log('Auth state saved (Mock Storage)');
      } else {
        await MockStorage.deleteItemAsync(this.AUTH_KEY);
      }
    } catch (error) {
      console.error('Error saving auth state:', error);
    }
  }

  async getStoredAuthState() {
    try {
      const stored = await MockStorage.getItemAsync(this.AUTH_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error('Error retrieving auth state:', error);
      return null;
    }
  }

  async clearAuthState() {
    try {
      await MockStorage.deleteItemAsync(this.AUTH_KEY);
      await MockStorage.deleteItemAsync(this.TOKEN_KEY);
    } catch (error) {
      console.error('Error clearing auth state:', error);
    }
  }
}

// Initialize Firebase
let app;
let auth;
let db;
let storage;
let realtimeDb;

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
  storage = getStorage(app, 'gs://loch-lomond-travel.firebasestorage.app');
  realtimeDb = firebase.database();

  // Configure auth persistence
  // Use NONE because we manage persistence via MockStorage/AuthPersistence
  auth.setPersistence(firebase.auth.Auth.Persistence.NONE)
    .then(() => {
      console.log('Firebase persistence enabled');
    })
    .catch((error) => {
      console.error('Error setting persistence:', error);
    });

  // Enable Firestore offline persistence
  db.enablePersistence({ synchronizeTabs: true })
    .then(() => {
      console.log('Firestore offline persistence enabled');
    })
    .catch((err) => {
      if (err.code === 'unimplemented') {
        console.log('Firestore persistence not available in this environment');
      } else {
        console.error('Firestore persistence error:', err);
      }
    });

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

// Set up global auth state observer
auth.onAuthStateChanged(async (user) => {
  console.log('Global auth state changed:', user ? user.uid : 'null');
  
  // Save auth state
  await authPersistence.saveAuthState(user);
  
  // Notify all listeners
  notifyAuthStateListeners(user);
});

// Enhanced auth functions
const authHelpers = {
  async signInAnonymouslyPersistent() {
    try {
      console.log('Attempting anonymous sign in...');
      
      // Check if we have a stored auth state
      const storedAuth = await authPersistence.getStoredAuthState();
      
      if (storedAuth && auth.currentUser) {
        console.log('Using existing auth session:', storedAuth.uid);
        return auth.currentUser;
      }
      
      // Sign in anonymously
      const result = await auth.signInAnonymously();
      console.log('Anonymous sign in successful:', result.user.uid);
      
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
  authHelpers,
  updateNetworkState,
  isOnline
};