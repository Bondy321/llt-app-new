# Android Emulator Workflow

This project is configured for a reusable Windows Android emulator loop.

## Installed Local Setup

- Android SDK root: `C:\Users\sa08b\AppData\Local\Android\Sdk`
- Android Studio JDK: `C:\Program Files\Android\Android Studio\jbr`
- AVD name: `Pixel_8_API_36`
- App package: `com.lochlomondtravel.tourapp`
- Dev-client Metro port: `8082`

WHPX acceleration was verified with `emulator -accel-check`.

## Run Commands

Start the emulator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android-emulator.ps1
```

Start the emulator, then open the Expo development client:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\expo-android-dev-client.ps1
```

Rebuild and reinstall the development client before starting Metro:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\expo-android-dev-client.ps1 -Build
```

Capture a screenshot from the emulator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android-screenshot.ps1
```

## Notes

- Expo Go is not enough for this app because `@react-native-clipboard/clipboard` is a native module. Use the development client.
- `android/` is gitignored and was generated locally by Expo prebuild.
- The generated Gradle wrapper was pinned to `8.14.3` in `android/gradle/wrapper/gradle-wrapper.properties` to avoid the Gradle 9 `JvmVendorSpec.IBM_SEMERU` failure seen during the first local build.
- Codex actions are available in `.codex/environments/environment.toml` for `Run`, `Run Android Emulator`, and `Android Screenshot`.
