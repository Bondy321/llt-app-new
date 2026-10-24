'use strict';

// Recovery may replace only the exact identity captured by its caller. In
// particular, restoration and storage awaits must not turn it into a sign-out
// operation against a newer login, even when that login has the same UID.
const replaceWithFreshAnonymousUser = async ({ auth, restoreReady, signOut, signInAnonymously,
  persistence, expectedUser = auth.currentUser, checkBoundary = () => {} }) => {
  const check = expected => {
    checkBoundary();
    if (auth.currentUser !== expected) {
      throw Object.assign(new Error('Authentication changed during account recovery.'), { code: 'AUTH_IDENTITY_CHANGED' });
    }
  };
  check(expectedUser);
  await restoreReady();
  check(expectedUser);
  if (expectedUser) {
    await signOut(auth);
    check(null);
  }
  await persistence.clearAuthState();
  check(null);
  const result = await signInAnonymously(auth);
  check(result.user);
  await persistence.saveAuthState(result.user);
  check(result.user);
  return result.user;
};

module.exports = { replaceWithFreshAnonymousUser };
