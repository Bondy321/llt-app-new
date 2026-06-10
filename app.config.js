const googleMapsApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
const isProductionBuild = process.env.EAS_BUILD_PROFILE === 'production';
const devClientAutolinkingExclusions = [
  'expo-dev-client',
  'expo-dev-launcher',
  'expo-dev-menu',
  'expo-dev-menu-interface',
];
const appTransportSecurity = isProductionBuild
  ? { NSAllowsArbitraryLoads: false }
  : {
      NSAllowsArbitraryLoads: true,
      NSExceptionDomains: {
        localhost: {
          NSExceptionAllowsInsecureHTTPLoads: true,
        },
      },
    };

module.exports = {
  expo: {
    name: 'LLT',
    slug: 'loch-lomond-travel',
    version: '1.0.2',
    orientation: 'portrait',
    icon: './assets/images/outward_app_icon.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#007DC3',
    },
    assetBundlePatterns: ['**/*'],
    autolinking: isProductionBuild
      ? {
          ios: { exclude: devClientAutolinkingExclusions },
          android: { exclude: devClientAutolinkingExclusions },
        }
      : undefined,
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.lochlomondtravel.tourapp',
      buildNumber: '3',
      infoPlist: {
        NSPhotoLibraryUsageDescription:
          'Loch Lomond Travel uses your photo library to choose and upload tour, chat, and private photos in the app.',
        NSPhotoLibraryAddUsageDescription:
          'Loch Lomond Travel uses this permission to save tour photos from the app to your photo library.',
        NSCameraUsageDescription:
          'Loch Lomond Travel uses the camera to capture tour, chat, and private photos you choose to upload.',
        NSLocationWhenInUseUsageDescription:
          'Loch Lomond Travel uses your location for bus finding, meeting points, driver pickup sharing, and optional safety reports or live location sharing.',
        NSAppTransportSecurity: appTransportSecurity,
      },
      config: {
        usesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/outward_app_icon.png',
        backgroundColor: '#007DC3',
      },
      package: 'com.lochlomondtravel.tourapp',
      versionCode: 3,
      permissions: [
        'CAMERA',
        'READ_MEDIA_IMAGES',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_FINE_LOCATION',
        'RECEIVE_BOOT_COMPLETED',
        'VIBRATE',
      ],
      config: {
        googleMaps: {
          apiKey: googleMapsApiKey || '',
        },
      },
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-font',
      'expo-image',
      'expo-secure-store',
      [
        'expo-build-properties',
        {
          ios: {
            deploymentTarget: '15.1',
          },
        },
      ],
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          locationWhenInUsePermission:
            'Loch Lomond Travel uses your location for bus finding, meeting points, driver pickup sharing, and optional safety reports or live location sharing.',
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission:
            'Loch Lomond Travel uses your photo library to choose and upload tour, chat, and private photos in the app.',
          cameraPermission:
            'Loch Lomond Travel uses the camera to capture tour, chat, and private photos you choose to upload.',
          microphonePermission: false,
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission:
            'Loch Lomond Travel uses your photo library to choose and upload tour, chat, and private photos in the app.',
          savePhotosPermission:
            'Loch Lomond Travel uses this permission to save tour photos from the app to your photo library.',
          granularPermissions: ['photo'],
        },
      ],
      [
        'expo-notifications',
        {
          color: '#007DC3',
          defaultChannel: 'default',
        },
      ],
      './plugins/withProductionReleaseCleanup',
    ],
    updates: {
      fallbackToCacheTimeout: 0,
      url: 'https://u.expo.dev/1b1ae41f-9096-4e7d-887c-b617613cf603',
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    extra: {
      eas: {
        projectId: '1b1ae41f-9096-4e7d-887c-b617613cf603',
      },
    },
    owner: 'lochlomondtravel',
  },
};
