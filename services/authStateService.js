import { auth, realtimeDb } from '../firebase';

export const getCurrentAuthUser = () => auth.currentUser;

export const updateCurrentAuthUserProfile = async (updates) => {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Authenticated user required');
  await realtimeDb.ref(`users/${uid}`).update(updates);
  return uid;
};
