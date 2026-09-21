#!/usr/bin/env bun
import { $ } from "bun"
import { copyFile } from "node:fs/promises"

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The OmniCode desktop preview currently builds on Apple Silicon macOS.")
}
const version = process.env.AGENTOS_VERSION ?? "0.2.0-preview.1"
process.env.AGENTOS_CODE = "1"
process.env.AGENTOS_VERSION = version
process.env.OPENCODE_CHANNEL = "agentos"
process.env.OPENCODE_VERSION = version
await $`cd ../opencode && bun run build:agentos --single --skip-install --skip-embed-web-ui`
await $`bun scripts/build-agentos-icons.ts`
await copyFile("../opencode/dist/agentos-code-darwin-arm64/bin/agentos-code", "resources/agentos-code")
await $`chmod 755 resources/agentos-code`
await $`electron-vite build`
