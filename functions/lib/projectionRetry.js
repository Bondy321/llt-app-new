'use strict';

// Source triggers and synchronous session cleanup can reconcile the same actor.
// Retry only lease contention; never bypass authority or swallow a failed write.
const retryProjection = async (operation, busyCode) => {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (error?.code !== busyCode || attempt >= 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * (2 ** attempt))));
    }
  }
};

module.exports = { retryProjection };
