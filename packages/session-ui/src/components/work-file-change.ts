import { getFilename } from "@opencode-ai/core/util/path"

// Omniwork Work mode shows file edits as one friendly line per file instead of diffs.
export type WorkFileChange = {
  file: string
  path: string
  kind: "create" | "update" | "delete" | "write" | "share"
}

export const WORK_FILE_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])

// present_files shows existing files in the app viewer; its parts render as the same file cards.
export const WORK_PRESENT_TOOL = "present_files"

export function workFileChanges(
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): WorkFileChange[] {
  if (tool === WORK_PRESENT_TOOL) {
    return Array.isArray(metadata.files)
      ? metadata.files.flatMap((item): WorkFileChange[] => {
          if (!item || typeof item !== "object" || !("path" in item) || typeof item.path !== "string") return []
          const name = "name" in item && typeof item.name === "string" ? item.name : getFilename(item.path)
          return name ? [{ file: name, path: item.path, kind: "share" }] : []
        })
      : []
  }
  if (tool === "edit") {
    const filediff = metadata.filediff
    const diffFile =
      filediff && typeof filediff === "object" && "file" in filediff && typeof filediff.file === "string"
        ? filediff.file
        : undefined
    const path = diffFile || (typeof input.filePath === "string" ? input.filePath : "")
    const file = getFilename(path)
    return file ? [{ file, path, kind: "update" }] : []
  }
  if (tool === "write") {
    const path = typeof input.filePath === "string" ? input.filePath : ""
    const file = getFilename(path)
    if (!file) return []
    return [{ file, path, kind: metadata.exists === true ? "update" : metadata.exists === false ? "create" : "write" }]
  }
  const files = Array.isArray(metadata.files)
    ? metadata.files.flatMap((item): WorkFileChange[] => {
        if (!item || typeof item !== "object") return []
        const path =
          "movePath" in item && typeof item.movePath === "string"
            ? item.movePath
            : "filePath" in item && typeof item.filePath === "string"
              ? item.filePath
              : undefined
        const file = getFilename(path)
        if (!file) return []
        const type = "type" in item ? item.type : undefined
        return [{ file, path, kind: type === "add" ? "create" : type === "delete" ? "delete" : "update" }]
      })
    : []
  if (files.length > 0) return files
  const text = typeof input.patchText === "string" ? input.patchText : ""
  return [...text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((match) => ({
    file: getFilename(match[2]!.trim()),
    path: match[2]!.trim(),
    kind: match[1] === "Add" ? "create" : match[1] === "Delete" ? "delete" : "update",
  }))
}

export function workFileLabelKey(kind: WorkFileChange["kind"] | undefined, pending: boolean) {
  if (!kind) return pending ? "ui.tool.work.updatingFiles" : "ui.tool.work.updatedFiles"
  if (kind === "create") return pending ? "ui.tool.work.creating" : "ui.tool.work.created"
  if (kind === "delete") return pending ? "ui.tool.work.deleting" : "ui.tool.work.deleted"
  if (kind === "write") return pending ? "ui.tool.work.saving" : "ui.tool.work.saved"
  if (kind === "share") return "ui.tool.work.shared"
  return pending ? "ui.tool.work.updating" : "ui.tool.work.updated"
}
