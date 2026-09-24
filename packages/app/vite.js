import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
        optimizeDeps: {
          // The Office viewers start workers with `new URL("./x-worker.js", import.meta.url)`, which
          // points at a missing file once esbuild pre-bundles them into .vite/deps. Serve them as-is
          // and pre-bundle only their dependencies (several are CommonJS).
          exclude: ["@extend-ai/react-xlsx", "@extend-ai/react-docx", "@extend-ai/react-pptx"],
          include: [
            "react/jsx-runtime",
            "react-dom",
            "react-dom/client",
            "react-dom/server",
            ...["regl", "d3-geo", "d3-hierarchy", "d3-scale", "d3-shape", "topojson-client"].flatMap((dep) => [
              `@extend-ai/react-xlsx > ${dep}`,
              `@extend-ai/react-pptx > ${dep}`,
            ]),
            "@extend-ai/react-xlsx > fflate",
            "@extend-ai/react-xlsx > @tanstack/react-virtual",
            "@extend-ai/react-pptx > @tanstack/react-virtual",
            "@extend-ai/react-pptx > @tanstack/virtual-core",
            "@extend-ai/react-docx > @tanstack/react-virtual",
            "@extend-ai/react-docx > @chenglou/pretext",
            "@extend-ai/react-docx > fast-png",
            "@extend-ai/react-docx > utif",
          ],
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
