// services/chatService.js - Enhanced Chat Service with Premium Features
const isTestEnv = process.env.NODE_ENV === 'test';
let realtimeDb;

if (!isTestEnv) {
  try {
    ({ realtimeDb } = require('../firebase'));
  } catch (error) {
    console.warn('Realtime database module not initialized during load:', error.message);
  }
}

// ==================== MESSAGE BUILDING ====================

const buildMessagePayload = (messageText, senderInfo, messageId, messageType = 'text') => {
  const safeSender = senderInfo || {};
  const timestamp = new Date().toISOString();

  return {
    id: messageId,
    text: messageText?.trim() || '',
    senderName: safeSender.name || 'Anonymous',
    senderId: safeSender.userId || 'anonymous',
    timestamp,
    isDriver: !!safeSender.isDriver,
    type: messageType, // 'text', 'image', 'system'
    status: 'sending', // 'sending', 'sent', 'delivered', 'failed'
    reactions: {}, // { emoji: [userId1, userId2, ...] }
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

const buildMessagesFromSnapshot = (snapshot) => {
  const messages = [];

  if (snapshot.exists()) {
    snapshot.forEach((childSnapshot) => {
      messages.push({
        id: childSnapshot.key,
        ...childSnapshot.val(),
      });
    });
  }

  messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return messages;
};

// ==================== SEND MESSAGES ====================

// Send a text message to the tour chat with optimistic response
const sendMessage = async (tourId, message, senderInfo, dbInstance = realtimeDb) => {
  try {
    const trimmed = (message || '').trim();

    if (!trimmed) {
      return { success: false, error: 'Message cannot be empty' };
    }

    const db = dbInstance || realtimeDb;

    if (!db) {
      return { success: false, error: 'Realtime database unavailable' };
    }

    const messagesRef = db.ref(`chats/${tourId}/messages`);
    const newMessageRef = messagesRef.push();
    const optimisticMessage = buildMessagePayload(trimmed, senderInfo, newMessageRef.key);

    // Persist message (without id since key is stored separately)
    const { id, status, ...payloadForDb } = optimisticMessage;
    payloadForDb.status = 'sent';
    const serverPromise = newMessageRef.set(payloadForDb);

    serverPromise.catch((error) => {
      console.error('Error sending message:', error);
    });

    return { success: true, message: optimisticMessage, serverPromise };
  } catch (error) {
    console.error('Error sending message:', error);
    return { success: false, error: error.message };
  }
};

// Send an image message to the tour chat
const sendImageMessage = async (tourId, imageUrl, caption, senderInfo, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;

    if (!db) {
      return { success: false, error: 'Realtime database unavailable' };
    }

    if (!imageUrl) {
      return { success: false, error: 'Image URL is required' };
    }

    const messagesRef = db.ref(`chats/${tourId}/messages`);
    const newMessageRef = messagesRef.push();
    const optimisticMessage = buildImageMessagePayload(imageUrl, caption || '', senderInfo, newMessageRef.key);

    const { id, status, ...payloadForDb } = optimisticMessage;
    payloadForDb.status = 'sent';
    const serverPromise = newMessageRef.set(payloadForDb);

    serverPromise.catch((error) => {
      console.error('Error sending image message:', error);
    });

    return { success: true, message: optimisticMessage, serverPromise };
  } catch (error) {
    console.error('Error sending image message:', error);
    return { success: false, error: error.message };
  }
};

// Send a message to the internal driver chat for a tour
const sendInternalDriverMessage = async (tourId, message, senderInfo, dbInstance = realtimeDb) => {
  try {
    const trimmed = (message || '').trim();

    if (!trimmed) {
      return { success: false, error: 'Message cannot be empty' };
    }

    const db = dbInstance || realtimeDb;

    if (!db) {
      return { success: false, error: 'Realtime database unavailable' };
    }

    const messagesRef = db.ref(`internal_chats/${tourId}/messages`);
    const newMessageRef = messagesRef.push();
    const optimisticMessage = buildMessagePayload(trimmed, senderInfo, newMessageRef.key);

    const { id, status, ...payloadForDb } = optimisticMessage;
    payloadForDb.status = 'sent';
    const serverPromise = newMessageRef.set(payloadForDb);

    serverPromise.catch((error) => {
      console.error('Error sending internal driver message:', error);
    });

    return { success: true, message: optimisticMessage, serverPromise };
  } catch (error) {
    console.error('Error sending internal driver message:', error);
    return { success: false, error: error.message };
  }
};

// ==================== MESSAGE REACTIONS ====================

// Add a reaction to a message
const addReaction = async (tourId, messageId, emoji, userId, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    const reactionRef = db.ref(`chats/${tourId}/messages/${messageId}/reactions/${emoji}`);

    // Get current reactions for this emoji
    const snapshot = await reactionRef.once('value');
    const currentUsers = snapshot.val() || [];

    // Add user if not already reacted
    if (!currentUsers.includes(userId)) {
      await reactionRef.set([...currentUsers, userId]);
    }

    return { success: true };
  } catch (error) {
    console.error('Error adding reaction:', error);
    return { success: false, error: error.message };
  }
};

// Remove a reaction from a message
const removeReaction = async (tourId, messageId, emoji, userId, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    const reactionRef = db.ref(`chats/${tourId}/messages/${messageId}/reactions/${emoji}`);

    const snapshot = await reactionRef.once('value');
    const currentUsers = snapshot.val() || [];

    const updatedUsers = currentUsers.filter(id => id !== userId);

    if (updatedUsers.length === 0) {
      await reactionRef.remove();
    } else {
      await reactionRef.set(updatedUsers);
    }

    return { success: true };
  } catch (error) {
    console.error('Error removing reaction:', error);
    return { success: false, error: error.message };
  }
};

// Toggle a reaction (add if not present, remove if present)
const toggleReaction = async (tourId, messageId, emoji, userId, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) {
      return { success: false, error: 'Database unavailable' };
    }

    const reactionRef = db.ref(`chats/${tourId}/messages/${messageId}/reactions/${emoji}`);

    const snapshot = await reactionRef.once('value');
    const currentUsers = snapshot.val() || [];

    if (currentUsers.includes(userId)) {
      // Remove reaction
      const updatedUsers = currentUsers.filter(id => id !== userId);
      if (updatedUsers.length === 0) {
        await reactionRef.remove();
      } else {
        await reactionRef.set(updatedUsers);
      }
      return { success: true, action: 'removed' };
    } else {
      // Add reaction
      await reactionRef.set([...currentUsers, userId]);
      return { success: true, action: 'added' };
    }
  } catch (error) {
    console.error('Error toggling reaction:', error);
    return { success: false, error: error.message };
  }
};

// ==================== TYPING INDICATORS ====================

// Update typing status for a user
const setTypingStatus = async (tourId, userId, userName, isTyping, isDriver = false, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false };

    const typingRef = db.ref(`chats/${tourId}/typing/${userId}`);

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
    console.error('Error setting typing status:', error);
    return { success: false };
  }
};

// Subscribe to typing indicators
const subscribeToTypingIndicators = (tourId, currentUserId, onTypingUpdate, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db || !tourId || typeof onTypingUpdate !== 'function') {
    return () => {};
  }

  const typingRef = db.ref(`chats/${tourId}/typing`);

  const listener = typingRef.on('value', (snapshot) => {
    const typingUsers = [];

    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const userId = child.key;
        const data = child.val();

        // Don't show current user's typing status
        // Only show if typing started within last 10 seconds
        if (userId !== currentUserId && Date.now() - data.timestamp < 10000) {
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
      console.warn('Error unsubscribing from typing indicators', error);
    }
  };
};

// ==================== ONLINE PRESENCE ====================

// Update user's online presence
const setOnlinePresence = async (tourId, userId, userName, isOnline, isDriver = false, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false };

    const presenceRef = db.ref(`chats/${tourId}/presence/${userId}`);

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
    console.error('Error setting presence:', error);
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
      console.warn('Error unsubscribing from presence', error);
    }
  };
};

// ==================== MESSAGE SUBSCRIPTIONS ====================

// Subscribe to chat messages for a tour
const subscribeToChatMessages = (tourId, onMessagesUpdate, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db || !tourId || typeof onMessagesUpdate !== 'function') {
    console.warn('subscribeToChatMessages called without required params');
    return () => {};
  }

  const messagesRef = db.ref(`chats/${tourId}/messages`);

  const listener = messagesRef.on('value', (snapshot) => {
    onMessagesUpdate(buildMessagesFromSnapshot(snapshot));
  });

  // Return unsubscribe function
  return () => {
    try {
      messagesRef.off('value', listener);
    } catch (error) {
      console.warn('Error unsubscribing from chat messages', error);
    }
  };
};

// Subscribe to internal driver chat messages for a tour
const subscribeToInternalDriverChat = (tourId, onMessagesUpdate, dbInstance = realtimeDb) => {
  const db = dbInstance || realtimeDb;

  if (!db || !tourId || typeof onMessagesUpdate !== 'function') {
    console.warn('subscribeToInternalDriverChat called without required params');
    return () => {};
  }

  const messagesRef = db.ref(`internal_chats/${tourId}/messages`);

  const listener = messagesRef.on('value', (snapshot) => {
    onMessagesUpdate(buildMessagesFromSnapshot(snapshot));
  });

  return () => {
    try {
      messagesRef.off('value', listener);
    } catch (error) {
      console.warn('Error unsubscribing from internal driver chat messages', error);
    }
  };
};

// ==================== READ RECEIPTS ====================

// Mark tour chat as read
const markChatAsRead = async (tourId, userId, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false };

    const lastReadRef = db.ref(`chats/${tourId}/lastRead/${userId}`);
    await lastReadRef.set(new Date().toISOString());
    return { success: true };
  } catch (error) {
    console.error('Error marking chat as read:', error);
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
      console.warn('Error unsubscribing from read receipts', error);
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
        messages.push({
          id: childSnapshot.key,
          ...childSnapshot.val(),
        });
      });
    }

    // Sort messages by timestamp
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return messages;
  } catch (error) {
    console.error('Error getting chat messages:', error);
    return [];
  }
};

// Copy message text to clipboard (returns text for clipboard API)
const getMessageTextForCopy = (message) => {
  if (!message) return '';
  return message.text || '';
};

// Delete a message (only for message owner or driver)
const deleteMessage = async (tourId, messageId, dbInstance = realtimeDb) => {
  try {
    const db = dbInstance || realtimeDb;
    if (!db) return { success: false, error: 'Database unavailable' };

    const messageRef = db.ref(`chats/${tourId}/messages/${messageId}`);

    // Instead of deleting, mark as deleted (for better UX)
    await messageRef.update({
      deleted: true,
      text: '',
      deletedAt: new Date().toISOString(),
    });

    return { success: true };
  } catch (error) {
    console.error('Error deleting message:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  // Send messages
  sendMessage,
  sendImageMessage,
  sendInternalDriverMessage,

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

  // Utilities
  getChatMessages,
  getMessageTextForCopy,
  deleteMessage,
};
