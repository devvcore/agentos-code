/**
 * PPTX/PPT preview built on @extend-ai/react-pptx (Rust/WebAssembly presentation parser).
 *
 * Adapted from Extend UI's pptx-viewer (https://github.com/extend-hq/ui), MIT License,
 * Copyright (c) 2026 CrowdView Inc, dba Extend; portions Copyright (c) 2023 shadcn. The package's
 * own toolbar and filmstrip are hidden; slides scroll continuously at fit-width. The shadcn/radix
 * chrome was not carried over.
 *
 * Written with createElement because vite-plugin-solid compiles every .tsx file in this package.
 */
import { createElement as h, useMemo } from "react"
import { ReactPptxViewer, setWasmSource } from "@extend-ai/react-pptx"
import wasm from "@extend-ai/react-pptx/pptx_wasm_bg.wasm?url"
import "@extend-ai/react-pptx/styles.css"
import "./pptx-viewer.css"
import { ViewerMessage } from "./viewer-message"

// The engine forwards this URL into its parser worker, so it must not be relative to the page.
setWasmSource(new URL(wasm, document.baseURI).href)

export type PptxPreviewProps = {
  bytes: Uint8Array
  labels: { loading: string; error: string }
}

export default function PptxPreview(props: PptxPreviewProps) {
  const source = useMemo(() => props.bytes.slice(), [props.bytes])
  return h(ReactPptxViewer, {
    source,
    mode: "continuous",
    defaultZoom: "fit-width",
    height: "100%",
    showToolbar: false,
    showThumbnails: false,
    className: "omni-pptx h-full",
    renderLoading: () => h(ViewerMessage, { text: props.labels.loading }),
    renderError: () => h(ViewerMessage, { text: props.labels.error, tone: "error" }),
  })
}
