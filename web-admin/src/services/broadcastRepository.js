import { limitToLast, onValue, orderByChild, push, query, ref, set } from 'firebase/database';
import { auth, db } from '../firebase';

export const subscribeToBroadcastTours = ({ onData, onError }) => onValue(
  ref(db, 'tours'),
  (snapshot) => onData(snapshot.val() || {}),
  onError,
);

export const subscribeToBroadcastHistory = ({ rootPath, limit = 25, onData, onError }) => {
  const historyQuery = query(ref(db, rootPath), orderByChild('createdAtMs'), limitToLast(limit));
  return onValue(historyQuery, (snapshot) => onData(snapshot.val() || {}), onError);
};

export const queueBroadcast = async ({ rootPath, payload }) => {
  const authUid = auth.currentUser?.uid;
  if (!authUid) {
    const error = new Error('A current admin session is required.');
    error.code = 'auth/session-expired';
    throw error;
  }
  const newBroadcastRef = push(ref(db, rootPath));
  await set(newBroadcastRef, { ...payload, createdByUid: authUid });
  return newBroadcastRef.key;
};
