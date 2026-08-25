const {
  DEFAULT_LIVE_MESSAGE_LIMIT,
  DEFAULT_PAGE_MESSAGE_LIMIT,
  getRealtimeActorContext,
  logChatEvent,
  logReactionEvent,
  maskUserId,
  normalizeMessageLimit,
  normalizeMessageTimestamp,
  parseTimestampToMillis,
  resolveRealtimeDb,
  summarizeErrorForDbLog,
  summarizeMessagesForReactionDebug,
  validateCallback,
  validateMessageId,
  validateTourId,
} = require('./chatServiceContext');
const {
  buildTimestampQuery,
  getChatMessagesPath,
  hydrateGroupPhotoMessages,
  normalizeChatScope,
  readMessagesFromSnapshot,
} = require('./chatMessageModel');

const subscribeToChatMessages = (tourId, onMessagesUpdate, dbInstance, options = {}) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    validateCallback(onMessagesUpdate);

    const db = dbInstance || resolveRealtimeDb();

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

    let generation = 0;
    const listener = messagesQuery.on('value', (snapshot) => {
      const currentGeneration = ++generation;
      let messages;
      try {
        messages = readMessagesFromSnapshot(snapshot);
        const reactionSummary = summarizeMessagesForReactionDebug(messages);
        logReactionEvent('info', 'reaction_subscription_snapshot', {
          tourId: validatedTourId,
          chatType: 'group',
          ...reactionSummary,
        });
      } catch (error) {
        logChatEvent('error', 'chat_subscription_snapshot_processing_failed', {
          tourId: validatedTourId,
          error: summarizeErrorForDbLog(error),
        });
        options.onError?.(error);
        return;
      }
      const hasPhotoReferences = messages.some((message) => message?.type === 'image' && message?.photoId);
      if (!hasPhotoReferences) {
        onMessagesUpdate(messages);
        return;
      }
      hydrateGroupPhotoMessages(validatedTourId, messages, options.resolveGroupPhotoMediaFn)
        .then((hydrated) => {
          if (currentGeneration === generation) onMessagesUpdate(hydrated);
        })
        .catch((error) => options.onError?.(error));
    }, (error) => {
      logChatEvent('error', 'chat_subscription_failed', {
        tourId: validatedTourId,
        error: summarizeErrorForDbLog(error),
      });
      options.onError?.(error);
    });

    // Return unsubscribe function
    return () => {
      generation += 1;
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
const subscribeToInternalDriverChat = (tourId, onMessagesUpdate, dbInstance, options = {}) => {
  const db = dbInstance || resolveRealtimeDb();

  if (!db || !tourId || typeof onMessagesUpdate !== 'function') {
    logChatEvent('warn', 'internal_chat_subscription_skipped_missing_params', {
      hasDb: Boolean(db),
      hasTourId: Boolean(tourId),
      hasCallback: typeof onMessagesUpdate === 'function',
    });
    return () => {};
  }

  let validatedTourId;
  try {
    validatedTourId = validateTourId(tourId);
  } catch (error) {
    logChatEvent('error', 'internal_chat_subscription_setup_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      error: summarizeErrorForDbLog(error),
    });
    options.onError?.(error);
    return () => {};
  }

  const messagesRef = db.ref(`internal_chats/${validatedTourId}/messages`);
  const messagesQuery = buildTimestampQuery(messagesRef, {
    limit: normalizeMessageLimit(options.limit, DEFAULT_LIVE_MESSAGE_LIMIT),
  });
  logChatEvent('info', 'internal_chat_subscription_started', {
    tourId: validatedTourId,
    limit: normalizeMessageLimit(options.limit, DEFAULT_LIVE_MESSAGE_LIMIT),
  });

  const listener = messagesQuery.on('value', (snapshot) => {
    try {
      const messages = readMessagesFromSnapshot(snapshot);
      const reactionSummary = summarizeMessagesForReactionDebug(messages);
      logReactionEvent('info', 'reaction_subscription_snapshot', {
        tourId: validatedTourId,
        chatType: 'internal',
        ...reactionSummary,
      });
      onMessagesUpdate(messages);
    } catch (error) {
      logChatEvent('error', 'internal_chat_subscription_snapshot_processing_failed', {
        tourId: validatedTourId,
        error: summarizeErrorForDbLog(error),
      });
      options.onError?.(error);
    }
  }, (error) => {
    logChatEvent('error', 'internal_chat_subscription_failed', {
      tourId: validatedTourId,
      error: summarizeErrorForDbLog(error),
    });
    options.onError?.(error);
  });

  return () => {
    try {
      const refForOff = typeof messagesQuery?.off === 'function' ? messagesQuery : messagesRef;
      refForOff.off('value', listener);
      logChatEvent('debug', 'internal_chat_subscription_stopped', { tourId: validatedTourId });
    } catch (error) {
      logChatEvent('warn', 'internal_chat_subscription_unsubscribe_failed', {
        tourId: validatedTourId,
        error: summarizeErrorForDbLog(error),
      });
    }
  };
};

// ==================== READ RECEIPTS ====================

// Mark tour chat as read
const markChatAsRead = async (tourId, userId, dbInstance) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false };

    const lastReadRef = db.ref(`chats/${validatedTourId}/lastRead/${actorKey}`);
    await lastReadRef.set({ '.sv': 'timestamp' });
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
const markInternalChatAsRead = async (tourId, userId, dbInstance) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false };

    const lastReadRef = db.ref(`internal_chats/${validatedTourId}/lastRead/${actorKey}`);
    await lastReadRef.set({ '.sv': 'timestamp' });
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
const subscribeToReadReceipts = (tourId, onReadUpdate, dbInstance) => {
  const db = dbInstance || resolveRealtimeDb();

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
const getChatMessages = async (tourId, limit = 50, dbInstance) => {
  try {
    const db = dbInstance || resolveRealtimeDb();
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

const getChatMessageById = async ({
  tourId,
  messageId,
  scope = 'group',
  dbInstance,
} = {}) => {
  try {
    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false, error: 'Realtime database unavailable', message: null };

    const safeMessageId = validateMessageId(messageId);
    const messagePath = `${getChatMessagesPath(tourId, scope)}/${safeMessageId}`;
    const snapshot = await db.ref(messagePath).once('value');
    if (!snapshot?.exists?.()) {
      return { success: true, message: null };
    }

    const raw = snapshot.val();
    if (!raw || typeof raw !== 'object') {
      return { success: true, message: null };
    }

    return {
      success: true,
      message: normalizeMessageTimestamp({ id: safeMessageId, ...raw }),
    };
  } catch (error) {
    logChatEvent('warn', 'chat_message_target_fetch_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      messageId: maskUserId(messageId),
      scope: normalizeChatScope(scope),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: 'Message could not be loaded', message: null };
  }
};

const getChatMessagesPage = async ({
  tourId,
  scope = 'group',
  beforeTimestamp = null,
  beforeMessageId = null,
  limit = DEFAULT_PAGE_MESSAGE_LIMIT,
  dbInstance,
} = {}) => {
  try {
    const db = dbInstance || resolveRealtimeDb();
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

    let pageMessages = olderMessages.length > safeLimit
      ? olderMessages.slice(olderMessages.length - safeLimit)
      : olderMessages;
    if (normalizeChatScope(scope) === 'group') {
      pageMessages = await hydrateGroupPhotoMessages(tourId, pageMessages);
    }
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

// Soft-delete a group message owned by the active principal.
const deleteMessage = async (tourId, messageId, requestingUserId, _isDriver = false, dbInstance) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);
    const validatedMessageId = validateMessageId(messageId);

    if (!requestingUserId || typeof requestingUserId !== 'string') {
      return { success: false, error: 'User ID is required to delete a message' };
    }

    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false, error: 'Database unavailable' };

    const messageRef = db.ref(`chats/${validatedTourId}/messages/${validatedMessageId}`);

    // Firebase rules intentionally allow only the original sender to mutate a message.
    const snapshot = await messageRef.once('value');
    if (!snapshot.exists()) {
      return { success: false, error: 'Message not found' };
    }

    const messageData = snapshot.val();
    if (messageData.senderId !== requestingUserId && messageData.senderStableId !== requestingUserId) {
      return { success: false, error: 'You can only delete your own messages' };
    }

    // Instead of deleting, mark as deleted (for better UX)
    await messageRef.update({
      deleted: true,
      text: '',
      imageUrl: null,
      thumbnailUrl: null,
      deletedAt: new Date().toISOString(),
      deletedBy: requestingUserId,
    });

    return { success: true };
  } catch (error) {
    logChatEvent('error', 'chat_message_delete_failed', {
      tourId: typeof tourId === 'string' ? tourId.trim() : null,
      messageId: typeof messageId === 'string' ? messageId.trim() : null,
      maskedUserId: maskUserId(requestingUserId),
      isDriver: Boolean(_isDriver),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error.message };
  }
};

module.exports = {
  deleteMessage,
  getChatMessageById,
  getChatMessages,
  getChatMessagesPage,
  getMessageTextForCopy,
  markChatAsRead,
  markInternalChatAsRead,
  subscribeToChatMessages,
  subscribeToInternalDriverChat,
  subscribeToReadReceipts,
};
