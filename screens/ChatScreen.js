// screens/ChatScreen.js
import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { subscribeToChatMessages, sendMessage } from '../services/chatService';
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

export default function ChatScreen({ onBack, tourId, bookingData, tourData }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const scrollViewRef = useRef();
  const currentUser = auth.currentUser;

  useEffect(() => {
    if (!tourId) {
      console.error('No tourId provided to ChatScreen');
      setLoading(false);
      return;
    }

    // Subscribe to chat messages
    const unsubscribe = subscribeToChatMessages(tourId, (newMessages) => {
      setMessages(newMessages);
      setLoading(false);
      // Auto-scroll to bottom when new messages arrive
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    });

    // Cleanup subscription on unmount
    return () => {
      unsubscribe();
    };
  }, [tourId]);

  useEffect(() => {
    // Scroll to bottom when messages update
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const handleSendMessage = async () => {
    if (inputText.trim() === '' || sending) return;

    setSending(true);
    const messageText = inputText.trim();
    setInputText(''); // Clear input immediately for better UX

    try {
      // Determine sender name
      const senderName = bookingData?.passengerNames?.[0] || 'Tour Participant';
      
      const senderInfo = {
        name: senderName,
        userId: currentUser?.uid || 'anonymous',
        isDriver: false // Set to true if implementing driver chat
      };

      const result = await sendMessage(tourId, messageText, senderInfo);
      
      if (!result.success) {
        // If failed, restore the message
        setInputText(messageText);
        console.error('Failed to send message');
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setInputText(messageText); // Restore message on error
    } finally {
      setSending(false);
    }
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
  };

  const renderMessage = (msg) => {
    const isSelf = msg.senderId === currentUser?.uid;
    
    return (
      <View
        key={msg.id}
        style={[
          styles.messageRow,
          isSelf ? styles.myMessageRow : styles.theirMessageRow,
        ]}
      >
        <View style={[
          styles.messageBubble,
          isSelf ? styles.myMessageBubble : styles.theirMessageBubble,
          msg.isDriver ? styles.driverMessageBubble : {}
        ]}>
          {!isSelf && (
            <Text style={[styles.senderName, msg.isDriver ? styles.driverSenderName : {}]}>
              {msg.isDriver ? `Driver ${msg.senderName}` : msg.senderName}
            </Text>
          )}
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { backgroundColor: COLORS.chatHeaderColor }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>
        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerTitle}>Group Chat</Text>
          {tourData?.name && (
            <Text style={styles.headerSubtitle}>{tourData.name}</Text>
          )}
        </View>
        <View style={styles.headerButton} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardAvoidingContainer}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 60 : 80}
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
            onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: false })}
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
            style={styles.textInput}
            placeholder="Type your message here..."
            placeholderTextColor="#A0AEC0"
            value={inputText}
            onChangeText={setInputText}
            multiline
            selectionColor={COLORS.primaryBlue}
            editable={!sending}
          />
          <TouchableOpacity 
            style={[styles.sendButton, sending && styles.sendButtonDisabled]} 
            onPress={handleSendMessage} 
            activeOpacity={0.7}
            disabled={sending || inputText.trim() === ''}
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
    maxWidth: '80%',
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
  senderName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: COLORS.primaryBlue,
    marginBottom: 4,
  },
  driverSenderName: {
    color: COLORS.coralAccent,
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
    maxHeight: 120,
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