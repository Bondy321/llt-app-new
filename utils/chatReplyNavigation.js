const normalizeMessageId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const collectMessageIdCandidates = (rawMessageId) => {
  const normalized = normalizeMessageId(rawMessageId);
  if (!normalized) return [];

  const candidates = new Set([normalized]);

  if (normalized.startsWith('message-') && normalized.length > 8) {
    candidates.add(normalized.slice(8));
  } else {
    candidates.add(`message-${normalized}`);
  }

  return Array.from(candidates);
};

const buildReplyTargetIndex = (groupedMessages = []) => {
  const index = new Map();

  if (!Array.isArray(groupedMessages)) {
    return index;
  }

  groupedMessages.forEach((item, groupedIndex) => {
    if (!item || item.type !== 'message') return;

    const messageData = item.data || {};
    const messageIdCandidates = [
      ...collectMessageIdCandidates(messageData.id),
      ...collectMessageIdCandidates(messageData.idempotencyKey),
    ];

    messageIdCandidates.forEach((candidateId) => {
      if (!candidateId) return;
      if (!index.has(candidateId)) {
        index.set(candidateId, groupedIndex);
      }
    });
  });

  return index;
};

const resolveReplyTargetIndex = (replyMessageId, replyTargetIndex) => {
  if (!(replyTargetIndex instanceof Map)) return -1;

  const candidates = collectMessageIdCandidates(replyMessageId);
  for (const candidateId of candidates) {
    if (!replyTargetIndex.has(candidateId)) continue;
    return replyTargetIndex.get(candidateId);
  }

  return -1;
};

module.exports = {
  normalizeMessageId,
  collectMessageIdCandidates,
  buildReplyTargetIndex,
  resolveReplyTargetIndex,
};
