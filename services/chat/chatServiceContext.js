// services/chatService.js - Enhanced Chat Service with Premium Features
// Improved with comprehensive validation, error handling, and security measures
const isTestEnv = process.env.NODE_ENV === 'test';
const IS_DEV_RUNTIME =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
const { loadOptionalService } = require('../optionalServiceLoader');
const { createLazyRealtimeDbResolver } = require('../lazyRealtimeDb');
const { toRealtimeKeySegment } = require('../identityService');
const { parseTimestampMs: parseStrictTimestampMs } = require('../timeUtils');
const { assertTextPassesModeration } = require('../contentModerationService');

const resolveRealtimeDb = createLazyRealtimeDbResolver({
  loadFirebaseModule: () => (isTestEnv ? null : require('../firebase')),
  onLoadError: (error) => {
    if (IS_DEV_RUNTIME) {
      console.warn('Realtime database module is not available yet:', error?.message || String(error));
    }
  },
});

const offlineSyncService = loadOptionalService({
  modulePath: '../offlineSyncService',
  loadModule: () => require('./offlineSyncService'),
  serviceLabel: 'Offline sync service',
  isTestEnv,
});

const loggerServiceModule = loadOptionalService({
  modulePath: '../loggerService',
  loadModule: () => require('./loggerService'),
  serviceLabel: 'Logger service',
  isTestEnv,
});

const logger = loggerServiceModule?.default || loggerServiceModule;

// ==================== CONSTANTS & CONFIGURATION ====================

const MAX_MESSAGE_LENGTH = 10000;
const MAX_CAPTION_LENGTH = 500;
const CHAT_MESSAGE_SCHEMA_VERSION = 2;
const CHAT_MESSAGE_ID_MAX_LENGTH = 160;
const DEFAULT_LIVE_MESSAGE_LIMIT = 80;
const DEFAULT_PAGE_MESSAGE_LIMIT = 40;
const GROUP_PHOTO_CHAT_FUNCTION_NAME = 'createGroupPhotoChatMessage';

const buildGroupPhotoChatEndpoint = (authInstance) => {
  const explicit = process.env.EXPO_PUBLIC_CREATE_GROUP_PHOTO_CHAT_MESSAGE_URL?.trim();
  if (explicit) return explicit;
  const projectId = authInstance?.app?.options?.projectId;
  return projectId
    ? `https://europe-west1-${projectId}.cloudfunctions.net/${GROUP_PHOTO_CHAT_FUNCTION_NAME}`
    : null;
};

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
  if (!messageId || typeof messageId !== 'string' || messageId.trim().length === 0
    || messageId.trim().length > CHAT_MESSAGE_ID_MAX_LENGTH
    || /[.#$/\[\]]/.test(messageId.trim())) {
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

  return assertTextPassesModeration(trimmed, 'Message');
};

const createLocalMessageId = (prefix = 'msg') =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const resolveMessageWriteIdentity = (payload = {}, prefix = 'msg') => {
  const requestedMessageId = typeof payload.messageId === 'string' && payload.messageId.trim()
    ? payload.messageId.trim()
    : '';
  const requestedIdempotencyKey = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.trim()
    ? payload.idempotencyKey.trim()
    : '';
  const messageId = validateMessageId(requestedMessageId || requestedIdempotencyKey || createLocalMessageId(prefix));

  if (requestedIdempotencyKey && requestedIdempotencyKey !== messageId) {
    throw new Error('Message idempotency key must match the message ID');
  }

  return { messageId, idempotencyKey: messageId };
};

const resolveClientCreatedAt = (timestamp) => {
  const parsed = parseTimestampToMillis(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const writeMessageOnce = async (messageRef, payloadForDb) => {
  if (!messageRef || typeof messageRef.transaction !== 'function') {
    throw new Error('Realtime database transaction support is required for chat delivery');
  }

  const result = await messageRef.transaction((currentValue) => (
    currentValue === null || currentValue === undefined ? payloadForDb : undefined
  ));
  const storedMessage = result?.snapshot?.val?.();

  if (!storedMessage || typeof storedMessage !== 'object') {
    throw new Error('Message delivery could not be confirmed');
  }
  if (
    storedMessage.idempotencyKey !== payloadForDb.idempotencyKey
    || storedMessage.senderId !== payloadForDb.senderId
    || storedMessage.senderStableId !== payloadForDb.senderStableId
  ) {
    throw new Error('Message ID is already in use by another delivery');
  }

  return storedMessage;
};

const withTimeout = (promise, timeoutMs, message) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
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
  if (principalId.length > 160) {
    throw new Error('Sender principalId exceeds the maximum length');
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
  if (resolvedStablePassengerId.length > 160) {
    throw new Error('Sender stable identity exceeds the maximum length');
  }
  const normalizedName = sanitizeInput(String(senderInfo.name || 'Anonymous').trim());
  if (!normalizedName || normalizedName.length > 100) {
    throw new Error('Sender name must be between 1 and 100 characters');
  }

  return {
    userId: principalId,
    principalId,
    principalType: normalizedPrincipalType || 'passenger',
    name: normalizedName,
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
    } catch (_error) {
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
  } catch (_error) {
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
    } catch (_error) {
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
  } catch (_error) {
    // Diagnostics must never affect chat behavior.
  }

  if (IS_DEV_RUNTIME) {
    try {
      const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](`[ChatService] ${eventName}`, payload);
    } catch (_error) {
      // Ignore diagnostic fallback failures.
    }
  }
};

// ==================== MESSAGE BUILDING ====================

module.exports = {
  CHAT_MESSAGE_SCHEMA_VERSION,
  DEFAULT_LIVE_MESSAGE_LIMIT,
  DEFAULT_PAGE_MESSAGE_LIMIT,
  MAX_CAPTION_LENGTH,
  assertTextPassesModeration,
  buildActorKeySet,
  buildGroupPhotoChatEndpoint,
  createLocalMessageId,
  getReactionEmojiReadRef,
  getReactionEmojiPath,
  getReactionLeafPath,
  getReactionLeafRef,
  getRealtimeActorContext,
  isTestEnv,
  isValidFirebaseKey,
  logChatEvent,
  logChatImageDbEvent,
  logReactionEvent,
  mapReactionFailureReason,
  maskUserId,
  normalizeMessageLimit,
  normalizeMessageTimestamp,
  normalizeReactions,
  offlineSyncService,
  parseTimestampToMillis,
  resolveClientCreatedAt,
  resolveMessageWriteIdentity,
  resolveRealtimeDb,
  sanitizeInput,
  summarizeErrorForDbLog,
  summarizeMessagesForReactionDebug,
  summarizeReactionUsersForDebug,
  summarizeReactionsForDebug,
  summarizeSenderForDbLog,
  validateCallback,
  validateMessageId,
  validateMessageText,
  validateSenderInfo,
  validateTourId,
  validateUserId,
  withTimeout,
  writeMessageOnce,
};
