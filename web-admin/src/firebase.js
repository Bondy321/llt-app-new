import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase, onValue, ref } from "firebase/database";
import {
  getRuntimeDebugContext,
  logFirebaseDebug,
  logFirebaseError,
  startFirebaseDebugTimer,
  summarizeDatabaseInstance,
  summarizeFirebaseApp,
  summarizeFirebaseConfig,
} from "./services/firebaseDebug";

// Firebase configuration using environment variables
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

logFirebaseDebug('module:loaded', {
  vite: {
    mode: import.meta.env.MODE,
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
    firebaseDebugLogs: import.meta.env.VITE_FIREBASE_DEBUG_LOGS ?? '(default enabled)',
  },
  runtime: getRuntimeDebugContext(),
  config: summarizeFirebaseConfig(firebaseConfig),
}, 'info');

let app;
let auth;
let db;

const initTimer = startFirebaseDebugTimer('init', {
  config: summarizeFirebaseConfig(firebaseConfig),
});

try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
  initTimer.success({
    app: summarizeFirebaseApp(app),
    database: summarizeDatabaseInstance(db),
    auth: {
      appName: auth.app?.name || null,
      currentUserPresent: Boolean(auth.currentUser),
    },
  });
} catch (error) {
  initTimer.failure(error, {
    config: summarizeFirebaseConfig(firebaseConfig),
  });
  throw error;
}

const startRealtimeConnectionDiagnostics = () => {
  if (typeof window === 'undefined') return;

  try {
    logFirebaseDebug('realtime-diagnostics:start', {
      database: summarizeDatabaseInstance(db),
      runtime: getRuntimeDebugContext(),
      watchedPaths: ['.info/connected', '.info/serverTimeOffset'],
    }, 'info');

    onValue(
      ref(db, '.info/connected'),
      (snapshot) => {
        logFirebaseDebug('realtime-diagnostics:.info/connected', {
          connected: snapshot.val() === true,
          rawValue: snapshot.val(),
          database: summarizeDatabaseInstance(db),
          navigatorOnline: typeof navigator === 'undefined' ? null : navigator.onLine,
        }, snapshot.val() === true ? 'info' : 'warn');
      },
      (error) => {
        logFirebaseError('realtime-diagnostics:.info/connected:error', error, {
          database: summarizeDatabaseInstance(db),
        });
      },
    );

    onValue(
      ref(db, '.info/serverTimeOffset'),
      (snapshot) => {
        const offsetMs = Number(snapshot.val() || 0);
        logFirebaseDebug('realtime-diagnostics:.info/serverTimeOffset', {
          offsetMs,
          offsetSeconds: Math.round(offsetMs / 1000),
          localNowIso: new Date().toISOString(),
          estimatedServerNowIso: new Date(Date.now() + offsetMs).toISOString(),
        });
      },
      (error) => {
        logFirebaseError('realtime-diagnostics:.info/serverTimeOffset:error', error);
      },
    );
  } catch (error) {
    logFirebaseError('realtime-diagnostics:setup-failed', error, {
      database: summarizeDatabaseInstance(db),
    });
  }
};

startRealtimeConnectionDiagnostics();

export { app, auth, db };
