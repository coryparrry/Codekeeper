const globals = Object.fromEntries(
  [
    "AbortController",
    "AbortSignal",
    "Buffer",
    "ReadableStream",
    "Response",
    "TextDecoder",
    "URL",
    "URLSearchParams",
    "console",
    "clearTimeout",
    "fetch",
    "process",
    "queueMicrotask",
    "setImmediate",
    "setTimeout",
    "structuredClone",
  ].map((name) => [name, "readonly"]),
);

export default [
  {
    ignores: [
      "**/node_modules/**",
      ".codex-pr*-fix/**",
      "acceptance/fixture/**",
    ],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals,
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-dupe-keys": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-loss-of-precision": "error",
      "no-self-assign": "error",
      "no-sparse-arrays": "error",
      "no-unexpected-multiline": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unused-labels": "error",
      "no-useless-catch": "error",
      "no-undef": "error",
      "valid-typeof": "error",
    },
  },
];
