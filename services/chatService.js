// services/chatService.js
import { realtimeDb } from '../firebase';

// Send a message to the tour chat
export const sendMessage = async (tourId, message, senderInfo) => {
  try {
    const messagesRef = realtimeDb.ref(`chats/${tourId}/messages`);
    const newMessageRef = messagesRef.push();
    
    const messageData = {
      text: message.trim(),
      senderName: senderInfo.name || 'Anonymous',
      senderId: senderInfo.userId,
      timestamp: new Date().toISOString(),
      isDriver: senderInfo.isDriver || false
    };
    
    await newMessageRef.set(messageData);
    console.log('Message sent successfully');
    return { success: true };
  } catch (error) {
    console.error('Error sending message:', error);
    return { success: false, error: error.message };
  }
};

// Subscribe to chat messages for a tour
export const subscribeToChatMessages = (tourId, onMessagesUpdate) => {
  const messagesRef = realtimeDb.ref(`chats/${tourId}/messages`);
  
  // Set up real-time listener
  const listener = messagesRef.on('value', (snapshot) => {
    const messages = [];
    
    if (snapshot.exists()) {
      snapshot.forEach((childSnapshot) => {
        messages.push({
          id: childSnapshot.key,
          ...childSnapshot.val()
        });
      });
    }
    
    // Sort messages by timestamp
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    onMessagesUpdate(messages);
  });
  
  // Return unsubscribe function
  return () => {
    messagesRef.off('value', listener);
  };
};

// Mark tour chat as read (optional feature for future)
export const markChatAsRead = async (tourId, userId) => {
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
export const getChatMessages = async (tourId, limit = 50) => {
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
          ...childSnapshot.val()
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