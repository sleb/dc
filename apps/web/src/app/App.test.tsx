import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

// V8: runs only under `bun run test:web` (happy-dom preload). The root `test` process stays DOM-free (leak guard T3).
test("V8 the minimal app renders under happy-dom and React Testing Library", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Deep Cuts" })).toBeDefined();
});
