#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.expo',
  '.git',
  'generated',
  '__snapshots__',
]);
const PRODUCTION_ROOTS = [
  'App.js',
  'firebase.js',
  'components',
  'hooks',
  'screens',
  'services',
  'src',
  'utils',
  'functions/index.js',
  'functions/lib',
  'functions/src',
  'web-admin/src',
];

const toPosix = (value) => value.split(path.sep).join('/');
const relativePath = (value) => toPosix(path.relative(repositoryRoot, value));

const isProductionSource = (filePath) => {
  const relative = relativePath(filePath);
  const segments = relative.split('/');
  const base = path.basename(filePath);
  return SOURCE_EXTENSIONS.has(path.extname(filePath))
    && !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))
    && !segments.includes('tests')
    && !segments.includes('__tests__')
    && !/\.(?:test|spec)\.[^.]+$/u.test(base)
    && !/\.generated\.[^.]+$/u.test(base);
};

const walk = (target, output) => {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (isProductionSource(target)) output.add(path.resolve(target));
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    walk(path.join(target, entry.name), output);
  }
};

const collectProductionFiles = () => {
  const files = new Set();
  for (const root of PRODUCTION_ROOTS) walk(path.join(repositoryRoot, root), files);
  return [...files].sort();
};

const countLines = (source) => (source.length === 0 ? 0 : source.split(/\r?\n/u).length);

const extractSpecifiers = (source) => {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bexport\s+[^'";]+?\s+from\s+['"]([^'"]+)['"]/gu,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  }
  return [...new Set(specifiers)];
};

const resolveLocalDependency = (fromFile, specifier, productionFileSet) => {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => productionFileSet.has(path.resolve(candidate))) || null;
};

const findCycles = (graph) => {
  const cycles = new Set();
  const state = new Map();
  const stack = [];
  const canonicalize = (cycle) => {
    const core = cycle.slice(0, -1);
    const rotations = core.map((_, index) => [...core.slice(index), ...core.slice(0, index)]);
    rotations.sort((a, b) => a.join('>').localeCompare(b.join('>')));
    return [...rotations[0], rotations[0][0]].join(' -> ');
  };
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const dependency of graph.get(node) || []) {
      if (!state.has(dependency)) visit(dependency);
      else if (state.get(dependency) === 1) {
        const start = stack.indexOf(dependency);
        cycles.add(canonicalize([...stack.slice(start), dependency].map(relativePath)));
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return [...cycles].sort();
};

const extractCommonJsObjectExports = (source) => {
  const match = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};?\s*$/u);
  if (!match) return [];
  return match[1]
    .replace(/\/\/.*$/gmu, '')
    .split(',')
    .map((entry) => entry.trim().match(/^([A-Za-z_$][\w$]*)/u)?.[1])
    .filter(Boolean)
    .sort();
};

const lineMatches = (records, predicate) => records.flatMap(({ file, source }) => source
  .split(/\r?\n/u)
  .map((line, index) => ({ file: relativePath(file), line: index + 1, text: line.trim() }))
  .filter((entry) => predicate(entry.text)));

const collectMutableTopLevelState = (records) => records.flatMap(({ file, source }) => {
  let depth = 0;
  const matches = [];
  const lines = source.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (depth === 0 && /^(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:Cache|Map|Set|Queue|Pool|Store|Registry)?\s*=\s*(?:new\s+(?:Map|Set)|\[|\{)/u.test(line.trim())) {
      matches.push({ file: relativePath(file), line: index + 1, text: line.trim().slice(0, 180) });
    }
    const withoutStrings = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, '');
    depth += (withoutStrings.match(/\{/gu) || []).length;
    depth -= (withoutStrings.match(/\}/gu) || []).length;
    if (depth < 0) depth = 0;
  });
  return matches;
});

const createArchitectureReport = () => {
  const files = collectProductionFiles();
  const productionFileSet = new Set(files.map((file) => path.resolve(file)));
  const records = files.map((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return {
      file,
      source,
      path: relativePath(file),
      bytes: fs.statSync(file).size,
      lines: countLines(source),
      imports: extractSpecifiers(source),
    };
  });
  const graph = new Map(records.map((record) => [
    record.file,
    record.imports
      .map((specifier) => resolveLocalDependency(record.file, specifier, productionFileSet))
      .filter(Boolean),
  ]));
  const functionsIndex = records.find((record) => record.path === 'functions/index.js');
  const functionsCompositionRoot = records.find((record) => record.path === 'functions/src/compositionRoot.js');
  const appRoot = records.find((record) => record.path === 'App.js');
  const directFunctionExports = [...(functionsIndex?.source.matchAll(/^exports\.([A-Za-z_$][\w$]*)\s*=/gmu) || [])]
    .map((match) => match[1]);
  const composedFunctionExports = [...(functionsCompositionRoot?.source.matchAll(/^  ([A-Za-z_$][\w$]*):/gmu) || [])]
    .map((match) => match[1]);
  const functionExports = [...new Set([...directFunctionExports, ...composedFunctionExports])].sort();
  const serviceExports = Object.fromEntries([
    'services/chatService.js',
    'services/bookingServiceRealtime.js',
    'services/photoService.js',
  ].map((servicePath) => {
    const record = records.find((candidate) => candidate.path === servicePath);
    return [servicePath, extractCommonJsObjectExports(record?.source || '')];
  }));
  const routeRegistry = records.find((record) => record.path === 'src/app/navigation/routeRenderers.js');
  const routeRegistrySource = routeRegistry?.source
    .split('export const APP_ROUTE_RENDERERS = Object.freeze({')[1]?.split('});')[0] || '';
  const mobileRoutes = [...new Set([
    ...(appRoot?.source.matchAll(/case\s+['"]([A-Za-z0-9_-]+)['"]\s*:/gu) || []),
    ...(routeRegistrySource.matchAll(/^  ([A-Za-z0-9_-]+):/gmu) || []),
  ].map((match) => match[1]))].sort();

  return {
    generatedAt: new Date().toISOString(),
    sourceFileCount: records.length,
    byBytes: records.map(({ path: filePath, bytes, lines }) => ({ path: filePath, bytes, lines }))
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)),
    byLines: records.map(({ path: filePath, bytes, lines }) => ({ path: filePath, bytes, lines }))
      .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)),
    functionExports,
    serviceExports,
    mobileRoutes,
    directFirebaseImports: lineMatches(records, (line) => /(?:from\s+|require\()['"]firebase(?:\/|['"])/u.test(line)),
    directPersistenceImports: lineMatches(records, (line) => /@react-native-async-storage\/async-storage|expo-secure-store/u.test(line)),
    directFetchCalls: lineMatches(records, (line) => /\bfetch\s*\(/u.test(line)),
    circularDependencies: findCycles(graph),
    functionsIndexImports: functionsIndex?.imports || [],
    sharpImporters: records.filter((record) => record.imports.includes('sharp')).map((record) => record.path),
    expoServerSdkImporters: records.filter((record) => record.imports.includes('expo-server-sdk')).map((record) => record.path),
    topLevelMutableCollections: collectMutableTopLevelState(records),
  };
};

const formatEntries = (entries, limit = 20) => entries.slice(0, limit)
  .map((entry) => `${String(entry.bytes).padStart(8)} bytes  ${String(entry.lines).padStart(5)} lines  ${entry.path}`)
  .join('\n');

const formatReport = (report) => [
  `Architecture report generated ${report.generatedAt}`,
  `Production source files: ${report.sourceFileCount}`,
  '',
  'Largest production files by bytes:',
  formatEntries(report.byBytes),
  '',
  'Largest production files by lines:',
  formatEntries(report.byLines),
  '',
  `Firebase Function exports (${report.functionExports.length}): ${report.functionExports.join(', ')}`,
  `Mobile routes (${report.mobileRoutes.length}): ${report.mobileRoutes.join(', ')}`,
  ...Object.entries(report.serviceExports).map(([file, exports]) => `${file} exports (${exports.length}): ${exports.join(', ')}`),
  '',
  `Direct Firebase import lines: ${report.directFirebaseImports.length}`,
  `Direct persistence import lines: ${report.directPersistenceImports.length}`,
  `Direct fetch call lines: ${report.directFetchCalls.length}`,
  `Circular production dependencies: ${report.circularDependencies.length}`,
  `functions/index.js direct imports (${report.functionsIndexImports.length}): ${report.functionsIndexImports.join(', ')}`,
  `sharp importers: ${report.sharpImporters.join(', ') || '(none)'}`,
  `expo-server-sdk importers: ${report.expoServerSdkImporters.join(', ') || '(none)'}`,
  `Potential top-level mutable collections/caches: ${report.topLevelMutableCollections.length}`,
].join('\n');

if (require.main === module) {
  const report = createArchitectureReport();
  const json = process.argv.includes('--json');
  const writeArg = process.argv.find((argument) => argument.startsWith('--write='));
  const output = json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`;
  if (writeArg) {
    const outputPath = path.resolve(repositoryRoot, writeArg.slice('--write='.length));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

module.exports = {
  collectProductionFiles,
  createArchitectureReport,
  extractCommonJsObjectExports,
  extractSpecifiers,
  formatReport,
};
