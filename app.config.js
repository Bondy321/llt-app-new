const appConfig = require('./app.json');

const googleMapsApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

module.exports = {
  ...appConfig,
  expo: {
    ...appConfig.expo,
    android: {
      ...appConfig.expo.android,
      config: {
        ...appConfig.expo.android?.config,
        googleMaps: {
          apiKey: googleMapsApiKey || '',
        },
      },
    },
  },
};
