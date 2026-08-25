const {
  logger,
  SUPPORTED_QUEUE_TYPES,
  MAX_ATTEMPTS,
  runtimeState,
  RESPONSE,
  toSortableTimestampMs,
  maskIdentifier,
  summarizeQueueActionForLog,
  normalizeSessionScope,
  filterActionsForScope,
  isSameSessionScope,
} = require('./offlineSyncContext');

const {
  setLastSuccessAt,
  emitQueueState,
  getQueueRaw,
  getProcessedActionIds,
  setProcessedActionIds,
} = require('./syncStatusService');

const {
  getQueuedActions,
  updateAction,
  removeAction,
} = require('./offlineQueueService');

const applyReplayAction = async (action, services = {}) => {
  const { bookingService, chatService, photoService, driverTourPackActionService, db } = services;

  if (action.type === 'MANIFEST_UPDATE' && bookingService?.applyManifestUpdateDirect) {
    return bookingService.applyManifestUpdateDirect(action.payload, db);
  }

  if (action.type === 'CHAT_MESSAGE' && chatService?.sendMessageDirect) {
    return chatService.sendMessageDirect(action.payload, db);
  }

  if (action.type === 'INTERNAL_CHAT_MESSAGE' && chatService?.sendInternalMessageDirect) {
    return chatService.sendInternalMessageDirect(action.payload, db);
  }

  if (action.type === 'PHOTO_UPLOAD' && photoService?.uploadPhotoDirect) {
    const uploadResult = await photoService.uploadPhotoDirect(action.payload, db);
    const chatMessage = action.payload?.chatMessage;
    if (!uploadResult?.success || !chatMessage) {
      return uploadResult;
    }

    const photoId = uploadResult.data?.id;
    if (!photoId) {
      return RESPONSE.fail('Queued chat photo upload completed without a media reference');
    }

    const messageResult = await chatService.sendImageMessage(
      chatMessage.tourId || action.tourId,
      { photoId },
      chatMessage.caption || '',
      chatMessage.senderInfo,
      db,
      {
        messageId: chatMessage.messageId,
        idempotencyKey: chatMessage.idempotencyKey || chatMessage.messageId,
        photoId,
      },
    );
    if (!messageResult?.success) {
      return RESPONSE.fail(messageResult?.error || 'Queued chat photo message could not be created');
    }
    if (messageResult.serverPromise && typeof messageResult.serverPromise.then === 'function') {
      try {
        await messageResult.serverPromise;
      } catch (error) {
        return RESPONSE.fail(error);
      }
    }

    return {
      success: true,
      data: {
        ...uploadResult.data,
        chatMessageId: messageResult.message?.id || chatMessage.messageId,
      },
    };
  }

  if (action.type === 'DRIVER_TOUR_PACK_ACTION' && driverTourPackActionService?.submitDirect) {
    return driverTourPackActionService.submitDirect(action.payload, db);
  }

  return RESPONSE.fail(`Unsupported replay action type: ${action.type}`);
};

const hasReplayHandler = (action, services = {}) => {
  if (!action || !SUPPORTED_QUEUE_TYPES.has(action.type)) return false;
  if (action.type === 'MANIFEST_UPDATE') {
    return typeof services.bookingService?.applyManifestUpdateDirect === 'function';
  }
  if (action.type === 'CHAT_MESSAGE') {
    return typeof services.chatService?.sendMessageDirect === 'function';
  }
  if (action.type === 'INTERNAL_CHAT_MESSAGE') {
    return typeof services.chatService?.sendInternalMessageDirect === 'function';
  }
  if (action.type === 'PHOTO_UPLOAD') {
    const canUpload = typeof services.photoService?.uploadPhotoDirect === 'function';
    const needsChatMessage = Boolean(action.payload?.chatMessage);
    const canCreateChatMessage = typeof services.chatService?.sendImageMessage === 'function';
    return canUpload && (!needsChatMessage || canCreateChatMessage);
  }
  if (action.type === 'DRIVER_TOUR_PACK_ACTION') {
    return typeof services.driverTourPackActionService?.submitDirect === 'function';
  }
  return false;
};

const replayQueue = async ({ db, services = {}, scope = runtimeState.activeSessionScope } = {}) => {
  const replayScope = normalizeSessionScope(scope);
  if (!replayScope) {
    logger.info('OfflineSync', 'Queue replay skipped without an active signed-in tour scope');
    return RESPONSE.ok({
      skipped: true,
      reason: 'No active signed-in tour scope',
      processed: 0,
      failed: 0,
      outcomes: [],
    });
  }
  if (runtimeState.activeSessionScope && !isSameSessionScope(runtimeState.activeSessionScope, replayScope)) {
    logger.warn('OfflineSync', 'Queue replay rejected for a non-active session scope', {
      requestedTourId: maskIdentifier(replayScope.tourId),
      requestedPrincipalId: maskIdentifier(replayScope.principalId),
      activeTourId: maskIdentifier(runtimeState.activeSessionScope.tourId),
      activePrincipalId: maskIdentifier(runtimeState.activeSessionScope.principalId),
    });
    return RESPONSE.fail('Offline actions can only sync for the active signed-in tour session.');
  }
  if (runtimeState.replayLock) {
    logger.info('OfflineSync', 'Queue replay skipped because another replay is active');
    return RESPONSE.ok({ skipped: true, reason: 'Replay already in progress' });
  }

  runtimeState.replayLock = true;
  const replayGeneration = runtimeState.activeSessionGeneration;

  try {
    logger.info('OfflineSync', 'Queue replay started', {
      hasDbOverride: Boolean(db),
      serviceKeys: Object.keys(services || {}),
      tourId: maskIdentifier(replayScope.tourId),
      principalId: maskIdentifier(replayScope.principalId),
      role: replayScope.role,
    });
    const allActions = await getQueueRaw();
    const queue = filterActionsForScope(allActions, replayScope);
    const heldForOtherSessions = Math.max(0, allActions.length - queue.length);
    if (queue.length === 0) {
      logger.info('OfflineSync', 'Queue replay completed with no actions for active scope', {
        heldForOtherSessions,
      });
      return RESPONSE.ok({ processed: 0, failed: 0, outcomes: [], heldForOtherSessions });
    }

    const sortedQueue = [...queue].sort((a, b) => toSortableTimestampMs(a.createdAt) - toSortableTimestampMs(b.createdAt));
    let processedActionIds = await getProcessedActionIds();
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    const outcomes = [];

    logger.info('OfflineSync', 'Queue replay loaded actions', {
      queueCount: sortedQueue.length,
      processedIdCount: processedActionIds.length,
      sample: sortedQueue.slice(0, 10).map(summarizeQueueActionForLog),
    });

    for (const action of sortedQueue) {
      if (
        runtimeState.activeSessionGeneration !== replayGeneration
        || (runtimeState.activeSessionScope && !isSameSessionScope(runtimeState.activeSessionScope, replayScope))
      ) {
        skipped += 1;
        logger.warn('OfflineSync', 'Queue replay stopped because the signed-in tour session changed', {
          action: summarizeQueueActionForLog(action),
          replayGeneration,
          activeSessionGeneration: runtimeState.activeSessionGeneration,
        });
        break;
      }
      if (processedActionIds.includes(action.id)) {
        skipped += 1;
        logger.debug('OfflineSync', 'Queue replay removing already processed action', {
          action: summarizeQueueActionForLog(action),
        });
        await removeAction(action.id, { silent: true, scope: replayScope });
        continue;
      }

      if (action.status === 'failed' || (action.type === 'PHOTO_UPLOAD' && action.status === 'completed')) {
        skipped += 1;
        logger.debug('OfflineSync', 'Queue replay skipped action by terminal status', {
          action: summarizeQueueActionForLog(action),
        });
        continue;
      }

      const now = Date.now();
      const nextAttemptAt = toSortableTimestampMs(action.nextAttemptAt);
      if (nextAttemptAt && nextAttemptAt > now) {
        skipped += 1;
        logger.debug('OfflineSync', 'Queue replay skipped action until backoff expires', {
          action: summarizeQueueActionForLog(action),
          waitMs: nextAttemptAt - now,
        });
        continue;
      }

      // Screen-specific sync controls intentionally inject only the handlers
      // they own. Leave other feature actions untouched for their own replay
      // path instead of consuming retries and eventually marking them failed.
      if (!hasReplayHandler(action, services)) {
        skipped += 1;
        outcomes.push({
          actionId: action.id,
          type: action.type,
          tourId: action.tourId,
          bookingRef: action.payload?.bookingRef || null,
          success: false,
          skipped: true,
          reason: 'Replay handler unavailable in this sync context',
        });
        logger.debug('OfflineSync', 'Queue replay preserved action without an injected handler', {
          action: summarizeQueueActionForLog(action),
          serviceKeys: Object.keys(services || {}),
        });
        continue;
      }

      const inProgressStatus = action.type === 'PHOTO_UPLOAD' ? 'uploading' : 'syncing';
      await updateAction(action.id, { status: inProgressStatus, lastError: null }, { silent: true, scope: replayScope });
      logger.info('OfflineSync', 'Queue replay action started', {
        action: summarizeQueueActionForLog({ ...action, status: inProgressStatus, lastError: null }),
      });
      const result = await applyReplayAction(action, { ...services, db });

      if (result?.success) {
        processed += 1;
        outcomes.push({
          actionId: action.id,
          type: action.type,
          tourId: action.tourId,
          bookingRef: action.payload?.bookingRef || null,
          success: true,
          reconciled: Boolean(result.reconciled),
          conflict: result.conflict || null,
          status: result.status || null,
          passengerStatus: result.passengerStatus || null,
        });
        logger.info('OfflineSync', 'Queue replay action succeeded', {
          action: summarizeQueueActionForLog(action),
          hasResultData: Boolean(result.data),
          resultKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data).slice(0, 20) : [],
        });
        if (action.type === 'PHOTO_UPLOAD') {
          await updateAction(action.id, {
            status: 'completed',
            lastError: null,
            nextAttemptAt: null,
            result: result.data || null,
          }, { silent: true, scope: replayScope });
        } else {
          await removeAction(action.id, { silent: true, scope: replayScope });
          processedActionIds = [...processedActionIds, action.id];
          await setProcessedActionIds(processedActionIds);
        }
      } else {
        failed += 1;
        outcomes.push({
          actionId: action.id,
          type: action.type,
          tourId: action.tourId,
          bookingRef: action.payload?.bookingRef || null,
          success: false,
          error: result?.error || 'Replay failed',
        });
        const attempts = (action.attempts || 0) + 1;
        const shouldFail = attempts >= MAX_ATTEMPTS;
        const delayMinutes = Math.min(2 ** attempts, 60);
        logger.warn('OfflineSync', 'Queue replay action failed', {
          action: summarizeQueueActionForLog(action),
          attempts,
          shouldFail,
          delayMinutes,
          error: result?.error || 'Replay failed',
        });
        await updateAction(action.id, {
          attempts,
          status: shouldFail ? 'failed' : (action.type === 'PHOTO_UPLOAD' ? 'retrying' : 'queued'),
          lastError: result?.error || 'Replay failed',
          nextAttemptAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
        }, { silent: true, scope: replayScope });
      }
    }

    if (processed > 0) {
      const persistedLastSuccessAt = await setLastSuccessAt();
      if (!persistedLastSuccessAt.success) {
        logger.warn('OfflineSync', 'Replay processed actions but failed to persist last success timestamp', {
          error: persistedLastSuccessAt.error,
        });
      }
    }

    logger.info('OfflineSync', 'Queue replay completed', {
      processed,
      failed,
      skipped,
      queueCount: sortedQueue.length,
      heldForOtherSessions,
    });
    return RESPONSE.ok({ processed, failed, skipped, outcomes, heldForOtherSessions });
  } catch (error) {
    logger.error('OfflineSync', 'Queue replay failed', {
      error: error?.message,
      stack: error?.stack,
    });
    return RESPONSE.fail(error);
  } finally {
    runtimeState.replayLock = false;
    await emitQueueState();
  }
};

const getPhotoUploadActions = async ({ tourId, visibility, ownerId } = {}) => {
  const queued = await getQueuedActions();
  if (!queued.success) return queued;

  const filtered = queued.data.filter((action) => {
    if (action.type !== 'PHOTO_UPLOAD') return false;
    if (tourId && action.tourId !== tourId) return false;
    const payload = action.payload || {};
    if (visibility && payload.visibility !== visibility) return false;
    if (ownerId && payload.ownerId !== ownerId && payload.userId !== ownerId) return false;
    return true;
  });
  logger.debug('OfflineSync', 'Photo upload queue actions filtered', {
    tourId: maskIdentifier(tourId),
    visibility: visibility || null,
    ownerId: maskIdentifier(ownerId),
    totalCount: queued.data.length,
    filteredCount: filtered.length,
    sample: filtered.slice(0, 8).map(summarizeQueueActionForLog),
  });
  return RESPONSE.ok(filtered);
};
module.exports = {
  applyReplayAction,
  hasReplayHandler,
  replayQueue,
  getPhotoUploadActions,
};
