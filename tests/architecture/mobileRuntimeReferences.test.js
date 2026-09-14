const test = require('node:test');
const assert = require('node:assert/strict');
const { ESLint } = require('eslint');

test('every mobile source surface rejects missing runtime and JSX references', async () => {
  const eslint = new ESLint();
  for (const filePath of ['App.js', 'index.js', 'firebase.js', 'theme.js', ...['screens', 'components', 'services', 'hooks', 'src', 'utils'].map((dir) => `${dir}/runtimeGateProbe.js`)]) {
    const [result] = await eslint.lintText('export const missing = () => missingRuntimeHelper();\nexport const view = () => <MissingComponent />;\n', { filePath });
    assert.ok(result.messages.some((entry) => entry.ruleId === 'no-undef' && entry.severity === 2), filePath);
    assert.ok(result.messages.some((entry) => entry.ruleId === 'react/jsx-no-undef' && entry.severity === 2), filePath);
  }
  const [nativeGlobals] = await eslint.lintText('export const dev = __DEV__;\nexport const errors = ErrorUtils;\n', { filePath: 'services/runtimeGateProbe.js' });
  assert.equal(nativeGlobals.messages.filter((entry) => entry.ruleId === 'no-undef').length, 0);
});
