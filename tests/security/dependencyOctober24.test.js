'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const semver = require('semver');
const root = path.resolve(__dirname, '../..');
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRoot = path.dirname(expoRequire.resolve('@expo/cli/package.json'));
const cliRequire = createRequire(path.join(cliRoot, 'package.json'));
const loadCli = name => require(path.join(cliRoot, 'build/src/start/server', name));
const plugin = {
  packageName: 'synthetic-plugin', packageRoot: root,
  cliExtensions: { description: 'Synthetic local test', entryPoint: 'synthetic.js', commands: [
    { name: 'inspect', title: 'Inspect', environments: ['cli', 'mcp'], parameters: [
      { name: 'label', type: 'text' }, { name: 'count', type: 'number' }, { name: 'approved', type: 'confirm' },
    ] },
  ] },
};

test('installed Zod and body-parser copies match patched versions without changing body-parser major', () => {
  let zodCopies = 0; let parserCopies = 0;
  for (const directory of [root, path.join(root, 'functions'), path.join(root, 'web-admin')]) {
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!/(?:^|\/)node_modules\/(?:zod|body-parser)$/.test(location)) continue;
      const installed = require(path.join(directory, location, 'package.json'));
      assert.equal(installed.version, entry.version, `${location} lock/install parity`);
      if (location.endsWith('/zod')) {
        zodCopies++;
        assert.ok(semver.gte(entry.version, '4.6.6'), `${location} needs patched Zod`);
      } else {
        parserCopies++;
        assert.ok(semver.satisfies(entry.version, '^1.20.9 || ^2.4.0'), `${location} needs patched body-parser`);
      }
    }
  }
  assert.ok(zodCopies > 0 && parserCopies >= 2);
  assert.equal(semver.major(require('body-parser/package.json').version), 1);
  assert.equal(semver.major(require('../../functions/node_modules/body-parser/package.json').version), 2);
});

for (const [label, load] of [['root', require], ['Expo CLI', cliRequire],
  ['admin hooks lint', createRequire(path.join(root, 'web-admin/package.json'))]]) {
  test(`${label} rejects oversized constrained collections before visiting elements`, () => {
    const z = load('zod').z;
    const originalConfig = { ...z.config() };
    try {
      for (const jitless of [false, true]) {
        z.config({ jitless });
        let visited = 0;
        const element = z.unknown().superRefine((_value, context) => {
          visited++;
          context.addIssue({ code: 'custom', message: 'invalid synthetic element' });
        });
        const rows = Array.from({ length: 20000 }, (_, index) => index);
        for (const [schema, input] of [
          [z.array(element).max(2), rows],
          [z.array(element).length(2), rows],
          [z.set(element).size(2), new Set(rows)],
          [z.map(element, element).max(2), new Map(rows.map(value => [value, value]))],
        ]) {
          const result = z.object({ value: schema }).safeParse({ value: input });
          assert.equal(result.success, false);
          assert.equal(result.error.issues.length, 1);
          assert.equal(result.error.issues[0].code, 'too_big');
          assert.equal(visited, 0, 'oversized input must not create one error per element');
        }
        assert.deepEqual(z.array(z.number()).max(2).parse([1, 2]), [1, 2]);
      }
    } finally { z.config(originalConfig); }
  });
}

test('actual Expo plugin/output consumers preserve validation and error reporting on Zod 4', () => {
  const { PluginSchema, DevToolsPluginOutputSchema } = loadCli('DevToolsPlugin.schema.js');
  assert.equal(PluginSchema.safeParse(plugin).success, true);
  assert.equal(PluginSchema.safeParse({ ...plugin, packageName: '' }).success, false);
  assert.equal(PluginSchema.safeParse({ ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } }).success, false);
  const output = [
    { type: 'text', text: 'ready', level: 'info' },
    { type: 'audio', url: 'https://example.invalid/test.mp3' },
    { type: 'image', url: 'https://example.invalid/test.png', text: 'preview' },
  ];
  assert.deepEqual(DevToolsPluginOutputSchema.parse(output), output);
  assert.equal(DevToolsPluginOutputSchema.safeParse([{ type: 'image', url: 'invalid' }]).success, false);
  const { DevToolsPluginCliExtensionResults } = loadCli('DevToolsPluginCliExtensionResults.js');
  const consumer = new DevToolsPluginCliExtensionResults();
  consumer.append(JSON.stringify(output));
  consumer.append('[{"type":"unknown"}]');
  consumer.append('plain text');
  assert.deepEqual(consumer.getOutput().slice(0, 3), output);
  assert.equal(consumer.getOutput()[3].level, 'error');
  assert.match(consumer.getOutput()[3].text, /^Invalid JSON:/);
  assert.equal(consumer.getOutput()[4].text, 'plain text');
});

test('actual Expo MCP schema survives SDK registration, JSON Schema conversion and argument validation', async () => {
  const { createMCPDevToolsExtensionSchema } = loadCli('createMCPDevToolsExtensionSchema.js');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const schema = createMCPDevToolsExtensionSchema(plugin);
  const server = new McpServer({ name: 'synthetic', version: '1' });
  const client = new Client({ name: 'test', version: '1' });
  let calls = 0;
  server.registerTool('inspect', { inputSchema: { parameters: schema } }, async ({ parameters }) => {
    calls++;
    return { content: [{ type: 'text', text: JSON.stringify(parameters) }] };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools();
    const advertised = tools.tools[0].inputSchema.properties.parameters;
    assert.equal(advertised.additionalProperties, false);
    assert.equal(advertised.properties.count.type, 'number');
    assert.equal(advertised.properties.approved.type, 'boolean');
    const args = { command: 'inspect', label: 'hello', count: 2, approved: true };
    const result = await client.callTool({ name: 'inspect', arguments: { parameters: args } });
    assert.deepEqual(JSON.parse(result.content[0].text), args);
    for (const parameters of [{ command: 'other' }, { ...args, count: 'two' }, { ...args, extra: true }]) {
      const rejected = await client.callTool({ name: 'inspect', arguments: { parameters } });
      assert.equal(rejected.isError, true);
    }
    assert.equal(calls, 1);
  } finally { await client.close(); await server.close(); }
});

for (const consumer of ['express', 'functions/node_modules/express', '@modelcontextprotocol/sdk']) {
  test(`${consumer} real HTTP parser survives late compressed tails and preserves ordinary requests`, () => {
    const consumerPackage = consumer.startsWith('functions/')
      ? path.join(root, consumer, 'package.json')
      : consumer === '@modelcontextprotocol/sdk' ? require.resolve('@modelcontextprotocol/sdk/server/mcp.js')
        : require.resolve(`${consumer}/package.json`);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/bodyParserLateTail.cjs'), consumerPackage], {
      cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 8192,
    });
    assert.equal(result.error, undefined, 'bounded child must finish');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
