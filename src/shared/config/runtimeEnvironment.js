'use strict';

export const getRuntimeEnvironment = () => process.env;

export const isTestRuntime = (environment = getRuntimeEnvironment()) => (
  environment.NODE_ENV === 'test'
);
