// screens/ChatScreen.js - Premium Chat Experience
import { useState } from 'react';
export default function useChatCoreState(context, late) {
  const {} = context;
  // Core state
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [chatLoadError, setChatLoadError] = useState('');
  const [subscriptionRevision, setSubscriptionRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [queueStats, setQueueStats] = useState({
    pending: 0,
    syncing: 0,
    failed: 0,
    total: 0
  });
  const [syncBannerContract, setSyncBannerContract] = useState(null);
  const [syncBannerOutcomeText, setSyncBannerOutcomeText] = useState('');
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState(null);
  const [inputHeight, setInputHeight] = useState(44);
  const [draftRestored, setDraftRestored] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [transientFeedback, setTransientFeedback] = useState(null);

  // Feature state
  // Feature state
  const [typingUsers, setTypingUsers] = useState([]);
  Object.assign(late.current, {
    messages,
    setMessages,
    inputText,
    setInputText,
    loading,
    setLoading,
    chatLoadError,
    setChatLoadError,
    subscriptionRevision,
    setSubscriptionRevision,
    refreshing,
    setRefreshing,
    sending,
    setSending,
    queueStats,
    setQueueStats,
    syncBannerContract,
    setSyncBannerContract,
    syncBannerOutcomeText,
    setSyncBannerOutcomeText,
    lastSuccessfulSyncAt,
    setLastSuccessfulSyncAt,
    inputHeight,
    setInputHeight,
    draftRestored,
    setDraftRestored,
    composerHeight,
    setComposerHeight,
    isKeyboardVisible,
    setIsKeyboardVisible,
    keyboardHeight,
    setKeyboardHeight,
    hasMoreHistory,
    setHasMoreHistory,
    loadingOlderMessages,
    setLoadingOlderMessages,
    transientFeedback,
    setTransientFeedback,
    typingUsers,
    setTypingUsers
  });
  return {
    messages,
    setMessages,
    inputText,
    setInputText,
    loading,
    setLoading,
    chatLoadError,
    setChatLoadError,
    subscriptionRevision,
    setSubscriptionRevision,
    refreshing,
    setRefreshing,
    sending,
    setSending,
    queueStats,
    setQueueStats,
    syncBannerContract,
    setSyncBannerContract,
    syncBannerOutcomeText,
    setSyncBannerOutcomeText,
    lastSuccessfulSyncAt,
    setLastSuccessfulSyncAt,
    inputHeight,
    setInputHeight,
    draftRestored,
    setDraftRestored,
    composerHeight,
    setComposerHeight,
    isKeyboardVisible,
    setIsKeyboardVisible,
    keyboardHeight,
    setKeyboardHeight,
    hasMoreHistory,
    setHasMoreHistory,
    loadingOlderMessages,
    setLoadingOlderMessages,
    transientFeedback,
    setTransientFeedback,
    typingUsers,
    setTypingUsers
  };
}
