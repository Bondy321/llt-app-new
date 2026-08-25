const {
  logger,
  normalizeTourId,
  SUPPORTED_QUEUE_TYPES,
  MAX_QUEUE_ACTIONS,
  listeners,
  queueListeners,
  runtimeState,
  RESPONSE,
  toSortableTimestampMs,
  maskIdentifier,
  summarizeQueueActionForLog,
  normalizeSessionScope,
  deriveActionScope,
  actionMatchesScope,
  filterActionsForScope,
  isSameSessionScope,
  isSameActionOwnerScope,
  withQueueMutationLock,
  hasQueueCapacity,
} = require('./offlineSyncContext');

const {
  buildQueueStats,
  emitQueueState,
  getQueueRaw,
  setQueueRaw,
  getProcessedActionIds,
  setProcessedActionIds,
} = require('./syncStatusService');

const {
  buildAction,
} = require('./tourPackCacheService');

const enqueueAction = async (action) => withQueueMutationLock(async () => {
  try {
    logger.info('OfflineSync', 'Queue enqueue requested', {
      action: summarizeQueueActionForLog(action),
    });
    if (!action?.type || !action?.tourId) {
      logger.warn('OfflineSync', 'Queue enqueue rejected missing required fields', {
        hasType: Boolean(action?.type),
        hasTourId: Boolean(action?.tourId),
      });
      return RESPONSE.fail('type and tourId are required');
    }
    if (!SUPPORTED_QUEUE_TYPES.has(action.type)) {
      logger.warn('OfflineSync', 'Queue enqueue rejected unsupported action type', {
        type: action.type,
        tourId: maskIdentifier(action.tourId),
      });
      return RESPONSE.fail(`Unsupported action type: ${action.type}`);
    }
    const actionScope = deriveActionScope(action)
      || (normalizeTourId(runtimeState.activeSessionScope?.tourId) === normalizeTourId(action.tourId)
        ? runtimeState.activeSessionScope
        : null);
    if (!actionScope) {
      logger.warn('OfflineSync', 'Queue enqueue rejected without an owner scope', {
        type: action.type,
        tourId: maskIdentifier(action.tourId),
      });
      return RESPONSE.fail('A signed-in tour identity is required before an offline action can be queued.');
    }
    if (runtimeState.activeSessionScope && !isSameActionOwnerScope(runtimeState.activeSessionScope, actionScope)) {
      logger.warn('OfflineSync', 'Queue enqueue rejected for a non-active session scope', {
        type: action.type,
        requestedTourId: maskIdentifier(actionScope.tourId),
        requestedPrincipalId: maskIdentifier(actionScope.principalId),
        activeTourId: maskIdentifier(runtimeState.activeSessionScope.tourId),
        activePrincipalId: maskIdentifier(runtimeState.activeSessionScope.principalId),
      });
      return RESPONSE.fail('Offline actions can only be queued for the active signed-in tour session.');
    }
    const scopedAction = { ...action, scope: actionScope };
    let queue = await getQueueRaw({ persistRepairs: true });
    const exists = queue.find((entry) => entry.id === scopedAction.id);
    if (exists) {
      logger.info('OfflineSync', 'Queue enqueue skipped duplicate action', {
        action: summarizeQueueActionForLog(exists),
        queueCount: queue.length,
      });
      return RESPONSE.ok(exists);
    }

    let supersededActionCount = 0;
    if (scopedAction.type === 'MANIFEST_UPDATE' && scopedAction.payload?.bookingRef) {
      const actionTourId = normalizeTourId(scopedAction.tourId);
      const bookingRef = String(scopedAction.payload.bookingRef).trim().toUpperCase();
      const filteredQueue = queue.filter((entry) => {
        const isSupersededManifestUpdate = entry.type === 'MANIFEST_UPDATE'
          && entry.status !== 'syncing'
          && normalizeTourId(entry.tourId) === actionTourId
          && actionMatchesScope(entry, actionScope)
          && String(entry.payload?.bookingRef || '').trim().toUpperCase() === bookingRef;
        if (isSupersededManifestUpdate) supersededActionCount += 1;
        return !isSupersededManifestUpdate;
      });
      queue = filteredQueue;
    }
    if (scopedAction.type === 'DRIVER_TOUR_PACK_ACTION' && scopedAction.payload?.departureKey) {
      const actionKey = `${scopedAction.payload.departureKey}:${scopedAction.payload.driverId}:${scopedAction.payload.kind}:${scopedAction.payload.targetId || 'root'}`;
      queue = queue.filter((entry) => entry.type !== 'DRIVER_TOUR_PACK_ACTION' || entry.status === 'syncing' || !actionMatchesScope(entry, actionScope) || `${entry.payload?.departureKey}:${entry.payload?.driverId}:${entry.payload?.kind}:${entry.payload?.targetId || 'root'}` !== actionKey);
    }

    if (!hasQueueCapacity(queue)) {
      logger.error('OfflineSync', 'Queue enqueue rejected at capacity', {
        queueCount: queue.length,
        maxQueueActions: MAX_QUEUE_ACTIONS,
        action: summarizeQueueActionForLog(scopedAction),
      });
      return RESPONSE.fail('Offline queue is full. Reconnect and sync pending items before trying again.');
    }

    if (scopedAction.id) {
      const processedActionIds = await getProcessedActionIds();
      if (processedActionIds.includes(scopedAction.id)) {
        const filteredProcessedIds = processedActionIds.filter((processedId) => processedId !== scopedAction.id);
        const persistResult = await setProcessedActionIds(filteredProcessedIds);
        if (!persistResult.success) {
          logger.warn('OfflineSync', 'Failed to clear previously processed action id before re-enqueue', {
            actionId: scopedAction.id,
            error: persistResult.error,
          });
        }
      }
    }

    const entry = buildAction(scopedAction);
    queue.push(entry);
    queue.sort((a, b) => toSortableTimestampMs(a.createdAt) - toSortableTimestampMs(b.createdAt));
    await setQueueRaw(queue);
    logger.info('OfflineSync', 'Queue enqueue completed', {
      action: summarizeQueueActionForLog(entry),
      queueCount: queue.length,
      supersededActionCount,
    });
    return RESPONSE.ok({ ...entry, supersededActionCount });
  } catch (error) {
    logger.error('OfflineSync', 'Queue enqueue failed', {
      action: summarizeQueueActionForLog(action),
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const getQueuedActions = async ({ scope = runtimeState.activeSessionScope, includeAll = false } = {}) => {
  try {
    const queue = await getQueueRaw();
    const visibleQueue = includeAll ? queue : filterActionsForScope(queue, scope);
    return RESPONSE.ok(visibleQueue.sort((a, b) => toSortableTimestampMs(a.createdAt) - toSortableTimestampMs(b.createdAt)));
  } catch (error) {
    throw error;
  }
};

const updateAction = async (id, patch = {}, options = {}) => withQueueMutationLock(async () => {
  try {
    const queue = await getQueueRaw({ persistRepairs: true });
    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) {
      logger.warn('OfflineSync', 'Queue action update missed', {
        actionId: maskIdentifier(id),
        patchKeys: Object.keys(patch || {}),
      });
      return RESPONSE.fail('Action not found');
    }
    const mutationScope = options.scope || runtimeState.activeSessionScope;
    if (!options.includeAll && !actionMatchesScope(queue[index], mutationScope)) {
      logger.warn('OfflineSync', 'Queue action update rejected outside active session scope', {
        actionId: maskIdentifier(id),
        action: summarizeQueueActionForLog(queue[index]),
      });
      return RESPONSE.fail('Action belongs to a different signed-in tour session.');
    }
    queue[index] = {
      ...queue[index],
      ...patch,
      scope: queue[index].scope,
      lastUpdatedAt: new Date().toISOString(),
    };
    await setQueueRaw(queue, options);
    logger.debug('OfflineSync', 'Queue action updated', {
      actionId: maskIdentifier(id),
      patchKeys: Object.keys(patch || {}),
      nextAction: summarizeQueueActionForLog(queue[index]),
      silent: Boolean(options.silent),
    });
    return RESPONSE.ok(queue[index]);
  } catch (error) {
    logger.error('OfflineSync', 'Queue action update failed', {
      actionId: maskIdentifier(id),
      patchKeys: Object.keys(patch || {}),
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const removeAction = async (id, options = {}) => withQueueMutationLock(async () => {
  try {
    const queue = await getQueueRaw({ persistRepairs: true });
    const removed = queue.find((entry) => entry.id === id);
    if (removed && !options.includeAll && !actionMatchesScope(removed, options.scope || runtimeState.activeSessionScope)) {
      logger.warn('OfflineSync', 'Queue action removal rejected outside active session scope', {
        actionId: maskIdentifier(id),
        action: summarizeQueueActionForLog(removed),
      });
      return RESPONSE.fail('Action belongs to a different signed-in tour session.');
    }
    const nextQueue = queue.filter((entry) => entry.id !== id);
    await setQueueRaw(nextQueue, options);
    logger.info('OfflineSync', 'Queue action removed', {
      actionId: maskIdentifier(id),
      found: Boolean(removed),
      removedAction: removed ? summarizeQueueActionForLog(removed) : null,
      previousCount: queue.length,
      nextCount: nextQueue.length,
      silent: Boolean(options.silent),
    });
    return RESPONSE.ok(true);
  } catch (error) {
    logger.error('OfflineSync', 'Queue action remove failed', {
      actionId: maskIdentifier(id),
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const getQueueStats = async ({ scope = runtimeState.activeSessionScope, includeAll = false } = {}) => {
  try {
    const allActions = await getQueueRaw();
    const queue = includeAll ? allActions : filterActionsForScope(allActions, scope);
    return RESPONSE.ok(buildQueueStats(queue));
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const retryFailedActions = async ({ types, tourId, resetAttempts = false, scope = runtimeState.activeSessionScope, includeAll = false } = {}) => withQueueMutationLock(async () => {
  try {
    logger.info('OfflineSync', 'Retry failed queue actions requested', {
      types: Array.isArray(types) ? types : null,
      tourId: maskIdentifier(tourId),
      resetAttempts,
    });
    const queue = await getQueueRaw({ persistRepairs: true });
    const allowedTypes = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
    const normalizedTourId = tourId ? normalizeTourId(tourId) : null;
    let retriedCount = 0;

    const nextQueue = queue.map((action) => {
      const shouldRetryType = !allowedTypes || allowedTypes.has(action.type);
      const shouldRetryTour = !normalizedTourId || normalizeTourId(action.tourId) === normalizedTourId;
      const shouldRetryScope = includeAll || actionMatchesScope(action, scope);
      if (action.status !== 'failed' || !shouldRetryType || !shouldRetryTour || !shouldRetryScope) {
        return action;
      }

      retriedCount += 1;
      return {
        ...action,
        status: action.type === 'PHOTO_UPLOAD' ? 'retrying' : 'queued',
        nextAttemptAt: null,
        ...(resetAttempts ? { attempts: 0 } : null),
      };
    });

    if (retriedCount > 0) {
      await setQueueRaw(nextQueue);
    }

    logger.info('OfflineSync', 'Retry failed queue actions completed', {
      retriedCount,
      queueCount: nextQueue.length,
      sample: nextQueue.filter((action) => action.status === 'queued' || action.status === 'retrying').slice(0, 8).map(summarizeQueueActionForLog),
    });
    return RESPONSE.ok({ retriedCount });
  } catch (error) {
    logger.error('OfflineSync', 'Retry failed queue actions failed', {
      types: Array.isArray(types) ? types : null,
      resetAttempts,
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const purgeActionsForScope = async ({ scope, types } = {}) => withQueueMutationLock(async () => {
  try {
    const normalizedScope = normalizeSessionScope(scope);
    if (!normalizedScope) {
      return RESPONSE.fail('A complete signed-in tour scope is required');
    }

    const allowedTypes = Array.isArray(types) && types.length > 0
      ? new Set(types.filter((type) => SUPPORTED_QUEUE_TYPES.has(type)))
      : null;
    if (Array.isArray(types) && types.length > 0 && allowedTypes.size !== types.length) {
      return RESPONSE.fail('One or more queue action types are unsupported');
    }

    const queue = await getQueueRaw({ persistRepairs: true });
    const removed = [];
    const retained = queue.filter((action) => {
      const matchesOwner = actionMatchesScope(action, normalizedScope);
      const matchesType = !allowedTypes || allowedTypes.has(action.type);
      if (matchesOwner && matchesType) {
        removed.push(action);
        return false;
      }
      return true;
    });

    if (removed.length > 0) {
      await setQueueRaw(retained);
    }

    logger.info('OfflineSync', 'Purged queued actions for an exact signed-in tour scope', {
      tourId: maskIdentifier(normalizedScope.tourId),
      principalId: maskIdentifier(normalizedScope.principalId),
      role: normalizedScope.role,
      requestedTypes: allowedTypes ? [...allowedTypes] : null,
      removedCount: removed.length,
      retainedCount: retained.length,
    });
    return RESPONSE.ok({
      removedCount: removed.length,
      removedIds: removed.map((action) => action.id),
    });
  } catch (error) {
    logger.error('OfflineSync', 'Failed to purge queued actions for a signed-in tour scope', {
      error: error?.message,
    });
    return RESPONSE.fail(error);
  }
});

const getActiveSessionScope = () => (
  runtimeState.activeSessionScope ? { ...runtimeState.activeSessionScope } : null
);

const setActiveSessionScope = async (scope) => {
  const nextScope = normalizeSessionScope(scope);
  if (isSameSessionScope(runtimeState.activeSessionScope, nextScope)) {
    return RESPONSE.ok(getActiveSessionScope());
  }

  const previousScope = runtimeState.activeSessionScope;
  runtimeState.activeSessionScope = nextScope;
  runtimeState.activeSessionGeneration += 1;
  logger.info('OfflineSync', 'Active offline session scope changed', {
    previousTourId: maskIdentifier(previousScope?.tourId),
    previousPrincipalId: maskIdentifier(previousScope?.principalId),
    nextTourId: maskIdentifier(nextScope?.tourId),
    nextPrincipalId: maskIdentifier(nextScope?.principalId),
    nextRole: nextScope?.role || null,
    generation: runtimeState.activeSessionGeneration,
  });
  await emitQueueState();
  return RESPONSE.ok(getActiveSessionScope());
};

const getQueueIsolationSummary = async ({ scope = runtimeState.activeSessionScope } = {}) => {
  try {
    const allActions = await getQueueRaw();
    const ownedActions = filterActionsForScope(allActions, scope);
    const ownedIds = new Set(ownedActions.map((action) => action.id));
    const otherSessionActions = allActions.filter((action) => !ownedIds.has(action.id));
    return RESPONSE.ok({
      ownedCount: ownedActions.length,
      otherSessionCount: otherSessionActions.length,
      unownedLegacyCount: otherSessionActions.filter((action) => !deriveActionScope(action)).length,
    });
  } catch (error) {
    return RESPONSE.fail(error);
  }
};

const subscribeQueueState = (listener, { scope } = {}) => {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const subscription = {
    listener,
    scope: scope ? normalizeSessionScope(scope) : null,
    usesActiveScope: !scope,
  };
  listeners.add(subscription);
  logger.debug('OfflineSync', 'Queue state listener subscribed', {
    listenerCount: listeners.size,
  });
  getQueueStats({ scope: subscription.usesActiveScope ? runtimeState.activeSessionScope : subscription.scope }).then((stats) => {
    if (stats.success) listener(stats.data);
  });

  return () => {
    listeners.delete(subscription);
    logger.debug('OfflineSync', 'Queue state listener unsubscribed', {
      listenerCount: listeners.size,
    });
  };
};

const subscribeQueuedActions = (listener, { scope } = {}) => {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const subscription = {
    listener,
    scope: scope ? normalizeSessionScope(scope) : null,
    usesActiveScope: !scope,
  };
  queueListeners.add(subscription);
  logger.debug('OfflineSync', 'Queue actions listener subscribed', {
    listenerCount: queueListeners.size,
  });
  getQueueRaw().then((queue) => listener(filterActionsForScope(
    queue,
    subscription.usesActiveScope ? runtimeState.activeSessionScope : subscription.scope,
  )));

  return () => {
    queueListeners.delete(subscription);
    logger.debug('OfflineSync', 'Queue actions listener unsubscribed', {
      listenerCount: queueListeners.size,
    });
  };
};
module.exports = {
  enqueueAction,
  getQueuedActions,
  updateAction,
  removeAction,
  getQueueStats,
  retryFailedActions,
  purgeActionsForScope,
  getActiveSessionScope,
  setActiveSessionScope,
  getQueueIsolationSummary,
  subscribeQueueState,
  subscribeQueuedActions,
};
