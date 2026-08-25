// screens/ChatScreen.js - Premium Chat Experience
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Modal, PanResponder, Pressable, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import * as Haptics from '../../services/hapticsService';
import { COLORS as THEME, SPACING } from '../../theme';
import {
  buildReplyPreviewText,
  COLORS,
  DEFAULT_CHAT_WINDOW_WIDTH,
  getReactionUserIds,
  getSwipeReplyDragState,
  normalizeTimestamp,
  openChatExternalLink,
  QUICK_REACTIONS,
  shouldStartSwipeReplyGesture,
  shouldTriggerSwipeReplyOnRelease,
  URL_REGEX,
} from './chatShared';
import styles from "./chatStyles";
export const MessageReactions = ({
  reactions,
  onReactionPress,
  messageId,
  currentUserId,
  currentUserIds = []
}) => {
  if (!reactions || Object.keys(reactions).length === 0) return null;
  const visibleReactions = Object.entries(reactions).map(([emoji, users]) => ({
    emoji,
    userIds: getReactionUserIds(users)
  })).filter(({
    userIds
  }) => userIds.length > 0);
  if (visibleReactions.length === 0) return null;
  const currentUserIdSet = new Set([currentUserId, ...currentUserIds].filter(Boolean));
  return <View style={styles.reactionsContainer}>
      {visibleReactions.map(({
      emoji,
      userIds
    }) => {
      const reactedByCurrentUser = userIds.some(userId => currentUserIdSet.has(userId));
      return <TouchableOpacity key={emoji} style={[styles.reactionBubble, reactedByCurrentUser && styles.reactionBubbleActive]} onPress={() => onReactionPress(messageId, emoji)} activeOpacity={0.7}>
            <Text style={styles.reactionEmoji}>{emoji}</Text>
            <Text style={[styles.reactionCount, reactedByCurrentUser && styles.reactionCountActive]}>
              {userIds.length}
            </Text>
          </TouchableOpacity>;
    })}
    </View>;
};

// ==================== REACTION PICKER MODAL ====================
export
// ==================== REACTION PICKER MODAL ====================
const ReactionPicker = ({
  visible,
  onClose,
  onSelectReaction,
  position
}) => {
  if (!visible) return null;
  return <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.reactionModalOverlay} onPress={onClose}>
        <View style={[styles.reactionPicker, position && {
        top: position.y - 60
      }]}>
          {QUICK_REACTIONS.map(emoji => <TouchableOpacity key={emoji} style={styles.reactionOption} onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onSelectReaction(emoji);
        }} activeOpacity={0.7}>
              <Text style={styles.reactionOptionEmoji}>{emoji}</Text>
            </TouchableOpacity>)}
        </View>
      </Pressable>
    </Modal>;
};

// ==================== MESSAGE ACTION MENU ====================
export
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
  onReport,
  onMuteSender,
  onCopyLink,
  onOpenLink,
  canDelete,
  canReport = false,
  canMuteSender = false,
  allowReactions = true,
  insets
}) => {
  if (!visible) return null;
  const safePreview = buildReplyPreviewText(message).slice(0, 120);
  const normalizedMessageTime = normalizeTimestamp(message?.timestamp);
  const messageTimeLabel = Number.isFinite(normalizedMessageTime) ? new Date(normalizedMessageTime).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }) : 'Unknown time';
  const firstLinkMatch = typeof message?.text === 'string' ? message.text.match(URL_REGEX) : null;
  const hasLink = Array.isArray(firstLinkMatch) && firstLinkMatch.length > 0;
  return <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.actionMenuOverlay} onPress={onClose}>
        <Pressable style={[styles.actionMenuSheet, {
        paddingBottom: Math.max(insets?.bottom || 0, SPACING.md)
      }]} onPress={() => {}}>
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

          {allowReactions && <View style={styles.actionQuickReactionRow}>
              {QUICK_REACTIONS.map(emoji => <TouchableOpacity key={`quick-reaction-${emoji}`} style={styles.actionQuickReaction} onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onReact(emoji);
          }} activeOpacity={0.7}>
                  <Text style={styles.actionQuickReactionEmoji}>{emoji}</Text>
                </TouchableOpacity>)}
              <TouchableOpacity style={styles.actionQuickReaction} onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onOpenReactionPicker();
          }} activeOpacity={0.7}>
                <MaterialCommunityIcons name="dots-horizontal" size={20} color={COLORS.secondaryText} />
              </TouchableOpacity>
            </View>}

          <TouchableOpacity style={styles.actionMenuItem} onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onCopy();
        }}>
            <MaterialCommunityIcons name="content-copy" size={22} color={COLORS.darkText} />
            <Text style={styles.actionMenuText}>Copy</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionMenuItem} onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onReply();
        }}>
            <MaterialCommunityIcons name="reply-outline" size={22} color={COLORS.darkText} />
            <Text style={styles.actionMenuText}>Reply</Text>
          </TouchableOpacity>

          {hasLink && <>
              <TouchableOpacity style={styles.actionMenuItem} onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onOpenLink();
          }}>
                <MaterialCommunityIcons name="open-in-new" size={22} color={COLORS.darkText} />
                <Text style={styles.actionMenuText}>Open Link</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionMenuItem} onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onCopyLink();
          }}>
                <MaterialCommunityIcons name="link-variant" size={22} color={COLORS.darkText} />
                <Text style={styles.actionMenuText}>Copy Link</Text>
              </TouchableOpacity>
            </>}

          {canReport && <TouchableOpacity style={styles.actionMenuItem} onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onReport();
        }}>
              <MaterialCommunityIcons name="flag-outline" size={22} color={THEME.error} />
              <Text style={[styles.actionMenuText, {
            color: THEME.error
          }]}>Report</Text>
            </TouchableOpacity>}

          {canMuteSender && <TouchableOpacity style={styles.actionMenuItem} onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onMuteSender();
        }}>
              <MaterialCommunityIcons name="account-cancel-outline" size={22} color={COLORS.darkText} />
              <Text style={styles.actionMenuText}>Mute sender</Text>
            </TouchableOpacity>}

          {canDelete && <TouchableOpacity style={[styles.actionMenuItem, styles.actionMenuItemDanger]} onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onDelete();
        }}>
              <MaterialCommunityIcons name="delete-outline" size={22} color={THEME.error} />
              <Text style={[styles.actionMenuText, {
            color: THEME.error
          }]}>Delete</Text>
            </TouchableOpacity>}
        </Pressable>
      </Pressable>
    </Modal>;
};

// ==================== IMAGE MESSAGE COMPONENT ====================
export
// ==================== IMAGE MESSAGE COMPONENT ====================
const ImageMessage = React.memo(({
  imageUrl,
  onPress,
  imageSize = DEFAULT_CHAT_WINDOW_WIDTH * 0.55
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const imageSquareStyle = useMemo(() => ({
    width: imageSize,
    height: imageSize
  }), [imageSize]);
  const imageErrorStyle = useMemo(() => ({
    width: imageSize,
    height: Math.max(92, Math.round(imageSize * 0.64))
  }), [imageSize]);
  return <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={styles.imageMessageContainer}>
      {loading && <View style={[styles.imageLoading, imageSquareStyle]}>
          <ActivityIndicator size="small" color={COLORS.primaryBlue} />
        </View>}
      {error ? <View style={[styles.imageError, imageErrorStyle]}>
          <MaterialCommunityIcons name="image-broken" size={40} color={COLORS.secondaryText} />
          <Text style={styles.imageErrorText}>Failed to load image</Text>
        </View> : <Image source={{
      uri: imageUrl,
      cache: 'force-cache'
    }} style={[styles.messageImage, imageSquareStyle]} onLoadStart={() => setLoading(true)} onLoadEnd={() => setLoading(false)} onError={() => {
      setLoading(false);
      setError(true);
    }} progressiveRenderingEnabled fadeDuration={120} resizeMode="cover" />}
    </TouchableOpacity>;
});

// ==================== LINK PREVIEW COMPONENT ====================
export
// ==================== LINK PREVIEW COMPONENT ====================
const LinkPreview = ({
  url
}) => {
  const domain = useMemo(() => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return url;
    }
  }, [url]);
  return <TouchableOpacity style={styles.linkPreview} onPress={() => openChatExternalLink(url)} activeOpacity={0.7}>
      <MaterialCommunityIcons name="link-variant" size={16} color={COLORS.linkColor} />
      <Text style={styles.linkText} numberOfLines={1}>
        {domain}
      </Text>
      <MaterialCommunityIcons name="open-in-new" size={14} color={COLORS.linkColor} />
    </TouchableOpacity>;
};

// ==================== MESSAGE STATUS INDICATOR ====================
export
// ==================== MESSAGE STATUS INDICATOR ====================
const MessageStatus = ({
  status,
  isSelf
}) => {
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
export
// ==================== NEW MESSAGES BANNER ====================
const NewMessagesBanner = ({
  count,
  onPress,
  bottomOffset
}) => {
  if (count === 0) return null;
  return <TouchableOpacity style={[styles.newMessagesBanner, typeof bottomOffset === 'number' ? {
    bottom: bottomOffset
  } : null]} onPress={onPress} activeOpacity={0.9}>
      <MaterialCommunityIcons name="arrow-down" size={16} color={COLORS.white} />
      <Text style={styles.newMessagesBannerText}>
        {count} new message{count > 1 ? 's' : ''}
      </Text>
    </TouchableOpacity>;
};
export const UnreadCatchUpCard = ({
  summary,
  onJumpToUnread,
  onJumpToLatest,
  bottomOffset
}) => {
  if (!summary || !summary.count) return null;
  return <View style={[styles.catchUpCard, typeof bottomOffset === 'number' ? {
    bottom: bottomOffset
  } : null]}>
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
    </View>;
};
export const SwipeReplyHint = ({
  visible,
  onDismiss
}) => {
  if (!visible) return null;
  return <TouchableOpacity style={styles.swipeReplyHint} activeOpacity={0.92} onPress={onDismiss}>
      <MaterialCommunityIcons name="gesture-swipe-right" size={16} color={COLORS.primaryBlue} />
      <Text style={styles.swipeReplyHintText}>Tip: swipe a message right to reply quickly.</Text>
      <MaterialCommunityIcons name="close" size={14} color={COLORS.secondaryText} />
    </TouchableOpacity>;
};
export const SwipeToReplyMessageWrapper = ({
  children,
  onSwipeReply,
  disabled = false
}) => {
  const {
    width: windowWidth
  } = useWindowDimensions();
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
  const resetToOrigin = useCallback(({
    unlockTrigger = true
  } = {}) => {
    Animated.parallel([Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      speed: 26,
      bounciness: 4
    }), Animated.timing(feedbackOpacity, {
      toValue: 0,
      duration: 120,
      useNativeDriver: true
    }), Animated.timing(feedbackScale, {
      toValue: 0.9,
      duration: 120,
      useNativeDriver: true
    })]).start(() => {
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
      return shouldStartSwipeReplyGesture(gestureState, {
        disabled
      });
    },
    onMoveShouldSetPanResponderCapture: (_event, gestureState) => {
      return shouldStartSwipeReplyGesture(gestureState, {
        disabled
      });
    },
    onPanResponderMove: (_event, gestureState) => {
      if (triggerLatchRef.current) return;
      const dragState = getSwipeReplyDragState(gestureState, {
        screenWidth: windowWidth || DEFAULT_CHAT_WINDOW_WIDTH,
        peakDragX: peakDragRef.current
      });
      peakDragRef.current = dragState.peakDragX;
      translateX.setValue(dragState.dragX);
      feedbackOpacity.setValue(0.18 + dragState.progress * 0.82);
      feedbackScale.setValue(0.9 + dragState.progress * 0.12);
      setReadyToReply(dragState.isReleaseReady, true);
      if (dragState.shouldSnapActivate) {
        triggerSwipeReply({
          unlockTrigger: false
        });
      }
    },
    onPanResponderRelease: (_event, gestureState) => {
      if (triggerLatchRef.current) {
        resetToOrigin({
          unlockTrigger: true
        });
        return;
      }
      if (shouldTriggerSwipeReplyOnRelease(gestureState, {
        peakDragX: peakDragRef.current
      })) {
        triggerSwipeReply({
          unlockTrigger: true
        });
        return;
      }
      resetToOrigin({
        unlockTrigger: true
      });
    },
    onPanResponderTerminate: () => resetToOrigin({
      unlockTrigger: true
    }),
    onPanResponderTerminationRequest: () => false
  }), [disabled, feedbackOpacity, feedbackScale, resetToOrigin, setReadyToReply, translateX, triggerSwipeReply, windowWidth]);
  const feedbackColor = isReadyToReply ? THEME.success : COLORS.primaryBlue;
  return <View style={styles.swipeReplyRowContainer}>
      <Animated.View pointerEvents="none" style={[styles.swipeReplyFeedback, isReadyToReply && styles.swipeReplyFeedbackReady, {
      opacity: feedbackOpacity,
      transform: [{
        scale: feedbackScale
      }]
    }]}>
        <MaterialCommunityIcons name={isReadyToReply ? 'reply' : 'reply-outline'} size={16} color={feedbackColor} />
        <Text style={[styles.swipeReplyFeedbackText, isReadyToReply && styles.swipeReplyFeedbackTextReady]}>
          {isReadyToReply ? 'Reply ready' : 'Reply'}
        </Text>
      </Animated.View>
      <Animated.View style={{
      transform: [{
        translateX
      }]
    }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>;
};

// ==================== ATTACHMENT MENU ====================
