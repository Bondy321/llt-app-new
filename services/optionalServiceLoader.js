const loadOptionalService = ({
  modulePath,
  serviceLabel,
  logger,
  isTestEnv = process.env.NODE_ENV === 'test',
  shouldLogWhenUnavailable = false,
}) => {
  try {
    return require(modulePath);
  } catch (error) {
    const message = error?.message || String(error);
    const shouldLog = !isTestEnv && shouldLogWhenUnavailable;

    if (shouldLog && logger?.warn) {
      logger.warn(serviceLabel, 'Optional service unavailable', { modulePath, error: message });
    } else if (shouldLog) {
      console.warn(`${serviceLabel} unavailable:`, message);
    }

    return null;
  }
};

module.exports = { loadOptionalService };
