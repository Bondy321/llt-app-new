#!/usr/bin/env node
'use strict';

const { assertAllProfileParity } = require('./configParity');

try {
  const results = assertAllProfileParity();
  process.stdout.write(`Expo binary/update config parity passed for: ${results.map((result) => result.targetName).join(', ')}.\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
