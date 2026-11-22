import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const TOKEN_VAR = "VITE_APPCHECK_DEBUG_TOKEN";

// LLD 7 section 3.1, LLD 0 section 7: the App Check debug token exists only in staging builds. Any other build mode
// (production, emulator) that has it in its environment fails instead of shipping it.
export default defineConfig(({ command, mode }) => {
  if (command === "build" && mode !== "staging" && loadEnv(mode, import.meta.dirname, "VITE_")[TOKEN_VAR]) {
    throw new Error(`${TOKEN_VAR} is set for a "${mode}" build. The debug token is allowed only in staging builds; unset it.`);
  }
  return { plugins: [react(), tailwindcss()] };
});
