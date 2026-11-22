import { expect, test } from "bun:test";

// T2: runs only under `bun run test:web`, which preloads apps/web/test/setup.ts (happy-dom).
test("T2 the web test process has a DOM", () => {
  document.body.innerHTML = '<p id="x">hi</p>';
  expect(document.getElementById("x")?.textContent).toBe("hi");
  expect(typeof window).toBe("object");
});
