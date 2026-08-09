import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".npm-cache/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /*
     * Tests import what they use, so `node:` builtins stay visible at the top
     * of the file. These few are declared instead because Node exposes them
     * only as globals; there is no module to import them from.
     */
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        fetch: "readonly",
      },
    },
  },
];
