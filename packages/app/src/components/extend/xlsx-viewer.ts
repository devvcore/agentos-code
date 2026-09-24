/**
 * XLSX preview built on @extend-ai/react-xlsx (Duke Sheets WebAssembly engine: parsing, formula
 * calculation, charts, frozen panes, merged cells, conditional formatting).
 *
 * Viewer configuration and sheet-tab strip adapted from Extend UI's xlsx-viewer
 * (https://github.com/extend-hq/ui), MIT License, Copyright (c) 2026 CrowdView Inc, dba Extend;
 * portions Copyright (c) 2023 shadcn. Toolbar, search, thumbnails, and shadcn/radix chrome were
 * not carried over.
 *
 * Written with createElement because vite-plugin-solid compiles every .tsx file in this package.
 */
import { createElement as h, useMemo } from "react"
import { XlsxViewer, XlsxViewerProvider, setWasmSource, useXlsxViewer } from "@extend-ai/react-xlsx"
import wasm from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url"
import { readableInk } from "./contrast"
import { ViewerMessage } from "./viewer-message"

// The engine forwards this URL into its parser worker, so it must not be relative to the page.
setWasmSource(new URL(wasm, document.baseURI).href)

export type XlsxPreviewProps = {
  bytes: Uint8Array
  name: string
  dark: boolean
  labels: { loading: string; error: string; sheets: string }
}

export default function XlsxPreview(props: XlsxPreviewProps) {
  // The viewer transfers the buffer to its worker, so hand it a copy.
  const file = useMemo(() => props.bytes.slice().buffer, [props.bytes])
  return h(XlsxViewerProvider, {
    file,
    fileName: props.name,
    readOnly: true,
    isDark: props.dark,
    children: h(
      "div",
      { className: "flex h-full min-h-0 flex-col" },
      h(
        "div",
        { className: "min-h-0 flex-1" },
        h(XlsxViewer, {
          className: "h-full min-h-0 min-w-0",
          height: "100%",
          isDark: props.dark,
          // Night rendering lightens text but keeps workbook fills; keep filled cells legible.
          getCellStyle: props.dark
            ? (context) => {
                const color = readableInk(context.resolvedStyle.backgroundColor, context.resolvedStyle.color)
                return color ? { color } : undefined
              }
            : undefined,
          readOnly: true,
          allowResizeInReadOnly: true,
          rounded: false,
          showDefaultToolbar: false,
          showImages: true,
          loadingState: h(ViewerMessage, { text: props.labels.loading }),
          errorState: h(ViewerMessage, { text: props.labels.error, tone: "error" }),
        }),
      ),
      h(SheetTabs, { label: props.labels.sheets }),
    ),
  })
}

function SheetTabs(props: { label: string }) {
  const viewer = useXlsxViewer()
  if (viewer.tabs.length < 2) return null
  return h(
    "div",
    {
      role: "tablist",
      "aria-label": props.label,
      className:
        "flex shrink-0 items-center gap-1 overflow-x-auto border-t border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 no-scrollbar",
    },
    viewer.tabs.map((tab, index) =>
      h(
        "button",
        {
          key: tab.id,
          type: "button",
          role: "tab",
          "aria-selected": index === viewer.activeTabIndex,
          onClick: () => viewer.setActiveTabIndex(index),
          className:
            index === viewer.activeTabIndex
              ? "shrink-0 rounded-md bg-v2-overlay-simple-overlay-pressed px-2.5 py-1 text-12-medium text-v2-text-text-base"
              : "shrink-0 rounded-md px-2.5 py-1 text-12-regular text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover",
        },
        tab.name,
      ),
    ),
  )
}
