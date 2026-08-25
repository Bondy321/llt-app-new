'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');

const readTree = (directory) => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readTree(entryPath);
    return entry.isFile() && /\.(?:js|jsx)$/u.test(entry.name)
      ? [fs.readFileSync(entryPath, 'utf8')]
      : [];
  });

const readAppArchitectureSource = () => [
  fs.readFileSync(path.join(repositoryRoot, 'App.js'), 'utf8'),
  ...readTree(path.join(repositoryRoot, 'src', 'app')),
].join('\n');

const readFunctionsArchitectureSource = () => [
  fs.readFileSync(path.join(repositoryRoot, 'functions', 'index.js'), 'utf8'),
  ...readTree(path.join(repositoryRoot, 'functions', 'src')),
].join('\n');

const readMobileModuleSource = (relativePath) => {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const extension = path.extname(absolutePath);
  const baseName = path.basename(absolutePath, extension);
  const stylePath = path.join(path.dirname(absolutePath), 'styles', `${baseName}.styles.js`);
  const featureDirectories = {
    'screens/LoginScreen.js': path.join(repositoryRoot, 'src', 'features', 'auth', 'presentation'),
    'screens/MapScreen.js': path.join(repositoryRoot, 'components', 'map'),
    'screens/GroupPhotobookScreen.js': path.join(repositoryRoot, 'components', 'group-photobook'),
    'screens/PhotobookScreen.js': path.join(repositoryRoot, 'components', 'photobook'),
    'screens/NotificationPreferencesScreen.js': path.join(repositoryRoot, 'components', 'notification-preferences'),
    'screens/PassengerManifestScreen.js': path.join(repositoryRoot, 'components', 'passenger-manifest'),
    'screens/TourHomeScreen.js': path.join(repositoryRoot, 'components', 'tour-home'),
    'screens/ItineraryScreen.js': path.join(repositoryRoot, 'components', 'itinerary'),
  };
  const featureDirectory = featureDirectories[relativePath];
  return [
    fs.readFileSync(absolutePath, 'utf8'),
    ...(fs.existsSync(stylePath) ? [fs.readFileSync(stylePath, 'utf8')] : []),
    ...(featureDirectory && fs.existsSync(featureDirectory) ? readTree(featureDirectory) : []),
  ].join('\n');
};

const serviceDomainDirectories = {
  'services/bookingServiceRealtime.js': 'booking',
  'services/chatService.js': 'chat',
  'services/notificationService.js': 'notifications',
  'services/offlineSyncService.js': 'offline-sync',
  'services/photoService.js': 'photo',
  'services/safetyService.js': 'safety',
};

const readServiceModuleSource = (relativePath) => {
  const facadePath = path.join(repositoryRoot, relativePath);
  const domainDirectory = serviceDomainDirectories[relativePath];
  return [
    fs.readFileSync(facadePath, 'utf8'),
    ...(domainDirectory
      ? readTree(path.join(repositoryRoot, 'services', domainDirectory))
      : []),
  ].join('\n');
};

module.exports = {
  readAppArchitectureSource,
  readFunctionsArchitectureSource,
  readMobileModuleSource,
  readServiceModuleSource,
};
