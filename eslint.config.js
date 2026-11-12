// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.turbo/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Testlerde `code(() => fn())` kalıbı yaygın; bu yalnızca biçimsel bir kuraldır.
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.name='eval']", message: "eval yasak." },
        { selector: "NewExpression[callee.name='Function']", message: "new Function yasak." },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false },
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
);
