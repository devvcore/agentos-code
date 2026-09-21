#!/usr/bin/env bun
import { $ } from "bun"
import { copyFile, mkdir } from "node:fs/promises"

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The AgentOS Code desktop preview currently builds on Apple Silicon macOS.")
}
const version = process.env.AGENTOS_VERSION ?? "0.2.0-preview.1"
process.env.AGENTOS_CODE = "1"
process.env.AGENTOS_VERSION = version
process.env.OPENCODE_CHANNEL = "agentos"
process.env.OPENCODE_VERSION = version
await $`cd ../opencode && bun run build:agentos --single --skip-install --skip-embed-web-ui`
await mkdir("resources/icons/AgentOS.iconset", { recursive: true })
await copyFile("../opencode/dist/agentos-code-darwin-arm64/bin/agentos-code", "resources/agentos-code")
await $`chmod 755 resources/agentos-code`
await copyFile("icons/agentos.png", "resources/icons/dock.png")
await copyFile("icons/agentos.png", "resources/icons/icon.png")
for (const size of [16, 32, 128, 256, 512]) {
  await $`sips -z ${size} ${size} icons/agentos.png --out ${`resources/icons/AgentOS.iconset/icon_${size}x${size}.png`}`.quiet()
  await $`sips -z ${size * 2} ${size * 2} icons/agentos.png --out ${`resources/icons/AgentOS.iconset/icon_${size}x${size}@2x.png`}`.quiet()
}
await $`iconutil -c icns resources/icons/AgentOS.iconset -o resources/icons/icon.icns`
await $`electron-vite build`
