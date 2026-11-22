import { rm } from "node:fs/promises";
import { findSentinels, formatHit, scanFiles } from "./log-sentinels";
import type { Hit } from "./log-sentinels";

// The P19 harness (LLD 0, issue #16): run the integration suite, keep everything it prints (the Functions emulator
// writes its function logs to the same stream), and fail if a sentinel planted by the suite shows up. A failing suite
// keeps its own exit code. `firebase-debug.log` is read too, after being removed first so only this run counts.

export interface HarnessOptions {
  command: string[];
  /** Log files the command may write; removed before the run, scanned after. */
  extraLogs: string[];
  cwd?: string;
  /** Where the command's output is echoed (default stdout). */
  out?: (s: string) => void;
  /** Where findings are reported (default stderr). */
  report?: (s: string) => void;
}

export async function runHarness(o: HarnessOptions): Promise<{ code: number; hits: Hit[] }> {
  const out = o.out ?? ((s: string) => void process.stdout.write(s));
  const report = o.report ?? ((s: string) => void process.stderr.write(`${s}\n`));
  for (const f of o.extraLogs) await rm(f, { force: true });
  const proc = Bun.spawn(o.command, { ...(o.cwd ? { cwd: o.cwd } : {}), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  // One buffer per stream: interleaved chunks of the two streams must not split a sentinel in a shared buffer.
  const buffers = { stdout: "", stderr: "" };
  const pump = async (stream: ReadableStream<Uint8Array>, name: keyof typeof buffers) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const s = decoder.decode(chunk, { stream: true });
      buffers[name] += s;
      out(s);
    }
  };
  await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
  const exit = await proc.exited;
  const hits = [
    ...findSentinels(buffers.stdout, "<command stdout>"),
    ...findSentinels(buffers.stderr, "<command stderr>"),
    ...(await scanFiles(o.extraLogs)),
  ];
  for (const h of hits) report(formatHit(h));
  const code = exit !== 0 ? exit : hits.length > 0 ? 1 : 0;
  return { code, hits };
}

if (import.meta.main) {
  const { code, hits } = await runHarness({ command: ["bun", "run", "test:integration"], extraLogs: ["firebase-debug.log"] });
  console.log(hits.length === 0 ? "log-sentinels: ok (integration output and firebase-debug.log hold no sentinel)" : `log-sentinels: FAILED (${hits.length} hit(s))`);
  process.exit(code);
}
