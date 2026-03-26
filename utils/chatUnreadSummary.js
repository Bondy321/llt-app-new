const parseTimestampMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const formatRelativeTimeLabel = (timestamp, now = Date.now()) => {
  const messageMs = parseTimestampMs(timestamp);
  const nowMs = parseTimestampMs(now);

  if (!Number.isFinite(messageMs) || !Number.isFinite(nowMs) || messageMs > nowMs) {
    return '';
  }

  const diffMinutes = Math.floor((nowMs - messageMs) / (60 * 1000));
  if (diffMinutes <= 0) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'yesterday';
  return `${diffDays}d ago`;
};

const buildUnreadSummary = (messages, options = {}) => {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const { lastSeenTimestamp = null, currentUserId = null, now = Date.now() } = options;
  const seenMs = parseTimestampMs(lastSeenTimestamp);

  if (!Number.isFinite(seenMs)) {
    return null;
  }

  const unreadMessages = safeMessages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    if (currentUserId && message.senderId === currentUserId) return false;

    const timestampMs = parseTimestampMs(message.timestamp);
    return Number.isFinite(timestampMs) && timestampMs > seenMs;
  });

  if (unreadMessages.length === 0) {
    return null;
  }

  const latestMessage = unreadMessages[unreadMessages.length - 1];
  return {
    count: unreadMessages.length,
    latestSender: latestMessage.senderName || 'Participant',
    latestTimestamp: latestMessage.timestamp || null,
    latestRelativeLabel: formatRelativeTimeLabel(latestMessage.timestamp, now),
  };
};

module.exports = {
  parseTimestampMs,
  formatRelativeTimeLabel,
  buildUnreadSummary,
};
