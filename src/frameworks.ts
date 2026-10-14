// A framework's version, from its package.json in the project's node_modules: "Next.js 16.4", as the Python SDK says
// "Django 6.1". Read once per framework.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGES: Record<string, string> = {
  Express: "express",
  NestJS: "@nestjs/core",
  "Next.js": "next",
  Nuxt: "nuxt",
};

const versions = new Map<string, string | null>();

function installed(name: string): string | null {
  let folder = process.cwd();
  for (;;) {
    try {
      const version: unknown = JSON.parse(
        readFileSync(join(folder, "node_modules", name, "package.json"), "utf8"),
      ).version;
      return typeof version === "string" ? version : null;
    } catch {
      const parent = dirname(folder);
      if (parent === folder) return null;
      folder = parent;
    }
  }
}

/** "Express" as "Express 5.3.0", or with `parts` of the version only ("Express 5.3"); as it is when unknown. */
export function withVersion(framework: string, parts?: number): string {
  const name = PACKAGES[framework];
  if (!name) return framework;
  if (!versions.has(name)) versions.set(name, installed(name));
  const version = versions.get(name);
  if (!version) return framework;
  return `${framework} ${parts ? version.split(".").slice(0, parts).join(".") : version}`;
}
