import { auth, getAdminAppCheckToken } from '../firebase';
import { boundedRequest } from './boundedRequest';

export const getAdminRequestHeaders = async () => {
  if (!auth.currentUser) throw new Error('Sign in to continue.');
  const user = auth.currentUser;
  const [token, appCheck] = await boundedRequest(() => Promise.all([user.getIdToken(), getAdminAppCheckToken()]));
  if (auth.currentUser !== user) throw new Error('Your admin account changed. Retry from the current session.');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(appCheck ? { 'X-Firebase-AppCheck': appCheck } : {}),
  };
};
