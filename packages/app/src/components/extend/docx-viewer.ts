/**
 * DOCX preview built on @extend-ai/react-docx (Rust/WebAssembly DOCX parser with page layout).
 *
 * Adapted from Extend UI's docx-viewer (https://github.com/extend-hq/ui), MIT License,
 * Copyright (c) 2026 CrowdView Inc, dba Extend; portions Copyright (c) 2023 shadcn. Only the
 * read-only page view is used; the editor, comments, tracked-change cards, thumbnails, and
 * shadcn/radix chrome were not carried over.
 *
 * Written with createElement because vite-plugin-solid compiles every .tsx file in this package.
 */
import { createElement as h, useMemo } from "react"
import { ReactDocxViewer, setWasmSource } from "@extend-ai/react-docx"
import wasm from "@extend-ai/react-docx/docx_wasm_bg.wasm?url"

// The engine forwards this URL into its import worker, so it must not be relative to the page.
setWasmSource(new URL(wasm, document.baseURI).href)

export type DocxPreviewProps = {
  bytes: Uint8Array
}

// Pages keep their paper colors in both themes, like a printed document; only the gap follows the app.
export default function DocxPreview(props: DocxPreviewProps) {
  const file = useMemo(() => props.bytes.slice().buffer, [props.bytes])
  return h(
    "div",
    {
      className: "h-full min-h-0 overflow-auto",
      // Document text defaults to black ("auto" color) rather than inheriting the app's theme text.
      style: { backgroundColor: "var(--v2-background-bg-deep)", color: "#000", colorScheme: "light" },
    },
    h(ReactDocxViewer, { file, defaultZoom: "fit-width", className: "min-h-full" }),
  )
}
