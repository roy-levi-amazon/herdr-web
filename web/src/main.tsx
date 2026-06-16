import "@fontsource-variable/geist/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BridgeProvider } from "./bridge";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("missing root element");
}

createRoot(root).render(
  <StrictMode>
    <BridgeProvider>
      <App />
    </BridgeProvider>
  </StrictMode>,
);
