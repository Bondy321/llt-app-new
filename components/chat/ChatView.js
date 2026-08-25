// screens/ChatScreen.js - Premium Chat Experience

import { KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import * as Haptics from '../../services/hapticsService';
import { COLORS as THEME } from '../../theme';
import { ESTIMATED_MESSAGE_ROW_HEIGHT, SEARCH_FILTERS, COLORS, TypingIndicator, isMessageOwnedByCurrentSession, getMessageModerationSenderKey } from "./chatShared";
import { ReactionPicker, SwipeReplyHint } from "./ChatMessageActions";
import { ImageViewerModal, AttachmentTray, ChatActionSheet, ChatHeader, ChatFeedbackHost, ChatFloatingJump } from "./ChatChrome";
import { ChatTimeline, ChatComposer } from "./ChatTimeline";
import styles from "./chatStyles";
export default function ChatView(props) {
  const {
    canonicalIdentity,
    chatLoadError,
    composerBottomInset,
    cycleSearchResult,
    dismissSwipeReplyHint,
    draftRestored,
    filteredSearchResults,
    floatingUiBottomInset,
    formatTime,
    fullScreenImageStyle,
    groupedMessages,
    handleCopyFirstLink,
    handleCopyMessage,
    handleDeleteMessage,
    handleLoadOlderMessages,
    handleManualSync,
    handleMuteSender,
    handleOpenFirstLink,
    handlePickImage,
    handleReaction,
    handleRefresh,
    handleReplyToMessage,
    handleReportMessage,
    handleRetryImageSend,
    handleScroll,
    handleScrollBeginDrag,
    handleSendMessage,
    handleTakePhoto,
    handleTextChange,
    hasMoreHistory,
    imageSendState,
    inputHeight,
    inputText,
    insets,
    internalDriverChat,
    isAtBottomRef,
    isConnected,
    isSearchOpen,
    jumpToMessageById,
    jumpToUnread,
    keyExtractor,
    lastSuccessfulSyncAt,
    listBottomSpacerHeight,
    listContentHeightRef,
    listViewportHeightRef,
    loading,
    loadingOlderMessages,
    markActiveChatRead,
    messageListRef,
    messages,
    newMessagesCount,
    onBack,
    pendingJumpIndexRef,
    presenceInfo,
    preserveScrollAfterPrependRef,
    queueStats,
    reactionFeedbackMessage,
    refreshing,
    renderEmptyMessages,
    renderMessageRow,
    replyJumpFeedbackMessage,
    replyingToMessage,
    scrollToBottom,
    searchFilter,
    searchQuery,
    searchResultPreviewCards,
    selectedMessage,
    sending,
    setComposerHeight,
    setInputHeight,
    setIsSearchOpen,
    setNewMessagesCount,
    setReplyingToMessage,
    setSearchFilter,
    setSearchQuery,
    setSelectedMessage,
    setShowActionMenu,
    setShowAttachmentMenu,
    setShowReactionPicker,
    setSubscriptionRevision,
    setViewingImage,
    showActionMenu,
    showAttachmentMenu,
    showJumpToUnread,
    showReactionPicker,
    showSwipeReplyHint,
    syncBannerContract,
    syncBannerOutcomeText,
    transientFeedback,
    typingUsers,
    unreadSummary,
    viewingImage,
    visibleMessages
  } = props;
  return <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ChatHeader internalDriverChat={internalDriverChat} isSearchOpen={isSearchOpen} onBack={onBack} onToggleSearch={() => {
      setIsSearchOpen(prev => !prev);
      if (isSearchOpen) setSearchQuery('');
    }} onSync={handleManualSync} onlineCount={presenceInfo.onlineCount} queueStats={queueStats} isConnected={isConnected} />

      {chatLoadError && messages.length > 0 ? <View style={styles.liveErrorBanner} accessibilityRole="alert">
          <MaterialCommunityIcons name="cloud-alert-outline" size={17} color={THEME.error} />
          <Text style={styles.liveErrorBannerText} numberOfLines={2}>
            Live updates paused. Your existing messages are still available.
          </Text>
          <TouchableOpacity onPress={() => setSubscriptionRevision(current => current + 1)} accessibilityRole="button" accessibilityLabel="Retry live chat updates">
            <Text style={styles.liveErrorBannerAction}>Retry</Text>
          </TouchableOpacity>
        </View> : null}

      {isSearchOpen && <View style={styles.searchPanel}>
          <View style={styles.searchInputRow}>
            <MaterialCommunityIcons name="magnify" size={18} color={COLORS.secondaryText} />
            <TextInput style={styles.searchInput} placeholder="Search messages or names" placeholderTextColor={COLORS.tertiaryText} value={searchQuery} onChangeText={setSearchQuery} autoCorrect={false} autoCapitalize="none" accessibilityLabel="Search chat messages" />
            {searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Clear chat search">
                <MaterialCommunityIcons name="close-circle" size={18} color={COLORS.tertiaryText} />
              </TouchableOpacity>}
          </View>
          <View style={styles.searchMetaRow}>
            <Text style={styles.searchMetaText}>
              {searchQuery.trim().length === 0 ? 'Type to search this conversation' : `${filteredSearchResults.length} message${filteredSearchResults.length === 1 ? '' : 's'} matched`}
            </Text>
            <View style={styles.searchNavButtons}>
              <TouchableOpacity style={[styles.searchNavBtn, filteredSearchResults.length === 0 && styles.searchNavBtnDisabled]} onPress={() => cycleSearchResult(-1)} disabled={filteredSearchResults.length === 0} accessibilityRole="button" accessibilityLabel="Previous search result" accessibilityState={{
            disabled: filteredSearchResults.length === 0
          }}>
                <MaterialCommunityIcons name="chevron-up" size={18} color={COLORS.primaryBlue} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.searchNavBtn, filteredSearchResults.length === 0 && styles.searchNavBtnDisabled]} onPress={() => cycleSearchResult(1)} disabled={filteredSearchResults.length === 0} accessibilityRole="button" accessibilityLabel="Next search result" accessibilityState={{
            disabled: filteredSearchResults.length === 0
          }}>
                <MaterialCommunityIcons name="chevron-down" size={18} color={COLORS.primaryBlue} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.searchFiltersRow}>
            {SEARCH_FILTERS.map(filter => {
          const active = searchFilter === filter.key;
          return <TouchableOpacity key={filter.key} style={[styles.searchFilterChip, active && styles.searchFilterChipActive]} onPress={() => setSearchFilter(filter.key)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={`Filter chat by ${filter.label}`} accessibilityState={{
            selected: active
          }}>
                  <MaterialCommunityIcons name={filter.icon} size={14} color={active ? COLORS.white : COLORS.primaryBlue} />
                  <Text style={[styles.searchFilterLabel, active && styles.searchFilterLabelActive]}>
                    {filter.label}
                  </Text>
                </TouchableOpacity>;
        })}
          </View>

          {searchResultPreviewCards.length > 0 && <View style={styles.searchPreviewList}>
              {searchResultPreviewCards.map(item => <TouchableOpacity key={`search-preview-${item.id}`} style={[styles.searchPreviewCard, item.isActive && styles.searchPreviewCardActive]} onPress={() => jumpToMessageById(item.id)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={`Open message from ${item.senderName}: ${item.previewText}`}>
                  <View style={styles.searchPreviewHeader}>
                    <View style={styles.searchPreviewSenderRow}>
                      <Text style={styles.searchPreviewSender}>{item.senderName}</Text>
                      {item.isDriver && <View style={styles.searchPreviewDriverBadge}>
                          <Text style={styles.searchPreviewDriverBadgeText}>DRIVER</Text>
                        </View>}
                    </View>
                    <Text style={styles.searchPreviewTime}>{formatTime(item.timestamp)}</Text>
                  </View>
                  <Text numberOfLines={2} style={styles.searchPreviewText}>
                    {item.previewText}
                  </Text>
                </TouchableOpacity>)}
            </View>}
        </View>}

      <SwipeReplyHint visible={showSwipeReplyHint && visibleMessages.length > 0} onDismiss={dismissSwipeReplyHint} />

      <ChatFeedbackHost syncState={syncBannerContract} syncOutcomeText={syncBannerOutcomeText} lastSuccessfulSyncAt={lastSuccessfulSyncAt} onRetrySync={() => handleManualSync({
      retryFailedOnly: true
    })} reactionFeedbackMessage={reactionFeedbackMessage} replyJumpFeedbackMessage={replyJumpFeedbackMessage} transientFeedback={transientFeedback} imageSendState={imageSendState} onRetryImage={handleRetryImageSend} draftRestored={draftRestored} />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardAvoidingContainer} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}>
        <ChatTimeline loading={loading} messageListRef={messageListRef} groupedMessages={groupedMessages} keyExtractor={keyExtractor} renderMessageRow={renderMessageRow} renderEmptyMessages={renderEmptyMessages} listBottomSpacerHeight={listBottomSpacerHeight} onLayout={event => {
        listViewportHeightRef.current = event.nativeEvent.layout.height;
      }} onContentSizeChange={(_, contentHeight) => {
        const preserveRequest = preserveScrollAfterPrependRef.current;
        const previousContentHeight = listContentHeightRef.current;
        listContentHeightRef.current = contentHeight;
        if (preserveRequest) {
          preserveScrollAfterPrependRef.current = null;
          const delta = Math.max(contentHeight - preserveRequest.previousContentHeight, 0);
          messageListRef.current?.scrollToOffset({
            offset: preserveRequest.previousScrollY + delta,
            animated: false
          });
          return;
        }
        if (isAtBottomRef.current && contentHeight >= previousContentHeight) {
          scrollToBottom(false);
        }
      }} onScroll={handleScroll} onScrollBeginDrag={handleScrollBeginDrag} onScrollToIndexFailed={({
        index
      }) => {
        const fallbackOffset = Math.max(index * ESTIMATED_MESSAGE_ROW_HEIGHT - 80, 0);
        messageListRef.current?.scrollToOffset({
          offset: fallbackOffset,
          animated: true
        });
        const pendingTargetIndex = pendingJumpIndexRef.current;
        if (pendingTargetIndex == null || pendingTargetIndex !== index) {
          return;
        }
        setTimeout(() => {
          messageListRef.current?.scrollToIndex({
            index: pendingTargetIndex,
            animated: true,
            viewPosition: 0.45
          });
        }, 120);
      }} refreshing={refreshing} onRefresh={handleRefresh} hasMoreHistory={hasMoreHistory} loadingOlderMessages={loadingOlderMessages} onLoadOlderMessages={handleLoadOlderMessages} />

        {!loading && <TypingIndicator typingUsers={typingUsers} />}

        {!loading && <ChatFloatingJump mode={showJumpToUnread ? 'unread' : newMessagesCount > 0 ? 'new' : 'none'} count={newMessagesCount} summary={unreadSummary} bottomOffset={showJumpToUnread ? floatingUiBottomInset + 56 : floatingUiBottomInset} onJumpToUnread={jumpToUnread} onJumpToLatest={() => {
        scrollToBottom(true);
        setNewMessagesCount(0);
        markActiveChatRead({
          force: true
        });
      }} />}

        <AttachmentTray visible={!internalDriverChat && showAttachmentMenu} onClose={() => setShowAttachmentMenu(false)} onPickImage={handlePickImage} onTakePhoto={handleTakePhoto} />

        <ChatComposer composerBottomInset={composerBottomInset} inputHeight={inputHeight} inputText={inputText} sending={sending} replyingToMessage={replyingToMessage} showAttachmentMenu={showAttachmentMenu} attachmentsEnabled={!internalDriverChat} onComposerLayout={event => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setComposerHeight(prev => prev === nextHeight ? prev : nextHeight);
      }} onCancelReply={() => setReplyingToMessage(null)} onToggleAttachments={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setShowAttachmentMenu(prev => !prev);
      }} onTextChange={handleTextChange} onInputContentSizeChange={event => setInputHeight(event.nativeEvent.contentSize.height)} onSendMessage={handleSendMessage} />
      </KeyboardAvoidingView>

      {/* Modals */}
      <ChatActionSheet visible={showActionMenu} onClose={() => {
      setShowActionMenu(false);
      setSelectedMessage(null);
    }} message={selectedMessage} onCopy={handleCopyMessage} onReply={handleReplyToMessage} onReact={emoji => {
      setShowActionMenu(false);
      if (selectedMessage?.id && emoji) {
        handleReaction(selectedMessage.id, emoji);
      }
    }} onOpenReactionPicker={() => {
      setShowActionMenu(false);
      setShowReactionPicker(true);
    }} onCopyLink={handleCopyFirstLink} onOpenLink={handleOpenFirstLink} onDelete={handleDeleteMessage} onReport={handleReportMessage} onMuteSender={handleMuteSender} canDelete={!internalDriverChat && isMessageOwnedByCurrentSession(selectedMessage, canonicalIdentity)} canReport={Boolean(selectedMessage?.id && !selectedMessage?.deleted && !isMessageOwnedByCurrentSession(selectedMessage, canonicalIdentity))} canMuteSender={Boolean(selectedMessage?.id && !selectedMessage?.deleted && !isMessageOwnedByCurrentSession(selectedMessage, canonicalIdentity) && getMessageModerationSenderKey(selectedMessage))} allowReactions={!internalDriverChat} insets={insets} />

      <ReactionPicker visible={!internalDriverChat && showReactionPicker} onClose={() => {
      setShowReactionPicker(false);
      setSelectedMessage(null);
    }} onSelectReaction={emoji => {
      if (selectedMessage) {
        handleReaction(selectedMessage.id, emoji);
      }
    }} />

      <ImageViewerModal visible={!!viewingImage} imageUrl={viewingImage} onClose={() => setViewingImage(null)} imageStyle={fullScreenImageStyle} />
    </SafeAreaView>;
}
