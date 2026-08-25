// screens/ChatScreen.js - Premium Chat Experience
import { useMemo } from 'react';
import { SEARCH_RESULT_PREVIEW_LIMIT, URL_REGEX, isMessageOwnedByCurrentSession } from "./chatShared";
export default function useChatSearchResults(context, late) {
  const {
    activeSearchResultIndex,
    canonicalIdentity,
    messageLookupById,
    searchFilter,
    searchQuery,
    searchResults
  } = context;
  const filteredSearchResults = useMemo(() => {
    if (searchResults.length === 0) return [];
    return searchResults.filter(result => {
      const message = messageLookupById.get(result.id);
      if (!message) return false;
      switch (searchFilter) {
        case 'drivers':
          return message.isDriver === true;
        case 'mine':
          return isMessageOwnedByCurrentSession(message, canonicalIdentity);
        case 'links':
          return typeof message.text === 'string' && new RegExp(URL_REGEX).test(message.text);
        case 'media':
          return message.type === 'image' || Boolean(message.imageUrl);
        case 'all':
        default:
          return true;
      }
    });
  }, [searchResults, messageLookupById, searchFilter, canonicalIdentity]);
  const activeSearchResultMessageId = useMemo(() => {
    if (filteredSearchResults.length === 0) return null;
    const safeIndex = Math.min(Math.max(activeSearchResultIndex, 0), filteredSearchResults.length - 1);
    return filteredSearchResults[safeIndex]?.id || null;
  }, [filteredSearchResults, activeSearchResultIndex]);
  const searchResultPreviewCards = useMemo(() => {
    if (filteredSearchResults.length === 0) return [];
    const normalizedQuery = normalizeSearchQuery(searchQuery);
    const activeId = activeSearchResultMessageId;
    return filteredSearchResults.slice(0, SEARCH_RESULT_PREVIEW_LIMIT).map(result => {
      const message = messageLookupById.get(result.id);
      if (!message) return null;
      const messageText = typeof message.text === 'string' ? message.text.trim() : '';
      const fallbackText = message.type === 'image' ? '📷 Photo' : 'Message';
      const previewText = messageText || fallbackText;
      const lowerCasePreview = previewText.toLowerCase();
      const queryIndex = normalizedQuery ? lowerCasePreview.indexOf(normalizedQuery) : -1;
      const snippetStart = queryIndex > 24 ? queryIndex - 24 : 0;
      const snippetEnd = queryIndex >= 0 ? Math.min(previewText.length, queryIndex + normalizedQuery.length + 36) : Math.min(previewText.length, 72);
      const snippet = previewText.slice(snippetStart, snippetEnd).trim();
      const formattedSnippet = snippetStart > 0 ? `…${snippet}` : snippet;
      return {
        id: message.id,
        senderName: message.senderName || 'Participant',
        previewText: formattedSnippet || fallbackText,
        timestamp: message.timestamp,
        isActive: activeId === message.id,
        isDriver: message.isDriver === true
      };
    }).filter(Boolean);
  }, [filteredSearchResults, messageLookupById, searchQuery, activeSearchResultMessageId]);
  Object.assign(late.current, {
    filteredSearchResults,
    activeSearchResultMessageId,
    searchResultPreviewCards
  });
  return {
    filteredSearchResults,
    activeSearchResultMessageId,
    searchResultPreviewCards
  };
}
