import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import {
  buildPhotoCacheKey,
  resolveThumbnailDisplayUri,
} from '../services/photoVariantService';
import { COLORS } from '../theme';

const GalleryPhotoTile = React.memo(function GalleryPhotoTile({
  photo,
  onPress,
  style,
  imageStyle,
  children,
  disabled = false,
}) {
  const uri = resolveThumbnailDisplayUri(photo);
  const cacheKey = buildPhotoCacheKey(photo, 'thumbnail');
  const source = uri ? (cacheKey ? { uri, cacheKey } : { uri }) : undefined;

  return (
    <TouchableOpacity
      style={[styles.tile, style]}
      onPress={onPress}
      activeOpacity={0.85}
      disabled={disabled}
    >
      <ExpoImage
        source={source}
        style={[styles.image, imageStyle]}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
      />
      {children ? <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>{children}</View> : null}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  tile: {
    overflow: 'hidden',
    backgroundColor: COLORS.border,
  },
  image: {
    width: '100%',
    height: '100%',
  },
});

export default GalleryPhotoTile;
