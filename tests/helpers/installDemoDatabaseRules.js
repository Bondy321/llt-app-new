'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The CLI seeds only its selected namespace. Fresh Admin apps intentionally use
// separate demo namespaces, which still need the actual production query indexes.
const installDemoDatabaseRules = async ({ projectId }) => {
  const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
  if (!/^demo-[a-z0-9-]+$/u.test(projectId || '') || !/^127\.0\.0\.1:\d+$/u.test(host)) {
    throw new Error('Rules installation requires an explicit demo project and loopback database emulator');
  }
  const namespace = `${projectId}-default-rtdb`;
  const url = new URL(`http://${host}/.settings/rules.json`);
  url.searchParams.set('ns', namespace);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:'
    || url.searchParams.get('ns') !== namespace || !namespace.startsWith('demo-')) {
    throw new Error('Invalid demo database emulator target');
  }
  const response = await fetch(url, {
    method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: fs.readFileSync(path.resolve(__dirname, '../../database.rules.json'), 'utf8'),
  });
  if (!response.ok) throw new Error(`Demo database rules installation failed (${response.status})`);
};

module.exports = { installDemoDatabaseRules };
