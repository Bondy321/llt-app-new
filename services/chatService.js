'use strict';

const {
  sendImageMessage,
  sendInternalDriverMessage,
  sendInternalMessageDirect,
  sendMessage,
  sendMessageDirect,
} = require('./chat/chatSendService');
const { addReaction, removeReaction, toggleReaction } = require('./chat/chatReactionService');
const {
  setOnlinePresence,
  setTypingStatus,
  subscribeToPresence,
  subscribeToTypingIndicators,
} = require('./chat/chatPresenceService');
const {
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
} = require('./chat/chatHistoryService');
const { hydrateGroupPhotoMessages } = require('./chat/chatMessageModel');

module.exports = {
  addReaction,
  deleteMessage,
  getChatMessageById,
  getChatMessages,
  getChatMessagesPage,
  getMessageTextForCopy,
  hydrateGroupPhotoMessages,
  markChatAsRead,
  markInternalChatAsRead,
  removeReaction,
  sendImageMessage,
  sendInternalDriverMessage,
  sendInternalMessageDirect,
  sendMessage,
  sendMessageDirect,
  setOnlinePresence,
  setTypingStatus,
  subscribeToChatMessages,
  subscribeToInternalDriverChat,
  subscribeToPresence,
  subscribeToReadReceipts,
  subscribeToTypingIndicators,
  toggleReaction,
};
