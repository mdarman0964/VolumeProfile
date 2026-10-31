# VolumeProfile Android (WebView)

This repository builds a thin Android WebView app with Capacitor. The existing
React/TanStack Start/Nitro application and Exness integration remain hosted on
the web deployment; the APK loads that deployment over HTTPS. The Android build
does not bundle or replace the server-side backend.

## Configure the deployed app URL

1. Deploy the existing VolumeProfile web application with its current backend
   and environment variables.
2. Open **Settings → Secrets and variables → Actions → Variables** in this
   GitHub repository.
3. Create a repository variable named `APP_URL` containing the HTTPS origin
   and path of the deployed VolumeProfile app (for example,
   `https://your-volumeprofile-domain.example`). Do not use an API key or
   private credential as this value.
4. Push to `main` to build automatically, or run **Actions → Android Debug
   APK → Run workflow** and provide the `app_url` input.

The Capacitor config rejects non-HTTPS URLs. Keep Exness private keys, API
secrets, and server credentials in the existing server-side environment; never
put them in the APK or GitHub workflow inputs.

## Download the APK

After the workflow succeeds:

1. Open the **Actions** tab.
2. Select the successful **Android Debug APK** run.
3. Download the `VolumeProfile-android-debug` artifact.
4. Extract the ZIP and install `app-debug.apk` on the Android device.

This is a debug build for testing, not a Play Store release. Android may ask
you to allow installation from the app used to open the APK.

## Important behavior

- The APK requires an internet connection and a reachable HTTPS deployment.
- The web dashboard, login/session handling, API calls, and Exness backend are
  served by the configured deployment.
- A debug APK is not signed with a production release key.
- Changes to the hosted web app can appear in the app without rebuilding the
  APK; native-shell changes require a new workflow run.
