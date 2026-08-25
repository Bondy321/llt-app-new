#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractSpecifiers } = require('./reportArchitecture');

const repositoryRoot = path.resolve(__dirname, '..');
const functionsIndex = path.join(repositoryRoot, 'functions', 'index.js');
const domainRoot = path.join(repositoryRoot, 'functions', 'src', 'domains');

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const entryPath = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(entryPath) : [entryPath];
});

const probeSource = `
const started = process.hrtime.bigint();
require(${JSON.stringify(functionsIndex)});
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
const loaded = Object.keys(require.cache).map((value) => value.replace(/\\\\/g, '/'));
process.stdout.write(JSON.stringify({
  elapsedMs: Number(elapsedMs.toFixed(3)),
  sharpLoaded: loaded.some((value) => /\\/sharp\\//.test(value)),
  expoServerSdkLoaded: loaded.some((value) => /\\/expo-server-sdk\\//.test(value)),
  loadedModuleCount: loaded.length,
}));
`;

const probe = spawnSync(process.execPath, ['-e', probeSource], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    FIREBASE_CONFIG: JSON.stringify({
      projectId: 'demo-llt-import-measurement',
      storageBucket: 'demo-bucket.appspot.com',
    }),
  },
  timeout: 60_000,
});

if (probe.status !== 0) {
  process.stderr.write(probe.stderr || probe.stdout || 'Functions import probe failed.\n');
  process.exit(probe.status || 1);
}

const indexSource = fs.readFileSync(functionsIndex, 'utf8');
const largestDomains = walk(domainRoot)
  .filter((file) => /\.(?:js|cjs|mjs)$/u.test(file))
  .map((file) => ({
    path: path.relative(repositoryRoot, file).split(path.sep).join('/'),
    bytes: fs.statSync(file).size,
    lines: fs.readFileSync(file, 'utf8').split(/\r?\n/u).length,
  }))
  .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
  .slice(0, 10);

const report = {
  generatedAt: new Date().toISOString(),
  limitations: 'Local clean-process require timing is a regression signal only; it is not a Cloud Functions cold-start benchmark.',
  index: {
    bytes: fs.statSync(functionsIndex).size,
    lines: indexSource.split(/\r?\n/u).length,
    directImports: extractSpecifiers(indexSource),
  },
  cleanProcessImport: JSON.parse(probe.stdout),
  largestDomains,
};

const writeArgument = process.argv.find((value) => value.startsWith('--write='));
const output = `${JSON.stringify(report, null, 2)}\n`;
if (writeArgument) {
  const target = path.resolve(repositoryRoot, writeArgument.slice('--write='.length));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output, 'utf8');
} else {
  process.stdout.write(output);
}
