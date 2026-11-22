import { initializeApp } from "firebase/app";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initAppCheck } from "./firebase/appcheck";
import { readConfig } from "./firebase/config";
import "./styles/index.css";

// Minimal boot (LLD 7 section 2.4): config, App Check before anything else touches Firebase, render.
// Capturing #k, the named per-game apps and routing come with 5.1.
const config = readConfig(import.meta.env);
const app = initializeApp(config.firebase);
initAppCheck(app, {
  appEnv: config.appEnv,
  recaptchaSiteKey: config.recaptchaSiteKey,
  debugToken: import.meta.env.VITE_APPCHECK_DEBUG_TOKEN,
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
