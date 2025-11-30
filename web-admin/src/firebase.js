import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";

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

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);