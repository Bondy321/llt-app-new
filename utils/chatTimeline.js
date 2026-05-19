const DEFAULT_CLUSTER_WINDOW_MS = 5 * 60 * 1000;

const parseTimestampMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const getMessageTimestampMs = (message) => (
  message?.timestampMs ?? parseTimestampMs(message?.timestamp)
);

const getMessageSenderKey = (message = {}) => {
  if (typeof message.senderStableId === 'string' && message.senderStableId.trim()) {
    return message.senderStableId.trim();
  }
  if (typeof message.senderId === 'string' && message.senderId.trim()) {
    return message.senderId.trim();
  }
  if (typeof message.senderName === 'string' && message.senderName.trim()) {
    return message.senderName.trim();
  }
  return 'unknown';
};

const sameCluster = (message, comparison, options = {}) => {
  if (!message || !comparison) return false;
  const clusterWindowMs = options.clusterWindowMs || DEFAULT_CLUSTER_WINDOW_MS;
  if (Boolean(message.isDriver) !== Boolean(comparison.isDriver)) return false;
  if (getMessageSenderKey(message) !== getMessageSenderKey(comparison)) return false;

  const messageMs = getMessageTimestampMs(message);
  const comparisonMs = getMessageTimestampMs(comparison);
  if (!Number.isFinite(messageMs) || !Number.isFinite(comparisonMs)) return false;

  return Math.abs(messageMs - comparisonMs) <= clusterWindowMs;
};

const shouldShowSenderForMessage = (message, previousMessage, options = {}) => {
  if (!message || options.isOwnMessage) return false;
  if (!previousMessage) return true;
  if (options.previousIsOwnMessage) return true;
  return !sameCluster(message, previousMessage, options);
};

const getClusterPosition = ({ message, previousMessage, nextMessage, isOwnMessage, previousIsOwnMessage, nextIsOwnMessage }) => {
  const joinsPrevious = Boolean(previousMessage)
    && isOwnMessage === previousIsOwnMessage
    && sameCluster(message, previousMessage);
  const joinsNext = Boolean(nextMessage)
    && isOwnMessage === nextIsOwnMessage
    && sameCluster(message, nextMessage);

  if (joinsPrevious && joinsNext) return 'middle';
  if (joinsPrevious) return 'last';
  if (joinsNext) return 'first';
  return 'single';
};

const getMessageAliases = (message = {}) => {
  const aliases = new Set();
  if (typeof message.id === 'string' && message.id.trim()) aliases.add(message.id.trim());
  if (typeof message.idempotencyKey === 'string' && message.idempotencyKey.trim()) {
    aliases.add(message.idempotencyKey.trim());
  }
  return Array.from(aliases);
};

const sortMessagesAscending = (messages = []) => [...messages].sort((a, b) => {
  const aMs = getMessageTimestampMs(a) ?? 0;
  const bMs = getMessageTimestampMs(b) ?? 0;
  if (aMs !== bMs) return aMs - bMs;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
});

const mergeMessagesById = (existingMessages = [], incomingMessages = []) => {
  const merged = [];
  const aliasToIndex = new Map();

  const upsert = (message) => {
    if (!message || typeof message !== 'object') return;
    const aliases = getMessageAliases(message);
    const existingIndex = aliases.find((alias) => aliasToIndex.has(alias));

    if (existingIndex) {
      const targetIndex = aliasToIndex.get(existingIndex);
      merged[targetIndex] = {
        ...merged[targetIndex],
        ...message,
      };
      getMessageAliases(merged[targetIndex]).forEach((alias) => aliasToIndex.set(alias, targetIndex));
      return;
    }

    const nextIndex = merged.length;
    merged.push(message);
    aliases.forEach((alias) => aliasToIndex.set(alias, nextIndex));
  };

  existingMessages.forEach(upsert);
  incomingMessages.forEach(upsert);

  return sortMessagesAscending(merged);
};

const getOldestMessageCursor = (messages = []) => {
  const sorted = sortMessagesAscending(messages);
  const oldest = sorted.find((message) => message && typeof message === 'object');
  if (!oldest?.id) return null;

  return {
    beforeTimestamp: oldest.timestampRaw ?? oldest.timestamp,
    beforeMessageId: oldest.id,
  };
};

const formatChatTimestamp = (timestamp) => {
  const timestampMs = parseTimestampMs(timestamp);
  if (!Number.isFinite(timestampMs)) return '';
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

const resolveOwnership = (message, isMessageOwned) => {
  if (typeof isMessageOwned === 'function') return Boolean(isMessageOwned(message));
  return false;
};

const buildChatTimelineItems = (messages = [], options = {}) => {
  const sortedMessages = sortMessagesAscending(Array.isArray(messages) ? messages : []);
  const lastSeenMs = parseTimestampMs(options.lastSeenTimestamp);
  const isMessageOwned = options.isMessageOwned;
  const items = [];
  let currentDate = null;
  let unreadInjected = false;

  sortedMessages.forEach((message, index) => {
    const messageMs = getMessageTimestampMs(message);
    const messageDate = Number.isFinite(messageMs)
      ? new Date(messageMs).toDateString()
      : 'Unknown date';

    if (messageDate !== currentDate) {
      items.push({
        type: 'date',
        id: `date-${messageDate}-${messageMs ?? message?.id ?? index}`,
        date: messageMs ?? message?.timestamp ?? null,
      });
      currentDate = messageDate;
    }

    if (!unreadInjected && Number.isFinite(lastSeenMs) && Number.isFinite(messageMs) && messageMs > lastSeenMs) {
      items.push({ type: 'unread-separator', id: `unread-${message?.id || index}` });
      unreadInjected = true;
    }

    const previousMessage = sortedMessages[index - 1] || null;
    const nextMessage = sortedMessages[index + 1] || null;
    const isOwnMessage = resolveOwnership(message, isMessageOwned);
    const previousIsOwnMessage = resolveOwnership(previousMessage, isMessageOwned);
    const nextIsOwnMessage = resolveOwnership(nextMessage, isMessageOwned);

    items.push({
      type: 'message',
      id: message?.id ? `message-${message.id}` : `message-${index}`,
      data: message,
      presentation: {
        isOwnMessage,
        showSender: shouldShowSenderForMessage(message, previousMessage, {
          isOwnMessage,
          previousIsOwnMessage,
        }),
        clusterPosition: getClusterPosition({
          message,
          previousMessage,
          nextMessage,
          isOwnMessage,
          previousIsOwnMessage,
          nextIsOwnMessage,
        }),
      },
    });
  });

  return items;
};

module.exports = {
  DEFAULT_CLUSTER_WINDOW_MS,
  buildChatTimelineItems,
  formatChatTimestamp,
  getOldestMessageCursor,
  mergeMessagesById,
  parseTimestampMs,
  shouldShowSenderForMessage,
  sortMessagesAscending,
};
