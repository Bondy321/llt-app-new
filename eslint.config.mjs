import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import promise from 'eslint-plugin-promise';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';

const sourceFiles = ['**/*.{js,jsx,mjs,cjs}'];
const architectureFiles = [
  'src/**/*.{js,jsx}',
  'functions/src/**/*.js',
  'web-admin/src/{app,features,shared}/**/*.{js,jsx}',
  'contracts/**/*.js',
];
const presentationFiles = [
  'screens/**/*.{js,jsx}',
  'components/**/*.{js,jsx}',
  'src/features/**/components/**/*.{js,jsx}',
  'src/features/**/presentation/**/*.{js,jsx}',
  'web-admin/src/{components,features/**/components}/**/*.{js,jsx}',
  'web-admin/src/features/**/presentation/**/*.{js,jsx}',
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/generated/**',
      '**/*.generated.js',
      '**/*.min.js',
    ],
  },
  {
    files: sourceFiles,
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2024,
        ...globals.jest,
      },
    },
    plugins: {
      import: importPlugin,
      promise,
      react,
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
    rules: {
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-duplicate-imports': 'error',
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],
      'promise/no-return-wrap': 'error',
    },
  },
  {
    files: ['**/*.{jsx,tsx}', 'App.js', 'screens/**/*.js', 'components/**/*.js', 'src/**/*.js'],
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      'react/jsx-uses-react': 'off',
      'react/jsx-uses-vars': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: architectureFiles,
    rules: {
      complexity: ['error', 18],
      'max-lines-per-function': ['error', { max: 180, skipBlankLines: true, skipComments: true }],
      'no-console': 'error',
      'promise/catch-or-return': ['error', { allowFinally: true }],
      'promise/param-names': 'error',
    },
  },
  {
    // React coordinators and declarative views are bounded by checkArchitecture.js. Applying the
    // pure-logic 180-line/18-branch function rule to JSX counts render markup as algorithmic risk.
    files: [
      'src/app/**/*.{js,jsx}',
      'web-admin/src/components/**/*.{js,jsx}',
      'web-admin/src/features/**/presentation/**/*.{js,jsx}',
      'web-admin/src/features/**/components/**/*.{js,jsx}',
    ],
    rules: {
      complexity: ['error', 50],
      'max-lines-per-function': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: presentationFiles,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['firebase', 'firebase/*'], message: 'Presentation imports a feature repository or shared adapter, never Firebase directly.' },
          { group: ['@react-native-async-storage/async-storage', 'expo-secure-store'], message: 'Presentation uses the shared persistence adapter.' },
        ],
      }],
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.name='fetch']",
        message: 'Presentation uses an API client rather than fetch directly.',
      }],
    },
  },
  {
    files: ['src/shared/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['../../features/**', '../../app/**', '../../../features/**', '../../../app/**'], message: 'Shared modules cannot depend on app or feature internals.' },
        ],
      }],
    },
  },
  {
    files: ['functions/src/domains/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'firebase-admin', message: 'Use injected backend infrastructure.' },
          { name: 'sharp', message: 'Only the media processing adapter may load sharp.' },
          { name: 'expo-server-sdk', message: 'Only notification infrastructure may load the Expo SDK.' },
        ],
      }],
      'no-restricted-properties': ['error', {
        object: 'process',
        property: 'env',
        message: 'Read environment values through runtimeConfig.',
      }],
    },
  },
  {
    files: [
      'scripts/**/*.js',
      'functions/src/bootstrap/**/*.js',
      'functions/src/config/**/*.js',
      'functions/src/infrastructure/logging/**/*.js',
      'src/shared/logging/**/*.js',
      'web-admin/src/shared/logging/**/*.js',
      '**/*.{test,spec}.js',
      '**/*.{test,spec}.jsx',
    ],
    rules: {
      'no-console': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
      'promise/catch-or-return': 'off',
    },
  },
  {
    files: ['functions/src/infrastructure/storage/mediaProcessor.js'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['functions/src/infrastructure/notifications/expoPushClient.js'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
