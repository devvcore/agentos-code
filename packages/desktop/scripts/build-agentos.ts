#!/usr/bin/env bun
import { $ } from "bun"
import { copyFile, rm } from "node:fs/promises"

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

// Omniwork provisions its managed Python with uv (MIT OR Apache-2.0, notice in omnicode-notices.txt).
// Pinned release; the archive must match both this hash and the release's published checksum.
const uv = {
  version: "0.12.18",
  asset: "uv-aarch64-apple-darwin.tar.gz",
  sha256: "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b",
}
const release = `https://github.com/astral-sh/uv/releases/download/${uv.version}/${uv.asset}`
const archive = new Uint8Array(
  await fetch(release).then((res) =>
    res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${release}: ${res.status}`)),
  ),
)
const published = (await fetch(`${release}.sha256`).then((res) => res.text())).trim().split(/\s+/)[0]
const actual = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
if (actual !== uv.sha256 || published !== uv.sha256) {
  throw new Error(
    `uv ${uv.version} checksum mismatch: pinned ${uv.sha256}, published ${published}, downloaded ${actual}`,
  )
}
await Bun.write("resources/uv.tar.gz", archive)
await $`tar -xzf resources/uv.tar.gz -C resources --strip-components=1 uv-aarch64-apple-darwin/uv`
await rm("resources/uv.tar.gz")
await $`chmod 755 resources/uv`
await $`electron-vite build`
