// screens/ChatScreen.js - Premium Chat Experience
import { useEffect, useState } from 'react';
import { Alert, Animated, Linking, Text, View } from 'react-native';
import logger, { maskIdentifier } from '../../services/loggerService';
import { recordBreadcrumb, summarizeUri } from '../../services/crashDiagnosticsService';
import { isRealtimeKeySegment } from '../../services/identityService';
import { COLORS as THEME } from '../../theme';
import { parseTimestampMs as parseSharedTimestampMs } from '../../services/timeUtils';
export const {
  buildChatSearchResults,
  normalizeSearchQuery
} = require('../../utils/chatSearch');
export const {
  buildUnreadSummary
} = require('../../utils/chatUnreadSummary');
export const {
  buildReplyTargetIndex,
  collectMessageIdCandidates,
  resolveReplyTargetIndex
} = require('../../utils/chatReplyNavigation');
export const {
  buildChatTimelineItems,
  formatChatTimestamp,
  getOldestMessageCursor,
  mergeMessagesById
} = require('../../utils/chatTimeline');
export const {
  getSwipeReplyDragState,
  shouldStartSwipeReplyGesture,
  shouldTriggerSwipeReplyOnRelease
} = require('../../services/chatSwipeReplyGesture');
export const DEFAULT_CHAT_WINDOW_WIDTH = 360;

// Quick Reaction Emojis
export
// Quick Reaction Emojis
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
export const HEART_REACTION = QUICK_REACTIONS[1];
export const DOUBLE_TAP_REACTION_DELAY_MS = 300;
export const ESTIMATED_MESSAGE_ROW_HEIGHT = 120;
export const SEARCH_RESULT_PREVIEW_LIMIT = 3;
export const CATCH_UP_BUBBLE_DISTANCE_THRESHOLD = 220;
export const SWIPE_REPLY_HINT_KEY_PREFIX = 'swipe_reply_hint_seen';
export const SCROLL_BOTTOM_THRESHOLD = 16;
export const getExternalLinkDomain = url => {
  try {
    return new URL(url).hostname.replace('www.', '') || 'unknown';
  } catch {
    return 'unknown';
  }
};
export const openChatExternalLink = async url => {
  if (!url) return false;
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      throw new Error('No app can open this link');
    }
    await Linking.openURL(url);
    return true;
  } catch (error) {
    logger.warn('Chat', 'External link launch failed', {
      domain: getExternalLinkDomain(url),
      error: error?.message || String(error)
    });
    Alert.alert('Link unavailable', 'Could not open this link on your device.');
    return false;
  }
};
export const LIVE_CHAT_MESSAGE_LIMIT = 80;
export const CHAT_PAGE_MESSAGE_LIMIT = 40;
export const SEARCH_FILTERS = [{
  key: 'all',
  label: 'All',
  icon: 'message-text-outline'
}, {
  key: 'drivers',
  label: 'Drivers',
  icon: 'steering'
}, {
  key: 'mine',
  label: 'Mine',
  icon: 'account'
}, {
  key: 'links',
  label: 'Links',
  icon: 'link-variant'
}, {
  key: 'media',
  label: 'Photos',
  icon: 'image-outline'
}];

// URL Detection Regex
export
// URL Detection Regex
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

// Brand Colors
export
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
  overlay: THEME.overlay
};

// ==================== TYPING INDICATOR COMPONENT ====================
export
// ==================== TYPING INDICATOR COMPONENT ====================
const TypingIndicator = ({
  typingUsers
}) => {
  const [dots, setDots] = useState('');
  useEffect(() => {
    if (typingUsers.length === 0) return;
    const interval = setInterval(() => {
      setDots(prev => prev.length >= 3 ? '' : prev + '.');
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
  return <View style={styles.typingContainer}>
      <View style={styles.typingBubble}>
        <View style={styles.typingDots}>
          <Animated.View style={[styles.typingDot, {
          opacity: dots.length >= 1 ? 1 : 0.3
        }]} />
          <Animated.View style={[styles.typingDot, {
          opacity: dots.length >= 2 ? 1 : 0.3
        }]} />
          <Animated.View style={[styles.typingDot, {
          opacity: dots.length >= 3 ? 1 : 0.3
        }]} />
        </View>
        <Text style={styles.typingText}>{getTypingText()}</Text>
      </View>
    </View>;
};

// ==================== DATE SEPARATOR COMPONENT ====================
export
// ==================== DATE SEPARATOR COMPONENT ====================
const normalizeTimestamp = timestamp => {
  const parsed = parseSharedTimestampMs(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
};
export const isMessageOwnedByCurrentSession = (message, canonicalIdentity) => {
  const currentPrincipalType = typeof canonicalIdentity?.principalType === 'string' ? canonicalIdentity.principalType.trim() : '';
  const currentStableId = typeof canonicalIdentity?.stablePassengerId === 'string' ? canonicalIdentity.stablePassengerId.trim() : '';
  const senderPrincipalId = typeof message?.senderId === 'string' ? message.senderId.trim() : '';
  const currentPrincipalId = typeof canonicalIdentity?.principalId === 'string' ? canonicalIdentity.principalId.trim() : '';
  const senderStableId = typeof message?.senderStableId === 'string' ? message.senderStableId.trim() : '';
  const senderType = typeof message?.senderType === 'string' ? message.senderType.trim() : message?.isDriver ? 'driver' : 'passenger';
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
export const parseModerationMap = value => {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed).reduce((accumulator, [key, enabled]) => {
      if (enabled === true && typeof key === 'string' && key.trim()) {
        accumulator[key.trim()] = true;
      }
      return accumulator;
    }, {});
  } catch {
    return {};
  }
};
export const getMessageModerationSenderKey = message => {
  const candidates = [message?.senderStableId, message?.senderId];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return null;
};
export const buildReplyPreviewText = (message = {}) => {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'image') {
    const caption = typeof message.text === 'string' ? message.text.trim() : '';
    return caption ? `📷 ${caption}` : '📷 Photo';
  }
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  return text.length > 0 ? text : 'Message';
};
export const DateSeparator = ({
  date
}) => {
  const formatDateLabel = dateStr => {
    const normalized = normalizeTimestamp(dateStr);
    if (!Number.isFinite(normalized)) return 'Unknown date';
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
      day: 'numeric'
    });
  };
  return <View style={styles.dateSeparator}>
      <View style={styles.dateSeparatorLine} />
      <View style={styles.dateSeparatorBadge}>
        <Text style={styles.dateSeparatorText}>{formatDateLabel(date)}</Text>
      </View>
      <View style={styles.dateSeparatorLine} />
    </View>;
};
export const UnreadSeparator = () => <View style={styles.unreadSeparator}>
    <View style={styles.unreadSeparatorLine} />
    <View style={styles.unreadSeparatorBadge}>
      <Text style={styles.unreadSeparatorText}>Unread messages</Text>
    </View>
    <View style={styles.unreadSeparatorLine} />
  </View>;

// ==================== MESSAGE REACTIONS COMPONENT ====================
export
// ==================== MESSAGE REACTIONS COMPONENT ====================
const getReactionUserIds = users => {
  const normalizedUserIds = new Set();
  if (Array.isArray(users)) {
    users.forEach(userId => {
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
export const normalizeReactionMap = reactions => {
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
export const maskReactionDebugIds = (ids = []) => (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, 10).map(maskIdentifier);
export const summarizeReactionDebugId = id => {
  if (typeof id !== 'string' || !id.trim()) {
    return {
      present: false
    };
  }
  const normalized = id.trim();
  return {
    present: true,
    masked: maskIdentifier(normalized),
    length: normalized.length,
    isRealtimeSafe: isRealtimeKeySegment(normalized),
    containsEncodedDot: normalized.includes('_2E_'),
    containsDot: normalized.includes('.'),
    containsAt: normalized.includes('@')
  };
};
export const rawReactionDebugIds = (ids = []) => (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, 10).map(summarizeReactionDebugId);
export const summarizeReactionMapForDebug = (reactions, currentUserIds = []) => {
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
      currentUserPresent: userIds.some(userId => currentUserIdSet.has(userId)),
      truncated: userIds.length > 10
    }))
  };
};
export const summarizeMessagesForReactionDebug = (messages = [], currentUserIds = []) => {
  const messageSummaries = (Array.isArray(messages) ? messages : []).map(message => ({
    messageId: message?.id || null,
    ...summarizeReactionMapForDebug(message?.reactions, currentUserIds)
  })).filter(summary => summary.emojiCount > 0);
  return {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    reactionMessageCount: messageSummaries.length,
    reactionMessageSample: messageSummaries.slice(0, 5)
  };
};
export const summarizeImageAssetForDiagnostics = (asset = {}) => ({
  uri: summarizeUri(asset?.uri),
  width: typeof asset?.width === 'number' ? asset.width : null,
  height: typeof asset?.height === 'number' ? asset.height : null,
  fileSize: typeof asset?.fileSize === 'number' ? asset.fileSize : null,
  mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
  assetIdPresent: Boolean(asset?.assetId)
});
export const summarizeErrorForDiagnostics = error => ({
  name: error?.name || 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
  message: error?.message || String(error)
});
export const REMOTE_REACTION_DEBUG_EVENTS = new Set(['chat_reaction_actor_context', 'chat_reaction_target_message_missing', 'chat_reaction_optimistic_applied', 'chat_reaction_service_call_start', 'chat_reaction_service_call_success', 'chat_reaction_toggle_failed_rolled_back']);
export const logChatReactionDebug = (eventName, payload = {}, level = 'info') => {
  try {
    const persistLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    const loggerMethod = typeof logger?.[persistLevel] === 'function' ? persistLevel : 'warn';
    logger[loggerMethod]('ChatScreen', eventName, payload);
    if (REMOTE_REACTION_DEBUG_EVENTS.has(eventName) || persistLevel === 'warn' || persistLevel === 'error') {
      recordBreadcrumb('ChatReaction', eventName, payload, {
        remote: true,
        reason: `ChatReaction:${eventName}`
      });
    }
  } catch (_error) {
    // Debug logging should never affect chat behavior.
  }
};
export const applyOptimisticReactionToggle = ({
  reactions,
  emoji,
  userId,
  userIdAliases = []
}) => {
  const normalizedReactions = normalizeReactionMap(reactions);
  const existingUserIds = Array.isArray(normalizedReactions[emoji]) ? normalizedReactions[emoji] : [];
  const reactionUserIds = new Set([userId, ...userIdAliases].filter(Boolean));
  const matchedUserIds = existingUserIds.filter(existingUserId => reactionUserIds.has(existingUserId));
  const hasReaction = matchedUserIds.length > 0;
  const nextEmojiUserIds = hasReaction ? existingUserIds.filter(existingUserId => !reactionUserIds.has(existingUserId)) : [...existingUserIds, userId].sort((a, b) => a.localeCompare(b));
  const nextReactions = {
    ...normalizedReactions
  };
  if (nextEmojiUserIds.length === 0) {
    delete nextReactions[emoji];
  } else {
    nextReactions[emoji] = nextEmojiUserIds;
  }
  return {
    nextReactions,
    action: hasReaction ? 'removed' : 'added',
    matchedUserIds,
    nextEmojiUserIds
  };
};
export const applyOptimisticReactionAdd = ({
  reactions,
  emoji,
  userId,
  userIdAliases = []
}) => {
  const normalizedReactions = normalizeReactionMap(reactions);
  const existingUserIds = Array.isArray(normalizedReactions[emoji]) ? normalizedReactions[emoji] : [];
  const reactionUserIds = new Set([userId, ...userIdAliases].filter(Boolean));
  const matchedUserIds = existingUserIds.filter(existingUserId => reactionUserIds.has(existingUserId));
  const hasReaction = matchedUserIds.length > 0;
  const nextEmojiUserIds = hasReaction ? existingUserIds : [...existingUserIds, userId].sort((a, b) => a.localeCompare(b));
  return {
    nextReactions: {
      ...normalizedReactions,
      [emoji]: nextEmojiUserIds
    },
    action: hasReaction ? 'already_added' : 'added',
    matchedUserIds,
    nextEmojiUserIds
  };
};
