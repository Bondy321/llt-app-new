const normalizeMessageId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const stripReplyIdDecorators = (rawId) => {
  let normalized = normalizeMessageId(rawId);
  if (!normalized) return '';

  if (normalized.includes('/')) {
    const pathSegments = normalized.split('/').filter(Boolean);
    normalized = pathSegments[pathSegments.length - 1] || normalized;
  }

  while (normalized.startsWith('message-') && normalized.length > 8) {
    normalized = normalized.slice(8);
  }

  return normalized;
};

const collectMessageIdCandidates = (rawMessageId) => {
  const normalized = stripReplyIdDecorators(rawMessageId);
  if (!normalized) return [];

  const candidates = new Set([normalized]);
  candidates.add(`message-${normalized}`);

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
  stripReplyIdDecorators,
  collectMessageIdCandidates,
  buildReplyTargetIndex,
  resolveReplyTargetIndex,
};
