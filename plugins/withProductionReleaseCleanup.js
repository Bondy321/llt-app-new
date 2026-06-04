const { withAndroidManifest, withGradleProperties, withInfoPlist } = require('@expo/config-plugins');

const DEV_CLIENT_GRADLE_PROPERTY = 'EX_DEV_CLIENT_NETWORK_INSPECTOR';
const SYSTEM_ALERT_WINDOW = 'android.permission.SYSTEM_ALERT_WINDOW';

const removeAndroidPermission = (manifest, permissionName) => {
  const permissions = manifest?.manifest?.['uses-permission'];
  if (!Array.isArray(permissions)) return manifest;

  manifest.manifest['uses-permission'] = permissions.filter(
    (permission) => permission?.$?.['android:name'] !== permissionName
  );

  return manifest;
};

const withProductionReleaseCleanup = (config) => {
  if (process.env.EAS_BUILD_PROFILE !== 'production') {
    return config;
  }

  config = withInfoPlist(config, (pluginConfig) => {
    delete pluginConfig.modResults.NSBonjourServices;
    delete pluginConfig.modResults.NSLocalNetworkUsageDescription;
    return pluginConfig;
  });

  config = withAndroidManifest(config, (pluginConfig) => {
    pluginConfig.modResults = removeAndroidPermission(pluginConfig.modResults, SYSTEM_ALERT_WINDOW);
    return pluginConfig;
  });

  config = withGradleProperties(config, (pluginConfig) => {
    pluginConfig.modResults = (pluginConfig.modResults || []).filter(
      (property) => property?.key !== DEV_CLIENT_GRADLE_PROPERTY
    );
    return pluginConfig;
  });

  return config;
};

module.exports = withProductionReleaseCleanup;
