'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLogData, sanitizeLogText } = require('../../functions/src/infrastructure/logging/safeLogger');
test('staff enrolment secrets never survive structured or diagnostic-text sanitization', () => {
  const secret = `LLT1-${'x'.repeat(43)}`;
  assert.deepEqual(sanitizeLogData({ enrolmentSecret: secret, nested: { password: secret, enrolmentCode: secret } }),
    { enrolmentSecret: '[redacted]', nested: { password: '[redacted]', enrolmentCode: '[redacted]' } });
  assert.equal(sanitizeLogText(`Rejected ${secret}`), 'Rejected [redacted-enrolment-secret]');
});
