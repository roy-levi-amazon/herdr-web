import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

type NativeBackHandler = () => boolean;

let nativeControlsStarted = false;
const nativeBackHandlers: NativeBackHandler[] = [];

export function startNativeControls() {
  if (nativeControlsStarted || !Capacitor.isNativePlatform()) {
    return;
  }
  nativeControlsStarted = true;

  void App.addListener("backButton", ({ canGoBack }) => {
    for (const handler of [...nativeBackHandlers].reverse()) {
      if (handler()) {
        return;
      }
    }
    if (canGoBack) {
      window.history.back();
    } else {
      void App.exitApp();
    }
  });
}

export function addNativeBackHandler(handler: NativeBackHandler) {
  nativeBackHandlers.push(handler);
  return () => {
    const index = nativeBackHandlers.lastIndexOf(handler);
    if (index >= 0) {
      nativeBackHandlers.splice(index, 1);
    }
  };
}
