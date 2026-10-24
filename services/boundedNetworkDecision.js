'use strict';

const STARTUP_DECISION_TIMEOUT_MS = 5000;
// Read-only decisions may time out without cancelling the SDK request. Callers
// must apply only this returned result, never attach a late mutation callback.
const boundedNetworkDecision = async (operation, timeoutMs = STARTUP_DECISION_TIMEOUT_MS) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(
        new Error('Network decision timed out'), { code: 'NETWORK_DECISION_TIMEOUT' },
      )), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
};
module.exports = { STARTUP_DECISION_TIMEOUT_MS, boundedNetworkDecision };
