// components/ImageViewer.js
// Enhanced full-screen image viewer with swipe navigation, zoom, and actions
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Modal,
  TouchableOpacity,
  Dimensions,
  Platform,
  Animated,
  PanResponder,
  StatusBar,
  Share,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { COLORS, SPACING, RADIUS } from '../theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SWIPE_THRESHOLD = 80;
const VELOCITY_THRESHOLD = 0.3;

export default function ImageViewer({
  visible,
  photos,
  initialIndex = 0,
  onClose,
  onDelete,
  showUploaderInfo = false,
  canDelete = false,
  currentUserId = null,
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showInfo, setShowInfo] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const translateX = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const infoSlideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, visible]);

  useEffect(() => {
    if (visible) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      fadeAnim.setValue(0);
    }
  }, [visible]);

  useEffect(() => {
    Animated.spring(infoSlideAnim, {
      toValue: showInfo ? 1 : 0,
      friction: 8,
      tension: 40,
      useNativeDriver: true,
    }).start();
  }, [showInfo]);

  const currentPhoto = photos[currentIndex] || {};

  const goToNext = useCallback(() => {
    if (currentIndex < photos.length - 1) {
      setImageLoading(true);
      Animated.spring(translateX, {
        toValue: -SCREEN_WIDTH,
        friction: 10,
        tension: 40,
        useNativeDriver: true,
      }).start(() => {
        setCurrentIndex(prev => prev + 1);
        translateX.setValue(0);
      });
    }
  }, [currentIndex, photos.length]);

  const goToPrevious = useCallback(() => {
    if (currentIndex > 0) {
      setImageLoading(true);
      Animated.spring(translateX, {
        toValue: SCREEN_WIDTH,
        friction: 10,
        tension: 40,
        useNativeDriver: true,
      }).start(() => {
        setCurrentIndex(prev => prev - 1);
        translateX.setValue(0);
      });
    }
  }, [currentIndex]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 10;
      },
      onPanResponderMove: (_, gestureState) => {
        // Only allow horizontal movement within bounds
        const newX = gestureState.dx;
        if ((currentIndex === 0 && newX > 0) ||
            (currentIndex === photos.length - 1 && newX < 0)) {
          translateX.setValue(newX * 0.3); // Resistance at edges
        } else {
          translateX.setValue(newX);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        const { dx, vx } = gestureState;

        if (dx < -SWIPE_THRESHOLD || vx < -VELOCITY_THRESHOLD) {
          goToNext();
        } else if (dx > SWIPE_THRESHOLD || vx > VELOCITY_THRESHOLD) {
          goToPrevious();
        } else {
          // Snap back
          Animated.spring(translateX, {
            toValue: 0,
            friction: 10,
            tension: 40,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Unknown date';
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: currentPhoto.caption
          ? `${currentPhoto.caption}\n\nShared from Loch Lomond Travel`
          : 'Check out this photo from my Loch Lomond tour!',
        url: currentPhoto.url,
      });
    } catch (error) {
      console.log('Share error:', error);
    }
  };

  const handleSaveToDevice = async () => {
    try {
      setSaving(true);

      // Request permission
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to save photos to your device.');
        return;
      }

      // Download the image
      const filename = `llt_photo_${Date.now()}.jpg`;
      const fileUri = FileSystem.documentDirectory + filename;

      const downloadResult = await FileSystem.downloadAsync(currentPhoto.url, fileUri);

      if (downloadResult.status === 200) {
        await MediaLibrary.saveToLibraryAsync(downloadResult.uri);
        Alert.alert('Saved!', 'Photo has been saved to your device.');
      } else {
        throw new Error('Download failed');
      }
    } catch (error) {
      console.error('Save error:', error);
      Alert.alert('Error', 'Could not save the photo. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Photo',
      'Are you sure you want to delete this photo? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (onDelete) {
              onDelete(currentPhoto);
              if (photos.length <= 1) {
                onClose();
              } else if (currentIndex >= photos.length - 1) {
                setCurrentIndex(prev => prev - 1);
              }
            }
          },
        },
      ]
    );
  };

  const canDeleteThis = canDelete && currentPhoto.userId === currentUserId;

  const infoTranslateY = infoSlideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [200, 0],
  });

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar barStyle="light-content" backgroundColor="rgba(0,0,0,0.9)" />
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerButton}>
            <MaterialCommunityIcons name="close" size={28} color={COLORS.white} />
          </TouchableOpacity>

          <Text style={styles.counter}>
            {currentIndex + 1} / {photos.length}
          </Text>

          <TouchableOpacity
            onPress={() => setShowInfo(!showInfo)}
            style={styles.headerButton}
          >
            <MaterialCommunityIcons
              name={showInfo ? "information" : "information-outline"}
              size={26}
              color={COLORS.white}
            />
          </TouchableOpacity>
        </View>

        {/* Main Image Area */}
        <Animated.View
          style={[styles.imageContainer, { transform: [{ translateX }] }]}
          {...panResponder.panHandlers}
        >
          {imageLoading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={COLORS.white} />
            </View>
          )}
          <Image
            source={{ uri: currentPhoto.url }}
            style={styles.image}
            resizeMode="contain"
            onLoadStart={() => setImageLoading(true)}
            onLoadEnd={() => setImageLoading(false)}
          />

          {/* Navigation arrows for larger screens */}
          {currentIndex > 0 && (
            <TouchableOpacity
              style={[styles.navArrow, styles.navArrowLeft]}
              onPress={goToPrevious}
            >
              <MaterialCommunityIcons name="chevron-left" size={40} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          )}
          {currentIndex < photos.length - 1 && (
            <TouchableOpacity
              style={[styles.navArrow, styles.navArrowRight]}
              onPress={goToNext}
            >
              <MaterialCommunityIcons name="chevron-right" size={40} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          )}
        </Animated.View>

        {/* Bottom Actions */}
        <View style={styles.bottomActions}>
          <TouchableOpacity
            onPress={handleShare}
            style={styles.actionButton}
          >
            <MaterialCommunityIcons name="share-variant" size={24} color={COLORS.white} />
            <Text style={styles.actionText}>Share</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSaveToDevice}
            style={styles.actionButton}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={COLORS.white} />
            ) : (
              <MaterialCommunityIcons name="download" size={24} color={COLORS.white} />
            )}
            <Text style={styles.actionText}>{saving ? 'Saving...' : 'Save'}</Text>
          </TouchableOpacity>

          {canDeleteThis && (
            <TouchableOpacity
              onPress={handleDelete}
              style={[styles.actionButton, styles.deleteButton]}
            >
              <MaterialCommunityIcons name="delete-outline" size={24} color={COLORS.error} />
              <Text style={[styles.actionText, { color: COLORS.error }]}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Info Panel */}
        <Animated.View
          style={[
            styles.infoPanel,
            { transform: [{ translateY: infoTranslateY }] }
          ]}
        >
          <View style={styles.infoPanelHandle} />

          <Text style={styles.infoTitle}>Photo Details</Text>

          <View style={styles.infoRow}>
            <MaterialCommunityIcons name="calendar" size={20} color={COLORS.textSecondary} />
            <Text style={styles.infoLabel}>Taken</Text>
            <Text style={styles.infoValue}>{formatDate(currentPhoto.timestamp)}</Text>
          </View>

          {showUploaderInfo && currentPhoto.uploaderName && (
            <View style={styles.infoRow}>
              <MaterialCommunityIcons name="account" size={20} color={COLORS.textSecondary} />
              <Text style={styles.infoLabel}>By</Text>
              <Text style={styles.infoValue}>{currentPhoto.uploaderName}</Text>
            </View>
          )}

          {currentPhoto.caption && (
            <View style={styles.captionContainer}>
              <MaterialCommunityIcons name="text" size={20} color={COLORS.textSecondary} />
              <Text style={styles.captionText}>{currentPhoto.caption}</Text>
            </View>
          )}
        </Animated.View>

        {/* Dot indicators */}
        {photos.length > 1 && photos.length <= 10 && (
          <View style={styles.dotsContainer}>
            {photos.map((_, index) => (
              <View
                key={index}
                style={[
                  styles.dot,
                  index === currentIndex && styles.dotActive,
                ]}
              />
            ))}
          </View>
        )}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingTop: Platform.OS === 'ios' ? 50 : 40,
    paddingBottom: SPACING.md,
    zIndex: 10,
  },
  headerButton: {
    padding: SPACING.sm,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  counter: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '600',
  },
  imageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.65,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
  },
  navArrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -25,
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 25,
  },
  navArrowLeft: {
    left: 10,
  },
  navArrowRight: {
    right: 10,
  },
  bottomActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.xl,
    gap: SPACING.xxxl,
  },
  actionButton: {
    alignItems: 'center',
    padding: SPACING.sm,
  },
  actionText: {
    color: COLORS.white,
    fontSize: 12,
    marginTop: 4,
    fontWeight: '500',
  },
  deleteButton: {
    opacity: 0.9,
  },
  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: Platform.OS === 'ios' ? 30 : 20,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  dotActive: {
    backgroundColor: COLORS.white,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  infoPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.md,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    maxHeight: SCREEN_HEIGHT * 0.4,
  },
  infoPanelHandle: {
    width: 40,
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: SPACING.lg,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: SPACING.lg,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  infoLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
    width: 50,
  },
  infoValue: {
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '500',
    flex: 1,
  },
  captionContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: SPACING.sm,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: SPACING.sm,
  },
  captionText: {
    fontSize: 15,
    color: COLORS.textPrimary,
    lineHeight: 22,
    flex: 1,
  },
});
