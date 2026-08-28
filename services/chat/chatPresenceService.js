const {
  buildActorKeySet,
  getRealtimeActorContext,
  logChatEvent,
  maskUserId,
  resolveRealtimeDb,
  summarizeErrorForDbLog,
  validateTourId,
} = require('./chatServiceContext');
const {
  getChatActorStatusPath,
  getChatSessionStatusPath,
  normalizeChatScope,
} = require('./chatMessageModel');

const CHAT_STATUS_SOURCE_SCHEMA_VERSION = 2;
const CHAT_TYPING_EXPIRY_MS = 10_000;
const CHAT_PRESENCE_EXPIRY_MS = 5 * 60 * 1000;
const SERVER_TIMESTAMP = Object.freeze({ '.sv': 'timestamp' });

const readBoundedText = (value, maxLength) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

const resolveStatusOwnership = ({ validatedTourId, actorKey, isDriver, options }) => {
  const sessionScope = options?.sessionScope && typeof options.sessionScope === 'object'
    ? options.sessionScope
    : {};
  const appSessionId = readBoundedText(options?.appSessionId || sessionScope.sessionId, 100);
  const authUid = readBoundedText(options?.authUid || sessionScope.authUid, 128);
  const principalId = readBoundedText(options?.principalId || sessionScope.principalId, 100);
  const role = sessionScope.role || (isDriver ? 'driver' : 'passenger');
  if (!/^sess_v1_[a-f0-9]{32}$/.test(appSessionId)) throw new Error('A valid app session ID is required');
  if (!authUid || !principalId) throw new Error('An authenticated chat session is required');
  if (actorKey !== principalId) throw new Error('Chat status must use the app-session principal');
  if (sessionScope.tourId && validateTourId(sessionScope.tourId) !== validatedTourId) {
    throw new Error('The app session does not own this chat tour');
  }
  if (role !== (isDriver ? 'driver' : 'passenger')) throw new Error('The chat role does not match the app session');
  return { actorKey, appSessionId, authUid, principalId, principalType: role };
};

const buildStatusPayload = ({
  validatedTourId,
  actorKey,
  userName,
  isDriver,
  scope,
  options,
  expiryMs,
}) => {
  const now = typeof options?.now === 'function' ? options.now : Date.now;
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('A valid chat status time is required');
  const ownership = resolveStatusOwnership({ validatedTourId, actorKey, isDriver, options });
  return {
    schemaVersion: CHAT_STATUS_SOURCE_SCHEMA_VERSION,
    ...ownership,
    tourId: validatedTourId,
    tourActorKey: `${validatedTourId}|${actorKey}`,
    scope,
    name: readBoundedText(userName, 100) || 'Tour Participant',
    isDriver: Boolean(isDriver),
    timestamp: SERVER_TIMESTAMP,
    expiresAtMs: nowMs + expiryMs,
  };
};

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

    const ownership = resolveStatusOwnership({ validatedTourId, actorKey, isDriver, options });
    const typingRef = db.ref(getChatSessionStatusPath('typing', scope, ownership.appSessionId));

    if (isTyping) {
      const disconnect = typingRef.onDisconnect?.();
      if (typeof disconnect?.remove !== 'function') throw new Error('Realtime disconnect cleanup is unavailable');
      await disconnect.remove();
      await typingRef.set(buildStatusPayload({
        validatedTourId,
        actorKey,
        userName,
        isDriver,
        scope,
        options,
        expiryMs: CHAT_TYPING_EXPIRY_MS,
      }));
    } else {
      await typingRef.onDisconnect?.().cancel?.();
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

  let lastSnapshot = null;
  const emitTyping = (snapshot) => {
    const typingUsers = [];

    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const userId = child.key;
        const data = child.val();

        // Don't show current user's typing status
        // Only show if typing started within last 10 seconds
        if (data.isTyping !== false
          && !currentUserKeys.has(userId)
          && Date.now() - data.timestamp < 10000) {
          typingUsers.push({
            userId,
            name: data.name,
            isDriver: data.isDriver,
          });
        }
      });
    }

    onTypingUpdate(typingUsers);
  };
  const listener = typingRef.on('value', (snapshot) => {
    lastSnapshot = snapshot;
    emitTyping(snapshot);
  }, (error) => {
    logChatEvent('warn', 'typing_subscription_failed', {
      tourId: validatedTourId,
      scope,
      error: summarizeErrorForDbLog(error),
    });
    options.onError?.(error);
  });
  const expiryTimer = setInterval(() => {
    if (lastSnapshot) emitTyping(lastSnapshot);
  }, 1_000);
  expiryTimer.unref?.();

  return () => {
    clearInterval(expiryTimer);
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

    const ownership = resolveStatusOwnership({ validatedTourId, actorKey, isDriver, options });
    const presenceRef = db.ref(getChatSessionStatusPath('presence', scope, ownership.appSessionId));

    if (isOnline) {
      const disconnect = presenceRef.onDisconnect?.();
      if (typeof disconnect?.remove !== 'function') throw new Error('Realtime disconnect cleanup is unavailable');
      await disconnect.remove();
      await presenceRef.set(buildStatusPayload({
        validatedTourId,
        actorKey,
        userName,
        isDriver,
        scope,
        options,
        expiryMs: CHAT_PRESENCE_EXPIRY_MS,
      }));
    } else {
      await presenceRef.onDisconnect?.().cancel?.();
      await presenceRef.remove();
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

  let lastSnapshot = null;
  const emitPresence = (snapshot) => {
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
  };
  const listener = presenceRef.on('value', (snapshot) => {
    lastSnapshot = snapshot;
    emitPresence(snapshot);
  }, (error) => {
    logChatEvent('warn', 'presence_subscription_failed', {
      tourId: validatedTourId,
      scope,
      error: summarizeErrorForDbLog(error),
    });
    options.onError?.(error);
  });
  const expiryTimer = setInterval(() => {
    if (lastSnapshot) emitPresence(lastSnapshot);
  }, 30_000);
  expiryTimer.unref?.();

  return () => {
    clearInterval(expiryTimer);
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
  CHAT_PRESENCE_EXPIRY_MS,
  CHAT_STATUS_SOURCE_SCHEMA_VERSION,
  CHAT_TYPING_EXPIRY_MS,
  setOnlinePresence,
  setTypingStatus,
  subscribeToPresence,
  subscribeToTypingIndicators,
};

// Subscribe to chat messages for a tour
