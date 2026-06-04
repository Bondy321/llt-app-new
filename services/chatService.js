// services/chatService.js - Enhanced Chat Service with Premium Features
// Improved with comprehensive validation, error handling, and security measures
const isTestEnv = process.env.NODE_ENV === 'test';
const IS_DEV_RUNTIME =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
let realtimeDb;
const { loadOptionalService } = require('./optionalServiceLoader');
const { toRealtimeKeySegment } = require('./identityService');
const { parseTimestampMs: parseStrictTimestampMs } = require('./timeUtils');

if (!isTestEnv) {
  try {
    ({ realtimeDb } = require('../firebase'));
  } catch (error) {
    if (IS_DEV_RUNTIME) {
      console.warn('Realtime database module not initialized during load:', error.message);
    }
  }
}

const offlineSyncService = loadOptionalService({
  modulePath: './offlineSyncService',
  loadModule: () => require('./offlineSyncService'),
  serviceLabel: 'Offline sync service',
  isTestEnv,
});

const loggerServiceModule = loadOptionalService({
  modulePath: './loggerService',
  loadModule: () => require('./loggerService'),
  serviceLabel: 'Logger service',
  isTestEnv,
});

const logger = loggerServiceModule?.default || loggerServiceModule;

// ==================== CONSTANTS & CONFIGURATION ====================

const MAX_MESSAGE_LENGTH = 10000;
const MAX_CAPTION_LENGTH = 500;
const MAX_TYPING_INDICATOR_AGE_MS = 10000;
const MAX_PRESENCE_AGE_MS = 300000; // 5 minutes
const CLEANUP_TYPING_DELAY_MS = 10000;
const DEFAULT_LIVE_MESSAGE_LIMIT = 80;
const DEFAULT_PAGE_MESSAGE_LIMIT = 40;

const normalizeMessageLimit = (limit, fallback) => {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit)) return fallback;
  const integerLimit = Math.floor(numericLimit);
  if (integerLimit <= 0) return fallback;
  return Math.min(integerLimit, 250);
};

const parseTimestampToMillis = (timestamp) => {
  const parsed = parseStrictTimestampMs(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeReactionUsers = (users) => {
  const normalizedUserIds = new Set();

  if (users && typeof users === 'object' && !Array.isArray(users)) {
    Object.entries(users).forEach(([userId, reacted]) => {
      if (reacted !== true || typeof userId !== 'string') return;
      const trimmedUserId = userId.trim();
      if (!trimmedUserId) return;
      normalizedUserIds.add(trimmedUserId);
    });
  } else {
    return [];
  }

  return Array.from(normalizedUserIds).sort((a, b) => a.localeCompare(b));
};

const normalizeReactions = (reactions) => {
  if (!reactions || typeof reactions !== 'object') {
    return {};
  }

  return Object.entries(reactions).reduce((accumulator, [emoji, users]) => {
    if (typeof emoji !== 'string') {
      return accumulator;
    }
    const normalizedEmoji = emoji.trim();
    if (!normalizedEmoji) return accumulator;

    const normalizedUsers = normalizeReactionUsers(users);
    if (normalizedUsers.length > 0) {
      accumulator[normalizedEmoji] = normalizedUsers;
    }
    return accumulator;
  }, {});
};

const summarizeReactionUsersForDebug = (users, actorId = null) => {
  const normalizedUsers = normalizeReactionUsers(users);
  return {
    userCount: normalizedUsers.length,
    maskedUserIds: normalizedUsers.slice(0, 8).map(maskUserId),
    truncated: normalizedUsers.length > 8,
    actorPresent: actorId ? normalizedUsers.includes(actorId) : null,
  };
};

const summarizeReactionsForDebug = (reactions, actorId = null) => {
  const normalizedReactions = normalizeReactions(reactions);
  const entries = Object.entries(normalizedReactions);

  return {
    emojiCount: entries.length,
    totalReactionUsers: entries.reduce((total, [, users]) => total + users.length, 0),
    sample: entries.slice(0, 6).map(([emoji, users]) => ({
      emoji,
      ...summarizeReactionUsersForDebug(users, actorId),
    })),
  };
};

const summarizeMessagesForReactionDebug = (messages = []) => {
  const messagesWithReactions = (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      messageId: message?.id || null,
      summary: summarizeReactionsForDebug(message?.reactions),
    }))
    .filter(({ summary }) => summary.emojiCount > 0);

  return {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    reactionMessageCount: messagesWithReactions.length,
    sample: messagesWithReactions.slice(0, 5),
  };
};

const getReactionLeafPath = (tourId, messageId, emoji, userId) =>
  `chats/${tourId}/messages/${messageId}/reactions/${emoji}/${toRealtimeActorKey(userId)}`;

const getReactionEmojiPath = (tourId, messageId, emoji) =>
  `chats/${tourId}/messages/${messageId}/reactions/${emoji}`;

const getReactionLeafRef = (db, tourId, messageId, emoji, userId) =>
  db.ref(getReactionLeafPath(tourId, messageId, emoji, userId));

const getReactionEmojiReadRef = (db, tourId, messageId, emoji) =>
  db.ref(getReactionEmojiPath(tourId, messageId, emoji));

const normalizeMessageTimestamp = (message = {}) => {
  const timestampMs = parseTimestampToMillis(message.timestamp);
  const timestampRaw = message.timestampRaw ?? message.timestamp ?? null;
  return {
    ...message,
    reactions: normalizeReactions(message.reactions),
    timestampRaw,
    timestamp: timestampMs ?? message.timestamp ?? null,
    timestampMs,
  };
};

// ==================== VALIDATION HELPERS ====================

/**
 * Validates tour ID
 */
const validateTourId = (tourId) => {
  if (!tourId || typeof tourId !== 'string' || tourId.trim().length === 0) {
    throw new Error('Invalid tour ID');
  }
  return tourId.trim();
};

/**
 * Validates user ID
 */
const validateUserId = (userId) => {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Invalid user ID');
  }
  return userId.trim();
};

/**
 * Validates message ID
 */
const validateMessageId = (messageId) => {
  if (!messageId || typeof messageId !== 'string' || messageId.trim().length === 0) {
    throw new Error('Invalid message ID');
  }
  return messageId.trim();
};

/**
 * Validates and sanitizes message text
 */
const validateMessageText = (text, maxLength = MAX_MESSAGE_LENGTH) => {
  if (!text || typeof text !== 'string') {
    throw new Error('Message text must be a non-empty string');
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('Message cannot be empty');
  }

  if (trimmed.length > maxLength) {
    throw new Error(`Message exceeds maximum length of ${maxLength} characters`);
  }

  return trimmed;
};

/**
 * Validates sender info object
 */
const validateSenderInfo = (senderInfo) => {
  if (!senderInfo || typeof senderInfo !== 'object') {
    throw new Error('Invalid sender information');
  }

  const principalId = typeof senderInfo.principalId === 'string'
    ? senderInfo.principalId.trim()
    : (typeof senderInfo.userId === 'string' ? senderInfo.userId.trim() : '');

  if (!principalId) {
    throw new Error('Sender must have a valid principalId');
  }

  const normalizedStablePassengerId = typeof senderInfo.stablePassengerId === 'string'
    ? senderInfo.stablePassengerId.trim()
    : (typeof senderInfo.senderStableId === 'string' ? senderInfo.senderStableId.trim() : '');
  const normalizedAuthUid = typeof senderInfo.authUid === 'string'
    ? senderInfo.authUid.trim()
    : '';
  const normalizedPrincipalType = typeof senderInfo.principalType === 'string'
    ? senderInfo.principalType.trim()
    : (principalId.startsWith('driver:') ? 'driver' : 'passenger');
  const isKnownPassengerIdentity = normalizedPrincipalType === 'passenger'
    && principalId !== 'anonymous'
    && !principalId.startsWith('driver:');

  if (isKnownPassengerIdentity && !normalizedStablePassengerId) {
    throw new Error('Passenger senderStableId is required once identity is known');
  }

  const resolvedStablePassengerId = normalizedStablePassengerId
    || (normalizedPrincipalType === 'driver' ? principalId : '');

  return {
    userId: principalId,
    principalId,
    principalType: normalizedPrincipalType || 'passenger',
    name: (senderInfo.name || 'Anonymous').trim(),
    isDriver: !!senderInfo.isDriver,
    ...(normalizedAuthUid ? { authUid: normalizedAuthUid } : {}),
    ...(resolvedStablePassengerId ? { stablePassengerId: resolvedStablePassengerId } : {}),
  };
};

/**
 * Validates callback function
 */
const validateCallback = (callback) => {
  if (typeof callback !== 'function') {
    throw new Error('Callback must be a function');
  }
};

/**
 * Sanitizes user input to prevent injection attacks
 */
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;

  // Remove control characters except newlines and tabs
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
};

/**
 * Validates a string for use as a Firebase Realtime Database key.
 * Firebase keys cannot contain '.', '$', '#', '[', ']', or '/'.
 */
const isValidFirebaseKey = (key) => {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    return false;
  }
  return !/[.#$\/\[\]\x00-\x1F\x7F]/.test(key);
};

const toRealtimeActorKey = (userId) => {
  const validatedUserId = validateUserId(userId);
  return isValidFirebaseKey(validatedUserId)
    ? validatedUserId
    : toRealtimeKeySegment(validatedUserId);
};

const getRealtimeActorContext = (userId) => {
  const rawUserId = validateUserId(userId);
  const actorKey = toRealtimeActorKey(rawUserId);
  return {
    rawUserId,
    actorKey,
    actorKeyWasEncoded: actorKey !== rawUserId,
    actorKeyIsRealtimeSafe: isValidFirebaseKey(actorKey),
  };
};

const buildActorKeySet = (userId) => {
  const keys = new Set();
  if (typeof userId === 'string' && userId.trim()) {
    keys.add(userId.trim());
    try {
      keys.add(toRealtimeActorKey(userId));
    } catch (error) {
      // Invalid actor IDs are ignored for read-only subscription filtering.
    }
  }
  return keys;
};

const maskUserId = (userId) => {
  if (!userId || typeof userId !== 'string') return 'anonymous';
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return 'anonymous';
  if (trimmedUserId.length <= 4) return `${trimmedUserId[0] || ''}***`;
  return `${trimmedUserId.slice(0, 2)}***${trimmedUserId.slice(-2)}`;
};

const summarizeErrorForDbLog = (error) => ({
  name: error?.name || 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
  message: error?.message || String(error),
});

const summarizeSenderForDbLog = (sender = {}) => ({
  principalType: sender?.principalType || null,
  isDriver: Boolean(sender?.isDriver),
  senderIdMasked: maskUserId(sender?.principalId || sender?.userId),
  senderStableIdMasked: maskUserId(sender?.stablePassengerId || sender?.senderStableId),
  hasStablePassengerId: Boolean(sender?.stablePassengerId || sender?.senderStableId),
  hasAuthUid: Boolean(sender?.authUid),
});

const logChatImageDbEvent = (level, eventName, payload = {}) => {
  try {
    const persistLevel = level === 'error' ? 'error' : 'warn';
    if (logger && typeof logger[persistLevel] === 'function') {
      logger[persistLevel]('ChatService', eventName, payload);
    }
  } catch (error) {
    // Realtime database diagnostics must never affect chat behavior.
  }
};

const mapReactionFailureReason = (error, fallbackReason = 'REACTION_TOGGLE_FAILED') => {
  const errorCode = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const errorMessage = typeof error?.message === 'string' ? error.message.toLowerCase() : '';

  if (errorCode.includes('permission_denied') || errorMessage.includes('permission denied')) {
    return 'REACTION_WRITE_DENIED';
  }

  if (
    errorCode.includes('network')
    || errorCode.includes('unavailable')
    || errorMessage.includes('network')
    || errorMessage.includes('timeout')
    || errorMessage.includes('offline')
    || errorMessage.includes('unavailable')
    || errorMessage.includes('disconnected')
  ) {
    return 'REACTION_NETWORK_FAILURE';
  }

  if (
    errorMessage.includes('invalid')
    || errorMessage.includes('must be')
    || errorMessage.includes('required')
    || errorMessage.includes('database unavailable')
  ) {
    return 'REACTION_INPUT_INVALID';
  }

  return fallbackReason;
};

const REACTION_DEBUG_PERSIST_LEVEL = 'warn';

const logReactionEvent = (level, eventName, payload) => {
  const message = `[ChatService] ${eventName}`;
  if (IS_DEV_RUNTIME) {
    try {
      const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](`[ReactionDebug] ${message}`, payload);
    } catch (error) {
      // Debug logging should never affect chat behavior.
    }
  }

  const persistLevel = level === 'error' ? 'error' : REACTION_DEBUG_PERSIST_LEVEL;
  if (logger && typeof logger[persistLevel] === 'function') {
    logger[persistLevel]('ChatService', eventName, payload);
    return;
  }

  if (IS_DEV_RUNTIME) {
    if (level === 'error') {
      console.error(message, payload);
    } else if (level === 'warn') {
      console.warn(message, payload);
    } else {
      console.log(message, payload);
    }
  }
};

const logChatEvent = (level, eventName, payload = {}) => {
  try {
    const persistLevel = typeof logger?.[level] === 'function' ? level : 'info';
    if (logger && typeof logger[persistLevel] === 'function') {
      logger[persistLevel]('ChatService', eventName, payload);
      return;
    }
  } catch (error) {
    // Diagnostics must never affect chat behavior.
  }

  if (IS_DEV_RUNTIME) {
    try {
      const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](`[ChatService] ${eventName}`, payload);
    } catch (error) {
      // Ignore diagnostic fallback failures.
    }
  }
};

// ==================== MESSAGE BUILDING ====================

const buildMessagePayload = (messageText, senderInfo, messageId, messageType = 'text') => {
  const safeSender = senderInfo || {};
  const timestamp = new Date().toISOString();
  const rawMessageText = typeof messageText === 'string'
    ? messageText
    : String(messageText ?? '');
  const sanitizedText = sanitizeInput(rawMessageText.trim());

  return {
    id: messageId,
    text: sanitizedText,
    senderName: sanitizeInput(safeSender.name || 'Anonymous'),
    senderId: safeSender.principalId || safeSender.userId || 'anonymous',
    senderType: safeSender.principalType || (safeSender.isDriver ? 'driver' : 'passenger'),
    ...(safeSender.stablePassengerId ? { senderStableId: safeSender.stablePassengerId } : {}),
    timestamp,
    isDriver: !!safeSender.isDriver,
    type: messageType, // 'text', 'image', 'system'
    status: 'sending', // 'sending', 'sent', 'delivered', 'failed'
    reactions: {}, // { emoji: { [userId]: true } } normalized to arrays in UI/service reads
  };
};

const buildImageMessagePayload = (imageUrl, caption, senderInfo, messageId) => {
  const base = buildMessagePayload(caption, senderInfo, messageId, 'image');
  return {
    ...base,
    imageUrl,
    thumbnailUrl: imageUrl, // Could be a smaller version
  };
};

const sanitizeReplyContext = (replyTo) => {
  if (!replyTo || typeof replyTo !== 'object') {
    return null;
  }

  const replyMessageId = typeof replyTo.messageId === 'string' ? replyTo.messageId.trim() : '';
  if (!replyMessageId) {
    return null;
  }

  const replySenderName = typeof replyTo.senderName === 'string' && replyTo.senderName.trim().length > 0
    ? sanitizeInput(replyTo.senderName.trim())
    : 'Participant';

  const replyPreview = typeof replyTo.previewText === 'string'
    ? sanitizeInput(replyTo.previewText.trim()).slice(0, 160)
    : '';
  const replyIdempotencyKey = typeof replyTo.idempotencyKey === 'string'
    ? replyTo.idempotencyKey.trim()
    : '';

  return {
    messageId: replyMessageId,
    senderName: replySenderName,
    previewText: replyPreview,
    ...(replyIdempotencyKey ? { idempotencyKey: replyIdempotencyKey } : {}),
  };
};

const buildMessagesFromSnapshot = (snapshot) => {
  const messages = [];

  if (snapshot.exists()) {
    snapshot.forEach((childSnapshot) => {
      messages.push(normalizeMessageTimestamp({
        id: childSnapshot.key,
        ...childSnapshot.val(),
      }));
    });
  }

  messages.sort((a, b) => {
    const aTs = a.timestampMs ?? parseTimestampToMillis(a.timestamp) ?? 0;
    const bTs = b.timestampMs ?? parseTimestampToMillis(b.timestamp) ?? 0;
    return aTs - bTs;
  });

  return messages;
};

const getChatMessagesPath = (tourId, scope = 'group') => {
  const validatedTourId = validateTourId(tourId);
  return scope === 'internal'
    ? `internal_chats/${validatedTourId}/messages`
    : `chats/${validatedTourId}/messages`;
};

const buildTimestampQuery = (messagesRef, {
  limit,
  beforeTimestamp = null,
} = {}) => {
  const safeLimit = normalizeMessageLimit(limit, DEFAULT_LIVE_MESSAGE_LIMIT);
  let queryRef = typeof messagesRef?.orderByChild === 'function'
    ? messagesRef.orderByChild('timestamp')
    : messagesRef;

  if (beforeTimestamp !== null && beforeTimestamp !== undefined && typeof queryRef?.endAt === 'function') {
    queryRef = queryRef.endAt(beforeTimestamp);
  }

  if (typeof queryRef?.limitToLast === 'function') {
    queryRef = queryRef.limitToLast(safeLimit);
  }

  return queryRef;
};

const readMessagesFromSnapshot = (snapshot) => buildMessagesFromSnapshot(snapshot);

// ==================== SEND MESSAGES ====================

const sendMessageDirect = async (payload, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false, error: 'Realtime database unavailable' };

    const validatedTourId = validateTourId(payload.tourId);
    const validatedMessage = validateMessageText(payload.text);
    const validatedSender = validateSenderInfo(payload.senderInfo || {});

    const messagesRef = db.ref(`chats/${validatedTourId}/messages`);
    const pushedRef = typeof messagesRef?.push === 'function' && !payload.messageId ? messagesRef.push() : null;
    const messageId = payload.messageId || pushedRef?.key || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payloadForDb = {
      text: validatedMessage,
      senderName: validatedSender.name,
      senderId: validatedSender.principalId,
      senderType: validatedSender.principalType,
      ...(validatedSender.stablePassengerId ? { senderStableId: validatedSender.stablePassengerId } : {}),
      timestamp: payload.timestamp || new Date().toISOString(),
      isDriver: validatedSender.isDriver,
      status: 'sent',
      idempotencyKey: payload.idempotencyKey || messageId,
    };
    const replyContext = sanitizeReplyContext(payload.replyTo);
    if (replyContext) {
      payloadForDb.replyTo = replyContext;
    }

    if (pushedRef?.set) {
      await pushedRef.set(payloadForDb);
    } else {
      await db.ref(`chats/${validatedTourId}/messages/${messageId}`).set(payloadForDb);
    }
    return { success: true, message: { id: messageId, ...payloadForDb } };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const sendInternalMessageDirect = async (payload, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false, error: 'Realtime database unavailable' };

    const validatedTourId = validateTourId(payload.tourId);
    const validatedMessage = validateMessageText(payload.text);
    const validatedSender = validateSenderInfo(payload.senderInfo || {});

    const messagesRef = db.ref(`internal_chats/${validatedTourId}/messages`);
    const pushedRef = typeof messagesRef?.push === 'function' && !payload.messageId ? messagesRef.push() : null;
    const messageId = payload.messageId || pushedRef?.key || `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payloadForDb = {
      text: validatedMessage,
      senderName: validatedSender.name,
      senderId: validatedSender.principalId,
      senderType: validatedSender.principalType,
      ...(validatedSender.stablePassengerId ? { senderStableId: validatedSender.stablePassengerId } : {}),
      timestamp: payload.timestamp || new Date().toISOString(),
      isDriver: true,
      status: 'sent',
      idempotencyKey: payload.idempotencyKey || messageId,
    };
    const replyContext = sanitizeReplyContext(payload.replyTo);
    if (replyContext) {
      payloadForDb.replyTo = replyContext;
    }

    if (pushedRef?.set) {
      await pushedRef.set(payloadForDb);
    } else {
      await db.ref(`internal_chats/${validatedTourId}/messages/${messageId}`).set(payloadForDb);
    }
    return { success: true, message: { id: messageId, ...payloadForDb } };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Send a text message to the tour chat with optimistic response
const sendMessage = async (tourId, message, senderInfo, dbInstance = realtimeDb, options = {}) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessage = validateMessageText(message);
    const validatedSender = validateSenderInfo(senderInfo);
    const db = dbInstance || realtimeDb;
    logChatEvent('info', 'chat_message_send_started', {
      tourId: validatedTourId,
      messageLength: validatedMessage.length,
      sender: summarizeSenderForDbLog(validatedSender),
      onlineOption: options.online,
      hasReplyTo: Boolean(options.replyTo),
    });

    const localMessageId = options.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const idempotencyKey = options.idempotencyKey || localMessageId;
    const payload = {
      tourId: validatedTourId,
      messageId: options.messageId || null,
      text: validatedMessage,
      senderInfo: validatedSender,
      timestamp: new Date().toISOString(),
      idempotencyKey,
      replyTo: sanitizeReplyContext(options.replyTo),
    };

    const directResult = await sendMessageDirect(payload, db);
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

    const shouldQueue = !options.online || /timeout|network|unavailable/i.test(directResult.error || '');
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
const sendImageMessage = async (tourId, imageUrl, caption, senderInfo, dbInstance = realtimeDb) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedSender = validateSenderInfo(senderInfo);

    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
      logChatImageDbEvent('warn', 'chat_image_message_missing_url', {
        tourId: validatedTourId,
        sender: summarizeSenderForDbLog(validatedSender),
      });
      return { success: false, error: 'Image URL is required' };
    }

    // Validate caption length if provided
    const sanitizedCaption = caption ? sanitizeInput(caption.trim()) : '';
    if (sanitizedCaption.length > MAX_CAPTION_LENGTH) {
      logChatImageDbEvent('warn', 'chat_image_message_caption_too_long', {
        tourId: validatedTourId,
        captionLength: sanitizedCaption.length,
        sender: summarizeSenderForDbLog(validatedSender),
      });
      return { success: false, error: `Caption exceeds maximum length of ${MAX_CAPTION_LENGTH} characters` };
    }

    const db = dbInstance || realtimeDb;

    if (!db) {
      logChatImageDbEvent('error', 'chat_image_message_database_unavailable', {
        tourId: validatedTourId,
        sender: summarizeSenderForDbLog(validatedSender),
      });
      return { success: false, error: 'Realtime database unavailable' };
    }

    const messagesRef = db.ref(`chats/${validatedTourId}/messages`);
    const newMessageRef = messagesRef.push();
    const optimisticMessage = buildImageMessagePayload(imageUrl.trim(), sanitizedCaption, validatedSender, newMessageRef.key);

    const { id, status, ...payloadForDb } = optimisticMessage;
    payloadForDb.status = 'sent';

    // Send to database with timeout protection
    const serverPromise = Promise.race([
      newMessageRef.set(payloadForDb),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Image message send timeout')), 30000)
      )
    ]);

    serverPromise.catch((error) => {
      logChatImageDbEvent('error', 'chat_image_message_write_failed', {
        tourId: validatedTourId,
        messageId: newMessageRef.key || null,
        sender: summarizeSenderForDbLog(validatedSender),
        captionLength: sanitizedCaption.length,
        imageUrlLength: imageUrl.trim().length,
        error: summarizeErrorForDbLog(error),
      });
      if (optimisticMessage) {
        optimisticMessage.status = 'failed';
      }
    });

    return { success: true, message: optimisticMessage, serverPromise };
  } catch (error) {
    logChatImageDbEvent('error', 'chat_image_message_build_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      sender: summarizeSenderForDbLog(senderInfo),
      hasImageUrl: Boolean(imageUrl),
      captionLength: typeof caption === 'string' ? caption.length : 0,
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// Send a message to the internal driver chat for a tour
const sendInternalDriverMessage = async (tourId, message, senderInfo, dbInstance = realtimeDb, options = {}) => {
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

    const db = dbInstance || realtimeDb;

    const localMessageId = options.messageId || `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const idempotencyKey = options.idempotencyKey || localMessageId;
    const payload = {
      tourId: validatedTourId,
      messageId: options.messageId || null,
      text: validatedMessage,
      senderInfo: { ...validatedSender, isDriver: true },
      timestamp: new Date().toISOString(),
      idempotencyKey,
      replyTo: sanitizeReplyContext(options.replyTo),
    };

    const directResult = await sendInternalMessageDirect(payload, db);
    if (directResult.success) {
      logChatEvent('info', 'internal_chat_message_send_completed', {
        tourId: validatedTourId,
        messageId: directResult.message?.id || null,
        sender: summarizeSenderForDbLog(validatedSender),
        queued: false,
      });
      return { success: true, message: { ...directResult.message, status: 'sent' }, queued: false, serverPromise: Promise.resolve(directResult) };
    }

    const shouldQueue = !options.online || /timeout|network|unavailable/i.test(directResult.error || '');
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
const addReaction = async (tourId, messageId, emoji, userId, dbInstance = realtimeDb) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);
    const {
      rawUserId: validatedUserId,
      actorKey,
      actorKeyWasEncoded,
      actorKeyIsRealtimeSafe,
    } = getRealtimeActorContext(userId);

    if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
      return { success: false, error: 'Invalid emoji' };
    }

    const sanitizedEmoji = emoji.trim();
    if (!isValidFirebaseKey(sanitizedEmoji)) {
      return { success: false, error: 'Invalid emoji character for database key' };
    }

    const db = dbInstance || realtimeDb;
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    logReactionEvent('info', 'reaction_add_write_start', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      actorKeyIsRealtimeSafe,
    });

    const reactionLeafRef = getReactionLeafRef(
      db,
      validatedTourId,
      validatedMessageId,
      sanitizedEmoji,
      actorKey
    );

    await reactionLeafRef.set(true);
    logReactionEvent('info', 'reaction_add_write_complete', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
    });
    return { success: true };
  } catch (error) {
    logChatEvent('error', 'reaction_add_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      messageId: typeof messageId === 'string' ? messageId.trim() : null,
      emoji,
      maskedUserId: maskUserId(userId),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// Remove a reaction from a message
const removeReaction = async (tourId, messageId, emoji, userId, dbInstance = realtimeDb) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);
    const {
      rawUserId: validatedUserId,
      actorKey,
      actorKeyWasEncoded,
      actorKeyIsRealtimeSafe,
    } = getRealtimeActorContext(userId);

    if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
      return { success: false, error: 'Invalid emoji' };
    }

    const sanitizedEmoji = emoji.trim();
    if (!isValidFirebaseKey(sanitizedEmoji)) {
      return { success: false, error: 'Invalid emoji character for database key' };
    }

    const db = dbInstance || realtimeDb;
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    logReactionEvent('info', 'reaction_remove_write_start', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      actorKeyIsRealtimeSafe,
    });

    const reactionLeafRef = getReactionLeafRef(
      db,
      validatedTourId,
      validatedMessageId,
      sanitizedEmoji,
      actorKey
    );

    await reactionLeafRef.remove();
    logReactionEvent('info', 'reaction_remove_write_complete', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId: maskUserId(validatedUserId),
    });
    return { success: true };
  } catch (error) {
    logChatEvent('error', 'reaction_remove_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      messageId: typeof messageId === 'string' ? messageId.trim() : null,
      emoji,
      maskedUserId: maskUserId(userId),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

// Toggle a reaction (add if not present, remove if present)
// IMPORTANT: toggles never overwrite reactions/{emoji}; only leaf set/remove writes are allowed.
const toggleReaction = async (tourId, messageId, emoji, userId, dbInstance = realtimeDb, options = {}) => {
  const normalizedEmoji = typeof emoji === 'string' ? emoji.trim() : '';
  const maskedUserId = maskUserId(userId);
  logReactionEvent('info', 'reaction_toggle_attempt', {
    tourId: typeof tourId === 'string' ? tourId.trim() : '',
    messageId: typeof messageId === 'string' ? messageId.trim() : '',
    emoji: normalizedEmoji,
    maskedUserId,
  });

  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);
    const {
      rawUserId: validatedUserId,
      actorKey,
      actorKeyWasEncoded,
      actorKeyIsRealtimeSafe,
    } = getRealtimeActorContext(userId);

    if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
      return { success: false, error: 'Invalid emoji' };
    }

    const sanitizedEmoji = emoji.trim();
    if (!isValidFirebaseKey(sanitizedEmoji)) {
      return { success: false, error: 'Invalid emoji character for database key' };
    }

    const db = dbInstance || realtimeDb;
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    logReactionEvent('info', 'reaction_toggle_validated_context', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId,
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      reactionEmojiPath: getReactionEmojiPath(validatedTourId, validatedMessageId, sanitizedEmoji),
      actorKeyIsRealtimeSafe,
      forceAction: options.forceAction || null,
    });

    // Read-only parent ref; all writes must remain user-leaf only: reactions/{emoji}/{userId}.
    const emojiReadRef = getReactionEmojiReadRef(db, validatedTourId, validatedMessageId, sanitizedEmoji);
    const reactionLeafSnapshot = await getReactionLeafRef(
      db,
      validatedTourId,
      validatedMessageId,
      sanitizedEmoji,
      actorKey
    ).once('value');
    const hasUserReaction = reactionLeafSnapshot.exists();
    logReactionEvent('info', 'reaction_toggle_leaf_snapshot', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId,
      actorKey,
      actorKeyWasEncoded,
      reactionLeafPath: getReactionLeafPath(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey),
      leafExists: hasUserReaction,
      leafValueType: reactionLeafSnapshot.val() === true ? 'true' : typeof reactionLeafSnapshot.val(),
    });
    const getNormalizedReactionPayload = async () => {
      const nextSnapshot = await emojiReadRef.once('value');
      const users = normalizeReactionUsers(nextSnapshot.val());
      const reactions = users.length > 0 ? { [sanitizedEmoji]: users } : {};
      logReactionEvent('info', 'reaction_toggle_emoji_snapshot', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        actorKey,
        reactionEmojiPath: getReactionEmojiPath(validatedTourId, validatedMessageId, sanitizedEmoji),
        rawEmojiNodeType: nextSnapshot.val() === null ? 'null' : Array.isArray(nextSnapshot.val()) ? 'array' : typeof nextSnapshot.val(),
        rawEmojiNodeKeys: nextSnapshot.val() && typeof nextSnapshot.val() === 'object'
          ? Object.keys(nextSnapshot.val()).slice(0, 12)
          : [],
        ...summarizeReactionUsersForDebug(nextSnapshot.val(), actorKey),
      });
      return { users, reactions };
    };

    if (options.forceAction === 'add') {
      const addResult = await addReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
      if (!addResult?.success) {
        throw new Error(addResult?.error || 'Failed to add reaction');
      }
      const payload = await getNormalizedReactionPayload();
      logReactionEvent('info', 'reaction_toggle_success', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        action: 'added',
      });
      return { success: true, action: 'added', ...payload };
    }

    if (options.forceAction === 'remove') {
      const removeResult = await removeReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
      if (!removeResult?.success) {
        throw new Error(removeResult?.error || 'Failed to remove reaction');
      }
      const payload = await getNormalizedReactionPayload();
      logReactionEvent('info', 'reaction_toggle_success', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        action: 'removed',
      });
      return { success: true, action: 'removed', ...payload };
    }

    if (hasUserReaction) {
      const removeResult = await removeReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
      if (!removeResult?.success) {
        throw new Error(removeResult?.error || 'Failed to remove reaction');
      }
      const payload = await getNormalizedReactionPayload();
      logReactionEvent('info', 'reaction_toggle_success', {
        tourId: validatedTourId,
        messageId: validatedMessageId,
        emoji: sanitizedEmoji,
        maskedUserId,
        action: 'removed',
      });
      return { success: true, action: 'removed', ...payload };
    }

    const addResult = await addReaction(validatedTourId, validatedMessageId, sanitizedEmoji, actorKey, db);
    if (!addResult?.success) {
      throw new Error(addResult?.error || 'Failed to add reaction');
    }
    const payload = await getNormalizedReactionPayload();
    logReactionEvent('info', 'reaction_toggle_success', {
      tourId: validatedTourId,
      messageId: validatedMessageId,
      emoji: sanitizedEmoji,
      maskedUserId,
      action: 'added',
    });
    return { success: true, action: 'added', ...payload };
  } catch (error) {
    const reason = mapReactionFailureReason(error);
    logReactionEvent('warn', 'reaction_toggle_failure', {
      reason,
      tourId: typeof tourId === 'string' ? tourId.trim() : '',
      messageId: typeof messageId === 'string' ? messageId.trim() : '',
      emoji: normalizedEmoji,
      maskedUserId,
      errorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      errorMessage: typeof error?.message === 'string' ? error.message : 'Unknown reaction toggle failure',
    });
    return { success: false, error: error.message };
  }
};

// ==================== TYPING INDICATORS ====================

// Update typing status for a user
const setTypingStatus = async (tourId, userId, userName, isTyping, isDriver = false, dbInstance = realtimeDb) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false };

    const typingRef = db.ref(`chats/${validatedTourId}/typing/${actorKey}`);

    if (isTyping) {
      await typingRef.set({
        name: userName,
        isDriver,
        timestamp: Date.now(),
      });

      // Auto-remove typing status after 10 seconds (in case user leaves without clearing)
      setTimeout(async () => {
        try {
          const current = await typingRef.once('value');
          if (current.exists() && Date.now() - current.val().timestamp > 9000) {
            await typingRef.remove();
          }
        } catch (e) {
          // Ignore cleanup errors
        }
      }, 10000);
    } else {
      await typingRef.remove();
    }

    return { success: true };
  } catch (error) {
    logChatEvent('warn', 'typing_status_update_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      maskedUserId: maskUserId(userId),
      isTyping: Boolean(isTyping),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false };
  }
};

// Subscribe to typing indicators
const subscribeToTypingIndicators = (tourId, currentUserId, onTypingUpdate, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db || !tourId || typeof onTypingUpdate !== 'function') {
    return () => {};
  }

  const validatedTourId = validateTourId(tourId);
  const currentUserKeys = buildActorKeySet(currentUserId);
  const typingRef = db.ref(`chats/${validatedTourId}/typing`);

  const listener = typingRef.on('value', (snapshot) => {
    const typingUsers = [];

    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const userId = child.key;
        const data = child.val();

        // Don't show current user's typing status
        // Only show if typing started within last 10 seconds
        if (!currentUserKeys.has(userId) && Date.now() - data.timestamp < 10000) {
          typingUsers.push({
            userId,
            name: data.name,
            isDriver: data.isDriver,
          });
        }
      });
    }

    onTypingUpdate(typingUsers);
  });

  return () => {
    try {
      typingRef.off('value', listener);
    } catch (error) {
      logChatEvent('warn', 'typing_subscription_unsubscribe_failed', {
        tourId: validatedTourId,
        error: summarizeErrorForDbLog(error),
      });
    }
  };
};

// ==================== ONLINE PRESENCE ====================

// Update user's online presence
const setOnlinePresence = async (tourId, userId, userName, isOnline, isDriver = false, dbInstance = realtimeDb) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false };

    const presenceRef = db.ref(`chats/${validatedTourId}/presence/${actorKey}`);

    if (isOnline) {
      await presenceRef.set({
        name: userName,
        isDriver,
        lastSeen: Date.now(),
        online: true,
      });

      // Set up disconnect handler to mark user as offline
      presenceRef.onDisconnect().update({
        online: false,
        lastSeen: Date.now(),
      });
    } else {
      await presenceRef.update({
        online: false,
        lastSeen: Date.now(),
      });
    }

    return { success: true };
  } catch (error) {
    logChatEvent('warn', 'presence_update_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      maskedUserId: maskUserId(userId),
      isOnline: Boolean(isOnline),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false };
  }
};

// Subscribe to online presence
const subscribeToPresence = (tourId, onPresenceUpdate, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db || !tourId || typeof onPresenceUpdate !== 'function') {
    return () => {};
  }

  const presenceRef = db.ref(`chats/${tourId}/presence`);

  const listener = presenceRef.on('value', (snapshot) => {
    const users = [];
    let onlineCount = 0;

    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const data = child.val();
        const isRecent = Date.now() - data.lastSeen < 300000; // 5 minutes

        users.push({
          userId: child.key,
          name: data.name,
          isDriver: data.isDriver,
          online: data.online && isRecent,
          lastSeen: data.lastSeen,
        });

        if (data.online && isRecent) {
          onlineCount++;
        }
      });
    }

    onPresenceUpdate({ users, onlineCount, totalCount: users.length });
  });

  return () => {
    try {
      presenceRef.off('value', listener);
    } catch (error) {
      logChatEvent('warn', 'presence_subscription_unsubscribe_failed', {
        tourId,
        error: summarizeErrorForDbLog(error),
      });
    }
  };
};

// ==================== MESSAGE SUBSCRIPTIONS ====================

// Subscribe to chat messages for a tour
const subscribeToChatMessages = (tourId, onMessagesUpdate, dbInstance = realtimeDb, options = {}) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    validateCallback(onMessagesUpdate);

    const db = dbInstance || realtimeDb;

    if (!db) {
      logChatEvent('warn', 'chat_subscription_skipped_database_unavailable', { tourId: validatedTourId });
      return () => {};
    }
    logChatEvent('info', 'chat_subscription_started', {
      tourId: validatedTourId,
      limit: normalizeMessageLimit(options.limit, DEFAULT_LIVE_MESSAGE_LIMIT),
    });

    const messagesRef = db.ref(`chats/${validatedTourId}/messages`);
    const messagesQuery = buildTimestampQuery(messagesRef, {
      limit: normalizeMessageLimit(options.limit, DEFAULT_LIVE_MESSAGE_LIMIT),
    });

    const listener = messagesQuery.on('value', (snapshot) => {
      try {
        const messages = readMessagesFromSnapshot(snapshot);
        const reactionSummary = summarizeMessagesForReactionDebug(messages);
        logReactionEvent('info', 'reaction_subscription_snapshot', {
          tourId: validatedTourId,
          chatType: 'group',
          ...reactionSummary,
        });
        onMessagesUpdate(messages);
      } catch (error) {
        logChatEvent('error', 'chat_subscription_snapshot_processing_failed', {
          tourId: validatedTourId,
          error: summarizeErrorForDbLog(error),
        });
        onMessagesUpdate([]); // Provide empty array as fallback
      }
    }, (error) => {
      logChatEvent('error', 'chat_subscription_failed', {
        tourId: validatedTourId,
        error: summarizeErrorForDbLog(error),
      });
      onMessagesUpdate([]); // Provide empty array on error
    });

    // Return unsubscribe function
    return () => {
      try {
        const refForOff = typeof messagesQuery?.off === 'function' ? messagesQuery : messagesRef;
        refForOff.off('value', listener);
        logChatEvent('debug', 'chat_subscription_stopped', { tourId: validatedTourId });
      } catch (error) {
        logChatEvent('warn', 'chat_subscription_unsubscribe_failed', {
          tourId: validatedTourId,
          error: summarizeErrorForDbLog(error),
        });
      }
    };
  } catch (error) {
    logChatEvent('error', 'chat_subscription_setup_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      error: summarizeErrorForDbLog(error),
    });
    return () => {};
  }
};

// Subscribe to internal driver chat messages for a tour
const subscribeToInternalDriverChat = (tourId, onMessagesUpdate, dbInstance = realtimeDb, options = {}) => {
  const db = dbInstance || realtimeDb;

  if (!db || !tourId || typeof onMessagesUpdate !== 'function') {
    logChatEvent('warn', 'internal_chat_subscription_skipped_missing_params', {
      hasDb: Boolean(db),
      hasTourId: Boolean(tourId),
      hasCallback: typeof onMessagesUpdate === 'function',
    });
    return () => {};
  }

  const messagesRef = db.ref(`internal_chats/${tourId}/messages`);
  const messagesQuery = buildTimestampQuery(messagesRef, {
    limit: normalizeMessageLimit(options.limit, DEFAULT_LIVE_MESSAGE_LIMIT),
  });
  logChatEvent('info', 'internal_chat_subscription_started', {
    tourId,
    limit: normalizeMessageLimit(options.limit, DEFAULT_LIVE_MESSAGE_LIMIT),
  });

  const listener = messagesQuery.on('value', (snapshot) => {
    const messages = readMessagesFromSnapshot(snapshot);
    const reactionSummary = summarizeMessagesForReactionDebug(messages);
    logReactionEvent('info', 'reaction_subscription_snapshot', {
      tourId,
      chatType: 'internal',
      ...reactionSummary,
    });
    onMessagesUpdate(messages);
  });

  return () => {
    try {
      const refForOff = typeof messagesQuery?.off === 'function' ? messagesQuery : messagesRef;
      refForOff.off('value', listener);
      logChatEvent('debug', 'internal_chat_subscription_stopped', { tourId });
    } catch (error) {
      logChatEvent('warn', 'internal_chat_subscription_unsubscribe_failed', {
        tourId,
        error: summarizeErrorForDbLog(error),
      });
    }
  };
};

// ==================== READ RECEIPTS ====================

// Mark tour chat as read
const markChatAsRead = async (tourId, userId, dbInstance = realtimeDb) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false };

    const lastReadRef = db.ref(`chats/${validatedTourId}/lastRead/${actorKey}`);
    await lastReadRef.set(new Date().toISOString());
    return { success: true };
  } catch (error) {
    logChatEvent('warn', 'chat_mark_read_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      maskedUserId: maskUserId(userId),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false };
  }
};

// Mark internal driver chat as read
const markInternalChatAsRead = async (tourId, userId, dbInstance = realtimeDb) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false };

    const lastReadRef = db.ref(`internal_chats/${validatedTourId}/lastRead/${actorKey}`);
    await lastReadRef.set(new Date().toISOString());
    return { success: true };
  } catch (error) {
    logChatEvent('warn', 'internal_chat_mark_read_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      maskedUserId: maskUserId(userId),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false };
  }
};

// Subscribe to read receipts
const subscribeToReadReceipts = (tourId, onReadUpdate, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db || !tourId || typeof onReadUpdate !== 'function') {
    return () => {};
  }

  const lastReadRef = db.ref(`chats/${tourId}/lastRead`);

  const listener = lastReadRef.on('value', (snapshot) => {
    const readReceipts = {};

    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        readReceipts[child.key] = child.val();
      });
    }

    onReadUpdate(readReceipts);
  });

  return () => {
    try {
      lastReadRef.off('value', listener);
    } catch (error) {
      logChatEvent('warn', 'read_receipts_unsubscribe_failed', {
        tourId,
        error: summarizeErrorForDbLog(error),
      });
    }
  };
};

// ==================== UTILITY FUNCTIONS ====================

// Get initial messages (alternative to subscription for one-time fetch)
const getChatMessages = async (tourId, limit = 50, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return [];

    const messagesRef = db.ref(`chats/${tourId}/messages`);
    const snapshot = await messagesRef
      .orderByChild('timestamp')
      .limitToLast(limit)
      .once('value');

    const messages = [];
    if (snapshot.exists()) {
      snapshot.forEach((childSnapshot) => {
        messages.push(normalizeMessageTimestamp({
          id: childSnapshot.key,
          ...childSnapshot.val(),
        }));
      });
    }

    // Sort messages by timestamp
    messages.sort((a, b) => {
      const aTs = a.timestampMs ?? parseTimestampToMillis(a.timestamp) ?? 0;
      const bTs = b.timestampMs ?? parseTimestampToMillis(b.timestamp) ?? 0;
      return aTs - bTs;
    });

    return messages;
  } catch (error) {
    logChatEvent('error', 'chat_messages_fetch_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      limit,
      error: summarizeErrorForDbLog(error),
    });
    return [];
  }
};

const getChatMessagesPage = async ({
  tourId,
  scope = 'group',
  beforeTimestamp = null,
  beforeMessageId = null,
  limit = DEFAULT_PAGE_MESSAGE_LIMIT,
  dbInstance = realtimeDb,
} = {}) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false, error: 'Realtime database unavailable', messages: [] };

    const safeLimit = normalizeMessageLimit(limit, DEFAULT_PAGE_MESSAGE_LIMIT);
    const overfetchLimit = safeLimit + 2;
    const messagePath = getChatMessagesPath(tourId, scope);
    const messagesRef = db.ref(messagePath);
    const messagesQuery = buildTimestampQuery(messagesRef, {
      limit: overfetchLimit,
      beforeTimestamp,
    });

    const snapshot = await messagesQuery.once('value');
    const allMessages = readMessagesFromSnapshot(snapshot);
    const cursorMs = parseTimestampToMillis(beforeTimestamp);
    const hasCursor = beforeTimestamp !== null && beforeTimestamp !== undefined;

    const olderMessages = hasCursor
      ? allMessages.filter((message) => {
        if (!message || message.id === beforeMessageId) return false;
        const messageMs = message.timestampMs ?? parseTimestampToMillis(message.timestamp);
        if (!Number.isFinite(cursorMs) || !Number.isFinite(messageMs)) {
          return message.id !== beforeMessageId;
        }
        return messageMs <= cursorMs;
      })
      : allMessages;

    const pageMessages = olderMessages.length > safeLimit
      ? olderMessages.slice(olderMessages.length - safeLimit)
      : olderMessages;
    const nextCursor = pageMessages.length > 0
      ? {
        beforeTimestamp: pageMessages[0].timestampRaw ?? pageMessages[0].timestamp,
        beforeMessageId: pageMessages[0].id,
      }
      : null;

    return {
      success: true,
      messages: pageMessages,
      hasMore: olderMessages.length > safeLimit,
      nextCursor,
    };
  } catch (error) {
    logChatEvent('error', 'chat_messages_page_fetch_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      scope,
      limit,
      error: summarizeErrorForDbLog(error),
    });
    return {
      success: false,
      error: error?.message || 'Unable to load chat messages',
      messages: [],
      hasMore: false,
      nextCursor: null,
    };
  }
};

// Copy message text to clipboard (returns text for clipboard API)
const getMessageTextForCopy = (message) => {
  if (!message) return '';
  return message.text || '';
};

// Delete a message (only for message owner or driver)
const deleteMessage = async (tourId, messageId, requestingUserId, isDriver = false, dbInstance = realtimeDb) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);

    if (!requestingUserId || typeof requestingUserId !== 'string') {
      return { success: false, error: 'User ID is required to delete a message' };
    }

    const db = dbInstance || realtimeDb;
    if (!db) return { success: false, error: 'Database unavailable' };

    const messageRef = db.ref(`chats/${validatedTourId}/messages/${validatedMessageId}`);

    // Verify the requesting user owns the message or is a driver
    const snapshot = await messageRef.once('value');
    if (!snapshot.exists()) {
      return { success: false, error: 'Message not found' };
    }

    const messageData = snapshot.val();
    if (messageData.senderId !== requestingUserId && !isDriver) {
      return { success: false, error: 'You can only delete your own messages' };
    }

    // Instead of deleting, mark as deleted (for better UX)
    await messageRef.update({
      deleted: true,
      text: '',
      deletedAt: new Date().toISOString(),
      deletedBy: requestingUserId,
    });

    return { success: true };
  } catch (error) {
    logChatEvent('error', 'chat_message_delete_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      messageId: typeof messageId === 'string' ? messageId.trim() : null,
      maskedUserId: maskUserId(requestingUserId),
      isDriver: Boolean(isDriver),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

module.exports = {
  // Send messages
  sendMessage,
  sendImageMessage,
  sendInternalDriverMessage,
  sendMessageDirect,
  sendInternalMessageDirect,

  // Subscriptions
  subscribeToChatMessages,
  subscribeToInternalDriverChat,
  subscribeToTypingIndicators,
  subscribeToPresence,
  subscribeToReadReceipts,

  // Reactions
  addReaction,
  removeReaction,
  toggleReaction,

  // Typing & Presence
  setTypingStatus,
  setOnlinePresence,

  // Read receipts
  markChatAsRead,
  markInternalChatAsRead,

  // Utilities
  getChatMessages,
  getChatMessagesPage,
  getMessageTextForCopy,
  deleteMessage,
};
