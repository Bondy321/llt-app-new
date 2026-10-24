import { getApp } from '@react-native-firebase/app';
import { getToken, initializeAppCheck } from '@react-native-firebase/app-check';
import { CustomProvider } from 'firebase/app-check';
import { tokenWithExpiry } from './appCheckToken';

let nativeAppCheck;
const getNativeAppCheck = () => {
  if (!nativeAppCheck) {
    nativeAppCheck = initializeAppCheck(getApp(), {
      provider: { providerOptions: {
        apple: { provider: 'appAttestWithDeviceCheckFallback' },
        android: { provider: 'playIntegrity' },
      } },
      isTokenAutoRefreshEnabled: true,
    });
  }
  return nativeAppCheck;
};

// Bridge native attestation to the existing Firebase JS app. This ensures its
// RTDB/Storage requests and ordinary HTTP Functions use the same real provider.
export const createPlatformAppCheckProvider = () => new CustomProvider({
  getToken: async () => {
    const instance = await getNativeAppCheck();
    const result = await getToken(instance, false);
    return tokenWithExpiry(result.token);
  },
});
