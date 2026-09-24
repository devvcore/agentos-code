import { createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePlatform, type Platform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"
import {
  WORK_PANEL_CLOSED,
  workPanelReduce,
  type WorkAttachmentRef,
  type WorkPanelAction,
  type WorkPanelState,
} from "@/pages/session/work-panel-state"

// Sessions whose panel state is kept; the least recently touched ones are dropped beyond this.
const WORK_PANEL_SESSIONS = 100

type Entry = WorkPanelState & { at: number }

const root: { store?: ReturnType<typeof createWorkPanelStore> } = {}

/**
 * The Omniwork side panel state for every session, persisted across reloads. Chat file cards,
 * the header Files button, keybinds, and auto-open all drive it; the WorkPanel renders it.
 */
export function useWorkPanel() {
  const platform = usePlatform()
  root.store ??= createRoot(() => createWorkPanelStore(platform))
  return root.store
}

function createWorkPanelStore(platform: Platform) {
  const [state, setState, , ready] = persisted(
    Persist.global("omni.work.panel"),
    createStore<Record<string, Entry | undefined>>({}),
    platform,
  )
  const get = (sessionID: string): WorkPanelState => state[sessionID] ?? WORK_PANEL_CLOSED
  const dispatch = (sessionID: string, action: WorkPanelAction) => {
    const current = get(sessionID)
    const next = workPanelReduce(current, action)
    if (next === current) return
    setState(sessionID, reconcile({ ...next, at: Date.now() }))
    const stale = Object.entries(state)
      .flatMap(([id, entry]) => (entry ? [{ id, at: entry.at }] : []))
      .sort((a, b) => b.at - a.at)
      .slice(WORK_PANEL_SESSIONS)
    stale.forEach((item) => setState(item.id, undefined))
  }
  return {
    /** False until persisted state has loaded; auto-open waits for it. */
    ready,
    state: get,
    view: (sessionID: string) => get(sessionID).view,
    path: (sessionID: string) => (get(sessionID).view === "preview" ? get(sessionID).path : undefined),
    attachment: (sessionID: string) => (get(sessionID).view === "preview" ? get(sessionID).attachment : undefined),
    dispatch,
    openFiles: (sessionID: string) => dispatch(sessionID, { type: "files" }),
    open: (sessionID: string, path: string) => dispatch(sessionID, { type: "open", path }),
    /** Preview a message attachment; only the reference is persisted. */
    openAttachment: (sessionID: string, ref: WorkAttachmentRef) => dispatch(sessionID, { type: "attachment", ref }),
    close: (sessionID: string) => dispatch(sessionID, { type: "close" }),
    toggleFiles: (sessionID: string) => dispatch(sessionID, { type: "toggle" }),
    back: (sessionID: string) => dispatch(sessionID, { type: "back" }),
  }
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
