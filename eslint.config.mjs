import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".npm-cache/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
