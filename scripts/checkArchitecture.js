#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createArchitectureReport } = require('./reportArchitecture');
const limits = require('./architectureLimits');

const repositoryRoot = path.resolve(__dirname, '..');
const VAGUE_NAMES = new Set(['helpers.js', 'utils.js', 'common.js', 'misc.js', 'shared.js']);

const isStyleOnly = (filePath) => /(?:^|\/)(?:styles?|theme)(?:\/|\.|$)/u.test(filePath);
const isHook = (filePath) => /(?:^|\/)use[A-Z][^/]*\.[cm]?[jt]sx?$/u.test(filePath);
const isReactScreen = (filePath) => /(?:^|\/)(?:screens\/[^/]+|[^/]*Screen)\.(?:js|jsx|tsx)$/u.test(filePath)
  || /(?:^|\/)features\/[^/]+\/(?:[^/]+\/)*[^/]*(?:Page|Screen)\.(?:js|jsx|tsx)$/u.test(filePath);

const resolveLimit = (entry) => {
  if (Object.hasOwn(limits.exact, entry.path)) return limits.exact[entry.path];
  if (isStyleOnly(entry.path)) return limits.styleOnly;
  if (isHook(entry.path)) return limits.hook;
  if (isReactScreen(entry.path)) return limits.reactScreen;
  return limits.productionLogic;
};

const isExcepted = (entry) => limits.exceptions.some((exception) => (
  exception.path === entry.path
  && exception.currentSize === entry.lines
  && Number.isInteger(exception.maximumAllowedSize)
  && exception.maximumAllowedSize >= entry.lines
  && exception.reason
  && exception.owner
  && exception.expiryDate
  && exception.followUpIssue
));

const checkArchitecture = () => {
  const report = createArchitectureReport();
  const failures = [];
  for (const entry of report.byLines) {
    const limit = resolveLimit(entry);
    if (entry.lines > limit && !isExcepted(entry)) {
      failures.push(`${entry.path}: ${entry.lines} lines exceeds ${limit}`);
    }
    if (VAGUE_NAMES.has(path.basename(entry.path).toLowerCase())
      && entry.lines > limits.vagueModule && !isExcepted(entry)) {
      failures.push(`${entry.path}: vague module name exceeds ${limits.vagueModule} lines`);
    }
  }

  if (report.circularDependencies.length > 0) {
    failures.push(...report.circularDependencies.map((cycle) => `circular dependency: ${cycle}`));
  }
  if (report.sharpImporters.some((file) => file !== 'functions/src/infrastructure/storage/mediaProcessor.js')) {
    failures.push(`sharp imported outside media processor: ${report.sharpImporters.join(', ')}`);
  }
  if (report.expoServerSdkImporters.some((file) => file !== 'functions/src/infrastructure/notifications/expoPushClient.js')) {
    failures.push(`expo-server-sdk imported outside notification infrastructure: ${report.expoServerSdkImporters.join(', ')}`);
  }

  const functionsIndex = fs.readFileSync(path.join(repositoryRoot, 'functions/index.js'), 'utf8');
  const indexImports = report.functionsIndexImports.filter((specifier) => specifier.startsWith('.'));
  if (indexImports.some((specifier) => !/^\.\/src\/(?:compositionRoot|bootstrap\/)/u.test(specifier))) {
    failures.push(`functions/index.js imports non-composition modules: ${indexImports.join(', ')}`);
  }
  if (/\b(?:admin\.database|admin\.storage|process\.env|req\.(?:body|headers|method))\b/u.test(functionsIndex)) {
    failures.push('functions/index.js still contains infrastructure, configuration, or request handling');
  }

  return { failures, report };
};

if (require.main === module) {
  const { failures, report } = checkArchitecture();
  if (failures.length > 0) {
    process.stderr.write(`Architecture check failed with ${failures.length} violation(s):\n`);
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Architecture check passed for ${report.sourceFileCount} production source files.\n`);
  }
}

module.exports = { checkArchitecture, resolveLimit };
