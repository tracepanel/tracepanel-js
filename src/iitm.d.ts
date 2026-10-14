// import-in-the-middle ships register-hooks.d.ts next to register-hooks.mjs, which TypeScript doesn't pair up.
declare module "import-in-the-middle/register-hooks.mjs" {
  export function register(options?: {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
    disableCjsSourceStripping?: boolean;
  }): void;
  export function supportsSyncHooks(): boolean;
}
