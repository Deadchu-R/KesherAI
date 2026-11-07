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

export default tseslint.config(
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "docs/api/**"] },
  js.configs.recommended,
  { files: ["scripts/**", "apps/desktop/**"], languageOptions: { globals: globals.node } },
  { files: ["apps/web/**"], languageOptions: { globals: globals.browser } },
  ...tseslint.configs.recommended,
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
