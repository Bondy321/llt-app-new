// screens/ChatScreen.js - Premium Chat Experience
import { useCallback } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { COLORS } from "./chatShared";
import styles from "./chatStyles";
export default function useChatEmptyRenderer(context, late) {
  const {
    chatLoadError,
    onBack,
    setSubscriptionRevision,
    tourId
  } = context;
  const renderEmptyMessages = useCallback(() => <View style={styles.emptyContainer}>
      <LinearGradient colors={['#DBEAFE', '#EFF6FF']} style={styles.emptyIconContainer}>
        <MaterialCommunityIcons name="chat-processing-outline" size={60} color={COLORS.primaryBlue} />
      </LinearGradient>
      <Text style={styles.emptyText}>{chatLoadError ? 'Messages unavailable' : 'No messages yet'}</Text>
      <Text style={styles.emptySubtext}>
        {chatLoadError || 'Say hello, share a useful update, or send a photo from the tour.'}
      </Text>
      {chatLoadError ? <TouchableOpacity style={styles.emptyRetryButton} onPress={() => setSubscriptionRevision(current => current + 1)} accessibilityRole="button" accessibilityLabel="Retry loading messages">
          <MaterialCommunityIcons name="refresh" size={18} color={COLORS.white} />
          <Text style={styles.emptyRetryButtonText}>Retry</Text>
        </TouchableOpacity> : <View style={styles.emptyTips}>
        <View style={styles.emptyTip}>
          <MaterialCommunityIcons name="image" size={20} color={COLORS.primaryBlue} />
          <Text style={styles.emptyTipText}>Share photos</Text>
        </View>
        <View style={styles.emptyTip}>
          <MaterialCommunityIcons name="emoticon" size={20} color={COLORS.coralAccent} />
          <Text style={styles.emptyTipText}>React to messages</Text>
        </View>
      </View>}
    </View>, [chatLoadError, setSubscriptionRevision]);

  // Error state
  // Error state
  if (!tourId) {
    return <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={[styles.header, {
        backgroundColor: COLORS.chatHeaderColor
      }]}>
          <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Go back">
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
      </SafeAreaView>;
  }
  Object.assign(late.current, {
    renderEmptyMessages
  });
  return {
    renderEmptyMessages
  };
}
