// screens/ChatScreen.js - Premium Chat Experience
import { useCallback, useEffect } from 'react';
import { Text } from 'react-native';
import styles from "./chatStyles";
export default function useChatNavigationLifecycle(context, late) {
  const {
    activeSearchResultIndex,
    activeSearchResultMessageId,
    filteredSearchResults,
    highlightedReplyTargetMessageId,
    isSearchOpen,
    jumpToMessageById,
    replyJumpFeedbackMessage,
    searchFilter,
    searchQuery,
    setActiveSearchResultIndex,
    setHighlightedReplyTargetMessageId,
    setReplyJumpFeedbackMessage
  } = context;
  useEffect(() => {
    if (!replyJumpFeedbackMessage) return undefined;
    const timeoutId = setTimeout(() => setReplyJumpFeedbackMessage(''), 2600);
    return () => clearTimeout(timeoutId);
  }, [replyJumpFeedbackMessage, setReplyJumpFeedbackMessage]);
  useEffect(() => {
    if (!highlightedReplyTargetMessageId) return undefined;
    const timeoutId = setTimeout(() => setHighlightedReplyTargetMessageId(null), 2200);
    return () => clearTimeout(timeoutId);
  }, [highlightedReplyTargetMessageId, setHighlightedReplyTargetMessageId]);
  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [searchQuery, searchFilter, setActiveSearchResultIndex]);
  useEffect(() => {
    if (!isSearchOpen) return;
    if (filteredSearchResults.length === 0) return;
    jumpToMessageById(activeSearchResultMessageId);
  }, [isSearchOpen, filteredSearchResults.length, activeSearchResultMessageId, jumpToMessageById]);
  const cycleSearchResult = useCallback(direction => {
    if (filteredSearchResults.length === 0) return;
    const nextIndex = (activeSearchResultIndex + direction + filteredSearchResults.length) % filteredSearchResults.length;
    setActiveSearchResultIndex(nextIndex);
    jumpToMessageById(filteredSearchResults[nextIndex]?.id);
  }, [filteredSearchResults, activeSearchResultIndex, setActiveSearchResultIndex, jumpToMessageById]);
  const renderHighlightedText = useCallback((content, isSelf) => {
    const normalizedQuery = normalizeSearchQuery(searchQuery);
    if (!normalizedQuery || typeof content !== 'string') {
      return <Text>{content}</Text>;
    }
    const matcher = new RegExp(`(${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    const segments = content.split(matcher);
    return <Text>
        {segments.map((segment, index) => {
        const isMatch = segment.toLowerCase() === normalizedQuery;
        return <Text key={`${segment}-${index}`} style={isMatch ? [styles.searchHighlight, isSelf && styles.searchHighlightSelf] : undefined}>
              {segment}
            </Text>;
      })}
      </Text>;
  }, [searchQuery]);

  // Render a single message
  Object.assign(late.current, {
    cycleSearchResult,
    renderHighlightedText
  });
  return {
    cycleSearchResult,
    renderHighlightedText
  };
}
