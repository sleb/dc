// Preloaded by `bun run test:web` only. It registers happy-dom's globals (document, window, ...), so it must never run in
// the root `test` process (guard: packages/engine/test/leak-guard.test.ts). LLD 0 section 6, LLD 7 OQ10.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
