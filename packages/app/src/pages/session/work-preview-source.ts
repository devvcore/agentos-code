import type { FilePart, Part } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import type { WorkAttachmentRef } from "@/pages/session/work-panel-state"
import {
  PREVIEW_MAX_BYTES,
  previewBytes,
  previewKind,
  previewRelative,
  type PreviewBytes,
  type PreviewKind,
} from "@/pages/session/work-preview"

/**
 * What the WorkPanel previews: a file on disk (read through the project file API, so it must
 * live inside the session directory) or bytes carried inline by a message attachment.
 * `path` on an inline source is the on-disk location the attaching client recorded, when known;
 * it only powers "Open in <app>" and never replaces the inline bytes.
 */
export type WorkPreviewSource =
  | { type: "path"; path: string }
  | { type: "inline"; name: string; mime: string; url: string; path?: string }
  /** The attachment could not be found (deleted message, or history that no longer loads). */
  | { type: "missing" }

export type WorkPreviewLoaded =
  | PreviewBytes
  | { type: "outside" }
  | { type: "unsupported" }
  /** No bytes can be reached for this source; offer "Open in <app>" instead. */
  | { type: "unavailable" }

export type WorkPreviewRead = (path: string) => Promise<{
  type: "text" | "binary"
  content: string
  encoding?: "base64"
}>

function absolute(path: string) {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
}

function fileURLPath(url: string) {
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    // file:///C:/x decodes to /C:/x
    return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path
  } catch {
    return undefined
  }
}

const mimeKinds: Record<string, PreviewKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/svg+xml": "image",
  "application/json": "text",
}

/**
 * Renderer for a file. The extension wins; the MIME type fills in for files without a known
 * extension. Attachments carry text/plain for every text file, so any text/* becomes plain text.
 */
export function previewKindFor(name: string, mime?: string): PreviewKind {
  const kind = previewKind(name)
  if (kind !== "none" || !mime) return kind
  const type = mime.toLowerCase().split(";")[0].trim()
  return mimeKinds[type] ?? (type.startsWith("text/") ? "text" : "none")
}

/**
 * Decode a data: URL into preview bytes, honouring PREVIEW_MAX_BYTES before decoding.
 * Returns undefined for anything that is not a well-formed data: URL.
 */
export function previewDataURL(url: string): PreviewBytes | undefined {
  if (!url.startsWith("data:")) return
  const comma = url.indexOf(",")
  if (comma < 0) return
  const meta = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  if (meta.split(";").some((item) => item.trim().toLowerCase() === "base64"))
    return previewBytes({ type: "binary", content: payload.replace(/\s/g, ""), encoding: "base64" })
  // Percent-encoded payloads are at least a third of their encoded length once decoded.
  if (payload.length / 3 > PREVIEW_MAX_BYTES) return { type: "too-large", size: Math.floor(payload.length / 3) }
  try {
    return previewBytes({ type: "text", content: decodeURIComponent(payload) })
  } catch {
    return
  }
}

/** The file part a reference points at, from loaded sync data. */
export function workAttachmentPart(ref: WorkAttachmentRef, parts: Record<string, Part[] | undefined>) {
  return findFilePart(ref, parts[ref.messageID])
}

/** The file part a reference points at, from a list of the message's parts. */
export function findFilePart(ref: WorkAttachmentRef, parts: Part[] | undefined) {
  const part = parts?.find((item) => item.id === ref.partID)
  return part?.type === "file" ? part : undefined
}

/**
 * Preview source for a message attachment. Uploaded files carry their bytes as a data: URL, so
 * they preview wherever they came from (e.g. ~/Downloads). A file:// URL is read from disk,
 * which the server only allows inside the session directory.
 */
export function workAttachmentSource(file: Pick<FilePart, "url" | "mime" | "filename">): WorkPreviewSource {
  if (file.url.startsWith("file:")) {
    const path = fileURLPath(file.url)
    if (path) return { type: "path", path }
  }
  const filename = file.filename ?? ""
  return {
    type: "inline",
    name: getFilename(filename) || filename,
    mime: file.mime,
    url: file.url,
    path: absolute(filename) ? filename : undefined,
  }
}

/** Display name for the preview header. */
export function previewName(source: WorkPreviewSource) {
  if (source.type === "path") return getFilename(source.path)
  if (source.type === "inline") return source.name
  return ""
}

/** Path the header tooltip and "Open in <app>" use, when there is one. */
export function previewPath(source: WorkPreviewSource) {
  if (source.type === "path") return source.path
  if (source.type === "inline") return source.path
}

export function previewSourceKind(source: WorkPreviewSource): PreviewKind {
  if (source.type === "path") return previewKind(source.path)
  if (source.type === "inline") return previewKindFor(source.name, source.mime)
  return "none"
}

/**
 * Load the bytes to render. Project files go through `read` with a path relative to
 * `directory`; files outside it are not readable by the server, so they report `outside`.
 * Inline sources decode locally and never touch the server.
 */
export async function loadPreview(
  source: WorkPreviewSource,
  input: { directory: string; read: WorkPreviewRead },
): Promise<WorkPreviewLoaded> {
  if (source.type === "missing") return { type: "unavailable" }
  if (previewSourceKind(source) === "none") return { type: "unsupported" }
  if (source.type === "inline") return previewDataURL(source.url) ?? { type: "unavailable" }
  const relative = previewRelative(input.directory, source.path)
  if (!relative) return { type: "outside" }
  return previewBytes(await input.read(relative))
}

/** Same file to preview; keeps the preview from reloading when unrelated sync data changes. */
export function workPreviewSourceEqual(a: WorkPreviewSource | undefined, b: WorkPreviewSource | undefined) {
  if (a === b) return true
  if (!a || !b || a.type !== b.type) return false
  if (a.type === "path" && b.type === "path") return a.path === b.path
  if (a.type === "inline" && b.type === "inline")
    return a.url === b.url && a.name === b.name && a.mime === b.mime && a.path === b.path
  return true
}

/**
 * Where a click on a sent message's attachment goes. In Work mode it opens the WorkPanel preview
 * (returning the reference to open); elsewhere it returns undefined and the caller keeps the
 * reveal-in-file-manager / download behaviour.
 */
export function workAttachmentTarget(
  file: Pick<FilePart, "id" | "messageID" | "sessionID">,
  input: { work: boolean; sessionID?: string },
): WorkAttachmentRef | undefined {
  if (!input.work || !input.sessionID || file.sessionID !== input.sessionID) return
  return { messageID: file.messageID, partID: file.id }
}
