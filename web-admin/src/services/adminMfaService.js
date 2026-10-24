import { signOut, EmailAuthProvider, reauthenticateWithCredential, multiFactor, TotpMultiFactorGenerator } from 'firebase/auth';
import { auth } from '../firebase';

export const hasAdminSecondFactor = (claims) => claims?.firebase?.sign_in_second_factor === 'totp';

export const beginAdminTotpEnrollment = async (password) => {
  const user = auth.currentUser;
  if (!user?.email || !user.emailVerified) throw new Error('Verify this admin account’s email before setting up an authenticator.');
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  if (auth.currentUser !== user) throw new Error('Your account changed. Sign in again.');
  const session = await multiFactor(user).getSession();
  if (auth.currentUser !== user) throw new Error('Your account changed. Sign in again.');
  const secret = await TotpMultiFactorGenerator.generateSecret(session);
  if (auth.currentUser !== user) throw new Error('Your account changed. Sign in again.');
  return { uid: user.uid, secret };
};

export const finishAdminTotpEnrollment = async (enrollment, code) => {
  const user = auth.currentUser;
  if (!user || user.uid !== enrollment?.uid || !/^\d{6}$/.test(code)) throw new Error('Enter the current six-digit authenticator code.');
  await multiFactor(user).enroll(TotpMultiFactorGenerator.assertionForEnrollment(enrollment.secret, code), 'LLT operations');
  if (auth.currentUser !== user) throw new Error('Your account changed. Sign in again.');
};

export const captureAdminIdentityCheck = () => {
  const user = auth.currentUser;
  return () => Boolean(user) && auth.currentUser === user;
};
export const signOutAdmin = () => signOut(auth);
