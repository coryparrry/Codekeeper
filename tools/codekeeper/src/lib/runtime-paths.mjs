import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const CODEX_BIN = require.resolve("@openai/codex/bin/codex.js");
