// screens/ChatScreen.js
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  sendInternalDriverMessage,
  sendMessage,
  subscribeToChatMessages,
  subscribeToInternalDriverChat,
} from '../services/chatService';
import { auth } from '../firebase';

// Brand Colors
const COLORS = {
  primaryBlue: '#007DC3',
  lightBlueAccent: '#AECAEC',
  coralAccent: '#FF7757',
  white: '#FFFFFF',
  darkText: '#1A202C',
  secondaryText: '#4A5568',
  appBackground: '#F0F4F8',
  chatScreenBackground: '#E6F3F8',
  myMessageBackground: '#007DC3',
  theirMessageBackground: '#FFFFFF',
  driverMessageBackground: '#FFF2E0',
  driverMessageBorder: '#FFCAA8',
  inputBackground: '#FFFFFF',
  sendButtonColor: '#FF7757',
  chatHeaderColor: '#2ECC71',
};

export default function ChatScreen({ onBack, tourId, bookingData, tourData, internalDriverChat = false }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [inputHeight, setInputHeight] = useState(44);
  const scrollViewRef = useRef(null);
  const currentUser = auth.currentUser;

  const scrollToBottom = (animated = true) => {
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated });
    });
  };

  useEffect(() => {
    if (!tourId) {
      console.error('No tourId provided to ChatScreen');
      setLoading(false);
      return;
    }

    const unsubscribe = (internalDriverChat ? subscribeToInternalDriverChat : subscribeToChatMessages)(tourId, (newMessages) => {
      setMessages(newMessages);
      setLoading(false);
      scrollToBottom(true);
    });

    return () => {
      unsubscribe();
    };
  }, [tourId, internalDriverChat]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => scrollToBottom(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => scrollToBottom(true));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleSendMessage = async () => {
    if (sending) return;

    const trimmed = inputText.trim();

    if (!trimmed) {
      return;
    }

    setSending(true);
    setInputText('');

    const senderName = bookingData?.passengerNames?.[0] || 'Tour Participant';
    
    // Explicitly check for driver flag from bookingData props (passed from App.js)
    const isDriver = bookingData?.isDriver === true;

    const senderInfo = {
      name: senderName,
      userId: currentUser?.uid || 'anonymous',
      isDriver: isDriver, // CRITICAL: Ensure this is true for drivers
    };

    const optimisticTimestamp = new Date().toISOString();
    const optimisticId = `local-${Date.now()}`;
    const optimisticMessage = {
      id: optimisticId,
      text: trimmed,
      senderName,
      senderId: senderInfo.userId,
      timestamp: optimisticTimestamp,
      isDriver: senderInfo.isDriver,
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    scrollToBottom(true);

    try {
      const sendFn = internalDriverChat ? sendInternalDriverMessage : sendMessage;
      const result = await sendFn(tourId, trimmed, senderInfo);

      if (!result?.success || !result?.message) {
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId));
        setInputText(trimmed);
        setSending(false);
        return;
      }

      const confirmedMessage = result.message;

      setMessages((prev) => {
        const filtered = prev.filter(
          (msg) => msg.id !== optimisticId && msg.id !== confirmedMessage.id
        );
        return [...filtered, confirmedMessage];
      });

      if (result.serverPromise?.finally) {
        result.serverPromise
          .then(() => setSending(false))
          .catch(() => {
            setMessages((prev) => prev.filter((msg) => msg.id !== confirmedMessage.id));
            setInputText(trimmed);
            setSending(false);
          });
      } else {
        setSending(false);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId));
      setInputText(trimmed);
      setSending(false);
    }
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';

    const date = new Date(timestamp);
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  const renderMessage = (msg) => {
    const isSelf = msg.senderId === currentUser?.uid;
    const isDriver = !!msg.isDriver;

    return (
      <View
        key={msg.id}
        style={[
          styles.messageRow,
          isSelf ? styles.myMessageRow : styles.theirMessageRow,
        ]}
      >
        <View
          style={[
            styles.messageBubble,
            isSelf ? styles.myMessageBubble : styles.theirMessageBubble,
            isDriver && styles.driverMessageBubble,
          ]}
        >
          <View style={styles.messageHeader}>
            <Text
              style={[
                styles.senderName,
                isSelf && styles.mySenderName,
                isDriver && styles.driverSenderName,
              ]}
            >
              {msg.senderName || 'Participant'}
            </Text>
            {isDriver && (
              <View style={styles.driverBadge}>
                <Text style={styles.driverBadgeText}>DRIVER</Text>
              </View>
            )}
          </View>
          <Text style={[styles.messageText, isSelf ? styles.myMessageText : {}]}>
            {msg.text}
          </Text>
          <Text style={[styles.timestamp, isSelf ? styles.myTimestamp : {}]}>
            {formatTime(msg.timestamp)}
          </Text>
        </View>
      </View>
    );
  };

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
          <Text style={styles.errorText}>Chat is not available</Text>
        </View>
      </SafeAreaView>
    );
  }

  // --- Dynamic Styling for Header based on User Type ---
  // If it's a driver viewing, maybe make the header slightly different or just standard green?
  // Currently keeping it consistent green for "Chat" vibes.

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { backgroundColor: COLORS.chatHeaderColor }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>
        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerTitle}>Group Chat</Text>
          {tourData?.name && <Text style={styles.headerSubtitle}>{tourData.name}</Text>}
        </View>
        <View style={styles.headerButton} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoidingContainer}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 70 : 90}
      >
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primaryBlue} />
            <Text style={styles.loadingText}>Loading messages...</Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollViewRef}
            contentContainerStyle={styles.messagesScrollContainer}
            onContentSizeChange={() => scrollToBottom(false)}
            showsVerticalScrollIndicator={false}
          >
            {messages.length === 0 ? (
              <View style={styles.emptyContainer}>
                <MaterialCommunityIcons name="chat-outline" size={60} color={COLORS.lightBlueAccent} />
                <Text style={styles.emptyText}>No messages yet</Text>
                <Text style={styles.emptySubtext}>Be the first to say hello!</Text>
              </View>
            ) : (
              messages.map(renderMessage)
            )}
          </ScrollView>
        )}

        <View style={styles.inputArea}>
          <TextInput
            style={[
              styles.textInput,
              { height: Math.min(Math.max(44, inputHeight), 160) },
            ]}
            placeholder="Type your message here..."
            placeholderTextColor="#A0AEC0"
            value={inputText}
            onChangeText={setInputText}
            multiline
            onContentSizeChange={(event) => setInputHeight(event.nativeEvent.contentSize.height)}
            selectionColor={COLORS.primaryBlue}
            editable={!sending}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[styles.sendButton, (sending || !inputText.trim()) && styles.sendButtonDisabled]}
            onPress={handleSendMessage}
            activeOpacity={0.7}
            disabled={sending || !inputText.trim()}
          >
            {sending ? (
              <ActivityIndicator size="small" color={COLORS.sendButtonColor} />
            ) : (
              <MaterialCommunityIcons
                name="send-circle"
                size={38}
                color={inputText.trim() === '' ? '#CBD5E0' : COLORS.sendButtonColor}
              />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.chatScreenBackground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: Platform.OS === 'ios' ? 12 : 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
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
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.white,
  },
  headerSubtitle: {
    fontSize: 12,
    color: COLORS.white,
    opacity: 0.8,
    marginTop: 2,
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
    marginTop: 10,
    fontSize: 16,
    color: COLORS.darkText,
    opacity: 0.7,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 16,
    color: COLORS.secondaryText,
    textAlign: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.darkText,
    marginTop: 20,
  },
  emptySubtext: {
    fontSize: 16,
    color: COLORS.darkText,
    opacity: 0.6,
    marginTop: 8,
  },
  messagesScrollContainer: {
    paddingVertical: 15,
    paddingHorizontal: 12,
    flexGrow: 1,
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  myMessageRow: {
    justifyContent: 'flex-end',
  },
  theirMessageRow: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '85%',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  myMessageBubble: {
    backgroundColor: COLORS.myMessageBackground,
    borderBottomRightRadius: 5,
  },
  theirMessageBubble: {
    backgroundColor: COLORS.theirMessageBackground,
    borderBottomLeftRadius: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  driverMessageBubble: {
    backgroundColor: COLORS.driverMessageBackground,
    borderColor: COLORS.driverMessageBorder,
    borderWidth: 1,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  senderName: {
    fontSize: 13,
    fontWeight: 'bold',
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
    paddingVertical: 3,
    backgroundColor: '#FFE1CE',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.driverMessageBorder,
  },
  driverBadgeText: {
    color: COLORS.coralAccent,
    fontSize: 11,
    fontWeight: '700',
  },
  messageText: {
    fontSize: 15,
    lineHeight: 22,
    color: COLORS.darkText,
  },
  myMessageText: {
    color: COLORS.white,
  },
  timestamp: {
    fontSize: 11,
    color: COLORS.secondaryText,
    opacity: 0.7,
    alignSelf: 'flex-end',
    marginTop: 5,
  },
  myTimestamp: {
    color: COLORS.lightBlueAccent,
    opacity: 0.8,
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#D1D9E6',
    backgroundColor: COLORS.inputBackground,
  },
  textInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 160,
    backgroundColor: '#F0F4F8',
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
    fontSize: 16,
    color: COLORS.darkText,
    marginRight: 8,
  },
  sendButton: {
    padding: 4,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
});