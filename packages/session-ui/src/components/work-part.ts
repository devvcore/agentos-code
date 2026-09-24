import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { WORK_FILE_TOOLS, workFileChanges } from "./work-file-change"

// Omniwork Work mode hides tool activity. People see the conversation, answered questions, and
// deliverables; pending questions and permission requests render in the composer dock, not as parts.
export function workPartVisible(part: Part) {
  if (part.type === "reasoning") return false
  if (part.type !== "tool") return true
  if (part.tool === "question") return true
  if (part.state.status === "error") return false
  if (WORK_FILE_TOOLS.has(part.tool)) return workOutputChanges(part).length > 0
  return false
}

// Only deliverables under an outputs/ folder get a file card; scratch files stay hidden.
export function workOutputChanges(part: ToolPart) {
  return workFileChanges(part.tool, part.state.input ?? {}, toolMetadata(part)).filter((change) =>
    /(^|[\\/])outputs[\\/]/.test(change.path),
  )
}

export function workFilePath(directory: string, path: string) {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path.replace(/^\.[\\/]/, "")}`
}

// The quiet "Working… Reading sales.csv" line comes from the latest tool the turn is running.
// Returns undefined when the plain "Working…" label says enough.
export function workActivity(parts: Part[]) {
  const part = parts.findLast(
    (item): item is ToolPart =>
      item.type === "tool" && (item.state.status === "pending" || item.state.status === "running"),
  )
  if (!part) return
  const input = part.state.input ?? {}
  if (part.tool === "read") {
    const file = getFilename(typeof input.filePath === "string" ? input.filePath : undefined)
    return file
      ? { key: "ui.tool.work.status.reading" as const, target: file }
      : { key: "ui.tool.work.status.readingFiles" as const }
  }
  if (part.tool === "glob" || part.tool === "grep" || part.tool === "list")
    return { key: "ui.tool.work.status.readingFiles" as const }
  if (part.tool === "bash" || part.tool === "shell") return { key: "ui.tool.work.status.running" as const }
  if (part.tool === "webfetch" || part.tool === "websearch") return { key: "ui.tool.work.status.researching" as const }
  if (part.tool === "todowrite" || part.tool === "todoread") return { key: "ui.tool.work.status.planning" as const }
  if (part.tool === "skill") {
    const name = typeof input.name === "string" ? input.name : ""
    return name
      ? { key: "ui.tool.work.status.loading" as const, target: name }
      : { key: "ui.tool.work.status.loadingGuide" as const }
  }
  if (WORK_FILE_TOOLS.has(part.tool)) {
    const file = workFileChanges(part.tool, input, toolMetadata(part))[0]?.file
    return file
      ? { key: "ui.tool.work.status.writing" as const, target: file }
      : { key: "ui.tool.work.status.writingFiles" as const }
  }
}

function toolMetadata(part: ToolPart): Record<string, unknown> {
  return "metadata" in part.state && part.state.metadata ? part.state.metadata : {}
}
