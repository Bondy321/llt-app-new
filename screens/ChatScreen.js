// screens/ChatScreen.js - Premium Chat Experience
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import {
  sendInternalDriverMessage,
  sendMessage,
  sendImageMessage,
  subscribeToChatMessages,
  subscribeToInternalDriverChat,
  subscribeToTypingIndicators,
  subscribeToPresence,
  setTypingStatus,
  setOnlinePresence,
  toggleReaction,
  markChatAsRead,
  markInternalChatAsRead,
  deleteMessage,
  getMessageTextForCopy,
} from '../services/chatService';
import { createPersistenceProvider } from '../services/persistenceProvider';
import offlineSyncService from '../services/offlineSyncService';
import * as bookingService from '../services/bookingServiceRealtime';
import * as chatService from '../services/chatService';
import * as photoService from '../services/photoService';
import { auth } from '../firebase';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS } from '../theme';
import SyncStatusBanner from '../components/SyncStatusBanner';
const { buildChatSearchResults, normalizeSearchQuery } = require('../utils/chatSearch');

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Quick Reaction Emojis
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const DATE_SEPARATOR_HEIGHT = 40;
const UNREAD_SEPARATOR_HEIGHT = 36;
const ESTIMATED_MESSAGE_ROW_HEIGHT = 120;

// URL Detection Regex
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  primaryLight: THEME.primaryLight,
  primaryDark: THEME.primaryDark,
  lightBlueAccent: THEME.sync.info.border,
  coralAccent: THEME.accent,
  coralMuted: THEME.accentLight,
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  tertiaryText: THEME.textMuted,
  border: THEME.border,
  appBackground: THEME.background,
  chatScreenBackground: THEME.background,
  surfaceSecondary: '#EFF6FF',
  myMessageBackground: THEME.primary,
  theirMessageBackground: THEME.white,
  driverMessageBackground: THEME.accentLight,
  driverMessageBorder: '#FDBA74',
  inputBackground: THEME.white,
  sendButtonColor: THEME.accent,
  chatHeaderColor: THEME.primary,
  onlineIndicator: THEME.success,
  offlineIndicator: THEME.textMuted,
  typingIndicator: THEME.textSecondary,
  linkColor: THEME.primaryLight,
  reactionBackground: `${THEME.primary}10`,
  newMessageBanner: THEME.accent,
  overlay: THEME.overlay,
};

// ==================== TYPING INDICATOR COMPONENT ====================
const TypingIndicator = ({ typingUsers }) => {
  const [dots, setDots] = useState('');

  useEffect(() => {
    if (typingUsers.length === 0) return;

    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 400);

    return () => clearInterval(interval);
  }, [typingUsers.length]);

  if (typingUsers.length === 0) return null;

  const getTypingText = () => {
    if (typingUsers.length === 1) {
      return `${typingUsers[0].name} is typing${dots}`;
    } else if (typingUsers.length === 2) {
      return `${typingUsers[0].name} and ${typingUsers[1].name} are typing${dots}`;
    } else {
      return `${typingUsers.length} people are typing${dots}`;
    }
  };

  return (
    <View style={styles.typingContainer}>
      <View style={styles.typingBubble}>
        <View style={styles.typingDots}>
          <Animated.View style={[styles.typingDot, { opacity: dots.length >= 1 ? 1 : 0.3 }]} />
          <Animated.View style={[styles.typingDot, { opacity: dots.length >= 2 ? 1 : 0.3 }]} />
          <Animated.View style={[styles.typingDot, { opacity: dots.length >= 3 ? 1 : 0.3 }]} />
        </View>
        <Text style={styles.typingText}>{getTypingText()}</Text>
      </View>
    </View>
  );
};

// ==================== DATE SEPARATOR COMPONENT ====================
const normalizeTimestamp = (timestamp) => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string') {
    const numericTimestamp = Number(timestamp);
    if (Number.isFinite(numericTimestamp)) return numericTimestamp;

    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const DateSeparator = ({ date }) => {
  const formatDateLabel = (dateStr) => {
    const normalized = normalizeTimestamp(dateStr);
    if (!normalized) return 'Unknown date';

    const msgDate = new Date(normalized);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const isToday = msgDate.toDateString() === today.toDateString();
    const isYesterday = msgDate.toDateString() === yesterday.toDateString();

    if (isToday) return 'Today';
    if (isYesterday) return 'Yesterday';

    return msgDate.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <View style={styles.dateSeparator}>
      <View style={styles.dateSeparatorLine} />
      <View style={styles.dateSeparatorBadge}>
        <Text style={styles.dateSeparatorText}>{formatDateLabel(date)}</Text>
      </View>
      <View style={styles.dateSeparatorLine} />
    </View>
  );
};

const UnreadSeparator = () => (
  <View style={styles.unreadSeparator}>
    <View style={styles.unreadSeparatorLine} />
    <View style={styles.unreadSeparatorBadge}>
      <Text style={styles.unreadSeparatorText}>Unread messages</Text>
    </View>
    <View style={styles.unreadSeparatorLine} />
  </View>
);

// ==================== MESSAGE REACTIONS COMPONENT ====================
const getReactionUserIds = (users) => {
  if (Array.isArray(users)) {
    return users.filter((userId) => typeof userId === 'string' && userId.trim().length > 0);
  }

  if (users && typeof users === 'object') {
    return Object.entries(users)
      .filter(([userId, reacted]) => reacted === true && typeof userId === 'string' && userId.trim().length > 0)
      .map(([userId]) => userId);
  }

  return [];
};

const MessageReactions = ({ reactions, onReactionPress, messageId, currentUserId }) => {
  if (!reactions || Object.keys(reactions).length === 0) return null;

  const visibleReactions = Object.entries(reactions)
    .map(([emoji, users]) => ({ emoji, userIds: getReactionUserIds(users) }))
    .filter(({ userIds }) => userIds.length > 0);

  if (visibleReactions.length === 0) return null;

  return (
    <View style={styles.reactionsContainer}>
      {visibleReactions.map(({ emoji, userIds }) => {
        const reactedByCurrentUser = currentUserId ? userIds.includes(currentUserId) : false;
        return (
          <TouchableOpacity
            key={emoji}
            style={[styles.reactionBubble, reactedByCurrentUser && styles.reactionBubbleActive]}
            onPress={() => onReactionPress(messageId, emoji)}
            activeOpacity={0.7}
          >
            <Text style={styles.reactionEmoji}>{emoji}</Text>
            <Text style={[styles.reactionCount, reactedByCurrentUser && styles.reactionCountActive]}>
              {userIds.length}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

// ==================== REACTION PICKER MODAL ====================
const ReactionPicker = ({ visible, onClose, onSelectReaction, position }) => {
  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.reactionModalOverlay} onPress={onClose}>
        <View style={[styles.reactionPicker, position && { top: position.y - 60 }]}>
          {QUICK_REACTIONS.map((emoji) => (
            <TouchableOpacity
              key={emoji}
              style={styles.reactionOption}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onSelectReaction(emoji);
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.reactionOptionEmoji}>{emoji}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
};

// ==================== MESSAGE ACTION MENU ====================
const MessageActionMenu = ({ visible, onClose, message, onCopy, onReact, onDelete, canDelete }) => {
  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.actionMenuOverlay} onPress={onClose}>
        <View style={styles.actionMenu}>
          <TouchableOpacity
            style={styles.actionMenuItem}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onCopy();
            }}
          >
            <MaterialCommunityIcons name="content-copy" size={22} color={COLORS.darkText} />
            <Text style={styles.actionMenuText}>Copy</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionMenuItem}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onReact();
            }}
          >
            <MaterialCommunityIcons name="emoticon-happy-outline" size={22} color={COLORS.darkText} />
            <Text style={styles.actionMenuText}>React</Text>
          </TouchableOpacity>

          {canDelete && (
            <TouchableOpacity
              style={[styles.actionMenuItem, styles.actionMenuItemDanger]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onDelete();
              }}
            >
              <MaterialCommunityIcons name="delete-outline" size={22} color={THEME.error} />
              <Text style={[styles.actionMenuText, { color: THEME.error }]}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>
      </Pressable>
    </Modal>
  );
};

// ==================== IMAGE MESSAGE COMPONENT ====================
const ImageMessage = ({ imageUrl, onPress }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={styles.imageMessageContainer}>
      {loading && (
        <View style={styles.imageLoading}>
          <ActivityIndicator size="small" color={COLORS.primaryBlue} />
        </View>
      )}
      {error ? (
        <View style={styles.imageError}>
          <MaterialCommunityIcons name="image-broken" size={40} color={COLORS.secondaryText} />
          <Text style={styles.imageErrorText}>Failed to load image</Text>
        </View>
      ) : (
        <Image
          source={{ uri: imageUrl }}
          style={styles.messageImage}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setError(true);
          }}
          resizeMode="cover"
        />
      )}
    </TouchableOpacity>
  );
};

// ==================== LINK PREVIEW COMPONENT ====================
const LinkPreview = ({ url }) => {
  const domain = useMemo(() => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url;
    }
  }, [url]);

  return (
    <TouchableOpacity
      style={styles.linkPreview}
      onPress={() => Linking.openURL(url)}
      activeOpacity={0.7}
    >
      <MaterialCommunityIcons name="link-variant" size={16} color={COLORS.linkColor} />
      <Text style={styles.linkText} numberOfLines={1}>
        {domain}
      </Text>
      <MaterialCommunityIcons name="open-in-new" size={14} color={COLORS.linkColor} />
    </TouchableOpacity>
  );
};

// ==================== MESSAGE STATUS INDICATOR ====================
const MessageStatus = ({ status, isSelf }) => {
  if (!isSelf) return null;

  const getStatusIcon = () => {
    switch (status) {
      case 'sending':
        return <MaterialCommunityIcons name="clock-outline" size={14} color={COLORS.lightBlueAccent} />;
      case 'sent':
        return <MaterialCommunityIcons name="check" size={14} color={COLORS.lightBlueAccent} />;
      case 'delivered':
        return <MaterialCommunityIcons name="check-all" size={14} color={COLORS.lightBlueAccent} />;
      case 'failed':
        return <MaterialCommunityIcons name="alert-circle-outline" size={14} color={THEME.error} />;
      default:
        return <MaterialCommunityIcons name="check" size={14} color={COLORS.lightBlueAccent} />;
    }
  };

  return <View style={styles.messageStatus}>{getStatusIcon()}</View>;
};

// ==================== NEW MESSAGES BANNER ====================
const NewMessagesBanner = ({ count, onPress }) => {
  if (count === 0) return null;

  return (
    <TouchableOpacity style={styles.newMessagesBanner} onPress={onPress} activeOpacity={0.9}>
      <MaterialCommunityIcons name="arrow-down" size={16} color={COLORS.white} />
      <Text style={styles.newMessagesBannerText}>
        {count} new message{count > 1 ? 's' : ''}
      </Text>
    </TouchableOpacity>
  );
};

// ==================== ATTACHMENT MENU ====================
const AttachmentMenu = ({ visible, onClose, onPickImage, onTakePhoto }) => {
  if (!visible) return null;

  return (
    <View style={styles.attachmentMenu}>
      <TouchableOpacity
        style={styles.attachmentOption}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPickImage();
        }}
        activeOpacity={0.7}
      >
        <View style={[styles.attachmentIconBg, { backgroundColor: THEME.primaryMuted }]}>
          <MaterialCommunityIcons name="image" size={24} color={COLORS.primaryBlue} />
        </View>
        <Text style={styles.attachmentLabel}>Gallery</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.attachmentOption}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onTakePhoto();
        }}
        activeOpacity={0.7}
      >
        <View style={[styles.attachmentIconBg, { backgroundColor: THEME.errorLight }]}>
          <MaterialCommunityIcons name="camera" size={24} color={THEME.error} />
        </View>
        <Text style={styles.attachmentLabel}>Camera</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.attachmentOption}
        onPress={onClose}
        activeOpacity={0.7}
      >
        <View style={[styles.attachmentIconBg, { backgroundColor: COLORS.surfaceSecondary }]}>
          <MaterialCommunityIcons name="close" size={24} color={COLORS.secondaryText} />
        </View>
        <Text style={styles.attachmentLabel}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
};

// ==================== IMAGE VIEWER MODAL ====================
const ImageViewerModal = ({ visible, imageUrl, onClose }) => {
  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.imageViewerOverlay}>
        <TouchableOpacity style={styles.imageViewerClose} onPress={onClose}>
          <MaterialCommunityIcons name="close" size={28} color={COLORS.white} />
        </TouchableOpacity>
        <Image
          source={{ uri: imageUrl }}
          style={styles.fullScreenImage}
          resizeMode="contain"
        />
      </View>
    </Modal>
  );
};

// ==================== MAIN CHAT SCREEN ====================
export default function ChatScreen({ onBack, tourId, bookingData, tourData, internalDriverChat = false }) {
  // Core state
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [queueStats, setQueueStats] = useState({ pending: 0, syncing: 0, failed: 0, total: 0 });
  const [syncBannerContract, setSyncBannerContract] = useState(null);
  const [syncBannerOutcomeText, setSyncBannerOutcomeText] = useState('');
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState(null);
  const [inputHeight, setInputHeight] = useState(44);
  const [draftRestored, setDraftRestored] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);

  // Feature state
  const [typingUsers, setTypingUsers] = useState([]);
  const [presenceInfo, setPresenceInfo] = useState({ onlineCount: 0, totalCount: 0, users: [] });
  const [newMessagesCount, setNewMessagesCount] = useState(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState(null);
  const [currentScrollY, setCurrentScrollY] = useState(0);
  const [unreadAnchorY, setUnreadAnchorY] = useState(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);

  // Modal state
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [viewingImage, setViewingImage] = useState(null);

  const insets = useSafeAreaInsets();
  const composerBottomInset = insets.bottom > 0 ? Math.max(insets.bottom, SPACING.md) : SPACING.md;
  const currentUser = auth.currentUser;
  const isDriver = bookingData?.isDriver === true;
  const userName = bookingData?.passengerNames?.[0] || 'Tour Participant';
  const draftStorage = useMemo(() => createPersistenceProvider({ namespace: 'LLT_CHAT_DRAFTS' }), []);
  const readStateStorage = useMemo(() => createPersistenceProvider({ namespace: 'LLT_CHAT_READ_STATE' }), []);
  const draftStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `draft_${chatType}_${tourId}_${currentUser?.uid || 'anonymous'}`;
  }, [tourId, internalDriverChat, currentUser?.uid]);
  const readStateStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `last_seen_${chatType}_${tourId}_${currentUser?.uid || 'anonymous'}`;
  }, [tourId, internalDriverChat, currentUser?.uid]);

  const listBottomSpacerHeight = useMemo(() => {
    const safeComposerHeight = composerHeight > 0 ? composerHeight : 72;
    const attachmentMenuHeight = showAttachmentMenu ? 108 : 0;
    const typingHeight = typingUsers.length > 0 ? 44 : 0;

    return safeComposerHeight + attachmentMenuHeight + typingHeight + SPACING.lg;
  }, [composerHeight, showAttachmentMenu, typingUsers.length]);

  // Refs
  const messageListRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const syncBannerTimeoutRef = useRef(null);
  const lastMessageCountRef = useRef(0);
  const lastReadMarkAtRef = useRef(0);
  const rowOffsetsRef = useRef({});

  const getMessageTimestamp = useCallback((message) => {
    if (!message) return null;
    return normalizeTimestamp(message.timestamp);
  }, []);

  const markActiveChatRead = useCallback(async ({ force = false } = {}) => {
    if (!tourId || !currentUser?.uid) return;

    const now = Date.now();
    if (!force && now - lastReadMarkAtRef.current < 3000) return;
    lastReadMarkAtRef.current = now;

    const markReadFn = internalDriverChat ? markInternalChatAsRead : markChatAsRead;
    const latestMessage = messages[messages.length - 1];
    const latestTimestamp = getMessageTimestamp(latestMessage);
    const result = await markReadFn(tourId, currentUser.uid);

    if (result?.success && latestTimestamp && readStateStorageKey) {
      setLastSeenTimestamp(latestTimestamp);
      setUnreadAnchorY(null);
      await readStateStorage.setItemAsync(readStateStorageKey, String(latestTimestamp));
    }
  }, [
    tourId,
    currentUser?.uid,
    internalDriverChat,
    messages,
    getMessageTimestamp,
    readStateStorage,
    readStateStorageKey,
  ]);

  // Scroll to bottom helper
  const scrollToBottom = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      messageListRef.current?.scrollToEnd({ animated });
    });
  }, []);

  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom(false);
    }
  }, [composerHeight, isAtBottom, listBottomSpacerHeight, scrollToBottom]);

  // Handle scroll position tracking
  const handleScroll = useCallback((event) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    setCurrentScrollY(contentOffset.y);
    const isBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 50;
    setIsAtBottom(isBottom);
    if (isBottom) {
      setNewMessagesCount(0);
      markActiveChatRead({ force: true });
    }
  }, [markActiveChatRead]);


  useEffect(() => {
    let active = true;

    if (!readStateStorageKey) {
      setLastSeenTimestamp(null);
      return;
    }

    const restoreReadState = async () => {
      try {
        const storedTimestamp = await readStateStorage.getItemAsync(readStateStorageKey);
        if (!active) return;
        const parsed = Number(storedTimestamp);
        setLastSeenTimestamp(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
      } catch (error) {
        if (active) setLastSeenTimestamp(null);
      }
    };

    restoreReadState();

    return () => {
      active = false;
    };
  }, [readStateStorage, readStateStorageKey]);

  // Subscribe to messages
  useEffect(() => {
    if (!tourId) {
      setLoading(false);
      return;
    }

    const subscribeFn = internalDriverChat ? subscribeToInternalDriverChat : subscribeToChatMessages;
    const unsubscribe = subscribeFn(tourId, (newMessages) => {
      setMessages(newMessages);
      setLoading(false);

      // Track new messages when not at bottom
      if (!isAtBottom && newMessages.length > lastMessageCountRef.current) {
        setNewMessagesCount((prev) => prev + (newMessages.length - lastMessageCountRef.current));
      }
      lastMessageCountRef.current = newMessages.length;

      // Auto-scroll if at bottom
      if (isAtBottom) {
        scrollToBottom(true);
      }
    });

    return () => unsubscribe();
  }, [tourId, internalDriverChat, isAtBottom, scrollToBottom]);

  // Restore persisted chat draft for this tour/user context
  useEffect(() => {
    let active = true;

    if (!draftStorageKey) {
      setInputText('');
      setDraftRestored(false);
      return;
    }

    setDraftRestored(false);

    const restoreDraft = async () => {
      try {
        const savedDraft = await draftStorage.getItemAsync(draftStorageKey);
        if (!active || typeof savedDraft !== 'string') return;

        if (savedDraft.trim().length > 0) {
          setInputText(savedDraft);
          setDraftRestored(true);
        } else {
          setInputText('');
          setDraftRestored(false);
        }
      } catch (error) {
        setInputText('');
        setDraftRestored(false);
      }
    };

    restoreDraft();

    return () => {
      active = false;
    };
  }, [draftStorage, draftStorageKey]);

  // Persist draft while the user is typing
  useEffect(() => {
    if (!draftStorageKey) return;

    const timeout = setTimeout(() => {
      if (inputText.trim().length === 0) {
        draftStorage.deleteItemAsync(draftStorageKey);
      } else {
        draftStorage.setItemAsync(draftStorageKey, inputText);
      }
    }, 200);

    return () => clearTimeout(timeout);
  }, [draftStorage, draftStorageKey, inputText]);

  // Mark chat as read when screen opens with a valid user/tour context
  useEffect(() => {
    markActiveChatRead();
  }, [markActiveChatRead]);

  // Subscribe to typing indicators
  useEffect(() => {
    if (!tourId || !currentUser?.uid) return;

    const unsubscribe = subscribeToTypingIndicators(tourId, currentUser.uid, setTypingUsers);
    return () => unsubscribe();
  }, [tourId, currentUser?.uid]);

  // Subscribe to presence
  useEffect(() => {
    if (!tourId) return;

    const unsubscribe = subscribeToPresence(tourId, setPresenceInfo);
    return () => unsubscribe();
  }, [tourId]);

  const refreshQueueStats = useCallback(async () => {
    const statsResult = await offlineSyncService.getQueueStats();
    if (statsResult?.success && statsResult?.data) {
      setQueueStats(statsResult.data);
    }
  }, []);

  const clearSyncBannerTimeout = useCallback(() => {
    if (syncBannerTimeoutRef.current) {
      clearTimeout(syncBannerTimeoutRef.current);
      syncBannerTimeoutRef.current = null;
    }
  }, []);

  const showSyncBanner = useCallback(
    ({ contract, outcomeText = '', autoDismissMs = 4500 }) => {
      clearSyncBannerTimeout();
      setSyncBannerContract(contract);
      setSyncBannerOutcomeText(outcomeText);

      if (autoDismissMs > 0) {
        syncBannerTimeoutRef.current = setTimeout(() => {
          setSyncBannerContract(null);
          setSyncBannerOutcomeText('');
        }, autoDismissMs);
      }
    },
    [clearSyncBannerTimeout]
  );

  const showQueueSyncOutcome = useCallback(
    ({ replayResult, beforeStats = {}, afterStats = {}, fallbackErrorMessage = 'Unable to flush queued chat actions.' }) => {
      const safeBeforeStats = {
        pending: beforeStats?.pending || 0,
        failed: beforeStats?.failed || 0,
        syncing: beforeStats?.syncing || 0,
        total: beforeStats?.total || 0,
      };
      const safeAfterStats = {
        pending: afterStats?.pending || 0,
        failed: afterStats?.failed || 0,
        syncing: afterStats?.syncing || 0,
        total: afterStats?.total || 0,
      };

      const processed = replayResult?.data?.processed || 0;
      const syncOutcome = offlineSyncService.formatSyncOutcome({
        syncedCount: processed,
        pendingCount: safeAfterStats.pending,
        failedCount: safeAfterStats.failed,
        source: 'manual-refresh',
      });

      const unifiedStatus = offlineSyncService.deriveUnifiedSyncStatus({
        network: { isOnline: true },
        backend: { isReachable: replayResult?.success !== false, isDegraded: !replayResult?.success },
        queue: safeAfterStats,
        lastSyncAt: lastSuccessfulSyncAt,
        syncSummary: {
          syncedCount: processed,
          pendingCount: safeAfterStats.pending,
          failedCount: safeAfterStats.failed,
          source: 'manual-refresh',
        },
      });

      if (!replayResult?.success) {
        showSyncBanner({
          contract: {
            ...offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKEND_DEGRADED,
            canRetry: true,
            description: fallbackErrorMessage || replayResult?.error || offlineSyncService.UNIFIED_SYNC_STATES.ONLINE_BACKEND_DEGRADED.description,
          },
          outcomeText: syncOutcome,
          autoDismissMs: 7000,
        });
        return;
      }

      showSyncBanner({
        contract: {
          label: unifiedStatus.label,
          description: unifiedStatus.description,
          icon: unifiedStatus.icon,
          severity: unifiedStatus.severity,
          canRetry: unifiedStatus.canRetry,
          showLastSync: unifiedStatus.showLastSync,
        },
        outcomeText: syncOutcome,
        autoDismissMs: safeAfterStats.failed > 0 ? 7000 : safeAfterStats.pending > 0 ? 5500 : 3000,
      });

      if (safeAfterStats.failed === 0 && (processed > 0 || safeBeforeStats.total > 0 || safeAfterStats.total > 0)) {
        offlineSyncService.getLastSuccessAt().then((result) => {
          if (result?.success) setLastSuccessfulSyncAt(result.data);
        });
      }
    },
    [showSyncBanner, lastSuccessfulSyncAt]
  );

  useEffect(() => {
    let mounted = true;
    offlineSyncService.getLastSuccessAt().then((result) => {
      if (mounted && result?.success) {
        setLastSuccessfulSyncAt(result.data);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      clearSyncBannerTimeout();
    };
  }, [clearSyncBannerTimeout]);

  // Subscribe to offline queue state updates
  useEffect(() => {
    if (!tourId) {
      setQueueStats({ pending: 0, syncing: 0, failed: 0, total: 0 });
      return;
    }

    const unsubscribe = offlineSyncService.subscribeQueueState((stats) => {
      setQueueStats(stats || { pending: 0, syncing: 0, failed: 0, total: 0 });
    });

    return () => unsubscribe();
  }, [tourId]);

  // Set online presence on mount/unmount
  useEffect(() => {
    if (!tourId || !currentUser?.uid) return;

    setOnlinePresence(tourId, currentUser.uid, userName, true, isDriver);

    return () => {
      setOnlinePresence(tourId, currentUser.uid, userName, false, isDriver);
      setTypingStatus(tourId, currentUser.uid, userName, false, isDriver);
    };
  }, [tourId, currentUser?.uid, userName, isDriver]);

  // Keyboard listeners
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      if (isAtBottom) scrollToBottom(true);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      if (isAtBottom) scrollToBottom(true);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [isAtBottom, scrollToBottom]);

  // Handle typing indicator
  const handleTextChange = useCallback(
    (text) => {
      if (draftRestored && text !== inputText) {
        setDraftRestored(false);
      }

      setInputText(text);

      if (!tourId || !currentUser?.uid) return;

      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      // Set typing status
      if (text.trim().length > 0) {
        setTypingStatus(tourId, currentUser.uid, userName, true, isDriver);

        // Clear typing after 3 seconds of inactivity
        typingTimeoutRef.current = setTimeout(() => {
          setTypingStatus(tourId, currentUser.uid, userName, false, isDriver);
        }, 3000);
      } else {
        setTypingStatus(tourId, currentUser.uid, userName, false, isDriver);
      }
    },
    [draftRestored, inputText, tourId, currentUser?.uid, userName, isDriver]
  );

  // Send message handler
  const handleSendMessage = useCallback(async () => {
    if (sending) return;

    const trimmed = inputText.trim();
    if (!trimmed) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setSending(true);
    setInputText('');

    // Clear typing status
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    setTypingStatus(tourId, currentUser?.uid, userName, false, isDriver);

    const senderInfo = {
      name: userName,
      userId: currentUser?.uid || 'anonymous',
      isDriver,
    };

    const optimisticTimestamp = new Date().toISOString();
    const optimisticId = `local-${Date.now()}`;
    const optimisticMessage = {
      id: optimisticId,
      text: trimmed,
      senderName: userName,
      senderId: senderInfo.userId,
      timestamp: optimisticTimestamp,
      isDriver,
      status: 'sending',
      type: 'text',
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    scrollToBottom(true);

    try {
      const sendFn = internalDriverChat ? sendInternalDriverMessage : sendMessage;
      const result = await sendFn(tourId, trimmed, senderInfo);

      if (!result?.success || !result?.message) {
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId));
        setInputText(trimmed);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        const confirmedMessage = { ...result.message, status: result.queued ? 'queued' : 'sent' };
        setMessages((prev) => {
          const filtered = prev.filter(
            (msg) => msg.id !== optimisticId && msg.id !== confirmedMessage.id
          );
          return [...filtered, confirmedMessage];
        });

        if (!result.queued && result.serverPromise?.finally) {
          result.serverPromise
            .then(() => {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === confirmedMessage.id ? { ...msg, status: 'delivered' } : msg
                )
              );
            })
            .catch(() => {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === confirmedMessage.id ? { ...msg, status: 'failed' } : msg
                )
              );
            });
        }

        if (result.queued) {
          await refreshQueueStats();
        }
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId));
      setInputText(trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      await refreshQueueStats();
    }

    setSending(false);
  }, [
    sending,
    inputText,
    tourId,
    currentUser?.uid,
    userName,
    isDriver,
    internalDriverChat,
    refreshQueueStats,
    scrollToBottom,
  ]);

  const handleManualSync = useCallback(async ({ retryFailedOnly = false } = {}) => {
    try {
      const beforeStatsResult = await offlineSyncService.getQueueStats();
      const beforeStats = beforeStatsResult?.success
        ? beforeStatsResult.data
        : { pending: 0, failed: 0, syncing: 0, total: 0 };

      if (retryFailedOnly) {
        await offlineSyncService.retryFailedActions({
          types: internalDriverChat
            ? ['CHAT_MESSAGE', 'INTERNAL_CHAT_MESSAGE', 'PHOTO_UPLOAD']
            : ['CHAT_MESSAGE', 'PHOTO_UPLOAD'],
        });
      }

      const replayResult = await offlineSyncService.replayQueue({ services: { bookingService, chatService, photoService } });
      await refreshQueueStats();
      const afterStatsResult = await offlineSyncService.getQueueStats();
      const afterStats = afterStatsResult?.success
        ? afterStatsResult.data
        : { pending: 0, failed: 0, syncing: 0, total: 0 };

      showQueueSyncOutcome({ replayResult, beforeStats, afterStats });
    } catch (error) {
      showQueueSyncOutcome({
        replayResult: { success: false, error: error?.message || 'Unable to flush queued chat actions.' },
        fallbackErrorMessage: 'Unable to flush queued chat actions.',
      });
    }
  }, [internalDriverChat, refreshQueueStats, showQueueSyncOutcome]);

  // Image picker handler
  const handlePickImage = useCallback(async () => {
    setShowAttachmentMenu(false);

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.[0]) {
      await handleSendImage(result.assets[0].uri);
    }
  }, []);

  // Camera handler
  const handleTakePhoto = useCallback(async () => {
    setShowAttachmentMenu(false);

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.[0]) {
      await handleSendImage(result.assets[0].uri);
    }
  }, []);

  // Send image handler
  const handleSendImage = useCallback(
    async (imageUri) => {
      setUploadingImage(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      try {
        const userId = currentUser?.uid || 'anonymous';

        // Upload to Firebase Storage using correct signature:
        // uploadPhoto(uri, tourId, userId, caption, options)
        const uploadResult = await photoService.uploadPhoto(
          imageUri,
          tourId,
          userId,
          '', // caption
          {
            visibility: 'group',
            uploaderName: userName,
          }
        );

        if (uploadResult && uploadResult.url) {
          const senderInfo = {
            name: userName,
            userId,
            isDriver,
          };

          await sendImageMessage(tourId, uploadResult.url, '', senderInfo);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      } catch (error) {
        console.error('Error sending image:', error);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }

      setUploadingImage(false);
    },
    [tourId, userName, currentUser?.uid, isDriver]
  );

  // Handle reaction
  const handleReaction = useCallback(
    async (messageId, emoji) => {
      if (!currentUser?.uid) return;

      setShowReactionPicker(false);
      setSelectedMessage(null);

      const result = await toggleReaction(tourId, messageId, emoji, currentUser.uid);
      if (!result?.success) {
        console.warn('Failed to toggle chat reaction', {
          tourId,
          messageId,
          emoji,
          userId: currentUser.uid,
          error: result?.error || 'Unknown error',
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [tourId, currentUser?.uid]
  );

  // Handle message long press
  const handleMessageLongPress = useCallback((message) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedMessage(message);
    setShowActionMenu(true);
  }, []);

  // Handle copy message
  const handleCopyMessage = useCallback(() => {
    if (selectedMessage) {
      Clipboard.setString(getMessageTextForCopy(selectedMessage));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [selectedMessage]);

  // Handle delete message
  const handleDeleteMessage = useCallback(async () => {
    if (selectedMessage) {
      const result = await deleteMessage(tourId, selectedMessage.id, currentUser?.uid, isDriver);
      if (result.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [tourId, selectedMessage, currentUser?.uid, isDriver]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);

    try {
      const beforeStatsResult = await offlineSyncService.getQueueStats();
      const beforeStats = beforeStatsResult?.success
        ? beforeStatsResult.data
        : { pending: 0, failed: 0, syncing: 0, total: 0 };

      const replayResult = await offlineSyncService.replayQueue({ services: { bookingService, chatService, photoService } });
      await refreshQueueStats();

      const afterStatsResult = await offlineSyncService.getQueueStats();
      const afterStats = afterStatsResult?.success
        ? afterStatsResult.data
        : { pending: 0, failed: 0, syncing: 0, total: 0 };

      showQueueSyncOutcome({ replayResult, beforeStats, afterStats });
    } catch (error) {
      showQueueSyncOutcome({
        replayResult: { success: false, error: error?.message || 'Unable to refresh chat right now.' },
        fallbackErrorMessage: 'Unable to refresh chat right now.',
      });
    } finally {
      setRefreshing(false);
    }
  }, [refreshQueueStats, showQueueSyncOutcome]);

  // Format time helper
  const formatTime = useCallback((timestamp) => {
    const normalized = normalizeTimestamp(timestamp);
    if (!normalized) return '';
    const date = new Date(normalized);
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  }, []);

  // Parse message text for links
  const parseMessageText = useCallback((text) => {
    if (!text) return [{ type: 'text', content: '' }];

    const parts = [];
    let lastIndex = 0;
    let match;

    const regex = new RegExp(URL_REGEX);
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.substring(lastIndex, match.index) });
      }
      parts.push({ type: 'link', content: match[0] });
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.substring(lastIndex) });
    }

    return parts.length > 0 ? parts : [{ type: 'text', content: text }];
  }, []);

  const unreadAnchorMessageId = useMemo(() => {
    if (!lastSeenTimestamp) return null;

    const unreadMessage = messages.find((message) => {
      const timestamp = getMessageTimestamp(message);
      return timestamp && timestamp > lastSeenTimestamp;
    });

    return unreadMessage?.id || null;
  }, [messages, lastSeenTimestamp, getMessageTimestamp]);

  // Group messages by date
  const groupedMessages = useMemo(() => {
    const groups = [];
    let currentDate = null;
    let unreadInjected = false;

    messages.forEach((msg) => {
      const msgTimestamp = getMessageTimestamp(msg);
      const msgDate = msgTimestamp ? new Date(msgTimestamp).toDateString() : 'Unknown date';

      if (msgDate !== currentDate) {
        groups.push({
          type: 'date',
          id: `date-${msgDate}-${msgTimestamp ?? msg.timestamp ?? msg.id}`,
          date: msgTimestamp ?? msg.timestamp,
        });
        currentDate = msgDate;
      }

      if (!unreadInjected && unreadAnchorMessageId && msg.id === unreadAnchorMessageId) {
        groups.push({ type: 'unread-separator', id: `unread-${msg.id}` });
        unreadInjected = true;
      }

      groups.push({ type: 'message', id: `message-${msg.id}`, data: msg });
    });

    return groups;
  }, [messages, unreadAnchorMessageId]);

  const unreadAnchorIndex = useMemo(() => {
    if (!unreadAnchorMessageId) return -1;
    return groupedMessages.findIndex((item) => item.type === 'message' && item.data?.id === unreadAnchorMessageId);
  }, [groupedMessages, unreadAnchorMessageId]);

  const showJumpToUnread = useMemo(() => {
    if (!unreadAnchorMessageId || unreadAnchorY == null) return false;
    return Math.abs(currentScrollY - unreadAnchorY) > 180;
  }, [unreadAnchorMessageId, unreadAnchorY, currentScrollY]);

  const jumpToUnread = useCallback(() => {
    if (unreadAnchorIndex >= 0) {
      messageListRef.current?.scrollToIndex({ index: unreadAnchorIndex, animated: true, viewOffset: 80 });
      return;
    }
    if (unreadAnchorY == null) return;
    messageListRef.current?.scrollToOffset({ offset: Math.max(unreadAnchorY - 80, 0), animated: true });
  }, [unreadAnchorIndex, unreadAnchorY]);

  const searchResults = useMemo(
    () => buildChatSearchResults(messages, searchQuery),
    [messages, searchQuery]
  );

  const activeSearchResultMessageId = useMemo(() => {
    if (searchResults.length === 0) return null;
    const safeIndex = Math.min(Math.max(activeSearchResultIndex, 0), searchResults.length - 1);
    return searchResults[safeIndex]?.id || null;
  }, [searchResults, activeSearchResultIndex]);

  const jumpToMessageById = useCallback((messageId) => {
    if (!messageId) return;
    const groupedIndex = groupedMessages.findIndex(
      (item) => item.type === 'message' && item.data?.id === messageId
    );
    if (groupedIndex < 0) return;

    messageListRef.current?.scrollToIndex({ index: groupedIndex, animated: true, viewPosition: 0.45 });
  }, [groupedMessages]);

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (!isSearchOpen) return;
    if (searchResults.length === 0) return;
    jumpToMessageById(activeSearchResultMessageId);
  }, [isSearchOpen, searchResults.length, activeSearchResultMessageId, jumpToMessageById]);

  const cycleSearchResult = useCallback((direction) => {
    if (searchResults.length === 0) return;
    const nextIndex = (activeSearchResultIndex + direction + searchResults.length) % searchResults.length;
    setActiveSearchResultIndex(nextIndex);
    jumpToMessageById(searchResults[nextIndex]?.id);
  }, [searchResults, activeSearchResultIndex, jumpToMessageById]);

  const renderHighlightedText = useCallback((content, isSelf) => {
    const normalizedQuery = normalizeSearchQuery(searchQuery);
    if (!normalizedQuery || typeof content !== 'string') {
      return <Text>{content}</Text>;
    }

    const matcher = new RegExp(`(${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    const segments = content.split(matcher);
    return (
      <Text>
        {segments.map((segment, index) => {
          const isMatch = segment.toLowerCase() === normalizedQuery;
          return (
            <Text
              key={`${segment}-${index}`}
              style={isMatch ? [styles.searchHighlight, isSelf && styles.searchHighlightSelf] : undefined}
            >
              {segment}
            </Text>
          );
        })}
      </Text>
    );
  }, [searchQuery]);

  // Render a single message
  const renderMessage = useCallback(
    (msg) => {
      const isSelf = msg.senderId === currentUser?.uid;
      const isMsgDriver = !!msg.isDriver;
      const isDeleted = !!msg.deleted;
      const isImage = msg.type === 'image';
      const isSearchMatch = !!activeSearchResultMessageId && activeSearchResultMessageId === msg.id;

      if (isDeleted) {
        return (
          <View
            key={msg.id}
            style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}
          >
            <View style={[styles.messageBubble, styles.deletedMessageBubble]}>
              <Text style={styles.deletedMessageText}>
                <MaterialCommunityIcons name="cancel" size={14} color={COLORS.secondaryText} />
                {' This message was deleted'}
              </Text>
            </View>
          </View>
        );
      }

      const textParts = parseMessageText(msg.text);
      const hasLink = textParts.some((part) => part.type === 'link');

      return (
        <Pressable
          key={msg.id}
          onLongPress={() => handleMessageLongPress(msg)}
          delayLongPress={300}
        >
          <View
            style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}
          >
            <View
              style={[
                styles.messageBubble,
                isSelf ? styles.myMessageBubble : styles.theirMessageBubble,
                isMsgDriver && !isSelf && styles.driverMessageBubble,
                isImage && styles.imageMessageBubble,
                isSearchMatch && styles.searchFocusedBubble,
              ]}
            >
              {/* Message Header */}
              <View style={styles.messageHeader}>
                <Text
                  style={[
                    styles.senderName,
                    isSelf && styles.mySenderName,
                    isMsgDriver && !isSelf && styles.driverSenderName,
                  ]}
                >
                  {msg.senderName || 'Participant'}
                </Text>
                {isMsgDriver && (
                  <View style={styles.driverBadge}>
                    <Text style={styles.driverBadgeText}>DRIVER</Text>
                  </View>
                )}
              </View>

              {/* Image Content */}
              {isImage && msg.imageUrl && (
                <ImageMessage
                  imageUrl={msg.imageUrl}
                  onPress={() => setViewingImage(msg.imageUrl)}
                />
              )}

              {/* Text Content with Link Detection */}
              {msg.text && (
                <Text style={[styles.messageText, isSelf && styles.myMessageText]}>
                  {textParts.map((part, index) =>
                    part.type === 'link' ? (
                      <Text
                        key={index}
                        style={[styles.linkInMessage, isSelf && styles.linkInMessageSelf]}
                        onPress={() => Linking.openURL(part.content)}
                      >
                        {part.content}
                      </Text>
                    ) : (
                      <Text key={index}>{renderHighlightedText(part.content, isSelf)}</Text>
                    )
                  )}
                </Text>
              )}

              {/* Link Preview */}
              {hasLink && !isSelf && (
                <LinkPreview
                  url={textParts.find((p) => p.type === 'link')?.content || ''}
                />
              )}

              {/* Timestamp and Status */}
              <View style={styles.messageFooter}>
                <Text style={[styles.timestamp, isSelf && styles.myTimestamp]}>
                  {formatTime(msg.timestamp)}
                </Text>
                <MessageStatus status={msg.status} isSelf={isSelf} />
              </View>

              {/* Reactions */}
              <MessageReactions
                reactions={msg.reactions}
                onReactionPress={handleReaction}
                messageId={msg.id}
                currentUserId={currentUser?.uid}
              />
            </View>
          </View>
        </Pressable>
      );
    },
    [currentUser?.uid, formatTime, handleMessageLongPress, handleReaction, parseMessageText, renderHighlightedText, activeSearchResultMessageId]
  );

  const keyExtractor = useCallback((item) => {
    if (item.type === 'message') return item.data?.id ? `message-${item.data.id}` : item.id;
    return item.id;
  }, []);

  const getItemLayout = useCallback((data, index) => {
    if (!data || index < 0 || index >= data.length) {
      return { length: ESTIMATED_MESSAGE_ROW_HEIGHT, offset: 0, index };
    }

    let offset = 0;
    for (let i = 0; i < index; i += 1) {
      const row = data[i];
      if (row.type === 'date') {
        offset += DATE_SEPARATOR_HEIGHT;
      } else if (row.type === 'unread-separator') {
        offset += UNREAD_SEPARATOR_HEIGHT;
      } else {
        offset += rowOffsetsRef.current[row.data?.id] || ESTIMATED_MESSAGE_ROW_HEIGHT;
      }
    }

    const row = data[index];
    const length = row.type === 'date'
      ? DATE_SEPARATOR_HEIGHT
      : row.type === 'unread-separator'
        ? UNREAD_SEPARATOR_HEIGHT
        : rowOffsetsRef.current[row.data?.id] || ESTIMATED_MESSAGE_ROW_HEIGHT;

    return { length, offset, index };
  }, []);

  const renderMessageRow = useCallback(({ item }) => {
    if (item.type === 'date') return <DateSeparator date={item.date} />;
    if (item.type === 'unread-separator') return <UnreadSeparator />;

    const messageId = item.data?.id;
    return (
      <View
        onLayout={(event) => {
          if (!messageId) return;
          const { y, height } = event.nativeEvent.layout;
          rowOffsetsRef.current[messageId] = height;
          if (messageId === unreadAnchorMessageId) {
            setUnreadAnchorY(y);
          }
        }}
      >
        {renderMessage(item.data)}
      </View>
    );
  }, [renderMessage, unreadAnchorMessageId]);

  const renderEmptyMessages = useCallback(() => (
    <View style={styles.emptyContainer}>
      <LinearGradient
        colors={['#DBEAFE', '#EFF6FF']}
        style={styles.emptyIconContainer}
      >
        <MaterialCommunityIcons
          name="chat-processing-outline"
          size={60}
          color={COLORS.primaryBlue}
        />
      </LinearGradient>
      <Text style={styles.emptyText}>Start the Conversation!</Text>
      <Text style={styles.emptySubtext}>
        Say hello to your fellow travelers and tour guides
      </Text>
      <View style={styles.emptyTips}>
        <View style={styles.emptyTip}>
          <MaterialCommunityIcons name="image" size={20} color={COLORS.primaryBlue} />
          <Text style={styles.emptyTipText}>Share photos</Text>
        </View>
        <View style={styles.emptyTip}>
          <MaterialCommunityIcons name="emoticon" size={20} color={COLORS.coralAccent} />
          <Text style={styles.emptyTipText}>React to messages</Text>
        </View>
      </View>
    </View>
  ), []);

  // Error state
  if (!tourId) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={[styles.header, { backgroundColor: COLORS.chatHeaderColor }]}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
            <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Group Chat</Text>
          <View style={styles.headerButton} />
        </View>
        <View style={styles.errorContainer}>
          <MaterialCommunityIcons name="chat-remove-outline" size={60} color={COLORS.secondaryText} />
          <Text style={styles.errorText}>Chat is not available</Text>
          <Text style={styles.errorSubtext}>Please try again later</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      {/* Header */}
      <LinearGradient
        colors={internalDriverChat ? [COLORS.primaryDark, COLORS.primaryBlue] : [COLORS.primaryBlue, COLORS.primaryLight]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>

        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerTitle}>
            {internalDriverChat ? 'Driver Chat' : 'Group Chat'}
          </Text>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.syncNowBtn}
            onPress={() => {
              setIsSearchOpen((prev) => !prev);
              if (isSearchOpen) setSearchQuery('');
            }}
            accessibilityLabel="Search chat messages"
          >
            <MaterialCommunityIcons name={isSearchOpen ? 'close' : 'magnify'} size={18} color={COLORS.white} />
          </TouchableOpacity>
          <View style={styles.onlineIndicator}>
            <View style={[styles.onlineDot, { backgroundColor: COLORS.onlineIndicator }]} />
            <Text style={styles.onlineCount}>
              {presenceInfo.onlineCount} online
            </Text>
          </View>
          <TouchableOpacity
            style={styles.syncNowBtn}
            onPress={handleManualSync}
            accessibilityLabel={queueStats.pending > 0 || queueStats.syncing > 0 ? 'Sync pending' : 'Messages sent'}
          >
            <MaterialCommunityIcons
              name={queueStats.pending > 0 || queueStats.syncing > 0 ? 'check' : 'check-all'}
              size={18}
              color={COLORS.white}
            />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {isSearchOpen && (
        <View style={styles.searchPanel}>
          <View style={styles.searchInputRow}>
            <MaterialCommunityIcons name="magnify" size={18} color={COLORS.secondaryText} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search messages or names"
              placeholderTextColor={COLORS.tertiaryText}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} activeOpacity={0.7}>
                <MaterialCommunityIcons name="close-circle" size={18} color={COLORS.tertiaryText} />
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.searchMetaRow}>
            <Text style={styles.searchMetaText}>
              {searchQuery.trim().length === 0
                ? 'Type to search this conversation'
                : `${searchResults.length} message${searchResults.length === 1 ? '' : 's'} matched`}
            </Text>
            <View style={styles.searchNavButtons}>
              <TouchableOpacity
                style={[styles.searchNavBtn, searchResults.length === 0 && styles.searchNavBtnDisabled]}
                onPress={() => cycleSearchResult(-1)}
                disabled={searchResults.length === 0}
              >
                <MaterialCommunityIcons name="chevron-up" size={18} color={COLORS.primaryBlue} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.searchNavBtn, searchResults.length === 0 && styles.searchNavBtnDisabled]}
                onPress={() => cycleSearchResult(1)}
                disabled={searchResults.length === 0}
              >
                <MaterialCommunityIcons name="chevron-down" size={18} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      <SyncStatusBanner
        state={syncBannerContract}
        outcomeText={syncBannerOutcomeText}
        lastSyncAt={lastSuccessfulSyncAt}
        onRetry={() => handleManualSync({ retryFailedOnly: true })}
        retryLabel="Retry failed actions"
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoidingContainer}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Loading State */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primaryBlue} />
            <Text style={styles.loadingText}>Loading messages...</Text>
          </View>
        ) : (
          <>
            {/* Messages List */}
            <FlatList
              ref={messageListRef}
              contentContainerStyle={[
                styles.messagesScrollContainer,
                { paddingBottom: listBottomSpacerHeight },
              ]}
              data={groupedMessages}
              keyExtractor={keyExtractor}
              renderItem={renderMessageRow}
              ListEmptyComponent={renderEmptyMessages}
              getItemLayout={getItemLayout}
              removeClippedSubviews
              initialNumToRender={20}
              maxToRenderPerBatch={20}
              windowSize={10}
              onContentSizeChange={() => {
                if (isAtBottom) scrollToBottom(false);
              }}
              ListFooterComponent={<View style={{ height: Math.max(SPACING.sm, insets.bottom) }} />}
              onScroll={handleScroll}
              scrollEventThrottle={100}
              showsVerticalScrollIndicator={false}
              onScrollToIndexFailed={({ index }) => {
                const fallbackOffset = Math.max(index * ESTIMATED_MESSAGE_ROW_HEIGHT - 80, 0);
                messageListRef.current?.scrollToOffset({ offset: fallbackOffset, animated: true });
              }}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                  colors={[COLORS.primaryBlue]}
                  tintColor={COLORS.primaryBlue}
                />
              }
            />

            {/* Typing Indicator */}
            <TypingIndicator typingUsers={typingUsers} />

            {/* New Messages Banner */}
            <NewMessagesBanner
              count={newMessagesCount}
              onPress={() => {
                scrollToBottom(true);
                setNewMessagesCount(0);
              }}
            />

            {showJumpToUnread && (
              <TouchableOpacity style={styles.jumpToUnreadFab} onPress={jumpToUnread} activeOpacity={0.85}>
                <MaterialCommunityIcons name="message-badge" size={20} color={COLORS.white} />
                <Text style={styles.jumpToUnreadFabText}>Jump to unread</Text>
              </TouchableOpacity>
            )}

            {/* Attachment Menu */}
            <AttachmentMenu
              visible={showAttachmentMenu}
              onClose={() => setShowAttachmentMenu(false)}
              onPickImage={handlePickImage}
              onTakePhoto={handleTakePhoto}
            />

            {/* Input Area */}
            <View style={[styles.inputDock, { paddingBottom: composerBottomInset }]}>
              <View
                style={styles.inputArea}
                onLayout={(event) => {
                  const nextHeight = Math.ceil(event.nativeEvent.layout.height + composerBottomInset);
                  setComposerHeight((prev) => (prev === nextHeight ? prev : nextHeight));
                }}
              >
                {draftRestored && (
                  <View style={styles.draftBadge}>
                    <MaterialCommunityIcons name="content-save-edit-outline" size={14} color={COLORS.primaryBlue} />
                    <Text style={styles.draftBadgeText}>Draft restored</Text>
                  </View>
                )}

                <TouchableOpacity
                  style={styles.attachButton}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setShowAttachmentMenu(!showAttachmentMenu);
                  }}
                  activeOpacity={0.7}
                >
                  <MaterialCommunityIcons
                    name={showAttachmentMenu ? 'close' : 'plus-circle'}
                    size={28}
                    color={showAttachmentMenu ? COLORS.secondaryText : COLORS.primaryBlue}
                  />
                </TouchableOpacity>

                <TextInput
                  style={[
                    styles.textInput,
                    { height: Math.min(Math.max(44, inputHeight), 120) },
                  ]}
                  placeholder="Type your message..."
                  placeholderTextColor={COLORS.tertiaryText}
                  value={inputText}
                  onChangeText={handleTextChange}
                  multiline
                  onContentSizeChange={(event) =>
                    setInputHeight(event.nativeEvent.contentSize.height)
                  }
                  selectionColor={COLORS.primaryBlue}
                  editable={!sending && !uploadingImage}
                  blurOnSubmit={false}
                />

                <TouchableOpacity
                  style={[
                    styles.sendButton,
                    (sending || uploadingImage || !inputText.trim()) && styles.sendButtonDisabled,
                  ]}
                  onPress={handleSendMessage}
                  activeOpacity={0.7}
                  disabled={sending || uploadingImage || !inputText.trim()}
                >
                  {sending || uploadingImage ? (
                    <ActivityIndicator size="small" color={COLORS.sendButtonColor} />
                  ) : (
                    <MaterialCommunityIcons
                      name="send-circle"
                      size={38}
                      color={
                        inputText.trim() === '' ? COLORS.tertiaryText : COLORS.sendButtonColor
                      }
                    />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </KeyboardAvoidingView>

      {/* Modals */}
      <MessageActionMenu
        visible={showActionMenu}
        onClose={() => {
          setShowActionMenu(false);
          setSelectedMessage(null);
        }}
        message={selectedMessage}
        onCopy={handleCopyMessage}
        onReact={() => {
          setShowActionMenu(false);
          setShowReactionPicker(true);
        }}
        onDelete={handleDeleteMessage}
        canDelete={selectedMessage?.senderId === currentUser?.uid || isDriver}
      />

      <ReactionPicker
        visible={showReactionPicker}
        onClose={() => {
          setShowReactionPicker(false);
          setSelectedMessage(null);
        }}
        onSelectReaction={(emoji) => {
          if (selectedMessage) {
            handleReaction(selectedMessage.id, emoji);
          }
        }}
      />

      <ImageViewerModal
        visible={!!viewingImage}
        imageUrl={viewingImage}
        onClose={() => setViewingImage(null)}
      />
    </SafeAreaView>
  );
}

// ==================== STYLES ====================
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.chatScreenBackground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: Platform.OS === 'ios' ? SPACING.md : SPACING.lg,
    borderBottomLeftRadius: RADIUS.xl,
    borderBottomRightRadius: RADIUS.xl,
    ...SHADOWS.md,
  },
  headerButton: {
    width: 96,
    padding: SPACING.xs,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  headerTitleContainer: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: COLORS.white,
    letterSpacing: 0.2,
  },
  headerRight: {
    width: 108,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  syncNowBtn: {
    width: 28,
    height: 28,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  onlineIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  onlineCount: {
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '600',
  },
  refreshStatusContainer: {
    borderBottomWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  refreshStatusSuccess: {
    backgroundColor: THEME.sync.success.background,
    borderBottomColor: THEME.sync.success.border,
  },
  refreshStatusWarning: {
    backgroundColor: THEME.sync.warning.background,
    borderBottomColor: THEME.sync.warning.border,
  },
  refreshStatusError: {
    backgroundColor: THEME.sync.critical.background,
    borderBottomColor: THEME.sync.critical.border,
  },
  refreshStatusText: {
    color: THEME.sync.info.foregroundMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  refreshStatusActionText: {
    marginTop: 2,
    fontSize: 11,
    color: THEME.sync.info.foreground,
    fontWeight: '700',
  },
  keyboardAvoidingContainer: {
    flex: 1,
  },
  searchPanel: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.white,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    backgroundColor: COLORS.appBackground,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.darkText,
    paddingVertical: 2,
  },
  searchMetaRow: {
    marginTop: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  searchMetaText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '600',
  },
  searchNavButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  searchNavBtn: {
    width: 30,
    height: 30,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${COLORS.primaryBlue}15`,
  },
  searchNavBtnDisabled: {
    opacity: 0.45,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xxl,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: COLORS.secondaryText,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.darkText,
    marginTop: 16,
  },
  errorSubtext: {
    fontSize: 14,
    color: COLORS.secondaryText,
    marginTop: 4,
  },

  // Empty State
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 32,
  },
  emptyIconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: SPACING.xl,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.sm,
  },
  emptyText: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.darkText,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 15,
    color: COLORS.secondaryText,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  emptyTips: {
    flexDirection: 'row',
    gap: SPACING.xl,
  },
  emptyTip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.white,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.lg,
    ...SHADOWS.sm,
  },
  emptyTipText: {
    fontSize: 14,
    color: COLORS.darkText,
    fontWeight: '500',
  },

  // Messages
  messagesScrollContainer: {
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
    flexGrow: 1,
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: SPACING.sm,
  },
  myMessageRow: {
    justifyContent: 'flex-end',
  },
  theirMessageRow: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    paddingVertical: SPACING.sm + 2,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg,
  },
  myMessageBubble: {
    backgroundColor: COLORS.myMessageBackground,
    borderBottomRightRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: `${COLORS.primaryDark}40`,
  },
  theirMessageBubble: {
    backgroundColor: COLORS.theirMessageBackground,
    borderBottomLeftRadius: RADIUS.sm,
    ...SHADOWS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  driverMessageBubble: {
    backgroundColor: COLORS.driverMessageBackground,
    borderColor: COLORS.driverMessageBorder,
    borderWidth: 1.5,
  },
  imageMessageBubble: {
    padding: 4,
    maxWidth: '70%',
  },
  deletedMessageBubble: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.secondaryText,
    borderStyle: 'dashed',
  },
  deletedMessageText: {
    color: COLORS.secondaryText,
    fontStyle: 'italic',
    fontSize: 14,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  senderName: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primaryBlue,
  },
  mySenderName: {
    color: COLORS.lightBlueAccent,
  },
  driverSenderName: {
    color: COLORS.coralAccent,
  },
  driverBadge: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: COLORS.coralMuted,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.driverMessageBorder,
  },
  driverBadgeText: {
    color: COLORS.coralAccent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 21,
    color: COLORS.darkText,
  },
  myMessageText: {
    color: COLORS.white,
  },
  messageFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    gap: 4,
  },
  timestamp: {
    fontSize: 11,
    color: COLORS.secondaryText,
    opacity: 0.8,
  },
  myTimestamp: {
    color: COLORS.lightBlueAccent,
    opacity: 0.9,
  },
  messageStatus: {
    marginLeft: 2,
  },
  searchFocusedBubble: {
    borderColor: COLORS.coralAccent,
    borderWidth: 2,
  },
  searchHighlight: {
    backgroundColor: `${COLORS.coralAccent}40`,
    color: COLORS.darkText,
    fontWeight: '700',
  },
  searchHighlightSelf: {
    backgroundColor: `${COLORS.white}50`,
    color: COLORS.white,
  },

  // Links
  linkInMessage: {
    color: COLORS.linkColor,
    textDecorationLine: 'underline',
  },
  linkInMessageSelf: {
    color: COLORS.lightBlueAccent,
  },
  linkPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${COLORS.primaryBlue}10`,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs + 2,
    borderRadius: RADIUS.md,
    marginTop: SPACING.sm,
    gap: 6,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}20`,
  },
  linkText: {
    flex: 1,
    color: COLORS.linkColor,
    fontSize: 13,
  },

  // Image Message
  imageMessageContainer: {
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    marginVertical: 4,
  },
  messageImage: {
    width: SCREEN_WIDTH * 0.55,
    height: SCREEN_WIDTH * 0.55,
    borderRadius: RADIUS.md,
  },
  imageLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    width: SCREEN_WIDTH * 0.55,
    height: SCREEN_WIDTH * 0.55,
    borderRadius: RADIUS.md,
  },
  imageError: {
    width: SCREEN_WIDTH * 0.55,
    height: SCREEN_WIDTH * 0.35,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: RADIUS.md,
  },
  imageErrorText: {
    color: COLORS.secondaryText,
    marginTop: 8,
    fontSize: 13,
  },

  // Reactions
  reactionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
    gap: 4,
  },
  reactionBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.reactionBackground,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}12`,
  },
  reactionBubbleActive: {
    backgroundColor: `${COLORS.primaryBlue}20`,
    borderColor: COLORS.primaryBlue,
  },
  reactionEmoji: {
    fontSize: 14,
  },
  reactionCount: {
    fontSize: 12,
    color: COLORS.darkText,
    marginLeft: 4,
    fontWeight: '600',
  },
  reactionCountActive: {
    color: COLORS.primaryBlue,
  },

  // Date Separator
  dateSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.lg,
    paddingHorizontal: SPACING.lg,
  },
  dateSeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  dateSeparatorBadge: {
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
    borderRadius: RADIUS.full,
    marginHorizontal: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dateSeparatorText: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '600',
  },

  // Unread Separator

  unreadSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
  },
  unreadSeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.coralAccent,
    opacity: 0.5,
  },
  unreadSeparatorBadge: {
    backgroundColor: COLORS.coralMuted,
    borderWidth: 1,
    borderColor: COLORS.driverMessageBorder,
    paddingHorizontal: SPACING.md,
    paddingVertical: 4,
    borderRadius: RADIUS.full,
    marginHorizontal: SPACING.sm,
  },
  unreadSeparatorText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9A3412',
  },

  // Typing Indicator
  typingContainer: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    borderRadius: RADIUS.lg,
    alignSelf: 'flex-start',
    ...SHADOWS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  typingDots: {
    flexDirection: 'row',
    marginRight: 8,
    gap: 3,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.typingIndicator,
  },
  typingText: {
    fontSize: 13,
    color: COLORS.typingIndicator,
    fontStyle: 'italic',
  },

  // New Messages Banner
  newMessagesBanner: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.newMessageBanner,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.full,
    ...SHADOWS.md,
    gap: 6,
    borderWidth: 1,
    borderColor: `${COLORS.coralAccent}70`,
  },
  newMessagesBannerText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
  },


  jumpToUnreadFab: {
    position: 'absolute',
    bottom: 132,
    right: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.primaryBlue,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.md,
  },
  jumpToUnreadFabText: {
    color: COLORS.white,
    fontSize: 13,
    fontWeight: '700',
  },

  // Input Area
  inputDock: {
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    ...SHADOWS.md,
  },
  inputArea: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.sm,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
  },
  draftBadge: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 10,
  },
  draftBadgeText: {
    color: COLORS.primaryBlue,
    fontSize: 12,
    fontWeight: '600',
  },
  attachButton: {
    padding: SPACING.xs + 2,
    marginRight: 4,
    marginBottom: 4,
    borderRadius: RADIUS.full,
    backgroundColor: `${COLORS.primaryBlue}08`,
  },
  textInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 22,
    paddingHorizontal: SPACING.lg,
    paddingVertical: 10,
    paddingTop: 12,
    fontSize: 16,
    color: COLORS.darkText,
    marginRight: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sendButton: {
    padding: 2,
    marginBottom: 2,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },

  // Attachment Menu
  attachmentMenu: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: COLORS.white,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.xl,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
  },
  attachmentOption: {
    alignItems: 'center',
    gap: 8,
  },
  attachmentIconBg: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  attachmentLabel: {
    fontSize: 13,
    color: COLORS.darkText,
    fontWeight: '500',
  },

  // Modals
  reactionModalOverlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reactionPicker: {
    flexDirection: 'row',
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.xl,
    padding: SPACING.sm,
    ...SHADOWS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  reactionOption: {
    padding: 10,
  },
  reactionOptionEmoji: {
    fontSize: 28,
  },
  actionMenuOverlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionMenu: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.lg,
    paddingVertical: 8,
    width: 200,
    ...SHADOWS.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  actionMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 14,
  },
  actionMenuItemDanger: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    marginTop: 4,
    paddingTop: 18,
  },
  actionMenuText: {
    fontSize: 16,
    color: COLORS.darkText,
    fontWeight: '500',
  },

  // Image Viewer
  imageViewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 10,
  },
  fullScreenImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_WIDTH,
  },
});
