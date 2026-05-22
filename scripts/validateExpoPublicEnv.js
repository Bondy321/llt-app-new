#!/usr/bin/env node

const REQUIRED_ENV_VARS = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_DATABASE_URL',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
];

const ANDROID_REQUIRED_ENV_VARS = [
  'EXPO_PUBLIC_GOOGLE_MAPS_API_KEY',
];

const OPTIONAL_ENV_VARS = [
  'EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID',
  'EXPO_PUBLIC_SUPPORT_PHONE',
  'EXPO_PUBLIC_SUPPORT_SMS',
  'EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL',
  'EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_TIMEOUT_MS',
  'EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK',
  'EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK',
];

const PLACEHOLDER_PATTERNS = [
  /^@[\w.-]+$/,
  /^your[_-]/i,
  /your[_-].*here/i,
  /placeholder/i,
  /replace_with/i,
  /^undefined$/i,
  /^null$/i,
];

const FORMAT_CHECKS = {
  EXPO_PUBLIC_FIREBASE_API_KEY: {
    pattern: /^AIza[0-9A-Za-z_-]{20,}$/,
    message: 'expected a Firebase web API key that starts with AIza',
  },
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: {
    pattern: /^[a-z0-9-]+\.firebaseapp\.com$/i,
    message: 'expected a Firebase auth domain like project-id.firebaseapp.com',
  },
  EXPO_PUBLIC_FIREBASE_DATABASE_URL: {
    pattern: /^https:\/\/[a-z0-9-]+-default-rtdb\.europe-west1\.firebasedatabase\.app\/?$/i,
    message: 'expected the europe-west1 Realtime Database URL',
  },
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: {
    pattern: /^[a-z0-9-]+$/i,
    message: 'expected a Firebase project id',
  },
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: {
    pattern: /^[a-z0-9.-]+\.(appspot\.com|firebasestorage\.app)$/i,
    message: 'expected a Firebase Storage bucket host',
  },
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: {
    pattern: /^\d+$/,
    message: 'expected a numeric messaging sender id',
  },
  EXPO_PUBLIC_FIREBASE_APP_ID: {
    pattern: /^1:\d+:[a-z]+:[0-9a-f]+$/i,
    message: 'expected a Firebase app id like 1:sender:web:hash',
  },
  EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: {
    pattern: /^G-[A-Z0-9]+$/i,
    message: 'expected a Google Analytics measurement id like G-XXXXXXXXXX',
  },
  EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: {
    pattern: /^AIza[0-9A-Za-z_-]{20,}$/,
    message: 'expected a Google Maps API key that starts with AIza',
  },
  EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_URL: {
    pattern: /^https:\/\/.+/i,
    message: 'expected an HTTPS verifier URL',
  },
  EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_TIMEOUT_MS: {
    validate: (value) => Number.isFinite(Number(value)) && Number(value) >= 1000,
    message: 'expected a timeout in milliseconds, minimum 1000',
  },
  EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_USE_APPCHECK: {
    pattern: /^(true|false)$/i,
    message: 'expected true or false',
  },
  EXPO_PUBLIC_VERIFY_PASSENGER_LOGIN_REQUIRE_APPCHECK: {
    pattern: /^(true|false)$/i,
    message: 'expected true or false',
  },
};

const getRequestedPlatform = () => {
  const arg = process.argv.find((value) => value.startsWith('--platform='));
  const fromArg = arg ? arg.split('=')[1] : null;
  return (fromArg || process.env.LLT_VALIDATE_PLATFORM || process.env.EAS_BUILD_PLATFORM || 'all').toLowerCase();
};

const isAndroidBuildTarget = (platform) => platform !== 'ios';

const isPlaceholderValue = (value) => {
  const normalized = String(value || '').trim();
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
};

const isBlank = (value) => typeof value !== 'string' || value.trim().length === 0;

const validateFormat = (name, value) => {
  const check = FORMAT_CHECKS[name];
  if (!check || isBlank(value)) return null;

  if (check.pattern && !check.pattern.test(value.trim())) {
    return check.message;
  }

  if (check.validate && !check.validate(value.trim())) {
    return check.message;
  }

  return null;
};

const validateExpoPublicEnv = (env = process.env, options = {}) => {
  const platform = options.platform || getRequestedPlatform();
  const required = [...REQUIRED_ENV_VARS];

  if (isAndroidBuildTarget(platform)) {
    required.push(...ANDROID_REQUIRED_ENV_VARS);
  }

  const errors = [];

  required.forEach((name) => {
    const value = env[name];
    if (isBlank(value)) {
      errors.push(`${name} is missing`);
      return;
    }

    if (isPlaceholderValue(value)) {
      errors.push(`${name} still looks like a placeholder or unresolved EAS alias`);
      return;
    }

    const formatError = validateFormat(name, value);
    if (formatError) {
      errors.push(`${name} is invalid: ${formatError}`);
    }
  });

  OPTIONAL_ENV_VARS.forEach((name) => {
    const value = env[name];
    if (isBlank(value)) return;

    if (isPlaceholderValue(value)) {
      errors.push(`${name} still looks like a placeholder or unresolved EAS alias`);
      return;
    }

    const formatError = validateFormat(name, value);
    if (formatError) {
      errors.push(`${name} is invalid: ${formatError}`);
    }
  });

  return { ok: errors.length === 0, errors, platform };
};

if (require.main === module) {
  const result = validateExpoPublicEnv();

  if (!result.ok) {
    console.error(`Expo public environment validation failed for platform "${result.platform}":`);
    result.errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }

  console.log(`Expo public environment validation passed for platform "${result.platform}".`);
}

module.exports = {
  REQUIRED_ENV_VARS,
  ANDROID_REQUIRED_ENV_VARS,
  OPTIONAL_ENV_VARS,
  validateExpoPublicEnv,
};
