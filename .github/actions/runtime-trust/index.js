'use strict';

const { assertNodeRuntimeTrust } = require('../../../scripts/security/nodeRuntimeTrust');

try {
  const result = assertNodeRuntimeTrust();
  process.stdout.write(`${JSON.stringify({ kind: 'github-action-runtime', executable: process.execPath, ...result })}\n`);
} catch (error) {
  process.stderr.write(`JavaScript action runtime trust failed: ${error.message}\n`);
  process.exitCode = 1;
}
