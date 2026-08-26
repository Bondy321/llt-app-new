'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { ESLint } = require('eslint');

const repositoryRoot = path.resolve(__dirname, '../..');
const presentationLocations = [
  'src/features/lint-fixture/presentation/BoundaryFixture.js',
  'web-admin/src/features/lint-fixture/presentation/BoundaryFixture.js',
];
const prohibitedSources = [
  { source: "import { getDatabase } from 'firebase/database';\ngetDatabase();", ruleId: 'no-restricted-imports' },
  { source: "import AsyncStorage from '@react-native-async-storage/async-storage';\nAsyncStorage.getItem('x');", ruleId: 'no-restricted-imports' },
  { source: "import * as SecureStore from 'expo-secure-store';\nSecureStore.getItemAsync('x');", ruleId: 'no-restricted-imports' },
  { source: "export const load = () => fetch('/api/value');", ruleId: 'no-restricted-syntax' },
];

test('mobile and admin presentation folders reject direct platform and network access', async () => {
  const eslint = new ESLint({ cwd: repositoryRoot });
  for (const relativePath of presentationLocations) {
    for (const fixture of prohibitedSources) {
      const [result] = await eslint.lintText(fixture.source, {
        filePath: path.join(repositoryRoot, relativePath),
        warnIgnored: false,
      });
      assert.ok(
        result.messages.some((message) => message.ruleId === fixture.ruleId && message.severity === 2),
        `${relativePath} must reject ${fixture.ruleId}: ${JSON.stringify(result.messages)}`,
      );
    }
  }
});
