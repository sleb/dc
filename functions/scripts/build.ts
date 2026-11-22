export type BuildOptions = { env?: Record<string, string | undefined>; check?: boolean };

export function build(_root: string, _opts: BuildOptions = {}): Promise<void> {
  return Promise.reject(new Error("not implemented"));
}
