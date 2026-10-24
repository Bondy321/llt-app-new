const { withGradleProperties, withProjectBuildGradle, withSettingsGradle } = require('@expo/config-plugins');

const KOTLIN_VERSION = '2.4.0';
const KSP_VERSION = '2.3.12';

const replaceReviewedAnchor = (contents, anchor, replacement, description, familyPattern) => {
  if ((contents.match(familyPattern) || []).length !== 1) {
    throw new Error(`Firebase Android toolchain: expected one ${description}; duplicate or conflicting native configuration.`);
  }
  if (contents.includes(replacement)) return contents;
  if (contents.split(anchor).length !== 2) {
    throw new Error(`Firebase Android toolchain: expected one ${description}; review the native template before building.`);
  }
  return contents.replace(anchor, replacement);
};

// RNFirebase 27 requires Kotlin 2.4+. Expo 55 supports catalog overrides, but its
// built-in KSP lookup predates 2.4. Keep compiler, catalog and AsyncStorage's
// independently resolved buildscript aligned without patching installed modules.
const withFirebaseAndroidToolchain = config => {
  config = withProjectBuildGradle(config, mod => {
    if (mod.modResults.language !== 'groovy') throw new Error('Firebase Android toolchain requires the reviewed Expo Groovy template.');
    mod.modResults.contents = replaceReviewedAnchor(mod.modResults.contents,
      "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')",
      `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}')`, 'Kotlin Gradle classpath',
      /classpath\(['"]org\.jetbrains\.kotlin:kotlin-gradle-plugin[^'"]*['"]\)/g);
    return mod;
  });
  config = withSettingsGradle(config, mod => {
    if (mod.modResults.language !== 'groovy') throw new Error('Firebase Android toolchain requires the reviewed Expo Groovy template.');
    mod.modResults.contents = replaceReviewedAnchor(mod.modResults.contents,
      'expoAutolinking.useExpoVersionCatalog()',
      `expoAutolinking.useExpoVersionCatalog {\n  version("ksp", "${KSP_VERSION}")\n}`, 'Expo version catalog',
      /expoAutolinking\.useExpoVersionCatalog\b/g);
    return mod;
  });
  return withGradleProperties(config, mod => {
    // This is the actual property read by AsyncStorage 2.2.0. Its next-storage
    // backend stays disabled; even that mode resolves the KSP buildscript.
    const key = 'AsyncStorage_next_kspVersion';
    let found = false;
    mod.modResults = mod.modResults.filter(property => {
      if (property.key !== key) return true;
      if (found) return false;
      found = true; property.value = KSP_VERSION; return true;
    });
    if (!found) mod.modResults.push({ type: 'property', key, value: KSP_VERSION });
    return mod;
  });
};

module.exports = withFirebaseAndroidToolchain;
