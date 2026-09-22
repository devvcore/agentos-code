import type { Configuration } from "electron-builder"
import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

const local = process.env.AGENTOS_ALLOW_ADHOC === "1"
const signingIdentity = process.env.CSC_NAME?.replace(/^Developer ID Application:\s*/, "")
if (!local && !signingIdentity) {
  throw new Error("Set CSC_NAME to a Developer ID Application identity, or AGENTOS_ALLOW_ADHOC=1 for a local build.")
}

const config: Configuration = {
  appId: "net.tryagentos.code",
  productName: "OmniCode",
  artifactName: "omnicode-desktop-${os}-${arch}-${version}.${ext}",
  directories: { output: "dist-agentos", buildResources: "resources" },
  extraMetadata: {
    version: process.env.AGENTOS_VERSION ?? "0.2.0-preview.1",
    homepage: "https://tryagentos.net/code",
    author: { name: "AgentOS" },
  },
  files: ["out/**/*"],
  extraResources: [
    { from: "resources/omnicode-notices.txt", to: "omnicode-notices.txt" },
    { from: "resources/agentos-code", to: "agentos-code" },
    { from: "resources/icons", to: "icons" },
  ],
  protocols: { name: "OmniCode", schemes: ["agentos-code"] },
  publish: null,
  afterPack: local
    ? async (context) => {
        await promisify(execFile)("codesign", [
          "--force",
          "--deep",
          "--sign",
          "-",
          join(context.appOutDir, "OmniCode.app"),
        ])
      }
    : undefined,
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icons/icon.icns",
    identity: local ? null : signingIdentity,
    hardenedRuntime: !local,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: !local,
    target: ["dmg", "zip"],
  },
  dmg: { sign: !local },
}

export default config
