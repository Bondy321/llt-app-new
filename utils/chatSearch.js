const normalizeSearchQuery = (query) => {
  if (typeof query !== 'string') return '';
  return query.trim().toLowerCase();
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const countMatches = (sourceText, normalizedQuery) => {
  if (!normalizedQuery) return 0;
  const source = typeof sourceText === 'string' ? sourceText.toLowerCase() : '';
  if (!source) return 0;

  const pattern = new RegExp(escapeRegExp(normalizedQuery), 'g');
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
};

const buildChatSearchResults = (messages, query) => {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!Array.isArray(messages) || !normalizedQuery) return [];

  return messages
    .map((message) => {
      const textMatches = countMatches(message?.text, normalizedQuery);
      const senderMatches = countMatches(message?.senderName, normalizedQuery);
      const matchCount = textMatches + senderMatches;

      return {
        id: message?.id,
        matchCount,
      };
    })
    .filter((result) => typeof result.id === 'string' && result.id.length > 0 && result.matchCount > 0);
};

module.exports = {
  normalizeSearchQuery,
  buildChatSearchResults,
};
