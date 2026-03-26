const canRetryFailedMessage = (message, currentUserId) => {
  if (!message || typeof message !== 'object') return false;
  if (message.deleted) return false;
  if (message.status !== 'failed') return false;
  if ((message.type || 'text') !== 'text') return false;
  if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
  if (!currentUserId || message.senderId !== currentUserId) return false;
  return true;
};

module.exports = {
  canRetryFailedMessage,
};
