import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

type NativeBackHandler = () => boolean;
type NativeResumeHandler = () => void;

let nativeControlsStarted = false;
let lastNativeResumeAt = 0;
const nativeBackHandlers: NativeBackHandler[] = [];
const nativeResumeHandlers: NativeResumeHandler[] = [];

export function startNativeControls() {
  if (nativeControlsStarted || !Capacitor.isNativePlatform()) {
    return;
  }
  nativeControlsStarted = true;

  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      emitNativeResume();
    }
  });
  void App.addListener("resume", emitNativeResume);
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

export function addNativeResumeHandler(handler: NativeResumeHandler) {
  nativeResumeHandlers.push(handler);
  return () => {
    const index = nativeResumeHandlers.lastIndexOf(handler);
    if (index >= 0) {
      nativeResumeHandlers.splice(index, 1);
    }
  };
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

function emitNativeResume() {
  const now = Date.now();
  if (now - lastNativeResumeAt < 250) {
    return;
  }
  lastNativeResumeAt = now;
  for (const handler of [...nativeResumeHandlers]) {
    handler();
  }
}
