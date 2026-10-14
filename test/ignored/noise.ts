// Stands for a dev server's own client (Vite's /@vite/client): the recording leaves out what it logs.
export function noise(): void {
  // biome-ignore lint/suspicious/noConsole: the dev server's log, which the recording leaves out.
  console.info("[dev server] connected.");
}
