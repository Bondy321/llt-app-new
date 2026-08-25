const {
  buildActorKeySet,
  getRealtimeActorContext,
  logChatEvent,
  maskUserId,
  resolveRealtimeDb,
  summarizeErrorForDbLog,
  validateTourId,
} = require('./chatServiceContext');
const { getChatActorStatusPath, normalizeChatScope } = require('./chatMessageModel');

const setTypingStatus = async (tourId, userId, userName, isTyping, isDriver = false, dbInstance, options = {}) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const scope = normalizeChatScope(options.scope);
    if (scope === 'internal' && !isDriver) {
      return { success: false };
    }
    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false };

    const typingRef = db.ref(`${getChatActorStatusPath(validatedTourId, 'typing', scope)}/${actorKey}`);

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
        } catch (_error) {
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
      scope: normalizeChatScope(options.scope),
      maskedUserId: maskUserId(userId),
      isTyping: Boolean(isTyping),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false };
  }
};

// Subscribe to typing indicators
const subscribeToTypingIndicators = (tourId, currentUserId, onTypingUpdate, dbInstance, options = {}) => {
  const db = dbInstance || resolveRealtimeDb();

  if (!db || !tourId || typeof onTypingUpdate !== 'function') {
    return () => {};
  }

  const validatedTourId = validateTourId(tourId);
  const scope = normalizeChatScope(options.scope);
  const currentUserKeys = buildActorKeySet(currentUserId);
  const typingRef = db.ref(getChatActorStatusPath(validatedTourId, 'typing', scope));

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
  }, (error) => {
    logChatEvent('warn', 'typing_subscription_failed', {
      tourId: validatedTourId,
      scope,
      error: summarizeErrorForDbLog(error),
    });
    options.onError?.(error);
  });

  return () => {
    try {
      typingRef.off('value', listener);
    } catch (error) {
      logChatEvent('warn', 'typing_subscription_unsubscribe_failed', {
        tourId: validatedTourId,
        scope,
        error: summarizeErrorForDbLog(error),
      });
    }
  };
};

// ==================== ONLINE PRESENCE ====================

// Update user's online presence
const setOnlinePresence = async (tourId, userId, userName, isOnline, isDriver = false, dbInstance, options = {}) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const { actorKey } = getRealtimeActorContext(userId);
    const scope = normalizeChatScope(options.scope);
    if (scope === 'internal' && !isDriver) {
      return { success: false };
    }
    const db = dbInstance || resolveRealtimeDb();
    if (!db) return { success: false };

    const presenceRef = db.ref(`${getChatActorStatusPath(validatedTourId, 'presence', scope)}/${actorKey}`);

    if (isOnline) {
      await presenceRef.set({
        name: userName,
        isDriver,
        lastSeen: Date.now(),
        online: true,
      });

      // Set up disconnect handler to mark user as offline
      await presenceRef.onDisconnect().update({
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
      scope: normalizeChatScope(options.scope),
      maskedUserId: maskUserId(userId),
      isOnline: Boolean(isOnline),
      error: summarizeErrorForDbLog(error),
    });
    return { success: false };
  }
};

// Subscribe to online presence
const subscribeToPresence = (tourId, onPresenceUpdate, dbInstance, options = {}) => {
  const db = dbInstance || resolveRealtimeDb();

  if (!db || !tourId || typeof onPresenceUpdate !== 'function') {
    return () => {};
  }

  const validatedTourId = validateTourId(tourId);
  const scope = normalizeChatScope(options.scope);
  const presenceRef = db.ref(getChatActorStatusPath(validatedTourId, 'presence', scope));

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
  }, (error) => {
    logChatEvent('warn', 'presence_subscription_failed', {
      tourId: validatedTourId,
      scope,
      error: summarizeErrorForDbLog(error),
    });
    options.onError?.(error);
  });

  return () => {
    try {
      presenceRef.off('value', listener);
    } catch (error) {
      logChatEvent('warn', 'presence_subscription_unsubscribe_failed', {
        tourId: validatedTourId,
        scope,
        error: summarizeErrorForDbLog(error),
      });
    }
  };
};

// ==================== MESSAGE SUBSCRIPTIONS ====================

module.exports = {
  setOnlinePresence,
  setTypingStatus,
  subscribeToPresence,
  subscribeToTypingIndicators,
};

// Subscribe to chat messages for a tour
