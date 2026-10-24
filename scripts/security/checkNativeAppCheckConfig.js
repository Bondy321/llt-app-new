#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const BUNDLE_ID = 'com.lochlomondtravel.tourapp';

const checkNativeToolchainConfig = (config = require('../../app.config').expo) => {
  const properties = config.plugins?.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-build-properties')?.[1];
  if (properties?.android?.kotlinVersion !== '2.4.0' || properties?.android?.minSdkVersion !== 24
    || !config.plugins.includes('./plugins/withFirebaseAndroidToolchain')) {
    throw new Error('RNFirebase 27 requires the reviewed Kotlin 2.4.0 / API 24 / KSP toolchain configuration');
  }
  const iosTarget = Number(properties?.ios?.deploymentTarget);
  if (properties?.ios?.useFrameworks !== 'dynamic' || !Number.isFinite(iosTarget) || iosTarget < 15.1) {
    throw new Error('RNFirebase 27 requires dynamic SPM frameworks and iOS 15.1 or newer');
  }
  return { kotlinVersion: '2.4.0', minSdkVersion: 24, useFrameworks: 'dynamic' };
};

const checkNativeAppCheckConfig = ({ env = process.env, read = (name) => fs.readFileSync(path.resolve(name), 'utf8') } = {}) => {
  const platform = env.EAS_BUILD_PLATFORM;
  if (!['ios', 'android'].includes(platform)) return { checked: false, reason: 'not-native-build' };
  checkNativeToolchainConfig();
  const projectId = env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('Native Firebase project ID is required');
  if (platform === 'android') {
    const config = JSON.parse(read(env.GOOGLE_SERVICES_JSON || './google-services.json'));
    const client = config.client?.find((item) => item.client_info?.android_client_info?.package_name === BUNDLE_ID);
    if (config.project_info?.project_id !== projectId || !client?.client_info?.mobilesdk_app_id?.includes(':android:')) {
      throw new Error('Android Firebase configuration does not match this project and package');
    }
  } else {
    const config = read(env.GOOGLE_SERVICES_PLIST || './GoogleService-Info.plist');
    const value = (key) => new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]+)</string>`, 'u').exec(config)?.[1];
    if (value('PROJECT_ID') !== projectId || value('BUNDLE_ID') !== BUNDLE_ID || !value('GOOGLE_APP_ID')?.includes(':ios:')) {
      throw new Error('iOS Firebase configuration does not match this project and bundle');
    }
  }
  return { checked: true, platform, projectId };
};
if (require.main === module) {
  try { console.log(JSON.stringify(checkNativeAppCheckConfig())); }
  catch (error) { console.error(`Native App Check configuration: ${error.message}`); process.exitCode = 1; }
}
module.exports = { checkNativeAppCheckConfig, checkNativeToolchainConfig };
