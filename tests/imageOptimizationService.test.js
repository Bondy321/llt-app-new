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

const buildService = ({ sizeByCall }) => {
  let callCount = 0;

  Module._load = function mocked(request, parent, isMain) {
    if (request === 'expo-image-manipulator') {
      return {
        SaveFormat: { JPEG: 'jpeg' },
        ImageManipulator: {
          manipulate: () => ({
            resize: () => {},
            rotate: () => {},
            flip: () => {},
            crop: () => {},
            extent: () => {},
            release: () => {},
            renderAsync: async () => ({
              release: () => {},
              saveAsync: async (config) => {
                callCount += 1;
                return {
                  uri: `file://optimized-${callCount}.jpg`,
                  width: 1200,
                  height: 800,
                  compressUsed: config.compress,
                };
              },
            }),
          }),
        },
      };
    }

    if (request === 'expo-file-system/legacy' || request === 'expo-file-system') {
      return {
        getInfoAsync: async (uri) => ({ size: sizeByCall(uri) }),
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/imageOptimizationService')];
  return require('../services/imageOptimizationService');
};

test('optimizeSourcePhotoForUpload exits safely at max iterations when target budget is never met', async () => {
  const service = buildService({ sizeByCall: () => 5_000_000 });

  const result = await service.optimizeSourcePhotoForUpload({
    uri: 'file://stubborn.jpg',
    fileSize: 5_500_000,
    width: 3000,
    height: 2000,
  }, { maxIterations: 3 });

  assert.equal(result.metrics.fullOptimizationPasses, 3);
  assert.equal(result.metrics.viewerOptimizationPasses, 0);
  assert.equal(result.metrics.thumbnailOptimizationPasses, 0);
  assert.equal(result.metrics.optimizedSizeBytes, 5_000_000);
  assert.equal(result.metrics.viewerSizeBytes, null);
});

test('optimizeSourcePhotoForUpload skips viewer and thumbnail variant work', async () => {
  const service = buildService({
    sizeByCall: (uri) => {
      if (uri.includes('optimized-1')) return 1_100_000;
      return 2_400_000;
    },
  });

  const result = await service.optimizeSourcePhotoForUpload({
    uri: 'file://source-only.jpg',
    fileSize: 2_400_000,
    width: 3000,
    height: 2000,
  }, { maxIterations: 4 });

  assert.equal(result.uploadUri, 'file://optimized-1.jpg');
  assert.equal(result.metrics.optimizedSizeBytes, 1_100_000);
  assert.equal(result.metrics.viewerSizeBytes, null);
  assert.equal(result.metrics.thumbnailSizeBytes, null);
  assert.equal(result.metrics.viewerOptimizationPasses, 0);
  assert.equal(result.metrics.thumbnailOptimizationPasses, 0);
});
