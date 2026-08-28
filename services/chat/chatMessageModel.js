const {
  DEFAULT_LIVE_MESSAGE_LIMIT,
  normalizeMessageLimit,
  normalizeMessageTimestamp,
  parseTimestampToMillis,
  sanitizeInput,
  validateMessageId,
  validateTourId,
} = require('./chatServiceContext');

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

const buildImageMessagePayload = (media, caption, senderInfo, messageId) => {
  const base = buildMessagePayload(caption, senderInfo, messageId, 'image');
  const photoId = typeof media === 'object' ? media?.photoId : null;
  const previewUrl = typeof media === 'object' ? media?.previewUrl : media;
  return {
    ...base,
    ...(photoId ? { photoId } : {}),
    ...(typeof previewUrl === 'string' && previewUrl.trim()
      ? { imageUrl: previewUrl.trim(), thumbnailUrl: previewUrl.trim() }
      : {}),
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
  validateMessageId(replyMessageId);

  const replySenderName = typeof replyTo.senderName === 'string' && replyTo.senderName.trim().length > 0
    ? sanitizeInput(replyTo.senderName.trim()).slice(0, 100)
    : 'Participant';

  const replyPreview = typeof replyTo.previewText === 'string'
    ? sanitizeInput(replyTo.previewText.trim()).slice(0, 160)
    : '';
  const replyIdempotencyKey = typeof replyTo.idempotencyKey === 'string'
    ? replyTo.idempotencyKey.trim()
    : '';
  if (replyIdempotencyKey) validateMessageId(replyIdempotencyKey);

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

const normalizeChatScope = (scope = 'group') => (scope === 'internal' ? 'internal' : 'group');

const getChatRootPath = (tourId, scope = 'group') => {
  const validatedTourId = validateTourId(tourId);
  return normalizeChatScope(scope) === 'internal'
    ? `internal_chats/${validatedTourId}`
    : `chats/${validatedTourId}`;
};

const getChatMessagesPath = (tourId, scope = 'group') =>
  `${getChatRootPath(tourId, scope)}/messages`;

const getChatActorStatusPath = (tourId, statusType, scope = 'group') =>
  `${getChatRootPath(tourId, scope)}/${statusType}`;

const getChatSessionStatusPath = (statusType, scope = 'group', appSessionId) => {
  if (statusType !== 'presence' && statusType !== 'typing') {
    throw new Error('A valid chat status type is required');
  }
  const normalizedSessionId = typeof appSessionId === 'string' ? appSessionId.trim() : '';
  if (!/^sess_v1_[a-f0-9]{32}$/.test(normalizedSessionId)) {
    throw new Error('A valid app session ID is required');
  }
  const root = statusType === 'presence' ? 'chat_presence_sessions' : 'chat_typing_sessions';
  return `${root}/${normalizeChatScope(scope)}/${normalizedSessionId}`;
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

const hydrateGroupPhotoMessages = async (tourId, messages, resolveMediaFn = null) => {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const photoMessages = safeMessages.filter((message) => (
    message?.type === 'image' && typeof message.photoId === 'string' && message.photoId.trim()
  ));
  if (photoMessages.length === 0) return safeMessages;
  const resolver = resolveMediaFn || require('../photoService').resolveGroupPhotoMedia;
  const uniquePhotos = [...new Set(photoMessages.map((message) => message.photoId.trim()))]
    .map((id) => ({ id }));
  const hydrated = await resolver({ tourId, photos: uniquePhotos });
  const mediaById = new Map(hydrated.map((photo) => [photo.id, photo]));
  return safeMessages.map((message) => {
    const media = mediaById.get(message.photoId);
    if (!media) return message;
    const imageUrl = media.viewerUrl || media.sourceUrl || media.thumbnailUrl || null;
    const thumbnailUrl = media.thumbnailUrl || media.viewerUrl || media.sourceUrl || null;
    return {
      ...message,
      ...(imageUrl ? { imageUrl } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    };
  });
};

// ==================== SEND MESSAGES ====================

module.exports = {
  buildImageMessagePayload,
  buildMessagePayload,
  buildMessagesFromSnapshot,
  buildTimestampQuery,
  getChatActorStatusPath,
  getChatSessionStatusPath,
  getChatMessagesPath,
  hydrateGroupPhotoMessages,
  normalizeChatScope,
  readMessagesFromSnapshot,
  sanitizeReplyContext,
};
