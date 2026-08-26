'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../..');

test('strict staged typecheck contains the intended production boundary programme', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'tsconfig.architecture.json'), 'utf8'));
  assert.equal(config.compilerOptions.checkJs, true);
  const listed = execFileSync(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.architecture.json', '--listFilesOnly'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).replace(/\\/gu, '/');
  const expectedProductionModules = [
    'src/app/navigation/notificationNavigationBoundary.js',
    'src/app/session/appSessionBoundary.js',
    'src/shared/api/responseBoundaries.js',
    'src/shared/persistence/jsonBoundary.js',
    'functions/src/domains/app-sessions/sessionRequestBoundary.js',
    'functions/src/domains/media/mediaUploadMetadata.js',
    'functions/src/infrastructure/auth/requestBoundary.js',
    'functions/src/infrastructure/http/adminCors.js',
    'functions/src/infrastructure/validation/stringNormalization.js',
    'web-admin/src/shared/api/adminResponseBoundary.js',
    'web-admin/src/shared/session/appSessionBoundary.js',
    'contracts/types/generated/contracts.d.ts',
  ];
  expectedProductionModules.forEach((modulePath) => {
    assert.match(listed, new RegExp(modulePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), modulePath);
  });
  assert.ok(listed.split(/\r?\n/u).filter((line) => /(?:src|services|functions|web-admin|contracts)[/\\]/u.test(line)).length >= 20);
});
