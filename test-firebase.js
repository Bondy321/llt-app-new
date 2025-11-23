// test-firebase.js
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCeQqCtbFEB9nrUvP_Pffrt2aelATf9i9o",
  authDomain: "loch-lomond-travel.firebaseapp.com",
  projectId: "loch-lomond-travel",
  storageBucket: "loch-lomond-travel.firebasestorage.app",
  messagingSenderId: "500767842880",
  appId: "1:500767842880:web:b27b5630eed50e6ea4f5a5",
  measurementId: "G-D46EKN8EDZ"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

console.log("Firebase test:", firebase.auth());

export default firebase;