import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"

export type WorkOutput = {
  /** Absolute path on disk */
  path: string
  name: string
  /** Parent folder, relative to the project directory when inside it */
  folder: string
  time: number
}

type Change = { path: string; removed: boolean; time: number }

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

/**
 * Deliverable files an agent wrote under an `outputs/` folder, newest first.
 * Later deletes or moves (apply_patch) drop the earlier entry.
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
      const path = absolute(change.path) ? change.path : `${root}/${change.path.replace(/^\.[\\/]/, "")}`
      if (change.removed) {
        latest.delete(path)
        return
      }
      const inside = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
      const segments = (inside ? path.slice(root.length + 1) : path).split(/[\\/]/)
      if (!segments.slice(0, -1).includes("outputs")) return
      latest.set(path, {
        path,
        name: segments[segments.length - 1],
        folder: segments.slice(0, -1).join("/"),
        time: change.time,
      })
    })
  return [...latest.values()].sort((a, b) => b.time - a.time)
}
