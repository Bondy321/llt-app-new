# Loch Lomond Travel App

## EAS Update setup

This project is configured for EAS Update with:
- `updates.url` in `app.json`
- `runtimeVersion` policy set to `appVersion`
- `extra.eas.projectId` in `app.json`

### Build a new development build (once after native/runtime changes)

Your installed development build can receive OTA updates only when runtime-compatible.
Create/update a dev build with:

```bash
npm run build:dev:ios
npm run build:dev:android
```

### Publish updates manually

Publish JavaScript/assets to development:

```bash
npm run update:dev
```

Publish JavaScript/assets to production:

```bash
npm run update:prod
```

### CI publishing with EXPO_TOKEN

GitHub Actions workflow `.github/workflows/eas-update.yml` publishes to the `development` channel on every push to `main`.

It authenticates with Expo using repository secret `EXPO_TOKEN`, passed into `expo/expo-github-action@v8`.

### Important runtime compatibility note

Because `runtimeVersion` uses the `appVersion` policy, only updates compatible with the installed native runtime will apply.
Any native code/dependency/config changes still require shipping a new build before those changes are available on devices.
