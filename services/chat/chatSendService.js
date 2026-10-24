const {
  CHAT_MESSAGE_SCHEMA_VERSION,
  MAX_CAPTION_LENGTH,
  assertTextPassesModeration,
  buildGroupPhotoChatEndpoint,
  createLocalMessageId,
  isTestEnv,
  logChatImageDbEvent,
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

// Persist first: the immutable message ID is both the durable action identity
// and the RTDB create-once key. A timed-out transaction may still acknowledge;
// replay therefore always uses this same key instead of creating another send.
const sendDurableText = async (tourId, message, senderInfo, dbInstance, options, internal) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessage = validateMessageText(message);
    const sender = validateSenderInfo(senderInfo);
    const id = validateMessageId(options.messageId || createLocalMessageId(internal ? 'int' : 'msg'));
    const idempotencyKey = options.idempotencyKey || id;
    const payload = { tourId: validatedTourId, messageId: id, text: validatedMessage,
      senderInfo: sender, timestamp: new Date().toISOString(), idempotencyKey,
      replyTo: sanitizeReplyContext(options.replyTo) };
    const scope = { tourId: validatedTourId, principalId: sender.principalId,
      role: internal || sender.principalType === 'driver' ? 'driver' : 'passenger', authUid: sender.authUid || null };
    const queued = await offlineSyncService?.enqueueAction?.({ id: idempotencyKey,
      type: internal ? 'INTERNAL_CHAT_MESSAGE' : 'CHAT_MESSAGE', tourId: validatedTourId,
      scope, createdAt: payload.timestamp, payload, attempts: 0, status: 'queued' });
    if (!queued?.success) return { success: false, error: queued?.error || 'Message could not be saved on this phone' };
    options.onDurable?.();
    const pending = { id, ...payload, senderName: sender.name, senderId: sender.principalId,
      senderType: sender.principalType, ...(sender.stablePassengerId ? { senderStableId: sender.stablePassengerId } : {}),
      isDriver: internal || sender.isDriver, type: 'text', status: 'queued' };
    if (options.online === false) return { success: true, queued: true, message: pending };
    let result;
    try {
      result = await withTimeout((internal ? sendInternalMessageDirect : sendMessageDirect)(payload, dbInstance),
        options.deliveryTimeoutMs || 8000, 'Message delivery timed out');
    } catch (error) { result = { success: false, error: error?.message || 'Network unavailable' }; }
    if (result.success) {
      // A failed local removal leaves the same idempotent action for recovery.
      await offlineSyncService.removeAction?.(idempotencyKey, { scope }).catch(() => {});
      return { success: true, queued: false, message: result.message, serverPromise: Promise.resolve(result) };
    }
    const retryable = /timeout|timed out|network|offline|unavailable|disconnect/i.test(result.error || '');
    if (!retryable) {
      await offlineSyncService.updateAction?.(idempotencyKey, { status: 'failed', lastError: result.error }, { scope });
      return { success: false, error: result.error, durable: true, message: { ...pending, status: 'failed' } };
    }
    return { success: true, queued: true, message: pending };
  } catch (error) {
    return { success: false, error: error?.message || 'Message could not be saved' };
  }
};
const sendMessage = (tourId, message, senderInfo, dbInstance, options = {}) =>
  sendDurableText(tourId, message, senderInfo, dbInstance, options, false);

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
const sendInternalDriverMessage = (tourId, message, senderInfo, dbInstance, options = {}) =>
  sendDurableText(tourId, message, senderInfo, dbInstance, options, true);

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
