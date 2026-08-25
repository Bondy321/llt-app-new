// screens/ChatScreen.js - Premium Chat Experience
import React from 'react';
import { ActivityIndicator, Image, Modal, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import * as Haptics from '../../services/hapticsService';
import { COLORS as THEME } from '../../theme';
import SyncStatusBanner from '../../components/SyncStatusBanner';
import { COLORS } from "./chatShared";
import { MessageActionMenu } from "./ChatMessageActions";
import styles from "./chatStyles";
export
// ==================== ATTACHMENT MENU ====================
const AttachmentMenu = ({
  visible,
  onClose,
  onPickImage,
  onTakePhoto
}) => {
  if (!visible) return null;
  return <View style={styles.attachmentMenu}>
      <TouchableOpacity style={styles.attachmentOption} onPress={() => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPickImage();
    }} activeOpacity={0.7}>
        <View style={[styles.attachmentIconBg, {
        backgroundColor: THEME.primaryMuted
      }]}>
          <MaterialCommunityIcons name="image" size={24} color={COLORS.primaryBlue} />
        </View>
        <Text style={styles.attachmentLabel}>Gallery</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.attachmentOption} onPress={() => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onTakePhoto();
    }} activeOpacity={0.7}>
        <View style={[styles.attachmentIconBg, {
        backgroundColor: THEME.errorLight
      }]}>
          <MaterialCommunityIcons name="camera" size={24} color={THEME.error} />
        </View>
        <Text style={styles.attachmentLabel}>Camera</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.attachmentOption} onPress={onClose} activeOpacity={0.7}>
        <View style={[styles.attachmentIconBg, {
        backgroundColor: COLORS.surfaceSecondary
      }]}>
          <MaterialCommunityIcons name="close" size={24} color={COLORS.secondaryText} />
        </View>
        <Text style={styles.attachmentLabel}>Cancel</Text>
      </TouchableOpacity>
    </View>;
};

// ==================== IMAGE VIEWER MODAL ====================
export
// ==================== IMAGE VIEWER MODAL ====================
const ImageViewerModal = ({
  visible,
  imageUrl,
  onClose,
  imageStyle
}) => {
  if (!visible) return null;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.imageViewerOverlay}>
        <TouchableOpacity style={styles.imageViewerClose} onPress={onClose}>
          <MaterialCommunityIcons name="close" size={28} color={COLORS.white} />
        </TouchableOpacity>
        <Image source={{
        uri: imageUrl
      }} style={[styles.fullScreenImage, imageStyle]} resizeMode="contain" />
      </View>
    </Modal>;
};
export const AttachmentTray = AttachmentMenu;
export const ChatActionSheet = MessageActionMenu;
export const ChatHeader = React.memo(({
  internalDriverChat,
  isSearchOpen,
  onBack,
  onToggleSearch,
  onSync,
  onlineCount,
  queueStats,
  isConnected
}) => <LinearGradient colors={internalDriverChat ? [COLORS.primaryDark, COLORS.primaryBlue] : [COLORS.primaryBlue, COLORS.primaryLight]} start={{
  x: 0,
  y: 0
}} end={{
  x: 1,
  y: 1
}} style={styles.header}>
    <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
      <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
    </TouchableOpacity>

    <View style={styles.headerTitleContainer}>
      <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.84}>
        {internalDriverChat ? 'Driver Chat' : 'Group Chat'}
      </Text>
      <View style={styles.onlineIndicator}>
        <View style={[styles.onlineDot, {
        backgroundColor: isConnected ? COLORS.onlineIndicator : COLORS.tertiaryText
      }]} />
        <Text style={styles.onlineCount}>{isConnected ? `${onlineCount} online` : 'Offline'}</Text>
      </View>
    </View>

    <View style={styles.headerRight}>
      <TouchableOpacity style={styles.syncNowBtn} onPress={onToggleSearch} accessibilityRole="button" accessibilityLabel="Search chat messages" hitSlop={8}>
        <MaterialCommunityIcons name={isSearchOpen ? 'close' : 'magnify'} size={18} color={COLORS.white} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.syncNowBtn} onPress={onSync} accessibilityRole="button" accessibilityLabel={queueStats.pending > 0 || queueStats.syncing > 0 ? 'Sync pending' : 'Messages sent'} hitSlop={8}>
        <MaterialCommunityIcons name={queueStats.pending > 0 || queueStats.syncing > 0 ? 'check' : 'check-all'} size={18} color={COLORS.white} />
      </TouchableOpacity>
    </View>
  </LinearGradient>);
export const ChatFeedbackHost = React.memo(({
  syncState,
  syncOutcomeText,
  lastSuccessfulSyncAt,
  onRetrySync,
  reactionFeedbackMessage,
  replyJumpFeedbackMessage,
  transientFeedback,
  imageSendState,
  onRetryImage,
  draftRestored
}) => {
  const feedbackRows = [];
  if (reactionFeedbackMessage) {
    feedbackRows.push({
      key: 'reaction',
      type: 'error',
      icon: 'wifi-alert',
      message: reactionFeedbackMessage
    });
  }
  if (replyJumpFeedbackMessage) {
    feedbackRows.push({
      key: 'reply-jump',
      type: 'info',
      icon: 'message-alert-outline',
      message: replyJumpFeedbackMessage
    });
  }
  if (transientFeedback?.message) {
    feedbackRows.push({
      key: 'transient',
      type: transientFeedback.type || 'info',
      icon: transientFeedback.icon || 'information-outline',
      message: transientFeedback.message
    });
  }
  if (draftRestored) {
    feedbackRows.push({
      key: 'draft',
      type: 'info',
      icon: 'content-save-edit-outline',
      message: 'Draft restored'
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
      loading: imageSendState.status === 'uploading'
    });
  }
  if (!syncState && feedbackRows.length === 0) return null;
  return <View style={styles.feedbackHost}>
      {syncState ? <SyncStatusBanner state={syncState} outcomeText={syncOutcomeText} lastSyncAt={lastSuccessfulSyncAt} onRetry={syncState?.canRetry ? onRetrySync : null} compact /> : null}
      {feedbackRows.map(item => <View key={item.key} style={[styles.feedbackPill, item.type === 'error' && styles.feedbackPillError, item.type === 'success' && styles.feedbackPillSuccess]}>
          {item.loading ? <ActivityIndicator size="small" color={COLORS.primaryBlue} /> : <MaterialCommunityIcons name={item.icon} size={16} color={item.type === 'error' ? THEME.error : item.type === 'success' ? THEME.success : COLORS.primaryBlue} />}
          <Text style={[styles.feedbackPillText, item.type === 'error' && styles.feedbackPillTextError, item.type === 'success' && styles.feedbackPillTextSuccess]}>
            {item.message}
          </Text>
          {item.actionLabel && item.onAction ? <TouchableOpacity style={styles.feedbackPillAction} onPress={item.onAction} activeOpacity={0.8}>
              <Text style={styles.feedbackPillActionText}>{item.actionLabel}</Text>
            </TouchableOpacity> : null}
        </View>)}
    </View>;
});
export const ChatLoadingSkeleton = () => <View style={styles.skeletonContainer}>
    {[0, 1, 2, 3, 4, 5].map(item => <View key={`chat-skeleton-${item}`} style={[styles.skeletonRow, item % 3 === 2 ? styles.skeletonRowSelf : styles.skeletonRowOther]}>
        <View style={[styles.skeletonBubble, item % 2 === 0 && styles.skeletonBubbleWide]} />
      </View>)}
  </View>;
export const LoadOlderControl = React.memo(({
  visible,
  loading,
  onPress
}) => {
  if (!visible) return null;
  return <TouchableOpacity style={styles.loadOlderButton} onPress={onPress} activeOpacity={0.86} disabled={loading} accessibilityRole="button" accessibilityLabel={loading ? 'Loading older messages' : 'Load older messages'}>
      {loading ? <ActivityIndicator size="small" color={COLORS.primaryBlue} /> : <MaterialCommunityIcons name="chevron-up" size={18} color={COLORS.primaryBlue} />}
      <Text style={styles.loadOlderButtonText}>{loading ? 'Loading older messages' : 'Load older messages'}</Text>
    </TouchableOpacity>;
});
export const ChatFloatingJump = React.memo(({
  mode,
  count,
  summary,
  bottomOffset,
  onJumpToUnread,
  onJumpToLatest
}) => {
  if (mode === 'unread' && summary?.count) {
    return <TouchableOpacity style={[styles.floatingJumpCard, typeof bottomOffset === 'number' ? {
      bottom: bottomOffset
    } : null]} onPress={onJumpToUnread} activeOpacity={0.9}>
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
          <TouchableOpacity style={styles.floatingJumpLatest} onPress={onJumpToLatest} activeOpacity={0.8}>
            <Text style={styles.floatingJumpLatestText}>Latest</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>;
  }
  if (mode === 'new' && count > 0) {
    return <TouchableOpacity style={[styles.floatingJumpPill, typeof bottomOffset === 'number' ? {
      bottom: bottomOffset
    } : null]} onPress={onJumpToLatest} activeOpacity={0.9}>
        <MaterialCommunityIcons name="arrow-down" size={16} color={COLORS.white} />
        <Text style={styles.floatingJumpPillText}>
          {count} new message{count > 1 ? 's' : ''}
        </Text>
      </TouchableOpacity>;
  }
  return null;
});
