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
        manipulateAsync: async (_uri, _actions, config) => {
          callCount += 1;
          return {
            uri: `file://optimized-${callCount}.jpg`,
            width: 1200,
            height: 800,
            compressUsed: config.compress,
          };
        },
      };
    }

    if (request === 'expo-file-system') {
      return {
        getInfoAsync: async (uri) => ({ size: sizeByCall(uri) }),
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve('../services/imageOptimizationService')];
  return require('../services/imageOptimizationService');
};

test('optimizeImageForUpload returns full, viewer, and thumbnail variants with metrics', async () => {
  const service = buildService({
    sizeByCall: (uri) => {
      if (uri.includes('optimized-1')) return 2_000_000;
      if (uri.includes('optimized-2')) return 1_200_000;
      if (uri.includes('optimized-3')) return 700_000;
      if (uri.includes('optimized-4')) return 430_000;
      if (uri.includes('optimized-5')) return 180_000;
      if (uri.includes('optimized-6')) return 110_000;
      return 2_400_000;
    },
  });

  const result = await service.optimizeImageForUpload({
    uri: 'file://original.jpg',
    fileSize: 2_400_000,
    width: 3000,
    height: 2000,
  }, { maxIterations: 4 });

  assert.equal(result.uploadUri, 'file://optimized-2.jpg');
  assert.equal(result.viewerUri, 'file://optimized-4.jpg');
  assert.equal(result.thumbnailUri, 'file://optimized-6.jpg');
  assert.equal(result.metrics.originalSizeBytes, 2_400_000);
  assert.equal(result.metrics.optimizedSizeBytes, 1_200_000);
  assert.equal(result.metrics.viewerSizeBytes, 430_000);
  assert.equal(result.metrics.thumbnailSizeBytes, 110_000);
  assert.equal(result.metrics.fullOptimizationPasses, 2);
  assert.equal(result.metrics.viewerOptimizationPasses, 2);
  assert.equal(result.metrics.thumbnailOptimizationPasses, 2);
  assert.equal(typeof result.metrics.viewerOptimizationRatio, 'number');
});

test('optimizeImageForUpload exits safely at max iterations when target budgets are never met', async () => {
  const service = buildService({ sizeByCall: () => 5_000_000 });

  const result = await service.optimizeImageForUpload({
    uri: 'file://stubborn.jpg',
    fileSize: 5_500_000,
    width: 3000,
    height: 2000,
  }, { maxIterations: 3 });

  assert.equal(result.metrics.fullOptimizationPasses, 3);
  assert.equal(result.metrics.viewerOptimizationPasses, 3);
  assert.equal(result.metrics.thumbnailOptimizationPasses, 3);
  assert.equal(result.metrics.optimizedSizeBytes, 5_000_000);
  assert.equal(result.metrics.viewerSizeBytes, 5_000_000);
});
