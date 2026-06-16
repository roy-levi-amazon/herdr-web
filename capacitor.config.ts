import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.herdr.web",
  appName: "Herdr Web",
  webDir: "web/dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "http",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
