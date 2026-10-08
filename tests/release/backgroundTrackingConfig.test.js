'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const locationPlugin = require('expo-location/app.plugin');
const withLocation = locationPlugin.default || locationPlugin;
const { expo: appConfig } = require('../../app.config');
const eas = require('../../eas.json');

const getLocationOptions = () => appConfig.plugins.find((plugin) => (
  Array.isArray(plugin) && plugin[0] === 'expo-location'
))[1];

const createLocationConfig = () => withLocation(
  JSON.parse(JSON.stringify(appConfig)),
  getLocationOptions(),
);

test('driver background tracking enables iOS Always access and an Android foreground service', () => {
  const options = getLocationOptions();
  assert.equal(options.isIosBackgroundLocationEnabled, true);
  assert.equal(options.isAndroidForegroundServiceEnabled, true);
  assert.equal(options.isAndroidBackgroundLocationEnabled, false);
  assert.equal(options.locationAlwaysPermission, false);
  assert.match(options.locationAlwaysAndWhenInUsePermission, /driver location sharing is switched on/);
  assert.match(options.locationAlwaysAndWhenInUsePermission, /background or your phone is locked/);
  assert.match(options.locationAlwaysAndWhenInUsePermission, /stop sharing at any time/);
});

test('the installed location plugin generates iOS background mode and permission text in memory', async () => {
  const config = createLocationConfig();
  // Execute only the plist mod with supplied data. No providers, prebuild, or files are used.
  const result = await config.mods.ios.infoPlist({
    ...config,
    modRequest: { platform: 'ios', modName: 'infoPlist' },
    modResults: { ...appConfig.ios.infoPlist },
  });
  assert.ok(result.modResults.UIBackgroundModes.includes('location'));
  assert.equal(
    result.modResults.NSLocationAlwaysAndWhenInUseUsageDescription,
    getLocationOptions().locationAlwaysAndWhenInUsePermission,
  );
  assert.equal(result.modResults.NSLocationWhenInUseUsageDescription, getLocationOptions().locationWhenInUsePermission);
  assert.equal(result.modResults.NSLocationAlwaysUsageDescription, undefined);
});

test('the installed location plugin generates foreground permissions without Android background access', async () => {
  const config = createLocationConfig();
  // The asset-writing dangerous mod is deliberately never invoked.
  const result = await config.mods.android.manifest({
    ...config,
    modRequest: { platform: 'android', modName: 'manifest' },
    modResults: {
      manifest: {
        $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
        application: [{ $: { 'android:name': '.MainApplication' } }],
      },
    },
  });
  const permissions = result.modResults.manifest['uses-permission'].map((entry) => entry.$['android:name']);
  assert.ok(permissions.includes('android.permission.ACCESS_FINE_LOCATION'));
  assert.ok(permissions.includes('android.permission.ACCESS_COARSE_LOCATION'));
  assert.ok(permissions.includes('android.permission.FOREGROUND_SERVICE'));
  assert.ok(permissions.includes('android.permission.FOREGROUND_SERVICE_LOCATION'));
  assert.equal(permissions.includes('android.permission.ACCESS_BACKGROUND_LOCATION'), false);
});

test('native tracking uses the new appVersion runtime and retains remote build incrementing', () => {
  assert.equal(appConfig.version, '1.0.7');
  assert.deepEqual(appConfig.runtimeVersion, { policy: 'appVersion' });
  assert.equal(eas.cli.appVersionSource, 'remote');
  assert.equal(eas.build.production.autoIncrement, true);
  assert.equal(eas.build.testflight.extends, 'production');
});
