'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { compileModsAsync } = require('@expo/config-plugins');
const { withAndroidBuildProperties } = require('expo-build-properties/build/android');
const withFirebaseAndroidToolchain = require('../../plugins/withFirebaseAndroidToolchain');
const { checkNativeToolchainConfig } = require('../../scripts/security/checkNativeAppCheckConfig');
const root = path.resolve(__dirname, '../..');
const appConfig = require('../../app.config').expo;
const properties = appConfig.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-build-properties')[1];
const autolinkingRoot = path.dirname(require.resolve('expo-modules-autolinking/package.json'));

test('native toolchain guard rejects obsolete compiler, missing companion plugin and static Firebase frameworks', () => {
  assert.equal(checkNativeToolchainConfig().kotlinVersion, '2.4.0');
  for (const alter of [
    config => { config.plugins.find(Array.isArray)[1].android.kotlinVersion = '2.1.20'; },
    config => { config.plugins = config.plugins.filter(plugin => plugin !== './plugins/withFirebaseAndroidToolchain'); },
    config => { config.plugins.find(Array.isArray)[1].ios.useFrameworks = 'static'; },
    config => { delete config.plugins.find(Array.isArray)[1].ios.deploymentTarget; },
    config => { config.plugins.find(Array.isArray)[1].ios.deploymentTarget = 'invalid'; },
  ]) {
    const config = JSON.parse(JSON.stringify(appConfig)); alter(config);
    assert.throws(() => checkNativeToolchainConfig(config), /RNFirebase 27 requires/);
  }
});

test('actual Expo mods generate pinned compiler, catalog KSP and AsyncStorage properties from the installed native template', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'llt-native-config-'));
  const native = path.join(temp, 'android'); fs.mkdirSync(native);
  try {
    const template = path.join(path.dirname(require.resolve('expo/package.json')), 'template.tgz');
    for (const file of ['build.gradle', 'settings.gradle', 'gradle.properties']) {
      fs.writeFileSync(path.join(native, file), execFileSync('tar', ['-xOf', template, `package/android/${file}`]));
    }
    const originalBuild = fs.readFileSync(path.join(native, 'build.gradle'), 'utf8');
    const originalSettings = fs.readFileSync(path.join(native, 'settings.gradle'), 'utf8');
    const configure = () => withFirebaseAndroidToolchain(withAndroidBuildProperties({ name: 'Synthetic', slug: 'synthetic' }, properties));
    await compileModsAsync(configure(), { projectRoot: temp, platforms: ['android'] });
    const first = Object.fromEntries(['build.gradle', 'settings.gradle', 'gradle.properties'].map(file => [file, fs.readFileSync(path.join(native, file), 'utf8')]));
    assert.match(first['build.gradle'], /classpath\('org\.jetbrains\.kotlin:kotlin-gradle-plugin:2\.4\.0'\)/);
    assert.match(first['settings.gradle'], /useExpoVersionCatalog\s*\{\s*version\("ksp", "2\.3\.12"\)/);
    assert.match(first['gradle.properties'], /^android\.kotlinVersion=2\.4\.0$/m);
    assert.match(first['gradle.properties'], /^android\.minSdkVersion=24$/m);
    assert.match(first['gradle.properties'], /^AsyncStorage_next_kspVersion=2\.3\.12$/m);
    assert.match(first['gradle.properties'], /^newArchEnabled=true$/m);
    assert.match(first['gradle.properties'], /^hermesEnabled=true$/m);
    assert.match(first['build.gradle'], /classpath\('com\.android\.tools\.build:gradle'\)/);
    assert.equal(first['build.gradle'], originalBuild.replace("classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')", "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.0')"));
    assert.equal(first['settings.gradle'], originalSettings.replace('expoAutolinking.useExpoVersionCatalog()', 'expoAutolinking.useExpoVersionCatalog {\n  version("ksp", "2.3.12")\n}'));
    assert.doesNotMatch(Object.values(first).join('\n'), /skip-metadata-version-check|AsyncStorage_useNextStorage=true|ksp\.useKSP2=false/);
    await compileModsAsync(configure(), { projectRoot: temp, platforms: ['android'] });
    for (const file of Object.keys(first)) assert.equal(fs.readFileSync(path.join(native, file), 'utf8'), first[file], `${file} idempotent`);
    for (const [file, content, expected] of [
      ['settings.gradle', first['settings.gradle'].replace('useExpoVersionCatalog', 'unknownCatalog'), /expected one Expo version catalog/],
      ['settings.gradle', `${first['settings.gradle']}\nexpoAutolinking.useExpoVersionCatalog()`, /duplicate or conflicting/],
      ['build.gradle', `${first['build.gradle']}\nclasspath('org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20')`, /duplicate or conflicting/],
      ['build.gradle', `${first['build.gradle']}\nclasspath('org.jetbrains.kotlin:kotlin-gradle-plugin')`, /duplicate or conflicting/],
    ]) {
      for (const name of Object.keys(first)) fs.writeFileSync(path.join(native, name), first[name]);
      fs.writeFileSync(path.join(native, file), content);
      await assert.rejects(() => compileModsAsync(configure(), { projectRoot: temp, platforms: ['android'] }), expected);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('llt-native-config-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('installed Expo and AsyncStorage consume the exact supported override hooks and AGP supports selected KSP', () => {
  const source = relative => fs.readFileSync(path.join(autolinkingRoot, relative), 'utf8');
  const prefix = 'android/expo-gradle-plugin/';
  const settings = source(`${prefix}expo-autolinking-settings-plugin/src/main/kotlin/expo/modules/plugin/ExpoAutolinkingSettingsExtension.kt`);
  assert.match(settings, /"android.kotlinVersion" to "kotlin"/);
  assert.match(settings, /override\?\.execute\(catalog\)/);
  const project = source(`${prefix}expo-autolinking-plugin/src/main/kotlin/expo/modules/plugin/ExpoRootProjectPlugin.kt`);
  assert.match(project, /versionCatalogs\.getVersionOrDefault\("ksp"\)/);
  const asyncStorage = fs.readFileSync(path.join(root, 'node_modules/@react-native-async-storage/async-storage/android/config.gradle'), 'utf8');
  assert.match(asyncStorage, /getPropertyOfDefault\("AsyncStorage_next_kspVersion", null\)/);
  assert.match(asyncStorage, /getFlagOrDefault\("AsyncStorage_useNextStorage", false\)/);
  const catalog = fs.readFileSync(path.join(root, 'node_modules/react-native/gradle/libs.versions.toml'), 'utf8');
  const agp = /^agp = "([^"]+)"/m.exec(catalog)?.[1];
  assert.ok(require('semver').gte(agp, '8.12.0'), 'KSP 2.3.12 requires AGP >=8.12.0');
});
