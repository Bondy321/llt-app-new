const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

require('@babel/register')({
  extensions: ['.js', '.jsx'],
  presets: ['babel-preset-expo'],
  ignore: [/node_modules/],
  cache: false,
});

const originalLoad = Module._load;

test.after(() => {
  Module._load = originalLoad;
});

const loadServiceWithFsMock = ({ fsImpl }) => {
  Module._load = function mocked(request, parent, isMain) {
    if (request === 'expo-file-system') {
      return fsImpl;
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/photoViewerCacheService')];
  return require('../services/photoViewerCacheService');
};

test('getCachedPhotoUri returns local file when cache already exists', async () => {
  const infoCalls = [];
  const service = loadServiceWithFsMock({
    fsImpl: {
      cacheDirectory: 'file:///cache/',
      documentDirectory: 'file:///docs/',
      getInfoAsync: async (uri) => {
        infoCalls.push(uri);
        if (uri.endsWith('/photo-viewer-cache/')) return { exists: true };
        return { exists: true, modificationTime: 100 };
      },
      makeDirectoryAsync: async () => {},
      downloadAsync: async () => {
        throw new Error('Should not download when file exists');
      },
      readDirectoryAsync: async () => [],
      deleteAsync: async () => {},
    },
  });

  const result = await service.getCachedPhotoUri('https://cdn.example.com/photo.jpg');
  assert.ok(result.startsWith('file:///cache/photo-viewer-cache/'));
  assert.ok(infoCalls.some((uri) => uri.endsWith('/photo-viewer-cache/')));
});

test('getCachedPhotoUri deduplicates concurrent download requests', async () => {
  let downloadCount = 0;
  let firstLookup = true;
  const service = loadServiceWithFsMock({
    fsImpl: {
      cacheDirectory: 'file:///cache/',
      documentDirectory: 'file:///docs/',
      getInfoAsync: async (uri) => {
        if (uri.endsWith('/photo-viewer-cache/')) return { exists: true };
        if (firstLookup) {
          firstLookup = false;
          return { exists: false };
        }
        return { exists: false };
      },
      makeDirectoryAsync: async () => {},
      downloadAsync: async (_remote, local) => {
        downloadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { uri: local };
      },
      readDirectoryAsync: async () => [],
      deleteAsync: async () => {},
    },
  });

  const [a, b] = await Promise.all([
    service.getCachedPhotoUri('https://cdn.example.com/recent.webp'),
    service.getCachedPhotoUri('https://cdn.example.com/recent.webp'),
  ]);

  assert.equal(downloadCount, 1);
  assert.equal(a, b);
});

test('prefetchPhotoUris skips invalid entries and executes safely', async () => {
  let downloads = 0;
  const service = loadServiceWithFsMock({
    fsImpl: {
      cacheDirectory: 'file:///cache/',
      documentDirectory: 'file:///docs/',
      getInfoAsync: async (uri) => {
        if (uri.endsWith('/photo-viewer-cache/')) return { exists: true };
        return { exists: false };
      },
      makeDirectoryAsync: async () => {},
      downloadAsync: async (_remote, local) => {
        downloads += 1;
        return { uri: local };
      },
      readDirectoryAsync: async () => [],
      deleteAsync: async () => {},
    },
  });

  await service.prefetchPhotoUris([
    null,
    '',
    'https://cdn.example.com/a.jpg',
    'https://cdn.example.com/a.jpg',
    'https://cdn.example.com/b.png',
  ]);

  assert.equal(downloads, 2);
});

test('getCachedPhotoUri can skip network download when cache miss and downloadIfMissing is false', async () => {
  let downloadCount = 0;
  const remoteUri = 'https://cdn.example.com/no-download.jpg';
  const service = loadServiceWithFsMock({
    fsImpl: {
      cacheDirectory: 'file:///cache/',
      documentDirectory: 'file:///docs/',
      getInfoAsync: async (uri) => {
        if (uri.endsWith('/photo-viewer-cache/')) return { exists: true };
        return { exists: false };
      },
      makeDirectoryAsync: async () => {},
      downloadAsync: async (_remote, local) => {
        downloadCount += 1;
        return { uri: local };
      },
      readDirectoryAsync: async () => [],
      deleteAsync: async () => {},
    },
  });

  const result = await service.getCachedPhotoUri(remoteUri, { downloadIfMissing: false });
  assert.equal(result, remoteUri);
  assert.equal(downloadCount, 0);
});
