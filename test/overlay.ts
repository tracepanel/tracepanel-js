// Stands for Next.js's dev overlay, which wraps console's methods after the page's recording did (patchConsoleMethod):
// the wrapper keeps the method's name, so its frame reads `console.warn`.
export function wrapConsole(method: "warn"): () => void {
  // biome-ignore lint/suspicious/noConsole: the overlay's wrapper is what the test is about.
  const original = console[method];
  const wrapper = function (this: Console, ...args: unknown[]) {
    original.apply(this, args);
  };
  Object.defineProperty(wrapper, "name", { value: method });
  console[method] = wrapper;
  return () => {
    console[method] = original;
  };
}
