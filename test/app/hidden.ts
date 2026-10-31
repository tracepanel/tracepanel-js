// biome-ignore-all lint/suspicious/noConsole: the app's debug output is what the tests read.
// Values a dump can't show from a masked copy: a class whose inspect reads its #private fields, a proxy.

import { inspect } from "node:util";

/** A class whose own inspect reads its #private field: it can't be shown from a copy. */
export class Vault {
  #owner = "ann";
  apiKey = "k-123";

  [inspect.custom](): string {
    return `Vault { owner: '${this.#owner}', apiKey: '${this.apiKey}' }`;
  }
}

/** A Vault and a proxy logged: the proxy's traps record what read them. */
export function withVaultAndProxy(traps: string[]): void {
  const vault = new Vault();
  const noted = <T>(trap: string, result: T): T => {
    traps.push(trap);
    return result;
  };
  const account = new Proxy(
    { name: "ann", password: "pw", nested: { token: "t-1" } },
    {
      get: (target, key, receiver) => noted(`get ${String(key)}`, Reflect.get(target, key, receiver)),
      ownKeys: (target) => noted("ownKeys", Reflect.ownKeys(target)),
      getOwnPropertyDescriptor: (target, key) => noted("descriptor", Reflect.getOwnPropertyDescriptor(target, key)),
      getPrototypeOf: (target) => noted("prototype", Reflect.getPrototypeOf(target)),
      has: (target, key) => noted("has", Reflect.has(target, key)),
    },
  );
  console.log(vault, account); // hidden
}
