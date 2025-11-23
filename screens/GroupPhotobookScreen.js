// screens/GroupPhotobookScreen.js
import React, { useState, useEffect } from 'react';
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
  Alert
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { ref as storageRef, uploadBytesResumable, getDownloadURL, listAll } from 'firebase/storage';
import { storage } from '../firebase';

const windowWidth = Dimensions.get('window').width;
const windowHeight = Dimensions.get('window').height;

// Brand Colors
const COLORS = {
  primaryBlue: '#16a085',
  lightBlueAccent: '#AECAEC',
  coralAccent: '#FF7757',
  white: '#FFFFFF',
  darkText: '#1A202C',
  appBackground: '#F0F4F8',
  modalBackground: 'rgba(0, 20, 40, 0.9)',
};

export default function GroupPhotobookScreen({ onBack, userId, tourId }) {
  const [photos, setPhotos] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [loadingPhotos, setLoadingPhotos] = useState(true);

  useEffect(() => {
    if (tourId) {
      loadTourPhotos();
    }
  }, [tourId]);

  const loadTourPhotos = async () => {
    try {
      setLoadingPhotos(true);
      const tourPhotosRef = storageRef(storage, `group_tour_photos/${tourId}`);
      const result = await listAll(tourPhotosRef);
      
      const photoPromises = result.items.map(async (itemRef) => {
        const url = await getDownloadURL(itemRef);
        return {
          id: itemRef.name,
          url: url,
          name: itemRef.name
        };
      });
      
      const tourPhotos = await Promise.all(photoPromises);
      setPhotos(tourPhotos);
    } catch (error) {
      console.error("Error loading photos:", error);
    } finally {
      setLoadingPhotos(false);
    }
  };

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
      uploadImage(result.assets[0].uri);
    }
  };

  const uploadImage = async (imageUri) => {
    setUploading(true);
    
    try {
      // Convert URI to blob
      const response = await fetch(imageUri);
      const blob = await response.blob();
      
      // Create unique filename
      const fileName = `photo_${Date.now()}_${userId}.jpg`;
      const filePath = `group_tour_photos/${tourId}/${fileName}`;
      const fileRef = storageRef(storage, filePath);
      
      const uploadTask = uploadBytesResumable(fileRef, blob);
      
      uploadTask.on('state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          console.log('Upload is ' + progress + '% done');
        },
        (error) => {
          console.error("Upload failed:", error);
          Alert.alert('Upload Failed', 'Could not upload your photo. Please try again.');
          setUploading(false);
        },
        async () => {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          console.log('File available at', downloadURL);
          
          // Add to photos array
          setPhotos(prevPhotos => [...prevPhotos, {
            id: fileName,
            url: downloadURL,
            name: fileName
          }]);
          
          setUploading(false);
          Alert.alert('Success', 'Your photo has been uploaded!');
        }
      );
    } catch (error) {
      console.error("Error preparing upload:", error);
      Alert.alert('Upload Error', 'Could not prepare your photo for upload.');
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { backgroundColor: COLORS.primaryBlue }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton} activeOpacity={0.7}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={COLORS.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Group Photo Album</Text>
        <TouchableOpacity onPress={pickImage} style={styles.headerButton} activeOpacity={0.7} disabled={uploading}>
          {uploading ? (
            <ActivityIndicator size="small" color={COLORS.white} />
          ) : (
            <MaterialCommunityIcons name="camera-plus" size={26} color={COLORS.white} />
          )}
        </TouchableOpacity>
      </View>

      {loadingPhotos ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primaryBlue} />
          <Text style={styles.loadingText}>Loading tour photos...</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContainer}>
          {photos.length === 0 ? (
            <View style={styles.emptyContainer}>
              <MaterialCommunityIcons name="image-off" size={60} color={COLORS.lightBlueAccent} />
              <Text style={styles.emptyText}>No photos yet</Text>
              <Text style={styles.emptySubtext}>Be the first to share a photo with the group!</Text>
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
});