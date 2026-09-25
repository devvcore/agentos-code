import type { FilePart, Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { attached } from "@opencode-ai/session-ui/message-file"
import { getFilename } from "@opencode-ai/core/util/path"

export type WorkOutput = {
  /** Absolute path on disk */
  path: string
  name: string
  /** Parent folder, relative to the project directory when inside it */
  folder: string
  time: number
}

type Change = { path: string; removed: boolean; time: number; presented?: boolean }

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function absolute(path: string) {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
}

function trim(path: string) {
  return path.replace(/[\\/]+$/, "")
}

function changes(part: ToolPart): Change[] {
  if (part.state.status !== "completed") return []
  const state = part.state
  const time = state.time.end
  if (part.tool === "present_files")
    return presented(part).map((path) => ({ path, removed: false, time, presented: true }))
  if (part.tool === "write") {
    const path = text(state.input.filePath)
    return path ? [{ path, removed: false, time }] : []
  }
  if (part.tool === "edit") {
    const path = text(state.input.filePath) ?? text(record(state.metadata.filediff)?.file)
    return path ? [{ path, removed: false, time }] : []
  }
  if (part.tool !== "apply_patch" || !Array.isArray(state.metadata.files)) return []
  return state.metadata.files.flatMap((raw): Change[] => {
    const file = record(raw)
    const path = text(file?.filePath)
    if (!file || !path) return []
    if (file.type === "delete") return [{ path, removed: true, time }]
    const moved = file.type === "move" ? text(file.movePath) : undefined
    if (moved)
      return [
        { path, removed: true, time },
        { path: moved, removed: false, time },
      ]
    return [{ path, removed: false, time }]
  })
}

/** Absolute paths a completed `present_files` part showed to the user. */
function presented(part: ToolPart) {
  if (part.state.status !== "completed" || !Array.isArray(part.state.metadata.files)) return []
  return part.state.metadata.files.flatMap((raw) => {
    const path = text(record(raw)?.path)
    return path ? [path] : []
  })
}

/**
 * Deliverable files, newest first: files an agent wrote under an `outputs/` folder plus any
 * file it showed with `present_files`, wherever it lives. Later deletes or moves (apply_patch)
 * drop the earlier entry.
 */
export function workOutputs(input: {
  directory: string
  messages: Message[] | undefined
  parts: Record<string, Part[] | undefined>
}): WorkOutput[] {
  const root = trim(input.directory)
  const latest = new Map<string, WorkOutput>()
  ;(input.messages ?? [])
    .flatMap((message) => input.parts[message.id] ?? [])
    .filter((part): part is ToolPart => part.type === "tool")
    .flatMap(changes)
    .sort((a, b) => a.time - b.time)
    .forEach((change) => {
      const path = resolve(root, change.path)
      if (change.removed) {
        latest.delete(path)
        return
      }
      const inside = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
      const segments = (inside ? path.slice(root.length + 1) : path).split(/[\\/]/)
      if (!change.presented && !segments.slice(0, -1).includes("outputs")) {
        // A presented file the agent rewrites later stays listed; its time moves so previews reload.
        const known = latest.get(path)
        if (known) latest.set(path, { ...known, time: change.time })
        return
      }
      latest.set(path, {
        path,
        name: segments[segments.length - 1],
        folder: segments.slice(0, -1).join("/"),
        time: change.time,
      })
    })
  return [...latest.values()].sort((a, b) => b.time - a.time)
}

// Tools that can rewrite any file without saying which (scripts, subagents, recalculation).
const opaque = new Set(["bash", "execute", "task", "spreadsheet_recalculate"])

/**
 * Changes whenever the agent may have rewritten `path`: the last write, edit, patch, or
 * `present_files` of that path, or the last tool that can touch files without naming them.
 * The preview reloads when it changes and keeps its current render when the bytes are the same.
 */
export function workFileVersion(input: {
  directory: string
  path: string
  messages: Message[] | undefined
  parts: Record<string, Part[] | undefined>
}) {
  const root = trim(input.directory)
  return (input.messages ?? [])
    .flatMap((message) => input.parts[message.id] ?? [])
    .filter((part): part is ToolPart => part.type === "tool" && part.state.status === "completed")
    .reduce((version, part) => {
      if (part.state.status !== "completed") return version
      if (opaque.has(part.tool)) return Math.max(version, part.state.time.end)
      return changes(part)
        .filter((change) => resolve(root, change.path) === input.path)
        .reduce((result, change) => Math.max(result, change.time), version)
    }, 0)
}

function resolve(root: string, path: string) {
  return absolute(path) ? path : `${root}/${path.replace(/^\.[\\/]/, "")}`
}

/** Completed `present_files` parts in the order they ran, with the absolute paths they showed. */
export function workPresents(input: { messages: Message[] | undefined; parts: Record<string, Part[] | undefined> }) {
  return (input.messages ?? [])
    .flatMap((message) => input.parts[message.id] ?? [])
    .filter((part): part is ToolPart => part.type === "tool" && part.tool === "present_files")
    .filter((part) => part.state.status === "completed")
    .map((part) => ({ id: part.id, paths: presented(part) }))
}

export type WorkAttachment = {
  messageID: string
  partID: string
  name: string
  mime: string
  /** On-disk path the attaching client recorded, when it is absolute */
  path?: string
  /** Parent folder name of `path`, when known */
  folder: string
  time: number
}

/**
 * Files the user attached to messages in this session, newest first, one row per file: the same
 * file attached again (same on-disk path, or the same bytes when there is no path) keeps only its
 * newest row. Only uploaded attachments (bytes carried as a data: URL) count; inline @file
 * mentions of project files do not.
 */
export function workAttachments(input: {
  messages: Message[] | undefined
  parts: Record<string, Part[] | undefined>
}): WorkAttachment[] {
  const seen = new Set<string>()
  return (input.messages ?? [])
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      (input.parts[message.id] ?? [])
        .filter((part): part is FilePart => part.type === "file" && attached(part))
        .map((part) => {
          const filename = part.filename ?? ""
          const path = absolute(filename) ? filename : undefined
          const segments = path ? path.split(/[\\/]/) : []
          const name = getFilename(filename) || filename
          const item: WorkAttachment = {
            messageID: message.id,
            partID: part.id,
            name,
            mime: part.mime,
            path,
            folder: segments.length > 1 ? segments[segments.length - 2] : "",
            time: message.time.created,
          }
          return { item, key: path ? `path:${path}` : `url:${name}:${part.url}` }
        }),
    )
    .reverse()
    .flatMap((entry) => {
      if (seen.has(entry.key)) return []
      seen.add(entry.key)
      return [entry.item]
    })
}

/**
 * Attachments to list under "Attached": files the agent also presented or wrote are already
 * listed with the session's deliverables, so they are not listed twice.
 */
export function workAttachedOnly(attachments: WorkAttachment[], outputs: WorkOutput[]) {
  const listed = new Set(outputs.map((item) => item.path))
  return attachments.filter((item) => !item.path || !listed.has(item.path))
}
