import React from 'react';
import { Image as RNImage, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
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
  useExpoImage = true,
  onImageLoadStart = null,
  onImageLoad = null,
  onImageError = null,
}) {
  const uri = resolveThumbnailDisplayUri(photo);
  const cacheKey = buildPhotoCacheKey(photo, 'thumbnail');
  const source = uri ? (cacheKey ? { uri, cacheKey } : { uri }) : undefined;
  const recyclingKey = cacheKey || uri || photo?.id || photo?.idempotencyKey || 'photo-placeholder';

  return (
    <TouchableOpacity
      style={[styles.tile, style]}
      onPress={onPress}
      activeOpacity={0.85}
      disabled={disabled}
    >
      {source && useExpoImage ? (
        <ExpoImage
          source={source}
          style={[styles.image, imageStyle]}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={recyclingKey}
          transition={120}
          onLoadStart={() => onImageLoadStart?.(photo)}
          onLoad={() => onImageLoad?.(photo)}
          onError={(event) => onImageError?.(photo, event)}
        />
      ) : source ? (
        <RNImage
          source={{ uri }}
          style={[styles.image, imageStyle]}
          resizeMode="cover"
          onLoadStart={() => onImageLoadStart?.(photo)}
          onLoad={() => onImageLoad?.(photo)}
          onError={(event) => onImageError?.(photo, event)}
        />
      ) : (
        <View style={[styles.placeholder, imageStyle]}>
          <MaterialCommunityIcons name="image-outline" size={24} color={COLORS.textMuted} />
        </View>
      )}
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
  placeholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.border,
  },
});

export default GalleryPhotoTile;
