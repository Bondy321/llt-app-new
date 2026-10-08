'use strict';

// Changes stay separate from npm's truthful upstream package metadata.
const depthSource = `'use strict';

// GHSA-vfj7-8cjw-p6xm: bound recursive walkers, including caller-supplied ASTs.
const MAX_DEPTH = 128;
const literalRoots = new WeakMap();
const literalAst = input => {
  const ast = { type: 'root', input, nodes: [{ type: 'text', value: input }] };
  literalRoots.set(ast, input);
  return ast;
};
const escapeRegex = input => [...input].map(character =>
  '\\\\^$.*+?()[]{}|'.includes(character) ? '\\\\' + character : character).join('');
const inspect = ast => {
  if (literalRoots.has(ast)) return literalRoots.get(ast);
  const stack = [{ node: ast, depth: 0 }];
  const visited = new Set();
  const values = [];
  let deep = false;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    // Parent/prev references are deliberately never traversed. Cyclic child
    // graphs and aliases cannot create recursive calls or unbounded output.
    if (visited.has(node)) { deep = true; continue; }
    visited.add(node);
    if (depth >= MAX_DEPTH) deep = true;
    const parents = new Set();
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent === node || parents.has(parent) || parents.size >= MAX_DEPTH) {
        deep = true;
        break;
      }
      parents.add(parent);
    }
    if (node.value) { values.push(String(node.value)); continue; }
    if (Array.isArray(node.nodes)) {
      for (let i = node.nodes.length - 1; i >= 0; i--) {
        stack.push({ node: node.nodes[i], depth: depth + 1 });
      }
    }
  }
  return deep ? values.join('') : null;
};
module.exports = { MAX_DEPTH, literalAst, inspect, escapeRegex };
`;

const replace = (source, before, after) => {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error('Security patch anchor must occur exactly once');
  }
  return source.replace(before, after);
};

const definitions = {
  'braces@3.0.3': {
    added: { 'lib/depth.js': depthSource },
    transforms: {
      'lib/parse.js': source => {
        source = replace(source, "const stringify = require('./stringify');", "const stringify = require('./stringify');\nconst depthGuard = require('./depth');");
        source = replace(source, 'if (value === CHAR_LEFT_PARENTHESES) {', 'if (value === CHAR_LEFT_PARENTHESES) {\n      if (stack.length >= depthGuard.MAX_DEPTH) return depthGuard.literalAst(input);');
        return replace(source, 'if (value === CHAR_LEFT_CURLY_BRACE) {', 'if (value === CHAR_LEFT_CURLY_BRACE) {\n      if (stack.length >= depthGuard.MAX_DEPTH) return depthGuard.literalAst(input);');
      },
      'lib/compile.js': source => replace(source, 'const compile = (ast, options = {}) => {', "const compile = (ast, options = {}) => {\n  const depthGuard = require('./depth');\n  const literal = depthGuard.inspect(ast);\n  if (literal !== null) return depthGuard.escapeRegex(literal);"),
      'lib/expand.js': source => replace(source, 'const expand = (ast, options = {}) => {', "const expand = (ast, options = {}) => {\n  const literal = require('./depth').inspect(ast);\n  if (literal !== null) return [literal];"),
      'lib/stringify.js': source => replace(source, 'module.exports = (ast, options = {}) => {', "module.exports = (ast, options = {}) => {\n  const literal = require('./depth').inspect(ast);\n  if (literal !== null) return literal;")
    }
  },
  'node-forge@1.4.0': {
    added: {},
    transforms: {
      'lib/rsa.js': source => replace(source, 'obj.value.length !== 2) {', "obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {")
    }
  },
  'sprintf-js@1.0.3': {
    added: {},
    transforms: {
      'src/sprintf.js': source => replace(source, 'switch (match[8]) {', "// GHSA-hp3w-g68c-fv3c: keep all native numeric precisions in range.\n                if (/[efg]/.test(match[8]) && match[7] !== undefined) {\n                    match[7] = String(Math.min(100, Math.max(match[8] === 'g' ? 1 : 0, Number(match[7]))))\n                }\n                switch (match[8]) {")
    }
  }
};

module.exports = { definitions };
