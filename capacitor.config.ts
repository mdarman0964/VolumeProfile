import type { CapacitorConfig } from "@capacitor/cli";

const appUrl = process.env.APP_URL?.trim();

if (!appUrl) {
  throw new Error(
    "APP_URL is required. Set the GitHub Actions variable APP_URL or provide app_url when manually running the Android workflow.",
  );
}

const parsedAppUrl = new URL(appUrl);

if (parsedAppUrl.protocol !== "https:") {
  throw new Error("APP_URL must use HTTPS so dashboard and Exness traffic remain encrypted.");
}

const config: CapacitorConfig = {
  appId: "com.mdarman0964.volumeprofile",
  appName: "VolumeProfile",
  // The Android app is a WebView shell for the deployed application.
  // Keep the real TanStack/Nitro server and Exness integration hosted.
  webDir: "android-web",
  server: {
    url: parsedAppUrl.toString(),
    cleartext: false,
    allowNavigation: [parsedAppUrl.hostname],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
