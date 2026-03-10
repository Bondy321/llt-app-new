const { test, describe, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const loaderPath = '../services/optionalServiceLoader';

describe('loadOptionalService', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    mock.restoreAll();
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    mock.restoreAll();
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('returns module when require succeeds', () => {
    const { loadOptionalService } = require(loaderPath);
    const loaded = loadOptionalService({
      modulePath: './timeUtils',
      serviceLabel: 'Time service',
    });

    assert.equal(typeof loaded.parseTimestampMs, 'function');
  });

  test('returns null and does not warn in tests', () => {
    process.env.NODE_ENV = 'test';
    const warnMock = mock.method(console, 'warn', () => {});
    const { loadOptionalService } = require(loaderPath);

    const loaded = loadOptionalService({
      modulePath: './missingService',
      serviceLabel: 'Missing service',
      isTestEnv: true,
    });

    assert.equal(loaded, null);
    assert.equal(warnMock.mock.callCount(), 0);
  });


  test('does not log when missing module logging is disabled by default', () => {
    const warnMock = mock.method(console, 'warn', () => {});
    const { loadOptionalService } = require(loaderPath);

    const loaded = loadOptionalService({
      modulePath: './missingService',
      serviceLabel: 'Offline sync service',
      isTestEnv: false,
    });

    assert.equal(loaded, null);
    assert.equal(warnMock.mock.callCount(), 0);
  });

  test('uses logger.warn when missing module logging is enabled', () => {
    const logger = { warn: mock.fn() };
    const { loadOptionalService } = require(loaderPath);

    const loaded = loadOptionalService({
      modulePath: './missingService',
      serviceLabel: 'Offline sync service',
      logger,
      isTestEnv: false,
      shouldLogWhenUnavailable: true,
    });

    assert.equal(loaded, null);
    assert.equal(logger.warn.mock.callCount(), 1);
  });
});
