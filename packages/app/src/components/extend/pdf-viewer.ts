/**
 * PDF preview built on EmbedPDF (PDFium compiled to WebAssembly).
 *
 * Plugin wiring adapted from Extend UI's pdf-viewer (https://github.com/extend-hq/ui),
 * MIT License, Copyright (c) 2026 CrowdView Inc, dba Extend; portions Copyright (c) 2023 shadcn.
 * The toolbar, sidebar, search, selection, and shadcn/radix chrome were not carried over.
 *
 * Written with createElement because vite-plugin-solid compiles every .tsx file in this package.
 */
import { type ReactElement, createElement as h, useEffect, useMemo, useState } from "react"
import { createPluginRegistration } from "@embedpdf/core"
import { EmbedPDF } from "@embedpdf/core/react"
import type { PdfEngine } from "@embedpdf/models"
import { DocumentContent, DocumentManagerPluginPackage, useActiveDocument } from "@embedpdf/plugin-document-manager/react"
import { RenderLayer, RenderPluginPackage } from "@embedpdf/plugin-render/react"
import { Scroller, ScrollPluginPackage, useScroll } from "@embedpdf/plugin-scroll/react"
import { Viewport, ViewportPluginPackage } from "@embedpdf/plugin-viewport/react"
import { ZoomMode, ZoomPluginPackage } from "@embedpdf/plugin-zoom/react"
import wasm from "@embedpdf/pdfium/pdfium.wasm?url"
import { ViewerMessage } from "./viewer-message"

const PAGE_GAP = 12

export type PdfViewerProps = {
  bytes: Uint8Array
  name: string
  labels: { loading: string; error: string; page: (current: number, total: number) => string }
}

let shared: Promise<PdfEngine> | undefined

// One PDFium worker for the app. It runs from a blob: URL, so the wasm URL must be absolute, and
// font fallback is off so previews never fetch fonts from a CDN (PDFium's base-14 fonts still work).
function engine() {
  shared ??= import("@embedpdf/engines/pdfium-worker-engine").then((mod) =>
    mod.createPdfiumEngine(new URL(wasm, document.baseURI).href, { fontFallback: null }),
  )
  return shared
}

export default function PdfViewer(props: PdfViewerProps): ReactElement {
  const [state, setState] = useState<{ engine?: PdfEngine; failed?: boolean }>({})
  useEffect(() => {
    const live = { current: true }
    engine().then(
      (value) => live.current && setState({ engine: value }),
      () => live.current && setState({ failed: true }),
    )
    return () => {
      live.current = false
    }
  }, [])
  // EmbedPDF takes ownership of the buffer, so hand it a copy.
  const plugins = useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ buffer: props.bytes.slice().buffer, name: props.name }],
      }),
      createPluginRegistration(ViewportPluginPackage, { viewportGap: PAGE_GAP }),
      createPluginRegistration(ScrollPluginPackage, { defaultPageGap: PAGE_GAP, defaultBufferSize: 2 }),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.FitWidth }),
    ],
    [props.bytes, props.name],
  )

  if (state.failed) return h(ViewerMessage, { text: props.labels.error, tone: "error" })
  if (!state.engine) return h(ViewerMessage, { text: props.labels.loading })
  return h(EmbedPDF, {
    engine: state.engine,
    plugins,
    key: props.name,
    children: h(PdfDocument, { labels: props.labels }),
  })
}

function PdfDocument(props: { labels: PdfViewerProps["labels"] }) {
  const active = useActiveDocument()
  return h(DocumentContent, {
    documentId: active.activeDocumentId,
    children: (content) => {
      if (content.isError) return h(ViewerMessage, { text: props.labels.error, tone: "error" })
      if (!content.isLoaded || !active.activeDocumentId) return h(ViewerMessage, { text: props.labels.loading })
      return h(PdfPages, { id: active.activeDocumentId, labels: props.labels })
    },
  })
}

function PdfPages(props: { id: string; labels: PdfViewerProps["labels"] }) {
  const scroll = useScroll(props.id)
  return h(
    "div",
    { className: "relative flex h-full min-h-0 flex-col" },
    h(Viewport, {
      documentId: props.id,
      className: "min-h-0 flex-1",
      style: { backgroundColor: "var(--v2-background-bg-deep)" },
      children: h(Scroller, {
        documentId: props.id,
        renderPage: (page) =>
          h(
            "div",
            {
              style: { width: page.width, height: page.height },
              className: "overflow-hidden rounded-[2px] bg-white shadow-[var(--v2-elevation-raised)]",
            },
            h(RenderLayer, { documentId: props.id, pageIndex: page.pageIndex }),
          ),
      }),
    }),
    scroll.state.totalPages > 0
      ? h(
          "div",
          {
            className:
              "pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-v2-background-bg-contrast px-2.5 py-1 text-12-regular text-v2-text-text-inverse tabular-nums opacity-80",
          },
          props.labels.page(scroll.state.currentPage, scroll.state.totalPages),
        )
      : null,
  )
}
