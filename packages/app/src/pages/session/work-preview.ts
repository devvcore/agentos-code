import { createStore } from "solid-js/store"

// Which deliverable the Omniwork side panel is previewing, per session. Chat file cards and the
// WorkPanel outputs list open files here; the WorkPanel renders the preview and widens itself.
const [state, setState] = createStore<Record<string, string | undefined>>({})

export const workPreview = {
  path: (sessionID: string) => state[sessionID],
  open: (sessionID: string, path: string) => setState(sessionID, path),
  close: (sessionID: string) => setState(sessionID, undefined),
}

/** CSS width of the WorkPanel: compact for progress/outputs, wide while previewing a file. */
export function workPanelWidth(previewing: boolean) {
  return previewing ? "clamp(480px, 50%, 900px)" : "340px"
}

/** CSS width of the session column beside the WorkPanel (8px row gap), so both fill the row. */
export function workSessionWidth(previewing: boolean) {
  return `calc(100% - ${workPanelWidth(previewing)} - 8px)`
}

/** Largest file the preview will download and render. */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024

export type PreviewKind = "pdf" | "xlsx" | "docx" | "pptx" | "csv" | "tsv" | "image" | "text" | "none"

const kinds: Record<string, PreviewKind> = {
  pdf: "pdf",
  xlsx: "xlsx",
  xlsm: "xlsx",
  docx: "docx",
  pptx: "pptx",
  ppt: "pptx",
  csv: "csv",
  tsv: "tsv",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  txt: "text",
  md: "text",
  markdown: "text",
  json: "text",
  log: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
}

const mimes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
}

// Product names are not translated. Unknown types use the "default app" copy instead.
const apps: Record<string, string> = {
  doc: "Word",
  docx: "Word",
  ppt: "PowerPoint",
  pptx: "PowerPoint",
  xls: "Excel",
  xlsx: "Excel",
  xlsm: "Excel",
}

export function previewExtension(path: string) {
  const name = path.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

export function previewKind(path: string): PreviewKind {
  return kinds[previewExtension(path)] ?? "none"
}

export function previewMime(path: string) {
  return mimes[previewExtension(path)] ?? "application/octet-stream"
}

/** Desktop app that usually opens this file type, when it can be named with confidence. */
export function previewApp(path: string): string | undefined {
  return apps[previewExtension(path)]
}

/** Path relative to the session directory, or undefined when the file lives outside it. */
export function previewRelative(directory: string, path: string) {
  const root = directory.replace(/[\\/]+$/, "")
  if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) return path.slice(root.length + 1)
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)) return undefined
  return path.replace(/^\.[\\/]/, "")
}

export type PreviewBytes = { type: "bytes"; bytes: Uint8Array<ArrayBuffer> } | { type: "too-large"; size: number }

/**
 * Turn a legacy `file.read` response into bytes. Binary files arrive base64-encoded; text files
 * arrive decoded (and trimmed), so they are re-encoded as UTF-8. The size cap is checked on the
 * encoded length first so oversized files are never decoded.
 */
export function previewBytes(content: { type: "text" | "binary"; content: string; encoding?: "base64" }): PreviewBytes {
  if (content.encoding !== "base64") {
    const bytes = new TextEncoder().encode(content.content)
    if (bytes.byteLength > PREVIEW_MAX_BYTES) return { type: "too-large", size: bytes.byteLength }
    return { type: "bytes", bytes }
  }
  const size = Math.floor((content.content.length * 3) / 4)
  if (size > PREVIEW_MAX_BYTES) return { type: "too-large", size }
  const binary = atob(content.content)
  const bytes = new Uint8Array(binary.length)
  // Plain loop: this runs over up to 25M characters.
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return { type: "bytes", bytes }
}
