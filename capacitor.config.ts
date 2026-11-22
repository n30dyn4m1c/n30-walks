import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.n30.stride',
  appName: 'Stride',
  webDir: 'dist',
  android: {
    // Lets the WebView keep running JS while the foreground location service is active.
    allowMixedContent: false,
  },
};

export default config;
