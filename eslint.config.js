// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "coverage/", ".wrangler/", ".claude/", "src/generated/", "worker-configuration.d.ts"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Each file is linted with the first project that includes it:
        // core + node + tests -> node config, src/worker.ts -> worker config.
        project: ["./tsconfig.node.json", "./tsconfig.worker.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": ["error", { fixToUnknown: false, ignoreRestArgs: false }],
      "@typescript-eslint/no-restricted-types": [
        "error",
        {
          types: {
            unknown: {
              message:
                "Avoid `unknown`. JSON enters through parseJson() in src/json.ts as JsonValue; narrow with type guards from there.",
            },
            object: { message: "Use a precise type (e.g. JsonObject or a named type)." },
          },
        },
      ],
      // Type aliases (not interfaces) so object types stay assignable to JsonObject-style index signatures.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
