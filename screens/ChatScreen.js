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
  PanResponder,
  Platform,
  Pressable,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
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
  getChatMessagesPage,
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
import logger, { maskIdentifier } from '../services/loggerService';
import {
  recordBreadcrumb,
  summarizeUri,
} from '../services/crashDiagnosticsService';
import {
  getCanonicalIdentity,
  isRealtimeKeySegment,
  resolveRealtimeActorId,
  toRealtimeKeySegment,
} from '../services/identityService';
import { COLORS as THEME, SPACING, RADIUS, SHADOWS } from '../theme';
import SyncStatusBanner from '../components/SyncStatusBanner';
const { buildChatSearchResults, normalizeSearchQuery } = require('../utils/chatSearch');
const { buildUnreadSummary } = require('../utils/chatUnreadSummary');
const {
  buildReplyTargetIndex,
  collectMessageIdCandidates,
  resolveReplyTargetIndex,
} = require('../utils/chatReplyNavigation');
const {
  buildChatTimelineItems,
  formatChatTimestamp,
  getOldestMessageCursor,
  mergeMessagesById,
} = require('../utils/chatTimeline');
const {
  getSwipeReplyDragState,
  shouldStartSwipeReplyGesture,
  shouldTriggerSwipeReplyOnRelease,
} = require('../services/chatSwipeReplyGesture');

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Quick Reaction Emojis
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const HEART_REACTION = QUICK_REACTIONS[1];
const DOUBLE_TAP_REACTION_DELAY_MS = 300;
const ESTIMATED_MESSAGE_ROW_HEIGHT = 120;
const SEARCH_RESULT_PREVIEW_LIMIT = 3;
const CATCH_UP_BUBBLE_DISTANCE_THRESHOLD = 220;
const SWIPE_REPLY_HINT_KEY_PREFIX = 'swipe_reply_hint_seen';
const SCROLL_BOTTOM_THRESHOLD = 16;
const LIVE_CHAT_MESSAGE_LIMIT = 80;
const CHAT_PAGE_MESSAGE_LIMIT = 40;

const SEARCH_FILTERS = [
  { key: 'all', label: 'All', icon: 'message-text-outline' },
  { key: 'drivers', label: 'Drivers', icon: 'steering' },
  { key: 'mine', label: 'Mine', icon: 'account' },
  { key: 'links', label: 'Links', icon: 'link-variant' },
  { key: 'media', label: 'Photos', icon: 'image-outline' },
];

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

const isMessageOwnedByCurrentSession = (message, canonicalIdentity) => {
  const currentPrincipalType = typeof canonicalIdentity?.principalType === 'string'
    ? canonicalIdentity.principalType.trim()
    : '';
  const currentStableId = typeof canonicalIdentity?.stablePassengerId === 'string'
    ? canonicalIdentity.stablePassengerId.trim()
    : '';
  const senderPrincipalId = typeof message?.senderId === 'string' ? message.senderId.trim() : '';
  const currentPrincipalId = typeof canonicalIdentity?.principalId === 'string'
    ? canonicalIdentity.principalId.trim()
    : '';
  const senderStableId = typeof message?.senderStableId === 'string' ? message.senderStableId.trim() : '';
  const senderType = typeof message?.senderType === 'string'
    ? message.senderType.trim()
    : (message?.isDriver ? 'driver' : 'passenger');

  if (currentPrincipalType === 'passenger' && currentStableId) {
    if (senderStableId) {
      return senderStableId === currentStableId;
    }

    if (senderType === 'passenger' && senderPrincipalId === currentStableId) {
      return true;
    }
    return false;
  }

  if (senderPrincipalId && currentPrincipalId && senderType !== 'passenger') {
    return senderPrincipalId === currentPrincipalId;
  }

  return Boolean(senderPrincipalId && currentPrincipalId && senderPrincipalId === currentPrincipalId);
};

const buildReplyPreviewText = (message = {}) => {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'image') {
    const caption = typeof message.text === 'string' ? message.text.trim() : '';
    return caption ? `📷 ${caption}` : '📷 Photo';
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  return text.length > 0 ? text : 'Message';
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
  const normalizedUserIds = new Set();

  if (Array.isArray(users)) {
    users.forEach((userId) => {
      if (typeof userId !== 'string') return;
      const trimmedUserId = userId.trim();
      if (!trimmedUserId) return;
      normalizedUserIds.add(trimmedUserId);
    });
  } else if (users && typeof users === 'object') {
    Object.entries(users).forEach(([userId, reacted]) => {
      if (reacted !== true || typeof userId !== 'string') return;
      const trimmedUserId = userId.trim();
      if (!trimmedUserId) return;
      normalizedUserIds.add(trimmedUserId);
    });
  } else {
    return [];
  }

  return Array.from(normalizedUserIds).sort((a, b) => a.localeCompare(b));
};

const normalizeReactionMap = (reactions) => {
  if (!reactions || typeof reactions !== 'object') return {};

  return Object.entries(reactions).reduce((accumulator, [emoji, users]) => {
    if (typeof emoji !== 'string') return accumulator;
    const sanitizedEmoji = emoji.trim();
    if (!sanitizedEmoji) return accumulator;

    const normalizedUsers = getReactionUserIds(users);
    if (normalizedUsers.length > 0) {
      accumulator[sanitizedEmoji] = normalizedUsers;
    }
    return accumulator;
  }, {});
};

const maskReactionDebugIds = (ids = []) => (
  (Array.isArray(ids) ? ids : [])
    .filter(Boolean)
    .slice(0, 10)
    .map(maskIdentifier)
);

const rawReactionDebugIds = (ids = []) => (
  (Array.isArray(ids) ? ids : [])
    .filter(Boolean)
    .slice(0, 10)
);

const summarizeReactionMapForDebug = (reactions, currentUserIds = []) => {
  const normalizedReactions = normalizeReactionMap(reactions);
  const currentUserIdSet = new Set(currentUserIds.filter(Boolean));
  const entries = Object.entries(normalizedReactions);

  return {
    emojiCount: entries.length,
    totalReactionUsers: entries.reduce((total, [, userIds]) => total + userIds.length, 0),
    sample: entries.slice(0, 6).map(([emoji, userIds]) => ({
      emoji,
      userCount: userIds.length,
      maskedUserIds: maskReactionDebugIds(userIds),
      rawUserKeys: rawReactionDebugIds(userIds),
      currentUserPresent: userIds.some((userId) => currentUserIdSet.has(userId)),
      truncated: userIds.length > 10,
    })),
  };
};

const summarizeMessagesForReactionDebug = (messages = [], currentUserIds = []) => {
  const messageSummaries = (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      messageId: message?.id || null,
      ...summarizeReactionMapForDebug(message?.reactions, currentUserIds),
    }))
    .filter((summary) => summary.emojiCount > 0);

  return {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    reactionMessageCount: messageSummaries.length,
    reactionMessageSample: messageSummaries.slice(0, 5),
  };
};

const summarizeImageAssetForDiagnostics = (asset = {}) => ({
  uri: summarizeUri(asset?.uri),
  width: typeof asset?.width === 'number' ? asset.width : null,
  height: typeof asset?.height === 'number' ? asset.height : null,
  fileSize: typeof asset?.fileSize === 'number' ? asset.fileSize : null,
  mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
  assetIdPresent: Boolean(asset?.assetId),
});

const summarizeErrorForDiagnostics = (error) => ({
  name: error?.name || 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
  message: error?.message || String(error),
});

const logChatReactionDebug = (eventName, payload = {}, level = 'info') => {
  try {
    const persistLevel = level === 'error' ? 'error' : 'warn';
    const loggerMethod = typeof logger?.[persistLevel] === 'function' ? persistLevel : 'warn';
    logger[loggerMethod]('ChatScreen', eventName, payload);
  } catch (error) {
    // Debug logging should never affect chat behavior.
  }

  try {
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[consoleMethod](`[ReactionDebug] [ChatScreen] ${eventName}`, payload);
  } catch (error) {
    // no-op
  }
};

const applyOptimisticReactionToggle = ({ reactions, emoji, userId, userIdAliases = [] }) => {
  const normalizedReactions = normalizeReactionMap(reactions);
  const existingUserIds = Array.isArray(normalizedReactions[emoji]) ? normalizedReactions[emoji] : [];
  const reactionUserIds = new Set([userId, ...userIdAliases].filter(Boolean));
  const matchedUserIds = existingUserIds.filter((existingUserId) => reactionUserIds.has(existingUserId));
  const hasReaction = matchedUserIds.length > 0;

  const nextEmojiUserIds = hasReaction
    ? existingUserIds.filter((existingUserId) => !reactionUserIds.has(existingUserId))
    : [...existingUserIds, userId].sort((a, b) => a.localeCompare(b));

  const nextReactions = { ...normalizedReactions };
  if (nextEmojiUserIds.length === 0) {
    delete nextReactions[emoji];
  } else {
    nextReactions[emoji] = nextEmojiUserIds;
  }

  return {
    nextReactions,
    action: hasReaction ? 'removed' : 'added',
    matchedUserIds,
    nextEmojiUserIds,
  };
};

const applyOptimisticReactionAdd = ({ reactions, emoji, userId, userIdAliases = [] }) => {
  const normalizedReactions = normalizeReactionMap(reactions);
  const existingUserIds = Array.isArray(normalizedReactions[emoji]) ? normalizedReactions[emoji] : [];
  const reactionUserIds = new Set([userId, ...userIdAliases].filter(Boolean));
  const matchedUserIds = existingUserIds.filter((existingUserId) => reactionUserIds.has(existingUserId));
  const hasReaction = matchedUserIds.length > 0;
  const nextEmojiUserIds = hasReaction
    ? existingUserIds
    : [...existingUserIds, userId].sort((a, b) => a.localeCompare(b));

  return {
    nextReactions: {
      ...normalizedReactions,
      [emoji]: nextEmojiUserIds,
    },
    action: hasReaction ? 'already_added' : 'added',
    matchedUserIds,
    nextEmojiUserIds,
  };
};

const MessageReactions = ({ reactions, onReactionPress, messageId, currentUserId, currentUserIds = [] }) => {
  if (!reactions || Object.keys(reactions).length === 0) return null;

  const visibleReactions = Object.entries(reactions)
    .map(([emoji, users]) => ({ emoji, userIds: getReactionUserIds(users) }))
    .filter(({ userIds }) => userIds.length > 0);

  if (visibleReactions.length === 0) return null;
  const currentUserIdSet = new Set([currentUserId, ...currentUserIds].filter(Boolean));

  return (
    <View style={styles.reactionsContainer}>
      {visibleReactions.map(({ emoji, userIds }) => {
        const reactedByCurrentUser = userIds.some((userId) => currentUserIdSet.has(userId));
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
const MessageActionMenu = ({
  visible,
  onClose,
  message,
  onCopy,
  onReply,
  onReact,
  onOpenReactionPicker,
  onDelete,
  onCopyLink,
  onOpenLink,
  canDelete,
  insets,
}) => {
  if (!visible) return null;

  const safePreview = buildReplyPreviewText(message).slice(0, 120);
  const normalizedMessageTime = normalizeTimestamp(message?.timestamp);
  const messageTimeLabel = normalizedMessageTime
    ? new Date(normalizedMessageTime).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
    : 'Unknown time';
  const firstLinkMatch = typeof message?.text === 'string' ? message.text.match(URL_REGEX) : null;
  const hasLink = Array.isArray(firstLinkMatch) && firstLinkMatch.length > 0;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.actionMenuOverlay} onPress={onClose}>
        <Pressable
          style={[styles.actionMenuSheet, { paddingBottom: Math.max(insets?.bottom || 0, SPACING.md) }]}
          onPress={() => {}}
        >
          <View style={styles.actionMenuHandle} />
          <View style={styles.actionMessagePreviewCard}>
            <View style={styles.actionMessagePreviewHeader}>
              <Text style={styles.actionMessageSender} numberOfLines={1}>
                {message?.senderName || 'Tour Participant'}
              </Text>
              <Text style={styles.actionMessageTime}>{messageTimeLabel}</Text>
            </View>
            <Text style={styles.actionMessagePreviewText} numberOfLines={3}>
              {safePreview || 'Message'}
            </Text>
          </View>

          <View style={styles.actionQuickReactionRow}>
            {QUICK_REACTIONS.map((emoji) => (
              <TouchableOpacity
                key={`quick-reaction-${emoji}`}
                style={styles.actionQuickReaction}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onReact(emoji);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.actionQuickReactionEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.actionQuickReaction}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onOpenReactionPicker();
              }}
              activeOpacity={0.7}
            >
              <MaterialCommunityIcons name="dots-horizontal" size={20} color={COLORS.secondaryText} />
            </TouchableOpacity>
          </View>

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
              onReply();
            }}
          >
            <MaterialCommunityIcons name="reply-outline" size={22} color={COLORS.darkText} />
            <Text style={styles.actionMenuText}>Reply</Text>
          </TouchableOpacity>

          {hasLink && (
            <>
              <TouchableOpacity
                style={styles.actionMenuItem}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onOpenLink();
                }}
              >
                <MaterialCommunityIcons name="open-in-new" size={22} color={COLORS.darkText} />
                <Text style={styles.actionMenuText}>Open Link</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionMenuItem}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onCopyLink();
                }}
              >
                <MaterialCommunityIcons name="link-variant" size={22} color={COLORS.darkText} />
                <Text style={styles.actionMenuText}>Copy Link</Text>
              </TouchableOpacity>
            </>
          )}

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
        </Pressable>
      </Pressable>
    </Modal>
  );
};

// ==================== IMAGE MESSAGE COMPONENT ====================
const ImageMessage = React.memo(({ imageUrl, onPress }) => {
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
          source={{ uri: imageUrl, cache: 'force-cache' }}
          style={styles.messageImage}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setError(true);
          }}
          progressiveRenderingEnabled
          fadeDuration={120}
          resizeMode="cover"
        />
      )}
    </TouchableOpacity>
  );
});

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
      case 'queued':
        return <MaterialCommunityIcons name="check" size={14} color={COLORS.lightBlueAccent} />;
      case 'sent':
        return <MaterialCommunityIcons name="check-all" size={14} color={COLORS.lightBlueAccent} />;
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
const NewMessagesBanner = ({ count, onPress, bottomOffset }) => {
  if (count === 0) return null;

  return (
    <TouchableOpacity
      style={[styles.newMessagesBanner, typeof bottomOffset === 'number' ? { bottom: bottomOffset } : null]}
      onPress={onPress}
      activeOpacity={0.9}
    >
      <MaterialCommunityIcons name="arrow-down" size={16} color={COLORS.white} />
      <Text style={styles.newMessagesBannerText}>
        {count} new message{count > 1 ? 's' : ''}
      </Text>
    </TouchableOpacity>
  );
};

const UnreadCatchUpCard = ({ summary, onJumpToUnread, onJumpToLatest, bottomOffset }) => {
  if (!summary || !summary.count) return null;

  return (
    <View style={[styles.catchUpCard, typeof bottomOffset === 'number' ? { bottom: bottomOffset } : null]}>
      <View style={styles.catchUpCardHeader}>
        <MaterialCommunityIcons name="chat-alert-outline" size={18} color={COLORS.primaryBlue} />
        <Text style={styles.catchUpCardTitle}>
          {summary.count} unread message{summary.count > 1 ? 's' : ''}
        </Text>
      </View>
      <Text style={styles.catchUpCardBody}>
        Latest from <Text style={styles.catchUpCardBodyStrong}>{summary.latestSender}</Text>
        {summary.latestRelativeLabel ? ` · ${summary.latestRelativeLabel}` : ''}
      </Text>
      <View style={styles.catchUpActions}>
        <TouchableOpacity style={styles.catchUpButtonSecondary} onPress={onJumpToUnread} activeOpacity={0.85}>
          <Text style={styles.catchUpButtonSecondaryText}>First unread</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.catchUpButtonPrimary} onPress={onJumpToLatest} activeOpacity={0.85}>
          <Text style={styles.catchUpButtonPrimaryText}>Latest</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const SwipeReplyHint = ({ visible, onDismiss }) => {
  if (!visible) return null;

  return (
    <TouchableOpacity style={styles.swipeReplyHint} activeOpacity={0.92} onPress={onDismiss}>
      <MaterialCommunityIcons name="gesture-swipe-right" size={16} color={COLORS.primaryBlue} />
      <Text style={styles.swipeReplyHintText}>Tip: swipe a message right to reply quickly.</Text>
      <MaterialCommunityIcons name="close" size={14} color={COLORS.secondaryText} />
    </TouchableOpacity>
  );
};

const SwipeToReplyMessageWrapper = ({ children, onSwipeReply, disabled = false }) => {
  const { width: windowWidth } = useWindowDimensions();
  const translateX = useRef(new Animated.Value(0)).current;
  const feedbackScale = useRef(new Animated.Value(0.9)).current;
  const feedbackOpacity = useRef(new Animated.Value(0)).current;
  const triggerLatchRef = useRef(false);
  const readyToReplyRef = useRef(false);
  const peakDragRef = useRef(0);
  const [isReadyToReply, setIsReadyToReply] = useState(false);

  const setReadyToReply = useCallback((isReady, shouldPulse = false) => {
    if (isReady === readyToReplyRef.current) return;

    readyToReplyRef.current = isReady;
    setIsReadyToReply(isReady);
    if (isReady && shouldPulse) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, []);

  const resetToOrigin = useCallback(({ unlockTrigger = true } = {}) => {
    Animated.parallel([
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        speed: 26,
        bounciness: 4,
      }),
      Animated.timing(feedbackOpacity, {
        toValue: 0,
        duration: 120,
        useNativeDriver: true,
      }),
      Animated.timing(feedbackScale, {
        toValue: 0.9,
        duration: 120,
        useNativeDriver: true,
      }),
    ]).start(() => {
      if (unlockTrigger) {
        triggerLatchRef.current = false;
      }
      readyToReplyRef.current = false;
      peakDragRef.current = 0;
      setIsReadyToReply(false);
    });
  }, [translateX, feedbackOpacity, feedbackScale]);

  const triggerSwipeReply = useCallback((resetOptions = {}) => {
    if (triggerLatchRef.current) return;

    triggerLatchRef.current = true;
    readyToReplyRef.current = true;
    setIsReadyToReply(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    resetToOrigin(resetOptions);
    onSwipeReply?.();
  }, [onSwipeReply, resetToOrigin]);

  const panResponder = useMemo(() => PanResponder.create({
    onPanResponderGrant: () => {
      translateX.stopAnimation();
      feedbackOpacity.stopAnimation();
      feedbackScale.stopAnimation();
      translateX.setValue(0);
      feedbackOpacity.setValue(0);
      feedbackScale.setValue(0.9);
      triggerLatchRef.current = false;
      readyToReplyRef.current = false;
      peakDragRef.current = 0;
      setIsReadyToReply(false);
    },
    onMoveShouldSetPanResponder: (_event, gestureState) => {
      return shouldStartSwipeReplyGesture(gestureState, { disabled });
    },
    onMoveShouldSetPanResponderCapture: (_event, gestureState) => {
      return shouldStartSwipeReplyGesture(gestureState, { disabled });
    },
    onPanResponderMove: (_event, gestureState) => {
      if (triggerLatchRef.current) return;

      const dragState = getSwipeReplyDragState(gestureState, {
        screenWidth: windowWidth || SCREEN_WIDTH,
        peakDragX: peakDragRef.current,
      });

      peakDragRef.current = dragState.peakDragX;
      translateX.setValue(dragState.dragX);
      feedbackOpacity.setValue(0.18 + dragState.progress * 0.82);
      feedbackScale.setValue(0.9 + dragState.progress * 0.12);
      setReadyToReply(dragState.isReleaseReady, true);

      if (dragState.shouldSnapActivate) {
        triggerSwipeReply({ unlockTrigger: false });
      }
    },
    onPanResponderRelease: (_event, gestureState) => {
      if (triggerLatchRef.current) {
        resetToOrigin({ unlockTrigger: true });
        return;
      }

      if (shouldTriggerSwipeReplyOnRelease(gestureState, { peakDragX: peakDragRef.current })) {
        triggerSwipeReply({ unlockTrigger: true });
        return;
      }

      resetToOrigin({ unlockTrigger: true });
    },
    onPanResponderTerminate: () => resetToOrigin({ unlockTrigger: true }),
    onPanResponderTerminationRequest: () => false,
  }), [
    disabled,
    feedbackOpacity,
    feedbackScale,
    resetToOrigin,
    setReadyToReply,
    translateX,
    triggerSwipeReply,
    windowWidth,
  ]);

  const feedbackColor = isReadyToReply ? THEME.success : COLORS.primaryBlue;

  return (
    <View style={styles.swipeReplyRowContainer}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.swipeReplyFeedback,
          isReadyToReply && styles.swipeReplyFeedbackReady,
          { opacity: feedbackOpacity, transform: [{ scale: feedbackScale }] },
        ]}
      >
        <MaterialCommunityIcons
          name={isReadyToReply ? 'reply' : 'reply-outline'}
          size={16}
          color={feedbackColor}
        />
        <Text style={[styles.swipeReplyFeedbackText, isReadyToReply && styles.swipeReplyFeedbackTextReady]}>
          {isReadyToReply ? 'Reply ready' : 'Reply'}
        </Text>
      </Animated.View>
      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
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

const AttachmentTray = AttachmentMenu;
const ChatActionSheet = MessageActionMenu;

const ChatHeader = React.memo(({
  internalDriverChat,
  isSearchOpen,
  onBack,
  onToggleSearch,
  onSync,
  onlineCount,
  queueStats,
}) => (
  <LinearGradient
    colors={internalDriverChat ? [COLORS.primaryDark, COLORS.primaryBlue] : [COLORS.primaryBlue, COLORS.primaryLight]}
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 1 }}
    style={styles.header}
  >
    <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7} hitSlop={8}>
      <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
    </TouchableOpacity>

    <View style={styles.headerTitleContainer}>
      <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.84}>
        {internalDriverChat ? 'Driver Chat' : 'Group Chat'}
      </Text>
      <View style={styles.onlineIndicator}>
        <View style={[styles.onlineDot, { backgroundColor: COLORS.onlineIndicator }]} />
        <Text style={styles.onlineCount}>{onlineCount} online</Text>
      </View>
    </View>

    <View style={styles.headerRight}>
      <TouchableOpacity
        style={styles.syncNowBtn}
        onPress={onToggleSearch}
        accessibilityRole="button"
        accessibilityLabel="Search chat messages"
        hitSlop={8}
      >
        <MaterialCommunityIcons name={isSearchOpen ? 'close' : 'magnify'} size={18} color={COLORS.white} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.syncNowBtn}
        onPress={onSync}
        accessibilityRole="button"
        accessibilityLabel={queueStats.pending > 0 || queueStats.syncing > 0 ? 'Sync pending' : 'Messages sent'}
        hitSlop={8}
      >
        <MaterialCommunityIcons
          name={queueStats.pending > 0 || queueStats.syncing > 0 ? 'check' : 'check-all'}
          size={18}
          color={COLORS.white}
        />
      </TouchableOpacity>
    </View>
  </LinearGradient>
));

const ChatFeedbackHost = React.memo(({
  syncState,
  syncOutcomeText,
  lastSuccessfulSyncAt,
  onRetrySync,
  reactionFeedbackMessage,
  replyJumpFeedbackMessage,
  transientFeedback,
  imageSendState,
  onRetryImage,
  draftRestored,
}) => {
  const feedbackRows = [];

  if (reactionFeedbackMessage) {
    feedbackRows.push({
      key: 'reaction',
      type: 'error',
      icon: 'wifi-alert',
      message: reactionFeedbackMessage,
    });
  }

  if (replyJumpFeedbackMessage) {
    feedbackRows.push({
      key: 'reply-jump',
      type: 'info',
      icon: 'message-alert-outline',
      message: replyJumpFeedbackMessage,
    });
  }

  if (transientFeedback?.message) {
    feedbackRows.push({
      key: 'transient',
      type: transientFeedback.type || 'info',
      icon: transientFeedback.icon || 'information-outline',
      message: transientFeedback.message,
    });
  }

  if (draftRestored) {
    feedbackRows.push({
      key: 'draft',
      type: 'info',
      icon: 'content-save-edit-outline',
      message: 'Draft restored',
    });
  }

  if (imageSendState?.status && imageSendState.status !== 'idle') {
    feedbackRows.push({
      key: 'image',
      type: imageSendState.status === 'failed' ? 'error' : imageSendState.status === 'success' ? 'success' : 'info',
      icon: imageSendState.status === 'failed' ? 'alert-circle-outline' : imageSendState.status === 'success' ? 'check-circle-outline' : 'image',
      message: imageSendState.message || 'Sending photo...',
      actionLabel: imageSendState.status === 'failed' && imageSendState.retryUri ? 'Retry' : '',
      onAction: imageSendState.status === 'failed' ? onRetryImage : null,
      loading: imageSendState.status === 'uploading',
    });
  }

  if (!syncState && feedbackRows.length === 0) return null;

  return (
    <View style={styles.feedbackHost}>
      {syncState ? (
        <SyncStatusBanner
          state={syncState}
          outcomeText={syncOutcomeText}
          lastSyncAt={lastSuccessfulSyncAt}
          onRetry={syncState?.canRetry ? onRetrySync : null}
          compact
        />
      ) : null}
      {feedbackRows.map((item) => (
        <View
          key={item.key}
          style={[
            styles.feedbackPill,
            item.type === 'error' && styles.feedbackPillError,
            item.type === 'success' && styles.feedbackPillSuccess,
          ]}
        >
          {item.loading ? (
            <ActivityIndicator size="small" color={COLORS.primaryBlue} />
          ) : (
            <MaterialCommunityIcons
              name={item.icon}
              size={16}
              color={item.type === 'error' ? THEME.error : item.type === 'success' ? THEME.success : COLORS.primaryBlue}
            />
          )}
          <Text
            style={[
              styles.feedbackPillText,
              item.type === 'error' && styles.feedbackPillTextError,
              item.type === 'success' && styles.feedbackPillTextSuccess,
            ]}
          >
            {item.message}
          </Text>
          {item.actionLabel && item.onAction ? (
            <TouchableOpacity style={styles.feedbackPillAction} onPress={item.onAction} activeOpacity={0.8}>
              <Text style={styles.feedbackPillActionText}>{item.actionLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ))}
    </View>
  );
});

const ChatLoadingSkeleton = () => (
  <View style={styles.skeletonContainer}>
    {[0, 1, 2, 3, 4, 5].map((item) => (
      <View
        key={`chat-skeleton-${item}`}
        style={[
          styles.skeletonRow,
          item % 3 === 2 ? styles.skeletonRowSelf : styles.skeletonRowOther,
        ]}
      >
        <View style={[styles.skeletonBubble, item % 2 === 0 && styles.skeletonBubbleWide]} />
      </View>
    ))}
  </View>
);

const LoadOlderControl = React.memo(({ visible, loading, onPress }) => {
  if (!visible) return null;

  return (
    <TouchableOpacity
      style={styles.loadOlderButton}
      onPress={onPress}
      activeOpacity={0.86}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel={loading ? 'Loading older messages' : 'Load older messages'}
    >
      {loading ? (
        <ActivityIndicator size="small" color={COLORS.primaryBlue} />
      ) : (
        <MaterialCommunityIcons name="chevron-up" size={18} color={COLORS.primaryBlue} />
      )}
      <Text style={styles.loadOlderButtonText}>{loading ? 'Loading older messages' : 'Load older messages'}</Text>
    </TouchableOpacity>
  );
});

const ChatFloatingJump = React.memo(({
  mode,
  count,
  summary,
  bottomOffset,
  onJumpToUnread,
  onJumpToLatest,
}) => {
  if (mode === 'unread' && summary?.count) {
    return (
      <TouchableOpacity
        style={[styles.floatingJumpCard, typeof bottomOffset === 'number' ? { bottom: bottomOffset } : null]}
        onPress={onJumpToUnread}
        activeOpacity={0.9}
      >
        <View style={styles.floatingJumpHeader}>
          <MaterialCommunityIcons name="chat-alert-outline" size={18} color={COLORS.primaryBlue} />
          <Text style={styles.floatingJumpTitle}>
            {summary.count} unread message{summary.count > 1 ? 's' : ''}
          </Text>
        </View>
        <Text style={styles.floatingJumpBody} numberOfLines={1}>
          Latest from {summary.latestSender}{summary.latestRelativeLabel ? ` - ${summary.latestRelativeLabel}` : ''}
        </Text>
        <View style={styles.floatingJumpActions}>
          <Text style={styles.floatingJumpActionText}>Jump to unread</Text>
          <TouchableOpacity
            style={styles.floatingJumpLatest}
            onPress={onJumpToLatest}
            activeOpacity={0.8}
          >
            <Text style={styles.floatingJumpLatestText}>Latest</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  }

  if (mode === 'new' && count > 0) {
    return (
      <TouchableOpacity
        style={[styles.floatingJumpPill, typeof bottomOffset === 'number' ? { bottom: bottomOffset } : null]}
        onPress={onJumpToLatest}
        activeOpacity={0.9}
      >
        <MaterialCommunityIcons name="arrow-down" size={16} color={COLORS.white} />
        <Text style={styles.floatingJumpPillText}>
          {count} new message{count > 1 ? 's' : ''}
        </Text>
      </TouchableOpacity>
    );
  }

  return null;
});

const MessageBubble = React.memo(({
  message,
  presentation,
  activeSearchResultMessageId,
  highlightedReplyTargetMessageId,
  currentUserId,
  currentUserIds,
  canRetry,
  isRetrying,
  onRetry,
  onLongPress,
  onReactionPress,
  onDoubleTapReaction,
  onOpenImage,
  onJumpToMessage,
  renderHighlightedText,
  formatTime,
  parseMessageText,
}) => {
  const isSelf = Boolean(presentation?.isOwnMessage);
  const isMsgDriver = !!message?.isDriver;
  const isDeleted = !!message?.deleted;
  const isImage = message?.type === 'image';
  const isSearchMatch = !!activeSearchResultMessageId && activeSearchResultMessageId === message?.id;
  const isReplyJumpTarget = !!highlightedReplyTargetMessageId && highlightedReplyTargetMessageId === message?.id;
  const lastTapAtRef = useRef(0);
  const longPressTriggeredRef = useRef(false);

  const handlePress = useCallback(() => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      lastTapAtRef.current = 0;
      return;
    }

    if (!onDoubleTapReaction || !message?.id) return;

    const now = Date.now();
    if (now - lastTapAtRef.current <= DOUBLE_TAP_REACTION_DELAY_MS) {
      lastTapAtRef.current = 0;
      onDoubleTapReaction(message.id, HEART_REACTION);
      return;
    }

    lastTapAtRef.current = now;
  }, [message?.id, onDoubleTapReaction]);

  const handleLongPress = useCallback(() => {
    longPressTriggeredRef.current = true;
    lastTapAtRef.current = 0;
    onLongPress(message);
  }, [message, onLongPress]);

  if (isDeleted) {
    return (
      <View style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}>
        <View style={[styles.messageBubble, styles.deletedMessageBubble]}>
          <Text style={styles.deletedMessageText}>
            <MaterialCommunityIcons name="cancel" size={14} color={COLORS.secondaryText} />
            {' This message was deleted'}
          </Text>
        </View>
      </View>
    );
  }

  const textParts = parseMessageText(message?.text);
  const hasLink = textParts.some((part) => part.type === 'link');
  const clusterPosition = presentation?.clusterPosition || 'single';
  const showSender = Boolean(presentation?.showSender);
  const hasReplyReference = Boolean(message?.replyTo?.messageId);

  return (
    <Pressable onPress={handlePress} onLongPress={handleLongPress} delayLongPress={300}>
      <View style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}>
        <View
          style={[
            styles.messageBubble,
            isSelf ? styles.myMessageBubble : styles.theirMessageBubble,
            isSelf && clusterPosition === 'first' && styles.myMessageBubbleClusterFirst,
            isSelf && clusterPosition === 'middle' && styles.myMessageBubbleClusterMiddle,
            isSelf && clusterPosition === 'last' && styles.myMessageBubbleClusterLast,
            !isSelf && clusterPosition === 'first' && styles.theirMessageBubbleClusterFirst,
            !isSelf && clusterPosition === 'middle' && styles.theirMessageBubbleClusterMiddle,
            !isSelf && clusterPosition === 'last' && styles.theirMessageBubbleClusterLast,
            isMsgDriver && !isSelf && styles.driverMessageBubble,
            isImage && styles.imageMessageBubble,
            hasReplyReference && styles.messageBubbleWithReply,
            isSearchMatch && styles.searchFocusedBubble,
            isReplyJumpTarget && styles.replyJumpTargetBubble,
          ]}
        >
          {showSender && (
            <View style={styles.messageHeader}>
              <Text
                numberOfLines={1}
                style={[
                  styles.senderName,
                  isMsgDriver && !isSelf && styles.driverSenderName,
                ]}
              >
                {message?.senderName || 'Participant'}
              </Text>
              {isMsgDriver && (
                <View style={styles.driverBadge}>
                  <Text style={styles.driverBadgeText}>DRIVER</Text>
                </View>
              )}
            </View>
          )}

          {message?.replyTo?.messageId && (
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.replyReferenceCard, isSelf && styles.replyReferenceCardSelf]}
              onPress={() => onJumpToMessage(message.replyTo.messageId, message.replyTo.idempotencyKey)}
            >
              <View style={styles.replyReferenceAccent} />
              <View style={styles.replyReferenceContent}>
                <Text
                  numberOfLines={1}
                  style={[styles.replyReferenceSender, isSelf && styles.replyReferenceSenderSelf]}
                >
                  {message.replyTo.senderName || 'Participant'}
                </Text>
                <Text
                  numberOfLines={2}
                  style={[styles.replyReferencePreview, isSelf && styles.replyReferencePreviewSelf]}
                >
                  {message.replyTo.previewText || 'Message'}
                </Text>
              </View>
              <MaterialCommunityIcons
                name="arrow-top-right"
                size={14}
                color={isSelf ? COLORS.lightBlueAccent : COLORS.secondaryText}
              />
            </TouchableOpacity>
          )}

          {isImage && message?.imageUrl && (
            <ImageMessage
              imageUrl={message.imageUrl}
              onPress={() => onOpenImage(message.imageUrl)}
            />
          )}

          {!!message?.text && (
            <Text style={[styles.messageText, isSelf && styles.myMessageText]}>
              {textParts.map((part, index) => (
                part.type === 'link' ? (
                  <Text
                    key={`${message.id}-link-${index}`}
                    style={[styles.linkInMessage, isSelf && styles.linkInMessageSelf]}
                    onPress={() => Linking.openURL(part.content)}
                  >
                    {part.content}
                  </Text>
                ) : (
                  <Text key={`${message.id}-text-${index}`}>{renderHighlightedText(part.content, isSelf)}</Text>
                )
              ))}
            </Text>
          )}

          {hasLink && !isSelf && (
            <LinkPreview url={textParts.find((p) => p.type === 'link')?.content || ''} />
          )}

          <View style={styles.messageFooter}>
            <Text style={[styles.timestamp, isSelf && styles.myTimestamp]}>
              {formatTime(message?.timestamp)}
            </Text>
            <MessageStatus status={message?.status} isSelf={isSelf} />
          </View>

          {canRetry && (
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.failedMessageRetryChip, isRetrying && styles.failedMessageRetryChipDisabled]}
              onPress={() => onRetry(message)}
              disabled={isRetrying}
              accessibilityRole="button"
              accessibilityLabel={isRetrying ? 'Retrying message' : 'Retry sending failed message'}
            >
              {isRetrying ? (
                <ActivityIndicator size="small" color={COLORS.white} />
              ) : (
                <MaterialCommunityIcons name="refresh" size={14} color={COLORS.white} />
              )}
              <Text style={styles.failedMessageRetryText}>
                {isRetrying ? 'Retrying...' : 'Tap to retry'}
              </Text>
            </TouchableOpacity>
          )}

          <MessageReactions
            reactions={message?.reactions}
            onReactionPress={onReactionPress}
            messageId={message?.id}
            currentUserId={currentUserId}
            currentUserIds={currentUserIds}
          />
        </View>
      </View>
    </Pressable>
  );
});

const MessageRow = React.memo(({
  item,
  unreadAnchorMessageId,
  onRowLayout,
  onSwipeReply,
  ...bubbleProps
}) => {
  if (item.type === 'date') return <DateSeparator date={item.date} />;
  if (item.type === 'unread-separator') return <UnreadSeparator />;

  const messageId = item.data?.id;
  return (
    <View
      onLayout={(event) => {
        if (!messageId) return;
        onRowLayout(messageId, event.nativeEvent.layout);
      }}
    >
      <SwipeToReplyMessageWrapper
        onSwipeReply={() => onSwipeReply(item.data)}
        disabled={!!item.data?.deleted}
      >
        <MessageBubble
          message={item.data}
          presentation={item.presentation}
          {...bubbleProps}
        />
      </SwipeToReplyMessageWrapper>
    </View>
  );
});

const ChatTimeline = React.memo(({
  loading,
  messageListRef,
  groupedMessages,
  keyExtractor,
  renderMessageRow,
  renderEmptyMessages,
  listBottomSpacerHeight,
  onLayout,
  onContentSizeChange,
  onScroll,
  onScrollBeginDrag,
  onScrollToIndexFailed,
  refreshing,
  onRefresh,
  hasMoreHistory,
  loadingOlderMessages,
  onLoadOlderMessages,
}) => {
  if (loading) {
    return <ChatLoadingSkeleton />;
  }

  return (
    <FlatList
      ref={messageListRef}
      contentContainerStyle={styles.messagesScrollContainer}
      data={groupedMessages}
      keyExtractor={keyExtractor}
      renderItem={renderMessageRow}
      ListEmptyComponent={renderEmptyMessages}
      ListHeaderComponent={(
        <LoadOlderControl
          visible={hasMoreHistory && groupedMessages.length > 0}
          loading={loadingOlderMessages}
          onPress={onLoadOlderMessages}
        />
      )}
      removeClippedSubviews={Platform.OS === 'android'}
      initialNumToRender={20}
      maxToRenderPerBatch={12}
      updateCellsBatchingPeriod={24}
      windowSize={7}
      onLayout={onLayout}
      onContentSizeChange={onContentSizeChange}
      ListFooterComponent={<View style={{ height: listBottomSpacerHeight }} />}
      onScroll={onScroll}
      onScrollBeginDrag={onScrollBeginDrag}
      scrollEventThrottle={16}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      onScrollToIndexFailed={onScrollToIndexFailed}
      refreshControl={(
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[COLORS.primaryBlue]}
          tintColor={COLORS.primaryBlue}
        />
      )}
    />
  );
});

const ChatComposer = React.memo(({
  composerBottomInset,
  inputHeight,
  inputText,
  sending,
  replyingToMessage,
  showAttachmentMenu,
  onComposerLayout,
  onCancelReply,
  onToggleAttachments,
  onTextChange,
  onInputContentSizeChange,
  onSendMessage,
}) => (
  <View
    style={[styles.inputDock, { paddingBottom: composerBottomInset }]}
    onLayout={onComposerLayout}
  >
    <View style={styles.inputArea}>
      {replyingToMessage?.messageId && (
        <View style={styles.replyComposerCard}>
          <View style={styles.replyComposerAccent} />
          <View style={styles.replyComposerBody}>
            <Text numberOfLines={1} style={styles.replyComposerTitle}>
              Replying to {replyingToMessage.senderName || 'Participant'}
            </Text>
            <Text numberOfLines={1} style={styles.replyComposerPreview}>
              {replyingToMessage.previewText || 'Message'}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.replyComposerClose}
            onPress={onCancelReply}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
          >
            <MaterialCommunityIcons name="close" size={16} color={COLORS.secondaryText} />
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.composerInputRow}>
        <TouchableOpacity
          style={styles.attachButton}
          onPress={onToggleAttachments}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={showAttachmentMenu ? 'Close attachments' : 'Open attachments'}
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
          onChangeText={onTextChange}
          multiline
          onContentSizeChange={onInputContentSizeChange}
          selectionColor={COLORS.primaryBlue}
          editable
          blurOnSubmit={false}
        />

        <TouchableOpacity
          style={[
            styles.sendButton,
            (sending || !inputText.trim()) && styles.sendButtonDisabled,
          ]}
          onPress={onSendMessage}
          activeOpacity={0.7}
          disabled={sending || !inputText.trim()}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          {sending ? (
            <ActivityIndicator size="small" color={COLORS.sendButtonColor} />
          ) : (
            <MaterialCommunityIcons
              name="send-circle"
              size={38}
              color={inputText.trim() === '' ? COLORS.tertiaryText : COLORS.sendButtonColor}
            />
          )}
        </TouchableOpacity>
      </View>
    </View>
  </View>
));

// ==================== MAIN CHAT SCREEN ====================
export default function ChatScreen({
  onBack,
  tourId,
  bookingData,
  tourData,
  internalDriverChat = false,
  identityBinding: identityBindingProp = null,
  canonicalIdentity: canonicalIdentityProp = null,
}) {
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
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [transientFeedback, setTransientFeedback] = useState(null);

  // Feature state
  const [typingUsers, setTypingUsers] = useState([]);
  const [presenceInfo, setPresenceInfo] = useState({ onlineCount: 0, totalCount: 0, users: [] });
  const [newMessagesCount, setNewMessagesCount] = useState(0);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [imageSendState, setImageSendState] = useState({ status: 'idle', message: '', retryUri: null });
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState(null);
  const [unreadAnchorY, setUnreadAnchorY] = useState(null);
  const [showJumpToUnread, setShowJumpToUnread] = useState(false);
  const [replyingToMessage, setReplyingToMessage] = useState(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilter, setSearchFilter] = useState('all');
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const [showSwipeReplyHint, setShowSwipeReplyHint] = useState(false);
  const [retryingMessageIds, setRetryingMessageIds] = useState({});

  // Modal state
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [viewingImage, setViewingImage] = useState(null);
  const [reactionFeedbackMessage, setReactionFeedbackMessage] = useState('');
  const [replyJumpFeedbackMessage, setReplyJumpFeedbackMessage] = useState('');
  const [highlightedReplyTargetMessageId, setHighlightedReplyTargetMessageId] = useState(null);

  const insets = useSafeAreaInsets();
  const composerBottomInset = insets.bottom > 0 ? Math.max(insets.bottom, SPACING.md) : SPACING.md;
  const currentUser = auth.currentUser;
  const { identityBinding, identityBindingSource } = useMemo(() => {
    const hasIdentityBindingProp = identityBindingProp && typeof identityBindingProp === 'object';
    const sourceBinding = hasIdentityBindingProp
      ? identityBindingProp
      : (bookingData?.identityBinding && typeof bookingData.identityBinding === 'object'
        ? bookingData.identityBinding
        : {});
    const rawStablePassengerId = sourceBinding?.stablePassengerId || bookingData?.stablePassengerId || null;
    const normalizedStablePassengerId = typeof rawStablePassengerId === 'string'
      ? rawStablePassengerId.trim()
      : '';

    return {
      identityBinding: {
        ...sourceBinding,
        stablePassengerId: normalizedStablePassengerId || null,
      },
      identityBindingSource: hasIdentityBindingProp ? 'prop' : 'bookingData_fallback',
    };
  }, [identityBindingProp, bookingData?.identityBinding, bookingData?.stablePassengerId]);
  const isDriver = bookingData?.isDriver === true;
  const canonicalIdentity = useMemo(
    () => canonicalIdentityProp || getCanonicalIdentity({
      authUser: currentUser,
      bookingData,
      identityBinding,
    }),
    [canonicalIdentityProp, currentUser, bookingData, identityBinding]
  );
  const principalId = canonicalIdentity?.principalId || 'anonymous';
  const passengerStableId = canonicalIdentity?.stablePassengerId || null;
  const authUid = canonicalIdentity?.authUid || currentUser?.uid || null;
  const realtimeActorId = useMemo(
    () => resolveRealtimeActorId({ authUid, principalId }) || principalId,
    [authUid, principalId]
  );
  const currentReactionUserIds = useMemo(() => {
    const candidates = [
      realtimeActorId,
      principalId,
      passengerStableId,
      authUid,
      toRealtimeKeySegment(principalId),
      toRealtimeKeySegment(passengerStableId),
    ];

    return Array.from(new Set(candidates.filter(Boolean)));
  }, [authUid, passengerStableId, principalId, realtimeActorId]);
  const userName = bookingData?.passengerNames?.[0] || 'Tour Participant';
  useEffect(() => {
    logChatReactionDebug('chat_reaction_actor_context', {
      tourId,
      principalIdMasked: maskIdentifier(principalId),
      passengerStableIdMasked: maskIdentifier(passengerStableId),
      authUidMasked: maskIdentifier(authUid),
      realtimeActorIdMasked: maskIdentifier(realtimeActorId),
      realtimeActorDiffersFromPrincipal: realtimeActorId !== principalId,
      principalKeyIsRealtimeSafe: isRealtimeKeySegment(principalId),
      stableKeyIsRealtimeSafe: passengerStableId ? isRealtimeKeySegment(passengerStableId) : null,
      realtimeActorKeyIsRealtimeSafe: isRealtimeKeySegment(realtimeActorId),
      aliasCount: currentReactionUserIds.length,
      aliasIdsMasked: maskReactionDebugIds(currentReactionUserIds),
      aliasKeys: rawReactionDebugIds(currentReactionUserIds),
      principalKey: principalId,
      stablePassengerKey: passengerStableId,
      reactionActorKey: realtimeActorId,
    });
  }, [authUid, currentReactionUserIds, passengerStableId, principalId, realtimeActorId, tourId]);
  const requiresPassengerStableIdForWrites = !isDriver
    && canonicalIdentity?.principalType === 'passenger'
    && principalId !== 'anonymous';
  const logSenderIdentityPath = useCallback(() => {
    if (canonicalIdentity?.principalType === 'driver') {
      logger.info('ChatScreen', 'chat_sender_driver_principal_used', {
        tourId,
        source: identityBindingSource,
      });
      return;
    }

    if (passengerStableId) {
      logger.info('ChatScreen', 'chat_sender_stable_id_used', {
        tourId,
        source: identityBindingSource,
      });
      return;
    }

    logger.info('ChatScreen', 'chat_sender_uid_fallback_used', {
      tourId,
      source: identityBindingSource,
      currentUserUidPresent: Boolean(currentUser?.uid),
    });
  }, [canonicalIdentity?.principalType, passengerStableId, tourId, identityBindingSource, currentUser?.uid]);

  const buildChatSenderInfo = useCallback(() => ({
    name: userName,
    userId: principalId,
    principalId,
    principalType: canonicalIdentity?.principalType || (isDriver ? 'driver' : 'passenger'),
    isDriver,
    ...(authUid ? { authUid } : {}),
    ...(passengerStableId ? { stablePassengerId: passengerStableId, senderStableId: passengerStableId } : {}),
  }), [authUid, canonicalIdentity?.principalType, isDriver, passengerStableId, principalId, userName]);
  const traceChatImageSend = useCallback((event, data = {}) => {
    recordBreadcrumb('ChatImage', event, {
      tourId,
      chatScope: internalDriverChat ? 'internal' : 'group',
      principalType: canonicalIdentity?.principalType || (isDriver ? 'driver' : 'passenger'),
      isDriver,
      hasAuthUid: Boolean(authUid),
      authUidMasked: maskIdentifier(authUid),
      principalIdMasked: maskIdentifier(principalId),
      passengerStableIdMasked: maskIdentifier(passengerStableId),
      hasPassengerStableId: Boolean(passengerStableId),
      requiresPassengerStableIdForWrites,
      principalKeyIsRealtimeSafe: isRealtimeKeySegment(principalId),
      stableKeyIsRealtimeSafe: passengerStableId ? isRealtimeKeySegment(passengerStableId) : null,
      ...data,
    }, {
      remote: true,
      reason: `ChatImage:${event}`,
    });
  }, [
    authUid,
    canonicalIdentity?.principalType,
    internalDriverChat,
    isDriver,
    passengerStableId,
    principalId,
    requiresPassengerStableIdForWrites,
    tourId,
  ]);
  const draftStorage = useMemo(() => createPersistenceProvider({ namespace: 'LLT_CHAT_DRAFTS' }), []);
  const readStateStorage = useMemo(() => createPersistenceProvider({ namespace: 'LLT_CHAT_READ_STATE' }), []);
  const uxHintStorage = useMemo(() => createPersistenceProvider({ namespace: 'LLT_CHAT_UX_HINTS' }), []);
  const draftStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `draft_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);
  const readStateStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `last_seen_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);
  const swipeReplyHintStorageKey = useMemo(() => {
    if (!tourId) return null;
    const chatType = internalDriverChat ? 'internal' : 'group';
    return `${SWIPE_REPLY_HINT_KEY_PREFIX}_${chatType}_${tourId}_${principalId}`;
  }, [tourId, internalDriverChat, principalId]);

  const listBottomSpacerHeight = useMemo(() => {
    const attachmentMenuLift = showAttachmentMenu ? SPACING.sm : 0;
    return SPACING.sm + attachmentMenuLift;
  }, [showAttachmentMenu]);

  const floatingUiBottomInset = useMemo(() => {
    const safeComposerHeight = composerHeight > 0 ? composerHeight : (72 + composerBottomInset);
    const keyboardLift = Platform.OS === 'android' && isKeyboardVisible ? Math.max(keyboardHeight - composerBottomInset, 0) : 0;
    return safeComposerHeight + keyboardLift + SPACING.sm;
  }, [composerHeight, composerBottomInset, isKeyboardVisible, keyboardHeight]);
  const isImageUploading = imageSendState.status === 'uploading';

  // Refs
  const messageListRef = useRef(null);
  const messagesRef = useRef([]);
  const typingTimeoutRef = useRef(null);
  const syncBannerTimeoutRef = useRef(null);
  const transientFeedbackTimeoutRef = useRef(null);
  const lastLiveMessageCursorRef = useRef(null);
  const lastReadMarkAtRef = useRef(0);
  const rowOffsetsRef = useRef({});
  const listViewportHeightRef = useRef(0);
  const listContentHeightRef = useRef(0);
  const preserveScrollAfterPrependRef = useRef(null);
  const reactionFailureTimeoutRef = useRef(null);
  const inFlightReactionKeysRef = useRef(new Set());
  const pendingJumpIndexRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const currentScrollYRef = useRef(0);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const updateUnreadJumpVisibility = useCallback((scrollY, anchorY) => {
    if (anchorY == null) {
      setShowJumpToUnread(false);
      return;
    }
    const shouldShow = Math.abs(scrollY - anchorY) > CATCH_UP_BUBBLE_DISTANCE_THRESHOLD;
    setShowJumpToUnread((prev) => (prev === shouldShow ? prev : shouldShow));
  }, []);

  useEffect(() => {
    console.info('[ChatScreen] identity binding source selected', {
      source: identityBindingSource,
      hasStableBinding: Boolean(identityBinding?.stablePassengerId),
    });
  }, [identityBinding?.stablePassengerId, identityBindingSource]);

  const canRetryFailedMessageForCurrentSession = useCallback((message) => {
    if (!isMessageOwnedByCurrentSession(message, canonicalIdentity)) return false;
    if (!message || typeof message !== 'object') return false;
    if (message.deleted) return false;
    if (message.status !== 'failed') return false;
    if ((message.type || 'text') !== 'text') return false;
    if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
    return true;
  }, [canonicalIdentity]);

  const getMessageTimestamp = useCallback((message) => {
    if (!message) return null;
    return normalizeTimestamp(message.timestamp);
  }, []);

  const markActiveChatRead = useCallback(async ({ force = false } = {}) => {
    if (!tourId || !realtimeActorId) return;

    const now = Date.now();
    if (!force && now - lastReadMarkAtRef.current < 3000) return;
    lastReadMarkAtRef.current = now;

    const markReadFn = internalDriverChat ? markInternalChatAsRead : markChatAsRead;
    const latestMessage = messages[messages.length - 1];
    const latestTimestamp = getMessageTimestamp(latestMessage);
    const result = await markReadFn(tourId, realtimeActorId);

    if (result?.success && latestTimestamp && readStateStorageKey) {
      setLastSeenTimestamp(latestTimestamp);
      setUnreadAnchorY(null);
      await readStateStorage.setItemAsync(readStateStorageKey, String(latestTimestamp));
    }
  }, [
    tourId,
    realtimeActorId,
    internalDriverChat,
    messages,
    getMessageTimestamp,
    readStateStorage,
    readStateStorageKey,
  ]);

  // Scroll to bottom helper
  const scrollToBottom = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      const viewportHeight = listViewportHeightRef.current || 0;
      const contentHeight = listContentHeightRef.current || 0;
      const targetOffset = Math.max(contentHeight - viewportHeight, 0);
      messageListRef.current?.scrollToOffset({ offset: targetOffset, animated });
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
    listViewportHeightRef.current = layoutMeasurement.height;
    listContentHeightRef.current = contentSize.height;
    currentScrollYRef.current = contentOffset.y;
    const isBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - SCROLL_BOTTOM_THRESHOLD;
    isAtBottomRef.current = isBottom;
    setIsAtBottom((prev) => (prev === isBottom ? prev : isBottom));
    updateUnreadJumpVisibility(contentOffset.y, unreadAnchorY);
    if (isBottom) {
      setNewMessagesCount(0);
      markActiveChatRead({ force: true });
    }
  }, [markActiveChatRead, unreadAnchorY, updateUnreadJumpVisibility]);

  const handleScrollBeginDrag = useCallback(() => {
    if (isKeyboardVisible) {
      Keyboard.dismiss();
    }
  }, [isKeyboardVisible]);


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
      lastLiveMessageCursorRef.current = null;
      setMessages([]);
      setHasMoreHistory(false);
      setNewMessagesCount(0);
      setLoading(false);
      return;
    }

    lastLiveMessageCursorRef.current = null;
    setMessages([]);
    setHasMoreHistory(false);
    setNewMessagesCount(0);
    setLoading(true);
    const subscribeFn = internalDriverChat ? subscribeToInternalDriverChat : subscribeToChatMessages;
    const unsubscribe = subscribeFn(tourId, (newMessages) => {
      const reactionSummary = summarizeMessagesForReactionDebug(newMessages, currentReactionUserIds);
      logChatReactionDebug('chat_reaction_subscription_received', {
        tourId,
        chatType: internalDriverChat ? 'internal' : 'group',
        ...reactionSummary,
      });
      setMessages((prevMessages) => mergeMessagesById(prevMessages, newMessages));
      setHasMoreHistory(newMessages.length >= LIVE_CHAT_MESSAGE_LIMIT);
      setLoading(false);

      const latestMessage = newMessages[newMessages.length - 1] || null;
      const latestCursor = latestMessage
        ? `${latestMessage.id || 'unknown'}:${latestMessage.timestamp ?? latestMessage.timestampMs ?? ''}`
        : null;
      const previousCursor = lastLiveMessageCursorRef.current;

      if (!isAtBottomRef.current && previousCursor && latestCursor && latestCursor !== previousCursor) {
        const previousTimestamp = previousCursor.split(':').slice(1).join(':');
        const previousMs = normalizeTimestamp(previousTimestamp);
        const incomingCount = Number.isFinite(previousMs)
          ? newMessages.filter((message) => {
            const messageTs = getMessageTimestamp(message);
            return Number.isFinite(messageTs) && messageTs > previousMs;
          }).length
          : 1;
        setNewMessagesCount((prev) => prev + Math.max(incomingCount, 1));
      }
      lastLiveMessageCursorRef.current = latestCursor;

      // Auto-scroll if at bottom
      if (isAtBottomRef.current) {
        scrollToBottom(true);
      }
    }, undefined, { limit: LIVE_CHAT_MESSAGE_LIMIT });

    return () => unsubscribe();
  }, [tourId, internalDriverChat, scrollToBottom, getMessageTimestamp, currentReactionUserIds]);

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

  useEffect(() => {
    let active = true;
    if (!swipeReplyHintStorageKey) {
      setShowSwipeReplyHint(false);
      return;
    }

    const restoreHintState = async () => {
      try {
        const seenValue = await uxHintStorage.getItemAsync(swipeReplyHintStorageKey);
        if (!active) return;
        setShowSwipeReplyHint(seenValue !== '1');
      } catch (error) {
        if (active) setShowSwipeReplyHint(true);
      }
    };

    restoreHintState();
    return () => {
      active = false;
    };
  }, [swipeReplyHintStorageKey, uxHintStorage]);

  // Mark chat as read when screen opens with a valid user/tour context
  useEffect(() => {
    markActiveChatRead();
  }, [markActiveChatRead]);

  // Subscribe to typing indicators
  useEffect(() => {
    if (!tourId || !realtimeActorId) return;

    const unsubscribe = subscribeToTypingIndicators(tourId, realtimeActorId, setTypingUsers);
    return () => unsubscribe();
  }, [tourId, realtimeActorId]);

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

  const clearReactionFailureTimeout = useCallback(() => {
    if (reactionFailureTimeoutRef.current) {
      clearTimeout(reactionFailureTimeoutRef.current);
      reactionFailureTimeoutRef.current = null;
    }
  }, []);

  const clearTransientFeedbackTimeout = useCallback(() => {
    if (transientFeedbackTimeoutRef.current) {
      clearTimeout(transientFeedbackTimeoutRef.current);
      transientFeedbackTimeoutRef.current = null;
    }
  }, []);

  const showTransientFeedback = useCallback(({ type = 'info', message = '', icon = 'information-outline', autoDismissMs = 3600 } = {}) => {
    if (!message) return;
    clearTransientFeedbackTimeout();
    setTransientFeedback({ type, message, icon });
    if (autoDismissMs > 0) {
      transientFeedbackTimeoutRef.current = setTimeout(() => {
        setTransientFeedback(null);
      }, autoDismissMs);
    }
  }, [clearTransientFeedbackTimeout]);

  const showReactionFailureFeedback = useCallback((message = 'Could not update reaction. Please try again.') => {
    clearReactionFailureTimeout();
    setReactionFeedbackMessage(message);
    reactionFailureTimeoutRef.current = setTimeout(() => {
      setReactionFeedbackMessage('');
    }, 3200);
  }, [clearReactionFailureTimeout]);

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
      clearReactionFailureTimeout();
      clearTransientFeedbackTimeout();
    };
  }, [clearReactionFailureTimeout, clearSyncBannerTimeout, clearTransientFeedbackTimeout]);

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
    if (!tourId || !realtimeActorId) return;

    setOnlinePresence(tourId, realtimeActorId, userName, true, isDriver);

    return () => {
      setOnlinePresence(tourId, realtimeActorId, userName, false, isDriver);
      setTypingStatus(tourId, realtimeActorId, userName, false, isDriver);
    };
  }, [tourId, realtimeActorId, userName, isDriver]);

  // Keyboard listeners
  useEffect(() => {
    const keyboardShowEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const keyboardHideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(keyboardShowEvent, (event) => {
      setIsKeyboardVisible(true);
      const nextKeyboardHeight = event?.endCoordinates?.height || 0;
      setKeyboardHeight(nextKeyboardHeight);
      if (isAtBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom(true));
      }
    });
    const hideSub = Keyboard.addListener(keyboardHideEvent, () => {
      setIsKeyboardVisible(false);
      setKeyboardHeight(0);
      if (isAtBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom(true));
      }
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [scrollToBottom]);

  // Handle typing indicator
  const handleTextChange = useCallback(
    (text) => {
      if (draftRestored && text !== inputText) {
        setDraftRestored(false);
      }

      setInputText(text);

      if (!tourId || !realtimeActorId) return;

      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      // Set typing status
      if (text.trim().length > 0) {
        setTypingStatus(tourId, realtimeActorId, userName, true, isDriver);

        // Clear typing after 3 seconds of inactivity
        typingTimeoutRef.current = setTimeout(() => {
          setTypingStatus(tourId, realtimeActorId, userName, false, isDriver);
        }, 3000);
      } else {
        setTypingStatus(tourId, realtimeActorId, userName, false, isDriver);
      }
    },
    [draftRestored, inputText, tourId, realtimeActorId, userName, isDriver]
  );

  // Send message handler
  const handleSendMessage = useCallback(async () => {
    if (sending) return;

    const trimmed = inputText.trim();
    if (!trimmed) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setSending(true);
    setInputText('');
    setReplyingToMessage(null);

    // Clear typing status
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    setTypingStatus(tourId, realtimeActorId, userName, false, isDriver);

    if (requiresPassengerStableIdForWrites && !passengerStableId) {
      setInputText(trimmed);
      setSending(false);
      showTransientFeedback({
        type: 'warning',
        icon: 'account-alert-outline',
        message: 'Your chat identity is still syncing. Try again in a moment.',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      logger.warn('ChatScreen', 'chat_send_blocked_missing_sender_stable_id', {
        tourId,
        principalId,
        hasAuthUid: Boolean(authUid),
      });
      return;
    }

    const senderInfo = buildChatSenderInfo();
    logSenderIdentityPath();

    const optimisticTimestamp = new Date().toISOString();
    const optimisticId = `${internalDriverChat ? 'int' : 'msg'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = {
      id: optimisticId,
      idempotencyKey: optimisticId,
      text: trimmed,
      senderName: userName,
      senderId: senderInfo.userId,
      ...(passengerStableId ? { senderStableId: passengerStableId } : {}),
      timestamp: optimisticTimestamp,
      isDriver,
      status: 'sending',
      type: 'text',
      ...(replyingToMessage ? { replyTo: replyingToMessage } : {}),
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    scrollToBottom(true);

    try {
      const sendFn = internalDriverChat ? sendInternalDriverMessage : sendMessage;
      const result = await sendFn(tourId, trimmed, senderInfo, undefined, {
        messageId: optimisticId,
        idempotencyKey: optimisticId,
        replyTo: replyingToMessage || undefined,
      });

      if (!result?.success || !result?.message) {
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId));
        setInputText(trimmed);
        showTransientFeedback({
          type: 'warning',
          icon: 'message-alert-outline',
          message: result?.error || 'Message could not be sent. Please try again.',
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        const confirmedMessage = { ...result.message, status: result.queued ? 'queued' : 'sent' };
        setMessages((prev) => mergeMessagesById(prev, [confirmedMessage]));

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
      showTransientFeedback({
        type: 'warning',
        icon: 'message-alert-outline',
        message: 'Message could not be sent. Please try again.',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      await refreshQueueStats();
    }

    setSending(false);
  }, [
    authUid,
    buildChatSenderInfo,
    canonicalIdentity?.principalType,
    requiresPassengerStableIdForWrites,
    sending,
    inputText,
    tourId,
    principalId,
    realtimeActorId,
    userName,
    isDriver,
    passengerStableId,
    internalDriverChat,
    replyingToMessage,
    logSenderIdentityPath,
    refreshQueueStats,
    showTransientFeedback,
    scrollToBottom,
  ]);

  const handleRetryFailedMessage = useCallback(async (message) => {
    if (!canRetryFailedMessageForCurrentSession(message)) return;
    if (!tourId || !principalId) return;
    if (retryingMessageIds[message.id]) return;

    const trimmed = message.text.trim();
    if (!trimmed) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setRetryingMessageIds((prev) => ({ ...prev, [message.id]: true }));

    setMessages((prev) =>
      prev.map((msg) => (
        msg.id === message.id
          ? { ...msg, status: 'sending', retryAttemptedAt: new Date().toISOString() }
          : msg
      ))
    );

    if (requiresPassengerStableIdForWrites && !passengerStableId) {
      setMessages((prev) => prev.map((msg) => (msg.id === message.id ? { ...msg, status: 'failed' } : msg)));
      setRetryingMessageIds((prev) => {
        const next = { ...prev };
        delete next[message.id];
        return next;
      });
      showTransientFeedback({
        type: 'warning',
        icon: 'account-alert-outline',
        message: 'Your chat identity is still syncing. Try again in a moment.',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      logger.warn('ChatScreen', 'chat_retry_blocked_missing_sender_stable_id', {
        tourId,
        principalId,
        messageId: message.id,
      });
      return;
    }

    const senderInfo = buildChatSenderInfo();
    logSenderIdentityPath();

    try {
      const sendFn = internalDriverChat ? sendInternalDriverMessage : sendMessage;
      const result = await sendFn(tourId, trimmed, senderInfo, undefined, {
        replyTo: message.replyTo || undefined,
      });

      if (!result?.success || !result?.message) {
        setMessages((prev) => prev.map((msg) => (msg.id === message.id ? { ...msg, status: 'failed' } : msg)));
        showTransientFeedback({
          type: 'warning',
          icon: 'message-alert-outline',
          message: result?.error || 'Message could not be retried. Please try again.',
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      const confirmedMessage = { ...result.message, status: result.queued ? 'queued' : 'sent' };
      setMessages((prev) => mergeMessagesById(prev.filter((msg) => msg.id !== message.id), [confirmedMessage]));

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
    } catch (error) {
      console.error('Error retrying failed chat message:', error);
      setMessages((prev) => prev.map((msg) => (msg.id === message.id ? { ...msg, status: 'failed' } : msg)));
      showTransientFeedback({
        type: 'warning',
        icon: 'message-alert-outline',
        message: 'Message could not be retried. Please try again.',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setRetryingMessageIds((prev) => {
        const next = { ...prev };
        delete next[message.id];
        return next;
      });
      await refreshQueueStats();
    }
  }, [
    buildChatSenderInfo,
    canRetryFailedMessageForCurrentSession,
    principalId,
    requiresPassengerStableIdForWrites,
    internalDriverChat,
    isDriver,
    passengerStableId,
    retryingMessageIds,
    logSenderIdentityPath,
    refreshQueueStats,
    showTransientFeedback,
    tourId,
    userName,
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

  const handleSendImage = useCallback(
    async (imageUri) => {
      if (!imageUri || isImageUploading) return;

      let imageSendStage = 'start';
      traceChatImageSend('send_requested', {
        imageUri: summarizeUri(imageUri),
        isUploadAlreadyInFlight: isImageUploading,
      });

      setImageSendState({
        status: 'uploading',
        message: 'Preparing photo...',
        retryUri: imageUri,
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      try {
        const userId = principalId;

        if (requiresPassengerStableIdForWrites && !passengerStableId) {
          imageSendStage = 'identity';
          traceChatImageSend('blocked_missing_sender_stable_id', {
            imageUri: summarizeUri(imageUri),
          });
          setImageSendState({
            status: 'failed',
            message: 'Your chat identity is still syncing. Try again in a moment.',
            retryUri: imageUri,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          return;
        }

        // Upload to Firebase Storage using correct signature:
        // uploadPhoto(uri, tourId, userId, caption, options)
        imageSendStage = 'photo_upload';
        traceChatImageSend('photo_upload_start', {
          imageUri: summarizeUri(imageUri),
          uploaderNamePresent: Boolean(userName),
        });
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
          traceChatImageSend('photo_upload_success', {
            photoIdMasked: maskIdentifier(uploadResult.id),
            hasPhotoUrl: Boolean(uploadResult.url),
            photoUrl: summarizeUri(uploadResult.url),
          });
          const senderInfo = buildChatSenderInfo();
          logSenderIdentityPath();

          imageSendStage = 'chat_message_write';
          traceChatImageSend('chat_message_write_start', {
            senderPrincipalType: senderInfo.principalType,
            senderIdMasked: maskIdentifier(senderInfo.principalId || senderInfo.userId),
            senderStableIdMasked: maskIdentifier(senderInfo.stablePassengerId || senderInfo.senderStableId),
            hasImageUrl: true,
          });
          const result = await sendImageMessage(tourId, uploadResult.url, '', senderInfo);
          if (!result?.success) {
            throw new Error(result?.error || 'Image message could not be sent');
          }
          if (result.serverPromise && typeof result.serverPromise.then === 'function') {
            await result.serverPromise;
          }
          traceChatImageSend('chat_message_write_success', {
            messageIdMasked: maskIdentifier(result?.message?.id),
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setImageSendState({
            status: 'success',
            message: 'Photo sent',
            retryUri: null,
          });
          setTimeout(() => {
            setImageSendState((prev) => (prev.status === 'success' ? { status: 'idle', message: '', retryUri: null } : prev));
          }, 2400);
        } else {
          imageSendStage = 'photo_upload';
          traceChatImageSend('photo_upload_missing_url', {
            uploadResultKeys: uploadResult && typeof uploadResult === 'object' ? Object.keys(uploadResult).slice(0, 12) : [],
          });
          setImageSendState({
            status: 'failed',
            message: 'Photo could not be uploaded. Try again.',
            retryUri: imageUri,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      } catch (error) {
        traceChatImageSend('send_failed', {
          stage: imageSendStage,
          error: summarizeErrorForDiagnostics(error),
          imageUri: summarizeUri(imageUri),
        });
        setImageSendState({
          status: 'failed',
          message: 'Photo could not be sent. Try again.',
          retryUri: imageUri,
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [
      buildChatSenderInfo,
      isImageUploading,
      logSenderIdentityPath,
      passengerStableId,
      principalId,
      requiresPassengerStableIdForWrites,
      traceChatImageSend,
      tourId,
      userName,
    ]
  );

  // Image picker handler
  const handlePickImage = useCallback(async () => {
    setShowAttachmentMenu(false);
    traceChatImageSend('gallery_permission_requested');

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    traceChatImageSend('gallery_permission_result', { status });
    if (status !== 'granted') {
      showTransientFeedback({
        type: 'warning',
        icon: 'image-off-outline',
        message: 'Gallery permission is needed to choose a photo.',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.8,
    });
    traceChatImageSend('gallery_picker_result', {
      canceled: Boolean(result.canceled),
      asset: summarizeImageAssetForDiagnostics(result.assets?.[0]),
    });

    if (!result.canceled && result.assets?.[0]) {
      await handleSendImage(result.assets[0].uri);
    }
  }, [handleSendImage, showTransientFeedback, traceChatImageSend]);

  // Camera handler
  const handleTakePhoto = useCallback(async () => {
    setShowAttachmentMenu(false);
    traceChatImageSend('camera_permission_requested');

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    traceChatImageSend('camera_permission_result', { status });
    if (status !== 'granted') {
      showTransientFeedback({
        type: 'warning',
        icon: 'camera-off-outline',
        message: 'Camera permission is needed to take a photo.',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 0.8,
    });
    traceChatImageSend('camera_picker_result', {
      canceled: Boolean(result.canceled),
      asset: summarizeImageAssetForDiagnostics(result.assets?.[0]),
    });

    if (!result.canceled && result.assets?.[0]) {
      await handleSendImage(result.assets[0].uri);
    }
  }, [handleSendImage, showTransientFeedback, traceChatImageSend]);

  const handleRetryImageSend = useCallback(() => {
    const retryUri = imageSendState.retryUri;
    if (!retryUri || isImageUploading) return;
    handleSendImage(retryUri);
  }, [handleSendImage, imageSendState.retryUri, isImageUploading]);

  // Handle reaction
  const handleReaction = useCallback(
    async (messageId, emoji, options = {}) => {
      if (!realtimeActorId) return;
      if (!messageId || !emoji) return;
      const forceAction = options?.forceAction === 'add' ? 'add' : null;
      const reactionSource = options?.source || 'manual';

      const selectedMessageAtTap = selectedMessage;
      setShowReactionPicker(false);
      setSelectedMessage(null);
      const lockKey = `${messageId}::${emoji}::${realtimeActorId}`;
      if (inFlightReactionKeysRef.current.has(lockKey)) {
        return;
      }
      inFlightReactionKeysRef.current.add(lockKey);

      const currentMessages = Array.isArray(messagesRef.current) ? messagesRef.current : [];
      const targetMessage = currentMessages.find((message) => message?.id === messageId)
        || (selectedMessageAtTap?.id === messageId ? selectedMessageAtTap : null);

      if (!targetMessage) {
        logChatReactionDebug('chat_reaction_target_message_missing', {
          tourId,
          messageId,
          emoji,
          realtimeActorIdMasked: maskIdentifier(realtimeActorId),
          knownMessageCount: currentMessages.length,
          knownMessageIdsSample: currentMessages.slice(-10).map((message) => message?.id).filter(Boolean),
          selectedMessageIdAtTap: selectedMessageAtTap?.id || null,
        }, 'warn');
        inFlightReactionKeysRef.current.delete(lockKey);
        return;
      }

      const rollbackReactions = normalizeReactionMap(targetMessage.reactions);
      let reactionActorId = realtimeActorId;
      const existingUserIdsForEmoji = rollbackReactions[emoji] || [];
      const writableExistingActorId = currentReactionUserIds.find(
        (candidateId) => existingUserIdsForEmoji.includes(candidateId) && isRealtimeKeySegment(candidateId)
      );
      reactionActorId = writableExistingActorId || realtimeActorId;
      const {
        nextReactions,
        action: optimisticAction,
        matchedUserIds: optimisticMatchedUserIds,
        nextEmojiUserIds: optimisticNextEmojiUserIds,
      } = (forceAction === 'add' ? applyOptimisticReactionAdd : applyOptimisticReactionToggle)({
        reactions: targetMessage.reactions,
        emoji,
        userId: reactionActorId,
        userIdAliases: currentReactionUserIds,
      });

      setMessages((prevMessages) =>
        prevMessages.map((message) => (
          message.id === messageId ? { ...message, reactions: nextReactions } : message
        ))
      );

      logChatReactionDebug('chat_reaction_optimistic_applied', {
        tourId,
        messageId,
        emoji,
        realtimeActorIdMasked: maskIdentifier(realtimeActorId),
        chosenReactionActorIdMasked: maskIdentifier(reactionActorId),
        choseExistingSafeActor: reactionActorId !== realtimeActorId,
        aliasCount: currentReactionUserIds.length,
        aliasIdsMasked: maskReactionDebugIds(currentReactionUserIds),
        aliasKeys: rawReactionDebugIds(currentReactionUserIds),
        existingUserCountForEmoji: existingUserIdsForEmoji.length,
        existingUserIdsMasked: maskReactionDebugIds(existingUserIdsForEmoji),
        existingUserKeys: rawReactionDebugIds(existingUserIdsForEmoji),
        matchedCurrentUserIdsMasked: maskReactionDebugIds(optimisticMatchedUserIds),
        matchedCurrentUserKeys: rawReactionDebugIds(optimisticMatchedUserIds),
        optimisticAction,
        forceAction,
        reactionSource,
        nextUserCountForEmoji: optimisticNextEmojiUserIds.length,
        nextUserIdsMasked: maskReactionDebugIds(optimisticNextEmojiUserIds),
        nextUserKeys: rawReactionDebugIds(optimisticNextEmojiUserIds),
        reactionActorKey: reactionActorId,
      });

      try {
        logChatReactionDebug('chat_reaction_service_call_start', {
          tourId,
          messageId,
          emoji,
          reactionActorIdMasked: maskIdentifier(reactionActorId),
          reactionActorKey: reactionActorId,
          reactionActorKeyIsRealtimeSafe: isRealtimeKeySegment(reactionActorId),
          forceAction,
          reactionSource,
        });
        const result = await toggleReaction(
          tourId,
          messageId,
          emoji,
          reactionActorId,
          undefined,
          forceAction ? { forceAction } : undefined
        );
        if (!result?.success) {
          throw new Error(result?.error || 'Unknown error');
        }
        logChatReactionDebug('chat_reaction_service_call_success', {
          tourId,
          messageId,
          emoji,
          reactionActorIdMasked: maskIdentifier(reactionActorId),
          serviceAction: result.action || null,
          serviceUserCount: Array.isArray(result.users) ? result.users.length : null,
          serviceActorPresent: Array.isArray(result.users) ? result.users.includes(reactionActorId) : null,
          serviceUsersMasked: maskReactionDebugIds(result.users || []),
          serviceUserKeys: rawReactionDebugIds(result.users || []),
          forceAction,
          reactionSource,
        });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch (error) {
        setMessages((prevMessages) =>
          prevMessages.map((message) => (
            message.id === messageId
              ? { ...message, reactions: rollbackReactions || {} }
              : message
          ))
        );
        logChatReactionDebug('chat_reaction_toggle_failed_rolled_back', {
          tourId,
          messageId,
          emoji,
          userId: reactionActorId,
          reactionActorKey: reactionActorId,
          reactionActorKeyIsRealtimeSafe: isRealtimeKeySegment(reactionActorId),
          forceAction,
          reactionSource,
          error: error?.message || 'Unknown error',
        }, 'warn');
        showReactionFailureFeedback('Could not update reaction. Check your connection and try again.');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        inFlightReactionKeysRef.current.delete(lockKey);
      }
    },
    [currentReactionUserIds, realtimeActorId, selectedMessage, tourId, showReactionFailureFeedback]
  );

  const handleHeartReactionDoubleTap = useCallback(
    (messageId) => {
      if (internalDriverChat) return;
      handleReaction(messageId, HEART_REACTION, { forceAction: 'add', source: 'double_tap' });
    },
    [handleReaction, internalDriverChat]
  );

  // Handle message long press
  const handleMessageLongPress = useCallback((message) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedMessage(message);
    setShowActionMenu(true);
  }, []);

  const dismissSwipeReplyHint = useCallback(async () => {
    setShowSwipeReplyHint(false);
    if (!swipeReplyHintStorageKey) return;
    try {
      await uxHintStorage.setItemAsync(swipeReplyHintStorageKey, '1');
    } catch (error) {
      // no-op: hint persistence failures should not break chat UX
    }
  }, [swipeReplyHintStorageKey, uxHintStorage]);

  const startReplyComposer = useCallback((message, source = 'menu') => {
    if (!message) return;

    setReplyingToMessage({
      messageId: message.id,
      ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      senderName: message.senderName || 'Participant',
      previewText: buildReplyPreviewText(message),
    });

    if (source === 'swipe') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      dismissSwipeReplyHint();
    }
  }, [dismissSwipeReplyHint]);

  const handleReplyToMessage = useCallback(() => {
    if (!selectedMessage) return;
    startReplyComposer(selectedMessage, 'menu');
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [selectedMessage, startReplyComposer]);

  // Handle copy message
  const handleCopyMessage = useCallback(() => {
    if (selectedMessage) {
      Clipboard.setString(getMessageTextForCopy(selectedMessage));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [selectedMessage]);

  const getSelectedMessageFirstLink = useCallback(() => {
    if (!selectedMessage || typeof selectedMessage.text !== 'string') return null;
    const matches = selectedMessage.text.match(URL_REGEX);
    return matches?.[0] || null;
  }, [selectedMessage]);

  const handleCopyFirstLink = useCallback(() => {
    const firstLink = getSelectedMessageFirstLink();
    if (!firstLink) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    Clipboard.setString(firstLink);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [getSelectedMessageFirstLink]);

  const handleOpenFirstLink = useCallback(async () => {
    const firstLink = getSelectedMessageFirstLink();
    if (!firstLink) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    try {
      const supported = await Linking.canOpenURL(firstLink);
      if (!supported) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      await Linking.openURL(firstLink);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (error) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setShowActionMenu(false);
      setSelectedMessage(null);
    }
  }, [getSelectedMessageFirstLink]);

  // Handle delete message
  const handleDeleteMessage = useCallback(async () => {
    if (selectedMessage) {
      const result = await deleteMessage(tourId, selectedMessage.id, principalId, isDriver);
      if (result.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }
    setShowActionMenu(false);
    setSelectedMessage(null);
  }, [tourId, selectedMessage, principalId, isDriver]);

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

  const handleLoadOlderMessages = useCallback(async () => {
    if (!tourId || loadingOlderMessages || messages.length === 0) return;

    const cursor = getOldestMessageCursor(messages);
    if (!cursor) {
      setHasMoreHistory(false);
      return;
    }

    preserveScrollAfterPrependRef.current = {
      previousContentHeight: listContentHeightRef.current,
      previousScrollY: currentScrollYRef.current,
    };
    setLoadingOlderMessages(true);

    try {
      const result = await getChatMessagesPage({
        tourId,
        scope: internalDriverChat ? 'internal' : 'group',
        beforeTimestamp: cursor.beforeTimestamp,
        beforeMessageId: cursor.beforeMessageId,
        limit: CHAT_PAGE_MESSAGE_LIMIT,
      });

      if (!result?.success) {
        preserveScrollAfterPrependRef.current = null;
        showTransientFeedback({
          type: 'warning',
          icon: 'cloud-alert-outline',
          message: result?.error || 'Older messages could not be loaded right now.',
        });
        return;
      }

      setHasMoreHistory(Boolean(result.hasMore));
      if (Array.isArray(result.messages) && result.messages.length > 0) {
        setMessages((prevMessages) => mergeMessagesById(result.messages, prevMessages));
      } else {
        preserveScrollAfterPrependRef.current = null;
      }
    } catch (error) {
      preserveScrollAfterPrependRef.current = null;
      showTransientFeedback({
        type: 'warning',
        icon: 'cloud-alert-outline',
        message: 'Older messages could not be loaded right now.',
      });
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [internalDriverChat, loadingOlderMessages, messages, showTransientFeedback, tourId]);

  // Format time helper
  const formatTime = useCallback((timestamp) => {
    return formatChatTimestamp(timestamp);
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

  const groupedMessages = useMemo(() => {
    return buildChatTimelineItems(messages, {
      lastSeenTimestamp,
      isMessageOwned: (message) => isMessageOwnedByCurrentSession(message, canonicalIdentity),
    });
  }, [messages, lastSeenTimestamp, canonicalIdentity]);

  const unreadAnchorIndex = useMemo(() => {
    if (!unreadAnchorMessageId) return -1;
    return groupedMessages.findIndex((item) => item.type === 'message' && item.data?.id === unreadAnchorMessageId);
  }, [groupedMessages, unreadAnchorMessageId]);

  const replyTargetIndex = useMemo(() => buildReplyTargetIndex(groupedMessages), [groupedMessages]);

  useEffect(() => {
    if (!unreadAnchorMessageId || unreadAnchorY == null) {
      setShowJumpToUnread(false);
      return;
    }
    updateUnreadJumpVisibility(currentScrollYRef.current, unreadAnchorY);
  }, [unreadAnchorMessageId, unreadAnchorY, updateUnreadJumpVisibility]);

  const jumpToUnread = useCallback(() => {
    if (unreadAnchorIndex >= 0) {
      messageListRef.current?.scrollToIndex({ index: unreadAnchorIndex, animated: true, viewOffset: 80 });
      return;
    }
    if (unreadAnchorY == null) return;
    messageListRef.current?.scrollToOffset({ offset: Math.max(unreadAnchorY - 80, 0), animated: true });
  }, [unreadAnchorIndex, unreadAnchorY]);

  const unreadSummary = useMemo(() => (
    buildUnreadSummary(
      messages.filter((message) => !isMessageOwnedByCurrentSession(message, canonicalIdentity)),
      {
        lastSeenTimestamp,
        currentUserId: null,
      }
    )
  ), [messages, lastSeenTimestamp, canonicalIdentity]);

  const searchResults = useMemo(
    () => buildChatSearchResults(messages, searchQuery),
    [messages, searchQuery]
  );
  const messageLookupById = useMemo(
    () => new Map(messages.map((entry) => [entry?.id, entry])),
    [messages]
  );

  const filteredSearchResults = useMemo(() => {
    if (searchResults.length === 0) return [];
    return searchResults.filter((result) => {
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

    return filteredSearchResults
      .slice(0, SEARCH_RESULT_PREVIEW_LIMIT)
      .map((result) => {
        const message = messageLookupById.get(result.id);
        if (!message) return null;

        const messageText = typeof message.text === 'string' ? message.text.trim() : '';
        const fallbackText = message.type === 'image' ? '📷 Photo' : 'Message';
        const previewText = messageText || fallbackText;

        const lowerCasePreview = previewText.toLowerCase();
        const queryIndex = normalizedQuery ? lowerCasePreview.indexOf(normalizedQuery) : -1;
        const snippetStart = queryIndex > 24 ? queryIndex - 24 : 0;
        const snippetEnd = queryIndex >= 0
          ? Math.min(previewText.length, queryIndex + normalizedQuery.length + 36)
          : Math.min(previewText.length, 72);
        const snippet = previewText.slice(snippetStart, snippetEnd).trim();
        const formattedSnippet = snippetStart > 0 ? `…${snippet}` : snippet;

        return {
          id: message.id,
          senderName: message.senderName || 'Participant',
          previewText: formattedSnippet || fallbackText,
          timestamp: message.timestamp,
          isActive: activeId === message.id,
          isDriver: message.isDriver === true,
        };
      })
      .filter(Boolean);
  }, [filteredSearchResults, messageLookupById, searchQuery, activeSearchResultMessageId]);

  const jumpToMessageById = useCallback((messageId, fallbackId = null) => {
    const targetCandidates = [
      ...collectMessageIdCandidates(messageId),
      ...collectMessageIdCandidates(fallbackId),
    ];
    const uniqueCandidates = Array.from(new Set(targetCandidates));
    let targetIndex = -1;

    uniqueCandidates.some((candidate) => {
      const resolved = resolveReplyTargetIndex(candidate, replyTargetIndex);
      if (resolved < 0) return false;
      targetIndex = resolved;
      return true;
    });

    if (targetIndex < 0 && uniqueCandidates.length > 0) {
      targetIndex = groupedMessages.findIndex((item) => {
        if (item?.type !== 'message') return false;
        const messageData = item.data || {};
        const candidatePool = [
          ...collectMessageIdCandidates(messageData.id),
          ...collectMessageIdCandidates(messageData.idempotencyKey),
        ];
        return uniqueCandidates.some((candidate) => candidatePool.includes(candidate));
      });
    }

    if (targetIndex < 0) {
      setReplyJumpFeedbackMessage('Could not find the original message in this chat history.');
      return false;
    }

    pendingJumpIndexRef.current = targetIndex;
    setReplyJumpFeedbackMessage('');
    const targetMessageId = groupedMessages[targetIndex]?.data?.id;
    if (targetMessageId) {
      setHighlightedReplyTargetMessageId(targetMessageId);
    }
    messageListRef.current?.scrollToIndex({ index: targetIndex, animated: true, viewPosition: 0.45 });
    return true;
  }, [groupedMessages, replyTargetIndex]);


  useEffect(() => {
    if (!replyJumpFeedbackMessage) return undefined;
    const timeoutId = setTimeout(() => setReplyJumpFeedbackMessage(''), 2600);
    return () => clearTimeout(timeoutId);
  }, [replyJumpFeedbackMessage]);

  useEffect(() => {
    if (!highlightedReplyTargetMessageId) return undefined;
    const timeoutId = setTimeout(() => setHighlightedReplyTargetMessageId(null), 2200);
    return () => clearTimeout(timeoutId);
  }, [highlightedReplyTargetMessageId]);

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [searchQuery, searchFilter]);

  useEffect(() => {
    if (!isSearchOpen) return;
    if (filteredSearchResults.length === 0) return;
    jumpToMessageById(activeSearchResultMessageId);
  }, [isSearchOpen, filteredSearchResults.length, activeSearchResultMessageId, jumpToMessageById]);

  const cycleSearchResult = useCallback((direction) => {
    if (filteredSearchResults.length === 0) return;
    const nextIndex = (activeSearchResultIndex + direction + filteredSearchResults.length) % filteredSearchResults.length;
    setActiveSearchResultIndex(nextIndex);
    jumpToMessageById(filteredSearchResults[nextIndex]?.id);
  }, [filteredSearchResults, activeSearchResultIndex, jumpToMessageById]);

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
      const isSelf = isMessageOwnedByCurrentSession(msg, canonicalIdentity);
      const isMsgDriver = !!msg.isDriver;
      const isDeleted = !!msg.deleted;
      const isImage = msg.type === 'image';
      const isSearchMatch = !!activeSearchResultMessageId && activeSearchResultMessageId === msg.id;
      const isReplyJumpTarget = !!highlightedReplyTargetMessageId && highlightedReplyTargetMessageId === msg.id;
      const isRetryEligible = canRetryFailedMessageForCurrentSession(msg);
      const isRetrying = !!retryingMessageIds[msg.id];

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

      const messageBody = (
        <Pressable
          key={msg.id}
          onLongPress={() => handleMessageLongPress(msg)}
          delayLongPress={300}
        >
          <View style={[styles.messageRow, isSelf ? styles.myMessageRow : styles.theirMessageRow]}>
            <View
              style={[
                styles.messageBubble,
                isSelf ? styles.myMessageBubble : styles.theirMessageBubble,
                isMsgDriver && !isSelf && styles.driverMessageBubble,
                isImage && styles.imageMessageBubble,
                isSearchMatch && styles.searchFocusedBubble,
                isReplyJumpTarget && styles.replyJumpTargetBubble,
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

              {msg.replyTo?.messageId && (
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[styles.replyReferenceCard, isSelf && styles.replyReferenceCardSelf]}
                  onPress={() => jumpToMessageById(msg.replyTo.messageId, msg.replyTo.idempotencyKey)}
                >
                  <View style={styles.replyReferenceAccent} />
                  <View style={styles.replyReferenceContent}>
                    <Text
                      numberOfLines={1}
                      style={[styles.replyReferenceSender, isSelf && styles.replyReferenceSenderSelf]}
                    >
                      {msg.replyTo.senderName || 'Participant'}
                    </Text>
                    <Text
                      numberOfLines={2}
                      style={[styles.replyReferencePreview, isSelf && styles.replyReferencePreviewSelf]}
                    >
                      {msg.replyTo.previewText || 'Message'}
                    </Text>
                  </View>
                  <MaterialCommunityIcons
                    name="arrow-top-right"
                    size={14}
                    color={isSelf ? COLORS.lightBlueAccent : COLORS.secondaryText}
                  />
                </TouchableOpacity>
              )}

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

              {isRetryEligible && (
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[styles.failedMessageRetryChip, isRetrying && styles.failedMessageRetryChipDisabled]}
                  onPress={() => handleRetryFailedMessage(msg)}
                  disabled={isRetrying}
                  accessibilityRole="button"
                  accessibilityLabel={isRetrying ? 'Retrying message' : 'Retry sending failed message'}
                >
                  {isRetrying ? (
                    <ActivityIndicator size="small" color={COLORS.white} />
                  ) : (
                    <MaterialCommunityIcons name="refresh" size={14} color={COLORS.white} />
                  )}
                  <Text style={styles.failedMessageRetryText}>
                    {isRetrying ? 'Retrying…' : 'Tap to retry'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Reactions */}
              <MessageReactions
                reactions={msg.reactions}
                onReactionPress={handleReaction}
                messageId={msg.id}
                currentUserId={realtimeActorId}
                currentUserIds={currentReactionUserIds}
              />
            </View>
          </View>
        </Pressable>
      );

      return (
        <SwipeToReplyMessageWrapper
          onSwipeReply={() => startReplyComposer(msg, 'swipe')}
          disabled={isDeleted}
        >
          {messageBody}
        </SwipeToReplyMessageWrapper>
      );
    },
    [
      canRetryFailedMessageForCurrentSession,
      identityBinding,
      principalId,
      realtimeActorId,
      currentReactionUserIds,
      formatTime,
      handleMessageLongPress,
      handleReaction,
      parseMessageText,
      renderHighlightedText,
      activeSearchResultMessageId,
      highlightedReplyTargetMessageId,
      startReplyComposer,
      retryingMessageIds,
      handleRetryFailedMessage,
    ]
  );

  const keyExtractor = useCallback((item) => {
    if (item.type === 'message') return item.data?.id ? `message-${item.data.id}` : item.id;
    return item.id;
  }, []);

  const handleMessageRowLayout = useCallback((messageId, layout) => {
    const { y, height } = layout;
    rowOffsetsRef.current[messageId] = height;
    if (messageId === unreadAnchorMessageId) {
      setUnreadAnchorY(y);
    }
  }, [unreadAnchorMessageId]);

  const renderMessageRow = useCallback(({ item }) => {
    return (
      <MessageRow
        item={item}
        unreadAnchorMessageId={unreadAnchorMessageId}
        onRowLayout={handleMessageRowLayout}
        onSwipeReply={(message) => startReplyComposer(message, 'swipe')}
        activeSearchResultMessageId={activeSearchResultMessageId}
        highlightedReplyTargetMessageId={highlightedReplyTargetMessageId}
        currentUserId={realtimeActorId}
        currentUserIds={currentReactionUserIds}
        canRetry={item.type === 'message' ? canRetryFailedMessageForCurrentSession(item.data) : false}
        isRetrying={item.type === 'message' ? !!retryingMessageIds[item.data?.id] : false}
        onRetry={handleRetryFailedMessage}
        onLongPress={handleMessageLongPress}
        onReactionPress={handleReaction}
        onDoubleTapReaction={internalDriverChat ? null : handleHeartReactionDoubleTap}
        onOpenImage={setViewingImage}
        onJumpToMessage={jumpToMessageById}
        renderHighlightedText={renderHighlightedText}
        formatTime={formatTime}
        parseMessageText={parseMessageText}
      />
    );
  }, [
    activeSearchResultMessageId,
    canRetryFailedMessageForCurrentSession,
    formatTime,
    handleMessageLongPress,
    handleHeartReactionDoubleTap,
    handleMessageRowLayout,
    handleReaction,
    handleRetryFailedMessage,
    highlightedReplyTargetMessageId,
    internalDriverChat,
    jumpToMessageById,
    parseMessageText,
    principalId,
    realtimeActorId,
    currentReactionUserIds,
    renderHighlightedText,
    retryingMessageIds,
    startReplyComposer,
    unreadAnchorMessageId,
  ]);

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
      <Text style={styles.emptyText}>No messages yet</Text>
      <Text style={styles.emptySubtext}>
        Say hello, share a useful update, or send a photo from the tour.
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
      <ChatHeader
        internalDriverChat={internalDriverChat}
        isSearchOpen={isSearchOpen}
        onBack={onBack}
        onToggleSearch={() => {
          setIsSearchOpen((prev) => !prev);
          if (isSearchOpen) setSearchQuery('');
        }}
        onSync={handleManualSync}
        onlineCount={presenceInfo.onlineCount}
        queueStats={queueStats}
      />

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
                : `${filteredSearchResults.length} message${filteredSearchResults.length === 1 ? '' : 's'} matched`}
            </Text>
            <View style={styles.searchNavButtons}>
              <TouchableOpacity
                style={[styles.searchNavBtn, filteredSearchResults.length === 0 && styles.searchNavBtnDisabled]}
                onPress={() => cycleSearchResult(-1)}
                disabled={filteredSearchResults.length === 0}
              >
                <MaterialCommunityIcons name="chevron-up" size={18} color={COLORS.primaryBlue} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.searchNavBtn, filteredSearchResults.length === 0 && styles.searchNavBtnDisabled]}
                onPress={() => cycleSearchResult(1)}
                disabled={filteredSearchResults.length === 0}
              >
                <MaterialCommunityIcons name="chevron-down" size={18} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.searchFiltersRow}>
            {SEARCH_FILTERS.map((filter) => {
              const active = searchFilter === filter.key;
              return (
                <TouchableOpacity
                  key={filter.key}
                  style={[styles.searchFilterChip, active && styles.searchFilterChipActive]}
                  onPress={() => setSearchFilter(filter.key)}
                  activeOpacity={0.8}
                >
                  <MaterialCommunityIcons
                    name={filter.icon}
                    size={14}
                    color={active ? COLORS.white : COLORS.primaryBlue}
                  />
                  <Text style={[styles.searchFilterLabel, active && styles.searchFilterLabelActive]}>
                    {filter.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {searchResultPreviewCards.length > 0 && (
            <View style={styles.searchPreviewList}>
              {searchResultPreviewCards.map((item) => (
                <TouchableOpacity
                  key={`search-preview-${item.id}`}
                  style={[styles.searchPreviewCard, item.isActive && styles.searchPreviewCardActive]}
                  onPress={() => jumpToMessageById(item.id)}
                  activeOpacity={0.85}
                >
                  <View style={styles.searchPreviewHeader}>
                    <View style={styles.searchPreviewSenderRow}>
                      <Text style={styles.searchPreviewSender}>{item.senderName}</Text>
                      {item.isDriver && (
                        <View style={styles.searchPreviewDriverBadge}>
                          <Text style={styles.searchPreviewDriverBadgeText}>DRIVER</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.searchPreviewTime}>{formatTime(item.timestamp)}</Text>
                  </View>
                  <Text numberOfLines={2} style={styles.searchPreviewText}>
                    {item.previewText}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}

      <SwipeReplyHint
        visible={showSwipeReplyHint && messages.length > 0}
        onDismiss={dismissSwipeReplyHint}
      />

      <ChatFeedbackHost
        syncState={syncBannerContract}
        syncOutcomeText={syncBannerOutcomeText}
        lastSuccessfulSyncAt={lastSuccessfulSyncAt}
        onRetrySync={() => handleManualSync({ retryFailedOnly: true })}
        reactionFeedbackMessage={reactionFeedbackMessage}
        replyJumpFeedbackMessage={replyJumpFeedbackMessage}
        transientFeedback={transientFeedback}
        imageSendState={imageSendState}
        onRetryImage={handleRetryImageSend}
        draftRestored={draftRestored}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoidingContainer}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <ChatTimeline
          loading={loading}
          messageListRef={messageListRef}
          groupedMessages={groupedMessages}
          keyExtractor={keyExtractor}
          renderMessageRow={renderMessageRow}
          renderEmptyMessages={renderEmptyMessages}
          listBottomSpacerHeight={listBottomSpacerHeight}
          onLayout={(event) => {
            listViewportHeightRef.current = event.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_, contentHeight) => {
            const preserveRequest = preserveScrollAfterPrependRef.current;
            const previousContentHeight = listContentHeightRef.current;
            listContentHeightRef.current = contentHeight;

            if (preserveRequest) {
              preserveScrollAfterPrependRef.current = null;
              const delta = Math.max(contentHeight - preserveRequest.previousContentHeight, 0);
              messageListRef.current?.scrollToOffset({
                offset: preserveRequest.previousScrollY + delta,
                animated: false,
              });
              return;
            }

            if (isAtBottomRef.current && contentHeight >= previousContentHeight) {
              scrollToBottom(false);
            }
          }}
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollToIndexFailed={({ index }) => {
            const fallbackOffset = Math.max(index * ESTIMATED_MESSAGE_ROW_HEIGHT - 80, 0);
            messageListRef.current?.scrollToOffset({ offset: fallbackOffset, animated: true });

            const pendingTargetIndex = pendingJumpIndexRef.current;
            if (pendingTargetIndex == null || pendingTargetIndex !== index) {
              return;
            }

            setTimeout(() => {
              messageListRef.current?.scrollToIndex({
                index: pendingTargetIndex,
                animated: true,
                viewPosition: 0.45,
              });
            }, 120);
          }}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          hasMoreHistory={hasMoreHistory}
          loadingOlderMessages={loadingOlderMessages}
          onLoadOlderMessages={handleLoadOlderMessages}
        />

        {!loading && <TypingIndicator typingUsers={typingUsers} />}

        {!loading && (
          <ChatFloatingJump
            mode={showJumpToUnread ? 'unread' : newMessagesCount > 0 ? 'new' : 'none'}
            count={newMessagesCount}
            summary={unreadSummary}
            bottomOffset={showJumpToUnread ? floatingUiBottomInset + 56 : floatingUiBottomInset}
            onJumpToUnread={jumpToUnread}
            onJumpToLatest={() => {
              scrollToBottom(true);
              setNewMessagesCount(0);
              markActiveChatRead({ force: true });
            }}
          />
        )}

        <AttachmentTray
          visible={showAttachmentMenu}
          onClose={() => setShowAttachmentMenu(false)}
          onPickImage={handlePickImage}
          onTakePhoto={handleTakePhoto}
        />

        <ChatComposer
          composerBottomInset={composerBottomInset}
          inputHeight={inputHeight}
          inputText={inputText}
          sending={sending}
          replyingToMessage={replyingToMessage}
          showAttachmentMenu={showAttachmentMenu}
          onComposerLayout={(event) => {
            const nextHeight = Math.ceil(event.nativeEvent.layout.height);
            setComposerHeight((prev) => (prev === nextHeight ? prev : nextHeight));
          }}
          onCancelReply={() => setReplyingToMessage(null)}
          onToggleAttachments={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setShowAttachmentMenu((prev) => !prev);
          }}
          onTextChange={handleTextChange}
          onInputContentSizeChange={(event) => setInputHeight(event.nativeEvent.contentSize.height)}
          onSendMessage={handleSendMessage}
        />
      </KeyboardAvoidingView>

      {/* Modals */}
      <ChatActionSheet
        visible={showActionMenu}
        onClose={() => {
          setShowActionMenu(false);
          setSelectedMessage(null);
        }}
        message={selectedMessage}
        onCopy={handleCopyMessage}
        onReply={handleReplyToMessage}
        onReact={(emoji) => {
          setShowActionMenu(false);
          if (selectedMessage?.id && emoji) {
            handleReaction(selectedMessage.id, emoji);
          }
        }}
        onOpenReactionPicker={() => {
          setShowActionMenu(false);
          setShowReactionPicker(true);
        }}
        onCopyLink={handleCopyFirstLink}
        onOpenLink={handleOpenFirstLink}
        onDelete={handleDeleteMessage}
        canDelete={isMessageOwnedByCurrentSession(selectedMessage, canonicalIdentity) || isDriver}
        insets={insets}
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
    width: 80,
    height: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  headerTitleContainer: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    paddingHorizontal: SPACING.xs,
    gap: 4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.white,
    letterSpacing: 0,
  },
  headerRight: {
    width: 80,
    flexShrink: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 6,
  },
  syncNowBtn: {
    width: 34,
    height: 34,
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
    paddingHorizontal: 7,
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
    fontSize: 11,
    fontWeight: '700',
  },
  feedbackHost: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xs,
    gap: SPACING.xs,
  },
  feedbackPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    backgroundColor: THEME.primaryMuted,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  feedbackPillError: {
    borderColor: THEME.sync.critical.border,
    backgroundColor: THEME.sync.critical.background,
  },
  feedbackPillSuccess: {
    borderColor: THEME.sync.success.border,
    backgroundColor: THEME.sync.success.background,
  },
  feedbackPillText: {
    flex: 1,
    color: COLORS.primaryBlue,
    fontSize: 12,
    fontWeight: '700',
  },
  feedbackPillTextError: {
    color: THEME.sync.critical.foreground,
  },
  feedbackPillTextSuccess: {
    color: THEME.sync.success.foreground,
  },
  feedbackPillAction: {
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  feedbackPillActionText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue,
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
  searchFiltersRow: {
    marginTop: SPACING.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  searchFilterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
    backgroundColor: `${COLORS.primaryBlue}10`,
  },
  searchFilterChipActive: {
    backgroundColor: COLORS.primaryBlue,
    borderColor: COLORS.primaryBlue,
  },
  searchFilterLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryBlue,
  },
  searchFilterLabelActive: {
    color: COLORS.white,
  },
  searchPreviewList: {
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  searchPreviewCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.appBackground,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  searchPreviewCardActive: {
    borderColor: COLORS.primaryBlue,
    backgroundColor: `${COLORS.primaryBlue}10`,
  },
  searchPreviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs / 2,
  },
  searchPreviewSenderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flexShrink: 1,
  },
  searchPreviewSender: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.darkText,
  },
  searchPreviewTime: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.secondaryText,
  },
  searchPreviewDriverBadge: {
    borderRadius: RADIUS.full,
    backgroundColor: `${COLORS.coralAccent}26`,
    paddingHorizontal: SPACING.xs + 2,
    paddingVertical: SPACING.xs / 2,
  },
  searchPreviewDriverBadgeText: {
    fontSize: 9,
    letterSpacing: 0.3,
    color: COLORS.coralAccent,
    fontWeight: '800',
  },
  searchPreviewText: {
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.secondaryText,
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
  skeletonContainer: {
    flex: 1,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xl,
    backgroundColor: COLORS.chatScreenBackground,
  },
  skeletonRow: {
    flexDirection: 'row',
    marginBottom: SPACING.md,
  },
  skeletonRowOther: {
    justifyContent: 'flex-start',
  },
  skeletonRowSelf: {
    justifyContent: 'flex-end',
  },
  skeletonBubble: {
    width: '52%',
    height: 54,
    borderRadius: RADIUS.lg,
    backgroundColor: '#E2E8F0',
    opacity: 0.75,
  },
  skeletonBubbleWide: {
    width: '68%',
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
  loadOlderButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.sm,
  },
  loadOlderButtonText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue,
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  myMessageRow: {
    justifyContent: 'flex-end',
  },
  theirMessageRow: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '82%',
    minWidth: 0,
    paddingVertical: SPACING.sm + 2,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg,
  },
  messageBubbleWithReply: {
    minWidth: Math.min(SCREEN_WIDTH * 0.58, 260),
  },
  myMessageBubble: {
    backgroundColor: COLORS.myMessageBackground,
    borderBottomRightRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: `${COLORS.primaryDark}40`,
  },
  myMessageBubbleClusterFirst: {
    borderBottomRightRadius: RADIUS.lg,
  },
  myMessageBubbleClusterMiddle: {
    borderTopRightRadius: RADIUS.sm,
    borderBottomRightRadius: RADIUS.sm,
  },
  myMessageBubbleClusterLast: {
    borderTopRightRadius: RADIUS.sm,
  },
  theirMessageBubble: {
    backgroundColor: COLORS.theirMessageBackground,
    borderBottomLeftRadius: RADIUS.sm,
    ...SHADOWS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  theirMessageBubbleClusterFirst: {
    borderBottomLeftRadius: RADIUS.lg,
  },
  theirMessageBubbleClusterMiddle: {
    borderTopLeftRadius: RADIUS.sm,
    borderBottomLeftRadius: RADIUS.sm,
  },
  theirMessageBubbleClusterLast: {
    borderTopLeftRadius: RADIUS.sm,
  },
  driverMessageBubble: {
    backgroundColor: COLORS.driverMessageBackground,
    borderColor: COLORS.driverMessageBorder,
    borderWidth: 1.5,
  },
  imageMessageBubble: {
    padding: 4,
    maxWidth: '78%',
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
    minWidth: 0,
    marginBottom: 4,
  },
  replyReferenceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}26`,
    backgroundColor: `${COLORS.primaryBlue}10`,
    marginBottom: SPACING.xs,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    gap: SPACING.xs,
  },
  replyReferenceCardSelf: {
    borderColor: `${COLORS.lightBlueAccent}70`,
    backgroundColor: `${COLORS.primaryDark}55`,
  },
  replyReferenceAccent: {
    width: 3,
    borderRadius: RADIUS.full,
    alignSelf: 'stretch',
    backgroundColor: COLORS.primaryBlue,
  },
  replyReferenceContent: {
    flex: 1,
    minWidth: 0,
  },
  replyReferenceSender: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primaryBlue,
  },
  replyReferenceSenderSelf: {
    color: COLORS.lightBlueAccent,
  },
  replyReferencePreview: {
    marginTop: 2,
    fontSize: 12,
    color: COLORS.secondaryText,
  },
  replyReferencePreviewSelf: {
    color: `${COLORS.white}CC`,
  },
  senderName: {
    flexShrink: 1,
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
  failedMessageRetryChip: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: THEME.error,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 2,
    paddingVertical: 5,
    ...SHADOWS.sm,
  },
  failedMessageRetryChipDisabled: {
    opacity: 0.75,
  },
  failedMessageRetryText: {
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  searchFocusedBubble: {
    borderColor: COLORS.coralAccent,
    borderWidth: 2,
  },
  replyJumpTargetBubble: {
    borderColor: COLORS.primaryBlue,
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
  floatingJumpPill: {
    position: 'absolute',
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
  floatingJumpPillText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '700',
  },
  floatingJumpCard: {
    position: 'absolute',
    right: SPACING.lg,
    left: SPACING.lg,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}20`,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.md,
  },
  floatingJumpHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  floatingJumpTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  floatingJumpBody: {
    marginTop: 3,
    fontSize: 12,
    color: COLORS.secondaryText,
  },
  floatingJumpActions: {
    marginTop: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  floatingJumpActionText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue,
  },
  floatingJumpLatest: {
    borderRadius: RADIUS.full,
    backgroundColor: `${COLORS.primaryBlue}10`,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
  },
  floatingJumpLatestText: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryBlue,
  },
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
  reactionFeedbackBanner: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: THEME.error,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.sm,
  },
  reactionFeedbackText: {
    flex: 1,
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '600',
  },
  replyJumpFeedbackBanner: {
    marginHorizontal: SPACING.lg,
    marginBottom: SPACING.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.primaryBlue,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.sm,
  },
  replyJumpFeedbackText: {
    flex: 1,
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '600',
  },
  swipeReplyHint: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full,
    backgroundColor: THEME.primaryMuted,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}25`,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  swipeReplyHintText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.primaryBlue,
    fontWeight: '600',
  },
  swipeReplyRowContainer: {
    position: 'relative',
  },
  swipeReplyFeedback: {
    position: 'absolute',
    left: SPACING.lg + 4,
    top: '50%',
    marginTop: -12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: THEME.primaryMuted,
    borderColor: `${COLORS.primaryBlue}20`,
    borderWidth: 1,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
  },
  swipeReplyFeedbackReady: {
    backgroundColor: `${THEME.success}20`,
    borderColor: `${THEME.success}60`,
  },
  swipeReplyFeedbackText: {
    fontSize: 11,
    color: COLORS.primaryBlue,
    fontWeight: '700',
  },
  swipeReplyFeedbackTextReady: {
    color: THEME.success,
  },

  catchUpCard: {
    position: 'absolute',
    bottom: 182,
    right: SPACING.lg,
    left: SPACING.lg,
    backgroundColor: COLORS.white,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}20`,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    ...SHADOWS.md,
  },
  catchUpCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: 4,
  },
  catchUpCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.darkText,
  },
  catchUpCardBody: {
    fontSize: 12,
    color: COLORS.secondaryText,
    marginBottom: SPACING.xs,
  },
  catchUpCardBodyStrong: {
    fontWeight: '700',
    color: COLORS.darkText,
  },
  catchUpActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.xs,
  },
  catchUpButtonSecondary: {
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    backgroundColor: `${COLORS.primaryBlue}08`,
  },
  catchUpButtonSecondaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryBlue,
  },
  catchUpButtonPrimary: {
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    backgroundColor: COLORS.primaryBlue,
  },
  catchUpButtonPrimaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.white,
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
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
  },
  replyComposerCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
    borderWidth: 1,
    borderColor: `${COLORS.primaryBlue}30`,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    gap: SPACING.xs,
  },
  replyComposerAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primaryBlue,
  },
  replyComposerBody: {
    flex: 1,
    minWidth: 0,
  },
  replyComposerTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryBlue,
  },
  replyComposerPreview: {
    marginTop: 1,
    fontSize: 12,
    color: COLORS.secondaryText,
  },
  replyComposerClose: {
    width: 30,
    height: 30,
    borderRadius: RADIUS.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
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
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.full,
    backgroundColor: `${COLORS.primaryBlue}08`,
  },
  composerInputRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: SPACING.xs,
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 22,
    paddingHorizontal: SPACING.lg,
    paddingVertical: 10,
    paddingTop: 12,
    fontSize: 16,
    color: COLORS.darkText,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sendButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
    justifyContent: 'flex-end',
  },
  actionMenuSheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    ...SHADOWS.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  actionMenuHandle: {
    width: 44,
    height: 4,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.border,
    alignSelf: 'center',
    marginBottom: SPACING.md,
  },
  actionMessagePreviewCard: {
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceSecondary,
    marginBottom: SPACING.sm,
  },
  actionMessagePreviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
    gap: SPACING.sm,
  },
  actionMessageSender: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.darkText,
    flex: 1,
  },
  actionMessageTime: {
    fontSize: 12,
    color: COLORS.secondaryText,
    fontWeight: '500',
  },
  actionMessagePreviewText: {
    fontSize: 14,
    lineHeight: 19,
    color: COLORS.darkText,
    fontWeight: '500',
  },
  actionQuickReactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
    gap: SPACING.xs,
  },
  actionQuickReaction: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionQuickReactionEmoji: {
    fontSize: 22,
  },
  actionMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 10,
    gap: 14,
    borderRadius: RADIUS.md,
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
