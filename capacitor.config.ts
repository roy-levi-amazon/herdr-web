import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.herdr.web",
  appName: "Herdr Web",
  webDir: "web/dist",
  server: {
    androidScheme: "http",
    cleartext: true,
  },
};

export default config;
