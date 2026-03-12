const normalizeString = (value) => {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

const resolveAppVersionMetadata = ({ constants = {}, platform = {} } = {}) => {
  const appVersion =
    normalizeString(constants?.expoConfig?.version) ||
    normalizeString(constants?.manifest2?.extra?.expoClient?.version) ||
    normalizeString(constants?.nativeAppVersion) ||
    'unknown';

  const appBuild =
    normalizeString(constants?.expoConfig?.ios?.buildNumber) ||
    normalizeString(constants?.expoConfig?.android?.versionCode) ||
    normalizeString(constants?.nativeBuildVersion) ||
    null;

  const osVersion = normalizeString(platform?.Version) || 'unknown';

  return {
    appVersion,
    appBuild,
    osVersion,
  };
};

module.exports = {
  resolveAppVersionMetadata,
  default: resolveAppVersionMetadata,
};
