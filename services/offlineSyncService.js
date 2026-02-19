// services/offlineSyncService.js
// Offline-first data layer: local Tour Pack cache, action queue, and replay engine.
import { createPersistenceProvider } from './persistenceProvider';
import logger from './loggerService';

// --- Persistence Providers ---
const tourPackStore = createPersistenceProvider({ namespace: 'LLT_TOURPACK' });
const queueStore = createPersistenceProvider({ namespace: 'LLT_QUEUE' });

// --- Constants ---
const MAX_RETRY_ATTEMPTS = 5;
const STALENESS_FRESH_MS = 15 * 60 * 1000; // 15 minutes
const STALENESS_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCHEMA_VERSION = 1;

// --- Listener mechanism ---
let queueListeners = [];
let replayLock = false;
const processedActionIds = new Set();

// ==================== TOUR PACK DATA HELPERS ====================

/**
 * Save a Tour Pack payload for a given tour and role.
 * @param {string} tourId
 * @param {string} role - 'passenger' | 'driver'
 * @param {object} payload - The tour pack data bundle
 * @returns {{ success: boolean, error?: string }}
 */
export const saveTourPack = async (tourId, role, payload) => {
  try {
    if (!tourId || !role) {
      return { success: false, error: 'tourId and role are required' };
    }
    const key = `pack_${tourId}_${role}`;
    const wrapped = {
      ...payload,
      fetchedAt: new Date().toISOString(),
      sourceVersion: SCHEMA_VERSION,
    };
    await tourPackStore.setItemAsync(key, JSON.stringify(wrapped));
    await setTourPackMeta(tourId, role, {
      lastSyncedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
    });
    logger.info('OfflineSync', 'Tour Pack saved', { tourId, role });
    return { success: true, data: wrapped };
  } catch (error) {
    logger.error('OfflineSync', 'Failed to save Tour Pack', { tourId, role, error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Retrieve a cached Tour Pack for a given tour and role.
 * @param {string} tourId
 * @param {string} role
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
export const getTourPack = async (tourId, role) => {
  try {
    if (!tourId || !role) {
      return { success: false, error: 'tourId and role are required' };
    }
    const key = `pack_${tourId}_${role}`;
    const raw = await tourPackStore.getItemAsync(key);
    if (!raw) {
      return { success: true, data: null };
    }
    const parsed = JSON.parse(raw);
    return { success: true, data: parsed };
  } catch (error) {
    logger.warn('OfflineSync', 'Corrupt Tour Pack data, returning null', { tourId, role, error: error.message });
    return { success: true, data: null };
  }
};

/**
 * Store metadata about a Tour Pack.
 * @param {string} tourId
 * @param {string} role
 * @param {{ lastSyncedAt: string, schemaVersion: number }} meta
 * @returns {{ success: boolean, error?: string }}
 */
export const setTourPackMeta = async (tourId, role, meta) => {
  try {
    const key = `meta_${tourId}_${role}`;
    await tourPackStore.setItemAsync(key, JSON.stringify(meta));
    return { success: true };
  } catch (error) {
    logger.error('OfflineSync', 'Failed to save Tour Pack meta', { tourId, role, error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Retrieve metadata about a Tour Pack.
 * @param {string} tourId
 * @param {string} role
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
export const getTourPackMeta = async (tourId, role) => {
  try {
    const key = `meta_${tourId}_${role}`;
    const raw = await tourPackStore.getItemAsync(key);
    if (!raw) return { success: true, data: null };
    return { success: true, data: JSON.parse(raw) };
  } catch (error) {
    logger.warn('OfflineSync', 'Corrupt Tour Pack meta, returning null', { tourId, role, error: error.message });
    return { success: true, data: null };
  }
};

// ==================== STALENESS HELPERS ====================

/**
 * Determine freshness bucket for a given timestamp.
 * @param {string|null} isoTimestamp
 * @returns {'fresh'|'stale'|'old'|'none'}
 */
export const getStaleness = (isoTimestamp) => {
  if (!isoTimestamp) return 'none';
  const ageMs = Date.now() - new Date(isoTimestamp).getTime();
  if (isNaN(ageMs) || ageMs < 0) return 'fresh';
  if (ageMs <= STALENESS_FRESH_MS) return 'fresh';
  if (ageMs <= STALENESS_STALE_MS) return 'stale';
  return 'old';
};

/**
 * Return a human-readable staleness label for a given timestamp.
 * @param {string|null} isoTimestamp
 * @returns {string}
 */
export const getStalenessLabel = (isoTimestamp) => {
  if (!isoTimestamp) return '';
  const ageMs = Date.now() - new Date(isoTimestamp).getTime();
  if (isNaN(ageMs) || ageMs < 0) return 'Updated just now';
  if (ageMs <= 60 * 1000) return 'Updated just now';
  if (ageMs <= STALENESS_FRESH_MS) {
    const mins = Math.floor(ageMs / 60000);
    return `Updated ${mins} min ago`;
  }
  if (ageMs <= STALENESS_STALE_MS) {
    const hours = Math.floor(ageMs / 3600000);
    if (hours < 1) {
      const mins = Math.floor(ageMs / 60000);
      return `Updated ${mins} min ago`;
    }
    return `Updated ${hours}h ago`;
  }
  return 'Cached data from yesterday';
};

// ==================== QUEUE HELPERS ====================

const QUEUE_KEY = 'action_queue';

/**
 * Read the full queue array from storage.
 * Returns [] on any corruption.
 */
const readQueue = async () => {
  try {
    const raw = await queueStore.getItemAsync(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn('OfflineSync', 'Queue data was not an array, resetting');
      return [];
    }
    return parsed;
  } catch (error) {
    logger.warn('OfflineSync', 'Corrupt queue data, resetting', { error: error.message });
    return [];
  }
};

/**
 * Persist the full queue array.
 */
const writeQueue = async (queue) => {
  try {
    await queueStore.setItemAsync(QUEUE_KEY, JSON.stringify(queue));
  } catch (error) {
    logger.error('OfflineSync', 'Failed to write queue', { error: error.message });
  }
  notifyListeners();
};

/**
 * Enqueue an action to be replayed later.
 * @param {{ id: string, type: string, tourId: string, payload: object }} action
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
export const enqueueAction = async (action) => {
  try {
    if (!action || !action.id || !action.type || !action.tourId) {
      return { success: false, error: 'action must have id, type, and tourId' };
    }
    const queue = await readQueue();
    // Prevent duplicate enqueue of same idempotency key
    if (queue.some((a) => a.id === action.id)) {
      return { success: true, data: queue.find((a) => a.id === action.id) };
    }
    const entry = {
      id: action.id,
      type: action.type,
      tourId: action.tourId,
      createdAt: action.createdAt || new Date().toISOString(),
      payload: action.payload || {},
      attempts: 0,
      status: 'queued',
      lastError: null,
    };
    queue.push(entry);
    await writeQueue(queue);
    logger.info('OfflineSync', 'Action enqueued', { id: entry.id, type: entry.type });
    return { success: true, data: entry };
  } catch (error) {
    logger.error('OfflineSync', 'Failed to enqueue action', { error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Get all queued actions sorted by createdAt.
 * @returns {{ success: boolean, data: Array }}
 */
export const getQueuedActions = async () => {
  try {
    const queue = await readQueue();
    const sorted = queue.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return { success: true, data: sorted };
  } catch (error) {
    return { success: false, data: [], error: error.message };
  }
};

/**
 * Update a single action by id with a partial patch.
 * @param {string} id
 * @param {object} patch
 * @returns {{ success: boolean, error?: string }}
 */
export const updateAction = async (id, patch) => {
  try {
    const queue = await readQueue();
    const index = queue.findIndex((a) => a.id === id);
    if (index === -1) {
      return { success: false, error: 'Action not found' };
    }
    queue[index] = { ...queue[index], ...patch };
    await writeQueue(queue);
    return { success: true };
  } catch (error) {
    logger.error('OfflineSync', 'Failed to update action', { id, error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Remove a single action by id.
 * @param {string} id
 * @returns {{ success: boolean, error?: string }}
 */
export const removeAction = async (id) => {
  try {
    const queue = await readQueue();
    const filtered = queue.filter((a) => a.id !== id);
    await writeQueue(filtered);
    return { success: true };
  } catch (error) {
    logger.error('OfflineSync', 'Failed to remove action', { id, error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Get counts of actions by status.
 * @returns {{ success: boolean, data: { pending: number, failed: number, syncing: number, total: number }}}
 */
export const getQueueStats = async () => {
  try {
    const queue = await readQueue();
    const pending = queue.filter((a) => a.status === 'queued').length;
    const failed = queue.filter((a) => a.status === 'failed').length;
    const syncing = queue.filter((a) => a.status === 'syncing').length;
    return {
      success: true,
      data: { pending, failed, syncing, total: queue.length },
    };
  } catch (error) {
    return { success: true, data: { pending: 0, failed: 0, syncing: 0, total: 0 } };
  }
};

// ==================== REPLAY ENGINE ====================

/**
 * Process the queue FIFO, one-at-a-time.
 * Executor map defines how each action type is processed.
 *
 * @param {{ executors: { [type: string]: (action) => Promise<{ success: boolean, error?: string }> } }} options
 * @returns {{ success: boolean, data?: { processed: number, failed: number, skipped: number }}}
 */
export const replayQueue = async ({ executors = {} } = {}) => {
  if (replayLock) {
    logger.info('OfflineSync', 'Replay already in progress, skipping');
    return { success: true, data: { processed: 0, failed: 0, skipped: 0 } };
  }

  replayLock = true;
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const queue = await readQueue();
    const actionable = queue
      .filter((a) => a.status === 'queued' || a.status === 'failed')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    for (const action of actionable) {
      // Idempotency guard
      if (processedActionIds.has(action.id)) {
        await removeAction(action.id);
        skipped += 1;
        continue;
      }

      // Max retry check
      if (action.attempts >= MAX_RETRY_ATTEMPTS) {
        await updateAction(action.id, { status: 'failed', lastError: 'Max retry attempts reached' });
        failed += 1;
        continue;
      }

      const executor = executors[action.type];
      if (!executor) {
        logger.warn('OfflineSync', 'No executor for action type', { type: action.type });
        await updateAction(action.id, { status: 'failed', lastError: `No executor for type: ${action.type}` });
        failed += 1;
        continue;
      }

      // Mark as syncing
      await updateAction(action.id, { status: 'syncing', attempts: action.attempts + 1 });

      try {
        const result = await executor(action);
        if (result && result.success) {
          processedActionIds.add(action.id);
          await removeAction(action.id);
          processed += 1;
        } else {
          const errorMsg = result?.error || 'Executor returned failure';
          await updateAction(action.id, { status: 'failed', lastError: errorMsg });
          failed += 1;
        }
      } catch (execError) {
        await updateAction(action.id, {
          status: 'failed',
          lastError: execError.message || 'Executor threw an error',
        });
        failed += 1;
      }
    }

    logger.info('OfflineSync', 'Replay complete', { processed, failed, skipped });
    return { success: true, data: { processed, failed, skipped } };
  } catch (error) {
    logger.error('OfflineSync', 'Replay engine error', { error: error.message });
    return { success: false, error: error.message };
  } finally {
    replayLock = false;
  }
};

// ==================== SUBSCRIPTION / LISTENER MECHANISM ====================

/**
 * Subscribe to queue state changes. Returns an unsubscribe function.
 * @param {(stats: { pending: number, failed: number, syncing: number, total: number }) => void} listener
 * @returns {() => void}
 */
export const subscribeQueueState = (listener) => {
  if (typeof listener !== 'function') return () => {};
  queueListeners.push(listener);
  // Immediately fire with current stats
  getQueueStats().then((result) => {
    if (result.success && queueListeners.includes(listener)) {
      listener(result.data);
    }
  });
  return () => {
    queueListeners = queueListeners.filter((l) => l !== listener);
  };
};

const notifyListeners = async () => {
  const result = await getQueueStats();
  if (!result.success) return;
  const stats = result.data;
  for (const listener of queueListeners) {
    try {
      listener(stats);
    } catch (err) {
      logger.warn('OfflineSync', 'Listener error', { error: err.message });
    }
  }
};

// ==================== CONFLICT RESOLUTION ====================

/**
 * Deterministic manifest conflict resolution.
 * Prefers the most recent lastUpdated timestamp.
 * Falls back to server state if timestamps are equal or unavailable.
 *
 * @param {{ localStatus: string, localUpdatedAt?: string }} local
 * @param {{ serverStatus: string, serverUpdatedAt?: string }} server
 * @returns {{ resolvedStatus: string, source: 'local' | 'server', conflictDetected: boolean }}
 */
export const resolveManifestConflict = (local, server) => {
  if (!local || !server) {
    return {
      resolvedStatus: server?.serverStatus || local?.localStatus || 'PENDING',
      source: 'server',
      conflictDetected: false,
    };
  }

  // No conflict if statuses agree
  if (local.localStatus === server.serverStatus) {
    return {
      resolvedStatus: server.serverStatus,
      source: 'server',
      conflictDetected: false,
    };
  }

  // Conflict detected - compare timestamps
  const localTime = local.localUpdatedAt ? new Date(local.localUpdatedAt).getTime() : 0;
  const serverTime = server.serverUpdatedAt ? new Date(server.serverUpdatedAt).getTime() : 0;

  if (localTime > serverTime && !isNaN(localTime) && localTime > 0) {
    logger.info('OfflineSync', 'Conflict resolved: local wins', {
      local: local.localStatus,
      server: server.serverStatus,
    });
    return {
      resolvedStatus: local.localStatus,
      source: 'local',
      conflictDetected: true,
    };
  }

  // Server wins (timestamps equal, unavailable, or server is newer)
  logger.info('OfflineSync', 'Conflict resolved: server wins', {
    local: local.localStatus,
    server: server.serverStatus,
  });
  return {
    resolvedStatus: server.serverStatus,
    source: 'server',
    conflictDetected: true,
  };
};

// ==================== UTILITY ====================

/**
 * Generate a stable UUID v4 for idempotency keys.
 * Uses Math.random as a portable fallback.
 * @returns {string}
 */
export const generateActionId = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * Reset the processed action IDs cache. Mainly for testing.
 */
export const resetProcessedIds = () => {
  processedActionIds.clear();
};

/**
 * Check if replay is currently running.
 * @returns {boolean}
 */
export const isReplayRunning = () => replayLock;

// Export constants for testing
export const CONSTANTS = {
  MAX_RETRY_ATTEMPTS,
  STALENESS_FRESH_MS,
  STALENESS_STALE_MS,
  SCHEMA_VERSION,
};
