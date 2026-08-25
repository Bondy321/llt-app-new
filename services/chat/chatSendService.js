const {
  CHAT_MESSAGE_SCHEMA_VERSION,
  MAX_CAPTION_LENGTH,
  assertTextPassesModeration,
  buildGroupPhotoChatEndpoint,
  createLocalMessageId,
  isTestEnv,
  logChatEvent,
  logChatImageDbEvent,
  maskUserId,
  normalizeMessageTimestamp,
  offlineSyncService,
  parseTimestampToMillis,
  resolveClientCreatedAt,
  resolveMessageWriteIdentity,
  resolveRealtimeDb,
  sanitizeInput,
  summarizeErrorForDbLog,
  summarizeSenderForDbLog,
  validateMessageId,
  validateMessageText,
  validateSenderInfo,
  validateTourId,
  withTimeout,
  writeMessageOnce,
} = require('./chatServiceContext');
const { buildImageMessagePayload, sanitizeReplyContext } = require('./chatMessageModel');

const sendMessageDirect = async (payload, dbInstance) => {
  try {
    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false, error: 'Realtime database unavailable' };

    const validatedTourId = validateTourId(payload.tourId);
    const validatedMessage = validateMessageText(payload.text);
    const validatedSender = validateSenderInfo(payload.senderInfo || {});

    const { messageId, idempotencyKey } = resolveMessageWriteIdentity(payload, 'msg');
    const clientCreatedAt = resolveClientCreatedAt(payload.timestamp);
    const payloadForDb = {
      schemaVersion: CHAT_MESSAGE_SCHEMA_VERSION,
      text: validatedMessage,
      senderName: validatedSender.name,
      senderId: validatedSender.principalId,
      senderType: validatedSender.principalType,
      ...(validatedSender.stablePassengerId ? { senderStableId: validatedSender.stablePassengerId } : {}),
      timestamp: { '.sv': 'timestamp' },
      clientCreatedAt,
      isDriver: validatedSender.isDriver,
      status: 'sent',
      type: 'text',
      idempotencyKey,
    };
    const replyContext = sanitizeReplyContext(payload.replyTo);
    if (replyContext) {
      payloadForDb.replyTo = replyContext;
    }

    const storedMessage = await writeMessageOnce(
      db.ref(`chats/${validatedTourId}/messages/${messageId}`),
      payloadForDb,
    );
    return {
      success: true,
      message: normalizeMessageTimestamp({
        id: messageId,
        ...storedMessage,
        timestamp: parseTimestampToMillis(storedMessage.timestamp) ?? clientCreatedAt,
      }),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const sendInternalMessageDirect = async (payload, dbInstance) => {
  try {
    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false, error: 'Realtime database unavailable' };

    const validatedTourId = validateTourId(payload.tourId);
    const validatedMessage = validateMessageText(payload.text);
    const validatedSender = validateSenderInfo(payload.senderInfo || {});

    const { messageId, idempotencyKey } = resolveMessageWriteIdentity(payload, 'int');
    const clientCreatedAt = resolveClientCreatedAt(payload.timestamp);
    const payloadForDb = {
      schemaVersion: CHAT_MESSAGE_SCHEMA_VERSION,
      text: validatedMessage,
      senderName: validatedSender.name,
      senderId: validatedSender.principalId,
      senderType: validatedSender.principalType,
      ...(validatedSender.stablePassengerId ? { senderStableId: validatedSender.stablePassengerId } : {}),
      timestamp: { '.sv': 'timestamp' },
      clientCreatedAt,
      isDriver: true,
      status: 'sent',
      type: 'text',
      idempotencyKey,
    };
    const replyContext = sanitizeReplyContext(payload.replyTo);
    if (replyContext) {
      payloadForDb.replyTo = replyContext;
    }

    const storedMessage = await writeMessageOnce(
      db.ref(`internal_chats/${validatedTourId}/messages/${messageId}`),
      payloadForDb,
    );
    return {
      success: true,
      message: normalizeMessageTimestamp({
        id: messageId,
        ...storedMessage,
        timestamp: parseTimestampToMillis(storedMessage.timestamp) ?? clientCreatedAt,
      }),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Send a text message to the tour chat with optimistic response
const sendMessage = async (tourId, message, senderInfo, dbInstance, options = {}) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessage = validateMessageText(message);
    const validatedSender = validateSenderInfo(senderInfo);
    logChatEvent('info', 'chat_message_send_started', {
      tourId: validatedTourId,
      messageLength: validatedMessage.length,
      sender: summarizeSenderForDbLog(validatedSender),
      onlineOption: options.online,
      hasReplyTo: Boolean(options.replyTo),
    });

    const localMessageId = validateMessageId(options.messageId || createLocalMessageId('msg'));
    const idempotencyKey = options.idempotencyKey || localMessageId;
    const payload = {
      tourId: validatedTourId,
      messageId: localMessageId,
      text: validatedMessage,
      senderInfo: validatedSender,
      timestamp: new Date().toISOString(),
      idempotencyKey,
      replyTo: sanitizeReplyContext(options.replyTo),
    };

    const directResult = options.online === false
      ? { success: false, error: 'Device is offline' }
      : await sendMessageDirect(payload, dbInstance || resolveRealtimeDb());
    if (directResult.success) {
      const optimisticMessage = { ...directResult.message, status: 'sent' };
      logChatEvent('info', 'chat_message_send_completed', {
        tourId: validatedTourId,
        messageId: directResult.message?.id || null,
        sender: summarizeSenderForDbLog(validatedSender),
        queued: false,
      });
      return { success: true, message: optimisticMessage, queued: false, serverPromise: Promise.resolve(directResult) };
    }

    const shouldQueue = options.online === false || /timeout|network|offline|unavailable/i.test(directResult.error || '');
    if (!shouldQueue || !offlineSyncService?.enqueueAction) {
      logChatEvent('warn', 'chat_message_send_failed_without_queue', {
        tourId: validatedTourId,
        sender: summarizeSenderForDbLog(validatedSender),
        error: directResult.error || 'Failed to send message',
        shouldQueue,
        hasOfflineSync: Boolean(offlineSyncService?.enqueueAction),
      });
      return { success: false, error: directResult.error || 'Failed to send message' };
    }

    const optimisticMessage = {
      id: localMessageId,
      text: validatedMessage,
      senderName: validatedSender.name,
      senderId: validatedSender.principalId,
      senderType: validatedSender.principalType,
      ...(validatedSender.stablePassengerId ? { senderStableId: validatedSender.stablePassengerId } : {}),
      timestamp: payload.timestamp,
      isDriver: validatedSender.isDriver,
      status: 'queued',
      type: 'text',
      idempotencyKey,
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    };

    const queued = await offlineSyncService.enqueueAction({
      id: idempotencyKey,
      type: 'CHAT_MESSAGE',
      tourId: validatedTourId,
      scope: {
        tourId: validatedTourId,
        principalId: validatedSender.principalId,
        role: validatedSender.principalType === 'driver' ? 'driver' : 'passenger',
        authUid: validatedSender.authUid || null,
      },
      createdAt: payload.timestamp,
      payload,
      attempts: 0,
      status: 'queued',
      lastError: directResult.error || null,
    });

    if (!queued.success) {
      logChatEvent('warn', 'chat_message_queue_failed', {
        tourId: validatedTourId,
        sender: summarizeSenderForDbLog(validatedSender),
        idempotencyKey: maskUserId(idempotencyKey),
        error: queued.error || 'Failed to queue message',
      });
      return { success: false, error: queued.error || 'Failed to queue message' };
    }

    logChatEvent('info', 'chat_message_queued', {
      tourId: validatedTourId,
      sender: summarizeSenderForDbLog(validatedSender),
      messageId: localMessageId,
      idempotencyKey: maskUserId(idempotencyKey),
      originalError: directResult.error || null,
    });
    return { success: true, queued: true, message: optimisticMessage };
  } catch (error) {
    logChatEvent('error', 'chat_message_send_threw', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      sender: summarizeSenderForDbLog(senderInfo),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// Send an image message to the tour chat
const sendImageMessage = async (tourId, imageUrl, caption, senderInfo, dbInstance, options = {}) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedSender = validateSenderInfo(senderInfo);

    const photoId = validateMessageId(options.photoId || (typeof imageUrl === 'object' ? imageUrl?.photoId : ''));
    const previewUrl = typeof imageUrl === 'object' ? imageUrl?.previewUrl : imageUrl;
    if (!photoId) {
      logChatImageDbEvent('warn', 'chat_image_message_missing_url', {
        tourId: validatedTourId,
        sender: summarizeSenderForDbLog(validatedSender),
      });
      return { success: false, error: 'Photo reference is required' };
    }

    // Validate caption length if provided
    const sanitizedCaption = caption
      ? assertTextPassesModeration(sanitizeInput(caption.trim()), 'Caption')
      : '';
    if (sanitizedCaption.length > MAX_CAPTION_LENGTH) {
      logChatImageDbEvent('warn', 'chat_image_message_caption_too_long', {
        tourId: validatedTourId,
        captionLength: sanitizedCaption.length,
        sender: summarizeSenderForDbLog(validatedSender),
      });
      return { success: false, error: `Caption exceeds maximum length of ${MAX_CAPTION_LENGTH} characters` };
    }

    const { messageId, idempotencyKey } = resolveMessageWriteIdentity({
      messageId: options.messageId,
      idempotencyKey: options.idempotencyKey,
    }, 'img');
    const clientCreatedAt = Date.now();
    const optimisticMessage = buildImageMessagePayload({ photoId, previewUrl }, sanitizedCaption, validatedSender, messageId);
    const firebaseModule = options.firebaseModule || (isTestEnv ? null : require('../../firebase'));
    const authInstance = options.authInstance || firebaseModule?.auth;
    const endpoint = options.endpoint || buildGroupPhotoChatEndpoint(authInstance);
    const fetchFn = options.fetchFn || fetch;
    const appCheckTokenFn = options.appCheckTokenFn || firebaseModule?.getCurrentAppCheckToken;
    if (!endpoint || !authInstance?.currentUser?.getIdToken) {
      return { success: false, error: 'Secure group photo messaging is unavailable' };
    }
    const serverPromise = withTimeout(
      (async () => {
        const [token, appCheckToken] = await Promise.all([
          authInstance.currentUser.getIdToken(),
          typeof appCheckTokenFn === 'function' ? appCheckTokenFn() : null,
        ]);
        if (!token) throw new Error('Authentication required for group photos');
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        };
        if (appCheckToken) headers['x-firebase-appcheck'] = appCheckToken;
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            tourId: validatedTourId,
            photoId,
            messageId,
            caption: sanitizedCaption,
            senderName: validatedSender.name,
            clientCreatedAt,
          }),
        });
        const responsePayload = await response.json().catch(() => null);
        if (!response.ok || responsePayload?.success !== true) {
          throw new Error('Photo message could not be authorized');
        }
        return responsePayload.message;
      })(),
      30000,
      'Image message send timeout',
    );

    serverPromise.catch((error) => {
      logChatImageDbEvent('error', 'chat_image_message_write_failed', {
        tourId: validatedTourId,
        messageId,
        sender: summarizeSenderForDbLog(validatedSender),
        captionLength: sanitizedCaption.length,
        hasPhotoId: Boolean(photoId),
        error: summarizeErrorForDbLog(error),
      });
      if (optimisticMessage) {
        optimisticMessage.status = 'failed';
      }
    });

    return {
      success: true,
      message: {
        ...optimisticMessage,
        schemaVersion: CHAT_MESSAGE_SCHEMA_VERSION,
        clientCreatedAt,
        idempotencyKey,
      },
      serverPromise,
    };
  } catch (error) {
    logChatImageDbEvent('error', 'chat_image_message_build_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      sender: summarizeSenderForDbLog(senderInfo),
      hasPhotoId: Boolean(options?.photoId || (typeof imageUrl === 'object' && imageUrl?.photoId)),
      captionLength: typeof caption === 'string' ? caption.length : 0,
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// Send a message to the internal driver chat for a tour
const sendInternalDriverMessage = async (tourId, message, senderInfo, dbInstance, options = {}) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessage = validateMessageText(message);
    const validatedSender = validateSenderInfo(senderInfo);
    logChatEvent('info', 'internal_chat_message_send_started', {
      tourId: validatedTourId,
      messageLength: validatedMessage.length,
      sender: summarizeSenderForDbLog(validatedSender),
      onlineOption: options.online,
      hasReplyTo: Boolean(options.replyTo),
    });

    const localMessageId = validateMessageId(options.messageId || createLocalMessageId('int'));
    const idempotencyKey = options.idempotencyKey || localMessageId;
    const payload = {
      tourId: validatedTourId,
      messageId: localMessageId,
      text: validatedMessage,
      senderInfo: { ...validatedSender, isDriver: true },
      timestamp: new Date().toISOString(),
      idempotencyKey,
      replyTo: sanitizeReplyContext(options.replyTo),
    };

    const directResult = options.online === false
      ? { success: false, error: 'Device is offline' }
      : await sendInternalMessageDirect(payload, dbInstance || resolveRealtimeDb());
    if (directResult.success) {
      logChatEvent('info', 'internal_chat_message_send_completed', {
        tourId: validatedTourId,
        messageId: directResult.message?.id || null,
        sender: summarizeSenderForDbLog(validatedSender),
        queued: false,
      });
      return { success: true, message: { ...directResult.message, status: 'sent' }, queued: false, serverPromise: Promise.resolve(directResult) };
    }

    const shouldQueue = options.online === false || /timeout|network|offline|unavailable/i.test(directResult.error || '');
    if (!shouldQueue || !offlineSyncService?.enqueueAction) {
      logChatEvent('warn', 'internal_chat_message_send_failed_without_queue', {
        tourId: validatedTourId,
        sender: summarizeSenderForDbLog(validatedSender),
        error: directResult.error || 'Failed to send internal message',
        shouldQueue,
        hasOfflineSync: Boolean(offlineSyncService?.enqueueAction),
      });
      return { success: false, error: directResult.error || 'Failed to send internal message' };
    }

    const optimisticMessage = {
      id: localMessageId,
      text: validatedMessage,
      senderName: validatedSender.name,
      senderId: validatedSender.principalId,
      senderType: validatedSender.principalType,
      ...(validatedSender.stablePassengerId ? { senderStableId: validatedSender.stablePassengerId } : {}),
      timestamp: payload.timestamp,
      isDriver: true,
      status: 'queued',
      type: 'text',
      idempotencyKey,
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    };

    const queued = await offlineSyncService.enqueueAction({
      id: idempotencyKey,
      type: 'INTERNAL_CHAT_MESSAGE',
      tourId: validatedTourId,
      scope: {
        tourId: validatedTourId,
        principalId: validatedSender.principalId,
        role: 'driver',
        authUid: validatedSender.authUid || null,
      },
      createdAt: payload.timestamp,
      payload,
      attempts: 0,
      status: 'queued',
      lastError: directResult.error || null,
    });

    if (!queued.success) {
      logChatEvent('warn', 'internal_chat_message_queue_failed', {
        tourId: validatedTourId,
        sender: summarizeSenderForDbLog(validatedSender),
        idempotencyKey: maskUserId(idempotencyKey),
        error: queued.error || 'Failed to queue internal message',
      });
      return { success: false, error: queued.error || 'Failed to queue internal message' };
    }

    logChatEvent('info', 'internal_chat_message_queued', {
      tourId: validatedTourId,
      sender: summarizeSenderForDbLog(validatedSender),
      messageId: localMessageId,
      idempotencyKey: maskUserId(idempotencyKey),
      originalError: directResult.error || null,
    });
    return { success: true, queued: true, message: optimisticMessage };
  } catch (error) {
    logChatEvent('error', 'internal_chat_message_send_threw', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      sender: summarizeSenderForDbLog(senderInfo),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// ==================== MESSAGE REACTIONS ====================
// Canonical write contract source of truth:
// docs/reactions-write-contract.md
// Writes must only target chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId} leaf nodes.

// Add a reaction to a message

module.exports = {
  sendImageMessage,
  sendInternalDriverMessage,
  sendInternalMessageDirect,
  sendMessage,
  sendMessageDirect,
};
