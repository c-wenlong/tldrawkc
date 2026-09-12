// Flat config. typescript-eslint's type-checked recommended set, scoped to
// the TypeScript sources: applying it to this file (or any other .mjs) would
// ask for type information that no tsconfig covers.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    // Build output. dist/page is a Vite bundle of third-party code.
    "dist/**",
    "coverage/**",
    "node_modules/**",
  ]),
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Type-aware linting needs a project. These two between them cover
        // every source file: tsconfig.test.json is the node side plus the
        // tests and the root config files, tsconfig.page.json is the browser
        // bundle.
        project: ["./tsconfig.test.json", "./tsconfig.page.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
]);
