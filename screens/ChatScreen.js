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
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
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
import { uploadPhoto } from '../services/photoService';
import { createPersistenceProvider } from '../services/persistenceProvider';
import offlineSyncService from '../services/offlineSyncService';
import * as bookingService from '../services/bookingServiceRealtime';
import * as chatService from '../services/chatService';
import { auth } from '../firebase';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS } from '../theme';
import SyncStatusBanner from '../components/SyncStatusBanner';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Quick Reaction Emojis
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

// URL Detection Regex
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

// Brand Colors
const COLORS = {
  primaryBlue: THEME.primary,
  lightBlueAccent: '#93C5FD',
  coralAccent: THEME.accent,
  white: THEME.white,
  darkText: THEME.textPrimary,
  secondaryText: THEME.textSecondary,
  appBackground: THEME.background,
  chatScreenBackground: '#EFF6FF',
  myMessageBackground: THEME.primary,
  theirMessageBackground: THEME.white,
  driverMessageBackground: THEME.accentLight,
  driverMessageBorder: '#FDBA74',
  inputBackground: THEME.white,
  sendButtonColor: THEME.accent,
  chatHeaderColor: THEME.success,
  onlineIndicator: '#22C55E',
  offlineIndicator: '#94A3B8',
  typingIndicator: '#64748B',
  linkColor: '#2563EB',
  reactionBackground: 'rgba(0,0,0,0.05)',
  newMessageBanner: THEME.accent,
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
const MessageReactions = ({ reactions, onReactionPress, messageId }) => {
  if (!reactions || Object.keys(reactions).length === 0) return null;

  return (
    <View style={styles.reactionsContainer}>
      {Object.entries(reactions).map(([emoji, users]) => {
        if (!users || users.length === 0) return null;
        return (
          <TouchableOpacity
            key={emoji}
            style={styles.reactionBubble}
            onPress={() => onReactionPress(messageId, emoji)}
            activeOpacity={0.7}
          >
            <Text style={styles.reactionEmoji}>{emoji}</Text>
            <Text style={styles.reactionCount}>{users.length}</Text>
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
        <View style={[styles.attachmentIconBg, { backgroundColor: '#DBEAFE' }]}>
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
        <View style={[styles.attachmentIconBg, { backgroundColor: '#FEE2E2' }]}>
          <MaterialCommunityIcons name="camera" size={24} color={THEME.error} />
        </View>
        <Text style={styles.attachmentLabel}>Camera</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.attachmentOption}
        onPress={onClose}
        activeOpacity={0.7}
      >
        <View style={[styles.attachmentIconBg, { backgroundColor: '#F1F5F9' }]}>
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

  // Modal state
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [viewingImage, setViewingImage] = useState(null);

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

  // Refs
  const scrollViewRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const syncBannerTimeoutRef = useRef(null);
  const lastMessageCountRef = useRef(0);
  const lastReadMarkAtRef = useRef(0);
  const messageOffsetsRef = useRef({});

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
      scrollViewRef.current?.scrollToEnd({ animated });
    });
  }, []);

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

  const handleManualSync = useCallback(async () => {
    try {
      const beforeStatsResult = await offlineSyncService.getQueueStats();
      const beforeStats = beforeStatsResult?.success
        ? beforeStatsResult.data
        : { pending: 0, failed: 0, syncing: 0, total: 0 };

      const replayResult = await offlineSyncService.replayQueue({ services: { bookingService, chatService } });
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
  }, [refreshQueueStats, showQueueSyncOutcome]);

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
      allowsEditing: true,
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
      allowsEditing: true,
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
        const uploadResult = await uploadPhoto(
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

      await toggleReaction(tourId, messageId, emoji, currentUser.uid);
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

      const replayResult = await offlineSyncService.replayQueue({ services: { bookingService, chatService } });
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
        groups.push({ type: 'date', date: msgTimestamp ?? msg.timestamp });
        currentDate = msgDate;
      }

      if (!unreadInjected && unreadAnchorMessageId && msg.id === unreadAnchorMessageId) {
        groups.push({ type: 'unread-separator', id: `unread-${msg.id}` });
        unreadInjected = true;
      }

      groups.push({ type: 'message', data: msg });
    });

    return groups;
  }, [messages, unreadAnchorMessageId]);

  const showJumpToUnread = useMemo(() => {
    if (!unreadAnchorMessageId || unreadAnchorY == null) return false;
    return Math.abs(currentScrollY - unreadAnchorY) > 180;
  }, [unreadAnchorMessageId, unreadAnchorY, currentScrollY]);

  const jumpToUnread = useCallback(() => {
    if (unreadAnchorY == null) return;
    scrollViewRef.current?.scrollTo({ y: Math.max(unreadAnchorY - 80, 0), animated: true });
  }, [unreadAnchorY]);

  // Render a single message
  const renderMessage = useCallback(
    (msg) => {
      const isSelf = msg.senderId === currentUser?.uid;
      const isMsgDriver = !!msg.isDriver;
      const isDeleted = !!msg.deleted;
      const isImage = msg.type === 'image';

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
                      <Text key={index}>{part.content}</Text>
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
              />
            </View>
          </View>
        </Pressable>
      );
    },
    [currentUser?.uid, formatTime, handleMessageLongPress, handleReaction, parseMessageText]
  );

  // Error state
  if (!tourId) {
    return (
      <SafeAreaView style={styles.safeArea}>
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
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <LinearGradient
        colors={[COLORS.chatHeaderColor, '#059669']}
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
          {tourData?.name && <Text style={styles.headerSubtitle}>{tourData.name}</Text>}
        </View>

        <View style={styles.headerRight}>
          <View style={styles.onlineIndicator}>
            <View style={[styles.onlineDot, { backgroundColor: COLORS.onlineIndicator }]} />
            <Text style={styles.onlineCount}>
              {presenceInfo.onlineCount} online
            </Text>
          </View>
          <TouchableOpacity style={styles.syncNowBtn} onPress={handleManualSync}>
            <Text style={styles.syncNowText}>Pending {queueStats.pending}</Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      <SyncStatusBanner
        state={syncBannerContract}
        outcomeText={syncBannerOutcomeText}
        lastSyncAt={lastSuccessfulSyncAt}
        onRetry={handleManualSync}
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
            <ScrollView
              ref={scrollViewRef}
              contentContainerStyle={styles.messagesScrollContainer}
              onContentSizeChange={() => {
                if (isAtBottom) scrollToBottom(false);
              }}
              onScroll={handleScroll}
              scrollEventThrottle={100}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                  colors={[COLORS.primaryBlue]}
                  tintColor={COLORS.primaryBlue}
                />
              }
            >
              {groupedMessages.length === 0 ? (
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
              ) : (
                <>
                  {groupedMessages.map((item, index) => {
                    if (item.type === 'date') {
                      return <DateSeparator key={`date-${index}`} date={item.date} />;
                    }

                    if (item.type === 'unread-separator') {
                      return <UnreadSeparator key={item.id} />;
                    }

                    const messageId = item.data?.id;
                    return (
                      <View
                        key={messageId || `message-${index}`}
                        onLayout={(event) => {
                          if (!messageId) return;
                          const y = event.nativeEvent.layout.y;
                          messageOffsetsRef.current[messageId] = y;
                          if (messageId === unreadAnchorMessageId) {
                            setUnreadAnchorY(y);
                          }
                        }}
                      >
                        {renderMessage(item.data)}
                      </View>
                    );
                  })}
                </>
              )}
            </ScrollView>

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
            <View style={styles.inputArea}>
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
                placeholderTextColor="#A0AEC0"
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
                      inputText.trim() === '' ? '#CBD5E0' : COLORS.sendButtonColor
                    }
                  />
                )}
              </TouchableOpacity>
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
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 15,
    ...SHADOWS.md,
  },
  headerButton: {
    padding: 5,
    minWidth: 40,
    alignItems: 'center',
  },
  headerTitleContainer: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.white,
  },
  headerSubtitle: {
    fontSize: 12,
    color: COLORS.white,
    opacity: 0.85,
    marginTop: 2,
  },
  headerRight: {
    minWidth: 80,
    alignItems: 'flex-end',
  },
  onlineIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
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
    backgroundColor: '#ECFDF5',
    borderBottomColor: '#A7F3D0',
  },
  refreshStatusWarning: {
    backgroundColor: '#FFFBEB',
    borderBottomColor: '#FDE68A',
  },
  refreshStatusError: {
    backgroundColor: '#FEF2F2',
    borderBottomColor: '#FECACA',
  },
  refreshStatusText: {
    color: '#1F2937',
    fontSize: 12,
    fontWeight: '600',
  },
  refreshStatusActionText: {
    marginTop: 2,
    fontSize: 11,
    color: '#1D4ED8',
    fontWeight: '700',
  },
  keyboardAvoidingContainer: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
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
    marginBottom: 20,
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
    gap: 24,
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
    paddingVertical: 15,
    paddingHorizontal: 12,
    flexGrow: 1,
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  myMessageRow: {
    justifyContent: 'flex-end',
  },
  theirMessageRow: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: RADIUS.lg,
  },
  myMessageBubble: {
    backgroundColor: COLORS.myMessageBackground,
    borderBottomRightRadius: 4,
  },
  theirMessageBubble: {
    backgroundColor: COLORS.theirMessageBackground,
    borderBottomLeftRadius: 4,
    ...SHADOWS.sm,
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
    backgroundColor: '#FFE1CE',
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

  // Links
  linkInMessage: {
    color: COLORS.linkColor,
    textDecorationLine: 'underline',
  },
  linkInMessageSelf: {
    color: '#93C5FD',
  },
  linkPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(37, 99, 235, 0.08)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    marginTop: 8,
    gap: 6,
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
    backgroundColor: '#F1F5F9',
    width: SCREEN_WIDTH * 0.55,
    height: SCREEN_WIDTH * 0.55,
    borderRadius: RADIUS.md,
  },
  imageError: {
    width: SCREEN_WIDTH * 0.55,
    height: SCREEN_WIDTH * 0.35,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F1F5F9',
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

  // Date Separator
  dateSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
    paddingHorizontal: 16,
  },
  dateSeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#CBD5E1',
  },
  dateSeparatorBadge: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginHorizontal: 12,
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
    backgroundColor: '#FFF7ED',
    borderWidth: 1,
    borderColor: '#FDBA74',
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
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: RADIUS.lg,
    alignSelf: 'flex-start',
    ...SHADOWS.sm,
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
    borderRadius: 20,
    ...SHADOWS.md,
    gap: 6,
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
  inputArea: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    backgroundColor: COLORS.white,
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
    padding: 6,
    marginRight: 4,
    marginBottom: 4,
  },
  textInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: '#F1F5F9',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingTop: 12,
    fontSize: 16,
    color: COLORS.darkText,
    marginRight: 8,
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
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
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
  },
  attachmentLabel: {
    fontSize: 13,
    color: COLORS.darkText,
    fontWeight: '500',
  },

  // Modals
  reactionModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reactionPicker: {
    flexDirection: 'row',
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.xl,
    padding: 8,
    ...SHADOWS.lg,
  },
  reactionOption: {
    padding: 10,
  },
  reactionOptionEmoji: {
    fontSize: 28,
  },
  actionMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionMenu: {
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.lg,
    paddingVertical: 8,
    width: 200,
    ...SHADOWS.xl,
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
    borderTopColor: '#F1F5F9',
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
    backgroundColor: 'rgba(0,0,0,0.95)',
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
