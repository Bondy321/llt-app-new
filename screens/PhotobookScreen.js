// screens/PhotobookScreen.js
import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Image,
  Dimensions,
  Modal,
  Platform,
  ActivityIndicator,
  Alert,
  RefreshControl
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { uploadPhoto, subscribeToTourPhotos } from '../services/photoService';

const windowWidth = Dimensions.get('window').width;
const windowHeight = Dimensions.get('window').height;

// Brand Colors
const COLORS = {
  primaryBlue: '#007DC3',
  lightBlueAccent: '#AECAEC',
  coralAccent: '#FF7757',
  white: '#FFFFFF',
  darkText: '#1A202C',
  appBackground: '#F0F4F8',
  modalBackground: 'rgba(0, 20, 40, 0.9)',
};

export default function PhotobookScreen({ onBack, userId, tourId }) {
  const [photos, setPhotos] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!tourId || !userId) return undefined;

    setLoadingPhotos(true);
    const unsubscribe = subscribeToTourPhotos(tourId, (photoList) => {
      const userOnlyPhotos = photoList.filter((photo) => photo.userId === userId);
      setPhotos(userOnlyPhotos);
      setLoadingPhotos(false);
      setRefreshing(false);
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [tourId, userId]);

  const requestPermissions = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Needed', 'Sorry, we need camera roll permissions to make this work!');
      return false;
    }
    return true;
  };

  const pickImage = async () => {
    const hasPermission = await requestPermissions();
    if (!hasPermission) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
    });

    if (!result.canceled) {
      handleUpload(result.assets[0].uri);
    }
  };

  const getUploadErrorMessage = (error) => {
    switch (error?.code) {
      case 'file-too-large':
        return 'Please choose a photo smaller than 5MB to upload.';
      case 'permission-denied':
        return 'Please check your connection or permissions and try again.';
      case 'network-error':
        return 'Network error occurred while uploading. Please try again.';
      case 'invalid-params':
        return 'Something went wrong preparing your photo. Please try again.';
      default:
        return 'Could not upload your photo. Please try again.';
    }
  };

  const handleUpload = async (imageUri) => {
    setUploading(true);

    try {
      await uploadPhoto(imageUri, tourId, userId);
      Alert.alert('Success', 'Your photo has been uploaded!');
    } catch (error) {
      const message = getUploadErrorMessage(error);
      Alert.alert('Upload Failed', message);
    } finally {
      setUploading(false);
    }
  };

  const openImage = (image) => {
    setSelectedImage(image);
    setModalVisible(true);
  };

  const closeImage = () => {
    setModalVisible(false);
    setTimeout(() => setSelectedImage(null), 300);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { backgroundColor: COLORS.primaryBlue }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Photos</Text>
        <TouchableOpacity onPress={pickImage} style={styles.headerButton} activeOpacity={0.7} disabled={uploading}>
          {uploading ? (
            <MaterialCommunityIcons name="progress-upload" size={26} color={COLORS.white} />
          ) : (
            <MaterialCommunityIcons name="camera-plus" size={26} color={COLORS.white} />
          )}
        </TouchableOpacity>
      </View>

      {uploading && (
        <View style={styles.progressContainer}>
          <ActivityIndicator size="small" color={COLORS.primaryBlue} />
          <Text style={styles.progressText}>Uploading...</Text>
        </View>
      )}

      {loadingPhotos ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primaryBlue} />
          <Text style={styles.loadingText}>Loading your photos...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContainer}
          refreshControl={(
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primaryBlue} />
          )}
        >
          {photos.length === 0 ? (
            <View style={styles.emptyContainer}>
              <View style={styles.emptyIconWrapper}>
                <MaterialCommunityIcons name="lock-image" size={66} color={COLORS.primaryBlue} />
              </View>
              <Text style={styles.emptyText}>Your private album is empty</Text>
              <Text style={styles.emptySubtext}>
                Save special memories from this tour. Only you can see these photos.
              </Text>
              <TouchableOpacity style={styles.emptyCtaButton} onPress={pickImage} activeOpacity={0.85} disabled={uploading}>
                <MaterialCommunityIcons name="upload" size={22} color={COLORS.white} />
                <Text style={styles.emptyCtaText}>Add your first photo</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.grid}>
              {photos.map((photo) => (
                <TouchableOpacity
                  key={photo.id}
                  style={styles.imageTouchable}
                  onPress={() => openImage(photo)}
                  activeOpacity={0.8}
                >
                  <Image source={{ uri: photo.url }} style={styles.imageThumbnail} />
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {selectedImage && (
        <Modal
          animationType="fade"
          transparent={true}
          visible={modalVisible}
          onRequestClose={closeImage}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Image source={{ uri: selectedImage.url }} style={styles.fullImage} resizeMode="contain" />
            </View>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={closeImage}
              activeOpacity={0.7}
            >
              <MaterialCommunityIcons name="close" size={32} color={COLORS.lightBlueAccent} />
            </TouchableOpacity>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.appBackground,
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
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.white,
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
  scrollContainer: {
    padding: 8,
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.darkText,
    marginTop: 20,
  },
  emptySubtext: {
    fontSize: 16,
    color: COLORS.darkText,
    opacity: 0.7,
    marginTop: 10,
    textAlign: 'center',
  },
  emptyIconWrapper: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#EAF6FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCtaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: COLORS.primaryBlue,
    borderRadius: 12,
    marginTop: 20,
  },
  emptyCtaText: {
    color: COLORS.white,
    fontWeight: '600',
    fontSize: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  imageTouchable: {
    width: (windowWidth - 16) / 3,
    height: (windowWidth - 16) / 3,
    padding: 4,
  },
  imageThumbnail: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
    backgroundColor: '#E2E8F0',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: COLORS.modalBackground,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: windowWidth * 0.95,
    alignItems: 'center',
  },
  fullImage: {
    width: '100%',
    height: windowHeight * 0.6,
    borderRadius: 15,
  },
  closeButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 50 : 30,
    right: 20,
    padding: 10,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 20,
  },
  progressContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#EAF6FF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  progressText: {
    width: 50,
    textAlign: 'right',
    fontWeight: '700',
    color: COLORS.darkText,
  },
});