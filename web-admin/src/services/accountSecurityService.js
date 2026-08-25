import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';
import { auth } from '../firebase';

export const getCurrentAccountUser = () => auth.currentUser;

export const changeCurrentAccountPassword = async ({ currentPassword, newPassword }) => {
  const user = auth.currentUser;
  if (!user?.email) {
    const error = new Error('A current authenticated account with an email is required.');
    error.code = 'auth/session-expired';
    throw error;
  }
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
};
