import { ReCaptchaEnterpriseProvider } from 'firebase/app-check';

export const createPlatformAppCheckProvider = () => {
  const siteKey = process.env.EXPO_PUBLIC_APPCHECK_WEB_SITE_KEY;
  if (!siteKey) throw new Error('APP_CHECK_WEB_CONFIGURATION_REQUIRED');
  return new ReCaptchaEnterpriseProvider(siteKey);
};
