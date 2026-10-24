import { initializeAppCheck, getToken } from 'firebase/app-check';
import { createPlatformAppCheckProvider } from './appCheckProvider';

let instance;
export const initializeFirebaseAppCheck = (app) => {
  if (instance) return instance;
  if (process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK !== 'true') {
    if (process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK === 'true') {
      throw new Error('APP_CHECK_CONFIGURATION_REQUIRED');
    }
    return null;
  }
  instance = initializeAppCheck(app, {
    provider: createPlatformAppCheckProvider(),
    isTokenAutoRefreshEnabled: true,
  });
  return instance;
};

export const getFirebaseAppCheckToken = async () => {
  if (!instance) {
    if (process.env.EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK === 'true') {
      throw new Error('APP_CHECK_NOT_INITIALIZED');
    }
    return null;
  }
  const result = await getToken(instance, false);
  if (!result?.token) throw new Error('APP_CHECK_TOKEN_UNAVAILABLE');
  return result.token;
};
