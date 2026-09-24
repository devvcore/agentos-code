import { describe, expect, test } from "bun:test"
import { workFileChanges, workFileLabelKey } from "./work-file-change"

describe("workFileChanges", () => {
  test("uses the basename for edits", () => {
    expect(workFileChanges("edit", { filePath: "/Users/me/Reports/Q3 Summary.xlsx" }, {})).toEqual([
      { file: "Q3 Summary.xlsx", path: "/Users/me/Reports/Q3 Summary.xlsx", kind: "update" },
    ])
  })

  test("distinguishes created and updated writes", () => {
    const input = { filePath: "/tmp/out/report.docx" }
    expect(workFileChanges("write", input, { exists: false })).toEqual([
      { file: "report.docx", path: "/tmp/out/report.docx", kind: "create" },
    ])
    expect(workFileChanges("write", input, { exists: true })).toEqual([
      { file: "report.docx", path: "/tmp/out/report.docx", kind: "update" },
    ])
    expect(workFileChanges("write", input, {})).toEqual([
      { file: "report.docx", path: "/tmp/out/report.docx", kind: "write" },
    ])
  })

  test("reads patch metadata files, preferring moved paths", () => {
    expect(
      workFileChanges(
        "apply_patch",
        {},
        {
          files: [
            { filePath: "/a/notes.md", type: "add" },
            { filePath: "/a/old.csv", type: "delete" },
            { filePath: "/a/draft.txt", movePath: "/a/final.txt", type: "move" },
          ],
        },
      ),
    ).toEqual([
      { file: "notes.md", path: "/a/notes.md", kind: "create" },
      { file: "old.csv", path: "/a/old.csv", kind: "delete" },
      { file: "final.txt", path: "/a/final.txt", kind: "update" },
    ])
  })

  test("falls back to patch text headers while pending", () => {
    const patchText = ["*** Begin Patch", "*** Add File: docs/plan.md", "*** Update File: src/budget.csv"].join("\n")
    expect(workFileChanges("patch", { patchText }, {})).toEqual([
      { file: "plan.md", path: "docs/plan.md", kind: "create" },
      { file: "budget.csv", path: "src/budget.csv", kind: "update" },
    ])
  })
})

describe("workFileLabelKey", () => {
  test("maps kinds to completed and pending labels", () => {
    expect(workFileLabelKey("update", false)).toBe("ui.tool.work.updated")
    expect(workFileLabelKey("create", true)).toBe("ui.tool.work.creating")
    expect(workFileLabelKey(undefined, true)).toBe("ui.tool.work.updatingFiles")
  })
})
