'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');

const readTree = (directory) => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readTree(entryPath);
    return entry.isFile() && /\.(?:js|jsx)$/u.test(entry.name)
      ? [fs.readFileSync(entryPath, 'utf8')]
      : [];
  });

const readAppArchitectureSource = () => [
  fs.readFileSync(path.join(repositoryRoot, 'App.js'), 'utf8'),
  ...readTree(path.join(repositoryRoot, 'src', 'app')),
].join('\n');

module.exports = { readAppArchitectureSource };
