// ESLint flat config.
//
// The jsdoc rules below are the reason this file exists: every exported
// function, class, interface and type alias in `packages/` and `plugins/`
// must carry a TSDoc comment, so the generated API docs never have holes.
// See docs/CONTRIBUTING.md → "Documentation is part of the code".
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsdoc from "eslint-plugin-jsdoc";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // .kesher-self/ is the self-work agent's own scratch area (plan.md + throwaway scripts) — never linted.
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "docs/api/**", "apps/android/www/vendor/**", "vendor/**", ".kesher-self/**"] },
  js.configs.recommended,
  { files: ["scripts/**", "apps/desktop/**"], languageOptions: { globals: globals.node } },
  { files: ["apps/web/**"], languageOptions: { globals: globals.browser } },
  // Hooks in the same order on every render (a hook after an early return crashes the page: React error #310).
  { files: ["apps/web/**/*.tsx", "apps/web/**/*.ts", "plugins/**/*.tsx"], plugins: { "react-hooks": reactHooks }, rules: {
      "react-hooks/rules-of-hooks": "error",
      // An effect must not return a value by accident: new Chrome versions return a Promise from
      // scrollIntoView/scrollTo, and React then calls it as the cleanup ("M is not a function").
      "no-restricted-syntax": ["error", { selector: "CallExpression[callee.name=/^use(Layout)?Effect$/] > ArrowFunctionExpression[expression=true]:first-child:not([body.type=/^(UnaryExpression|ArrowFunctionExpression)$/])", message: "Use a block body { ... } in effects, so nothing is returned as the cleanup." }],
    } },
  { files: ["apps/browser-extension/**"], languageOptions: { globals: { ...globals.browser, ...globals.serviceworker, chrome: "readonly" } } },
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_name` marks a value that is unused on purpose (e.g. dropping fields with a rest pattern).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/*/src/**/*.ts", "plugins/*/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: true,
          },
          contexts: ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"],
        },
      ],
      "jsdoc/check-tag-names": ["error", { definedTags: ["remarks", "typeParam", "packageDocumentation"] }],
    },
  },
);
