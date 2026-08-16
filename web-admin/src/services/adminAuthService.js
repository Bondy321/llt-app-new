import { get, ref } from 'firebase/database';

export const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';

export async function hasOperationsAdminAccess(database, user) {
  const uid = typeof user?.uid === 'string' ? user.uid.trim() : '';
  if (!uid) return false;
  if (uid === OPERATIONS_ADMIN_UID) return true;

  try {
    const snapshot = await get(ref(database, `admin_users/${uid}`));
    return snapshot.val() === true;
  } catch {
    return false;
  }
}
