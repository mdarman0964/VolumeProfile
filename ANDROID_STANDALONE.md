# VELA standalone Android build

This Android target packages the VELA desk as a local static web bundle inside a Capacitor Android application.

## Standalone guarantees

- The app UI is bundled into the APK; it does not load a hosted website.
- The Android build uses a separate Vite configuration and does not start TanStack Start or Nitro.
- Strategy calculations and paper-trading logic execute on-device.
- Settings remain in the app's local browser storage.
- Exness REST calls are made from the Android app through Capacitor's native HTTP bridge, not through an app-owned cloud backend.
- No Exness API credentials are part of the source tree or build configuration.

## Build

The GitHub Actions workflow `.github/workflows/android-standalone.yml` creates a debug APK and uploads it as the `VELA-standalone-debug-apk` artifact.

## Important limitations before live use

The current broker screen is the existing REST-based integration. A successful APK build does not prove Exness account authorization, API-key source-IP permission, trading scopes, WebSocket streaming, or live order execution. These must be verified against an authorized demo account before live trading.

API credentials are currently held in component memory and are not written to localStorage. They are cleared when the app process is closed. Native Android Keystore-backed persistence is a separate hardening step; do not add keys to source code, build secrets, or Git history.

The app currently polls account state and candles. Server Events / ticks WebSocket streaming, complete pending-order lifecycle, and native encrypted credential persistence are not claimed as implemented by this initial Android target.
