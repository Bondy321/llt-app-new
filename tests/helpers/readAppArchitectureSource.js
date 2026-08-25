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

const readFunctionsArchitectureSource = () => [
  fs.readFileSync(path.join(repositoryRoot, 'functions', 'index.js'), 'utf8'),
  ...readTree(path.join(repositoryRoot, 'functions', 'src')),
].join('\n');

const readMobileModuleSource = (relativePath) => {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const extension = path.extname(absolutePath);
  const baseName = path.basename(absolutePath, extension);
  const stylePath = path.join(path.dirname(absolutePath), 'styles', `${baseName}.styles.js`);
  return [
    fs.readFileSync(absolutePath, 'utf8'),
    ...(fs.existsSync(stylePath) ? [fs.readFileSync(stylePath, 'utf8')] : []),
  ].join('\n');
};

module.exports = {
  readAppArchitectureSource,
  readFunctionsArchitectureSource,
  readMobileModuleSource,
};
