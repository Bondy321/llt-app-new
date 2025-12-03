// services/chatService.js
const isTestEnv = process.env.NODE_ENV === 'test';
let realtimeDb;

if (!isTestEnv) {
  try {
    ({ realtimeDb } = require('../firebase'));
  } catch (error) {
    console.warn('Realtime database module not initialized during load:', error.message);
  }
}

const buildMessagePayload = (messageText, senderInfo, messageId) => {
  const safeSender = senderInfo || {};
  const timestamp = new Date().toISOString();

  return {
    id: messageId,
    text: messageText.trim(),
    senderName: safeSender.name || 'Anonymous',
    senderId: safeSender.userId || 'anonymous',
    timestamp,
    isDriver: !!safeSender.isDriver,
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

// Send a message to the tour chat with optimistic response
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
    const { id, ...payloadForDb } = optimisticMessage;
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

    const { id, ...payloadForDb } = optimisticMessage;
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

// Mark tour chat as read (optional feature for future)
const markChatAsRead = async (tourId, userId) => {
  try {
    const lastReadRef = realtimeDb.ref(`chats/${tourId}/lastRead/${userId}`);
    await lastReadRef.set(new Date().toISOString());
    return { success: true };
  } catch (error) {
    console.error('Error marking chat as read:', error);
    return { success: false };
  }
};

// Get initial messages (alternative to subscription for one-time fetch)
const getChatMessages = async (tourId, limit = 50) => {
  try {
    const messagesRef = realtimeDb.ref(`chats/${tourId}/messages`);
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

module.exports = {
  sendMessage,
  subscribeToChatMessages,
  subscribeToInternalDriverChat,
  sendInternalDriverMessage,
  markChatAsRead,
  getChatMessages,
};