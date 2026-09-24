import { describe, expect, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { workActivity, workFilePath, workOutputChanges, workPartVisible } from "./work-part"

const base = { id: "prt_1", sessionID: "ses_1", messageID: "msg_1" }

function tool(name: string, input: Record<string, unknown>, status = "completed", metadata = {}): ToolPart {
  const state =
    status === "pending"
      ? { status, input, raw: "" }
      : status === "running"
        ? { status, input, metadata, time: { start: 1 } }
        : status === "error"
          ? { status, input, error: "boom", metadata, time: { start: 1, end: 2 } }
          : { status: "completed", input, output: "", title: "", metadata, time: { start: 1, end: 2 } }
  return { ...base, type: "tool", callID: "call_1", tool: name, state } as ToolPart
}

describe("workPartVisible", () => {
  test("keeps conversation text and files, hides reasoning", () => {
    expect(workPartVisible({ ...base, type: "text", text: "Here is the report" })).toBe(true)
    expect(workPartVisible({ ...base, type: "file", mime: "text/csv", url: "file:///a.csv" })).toBe(true)
    expect(workPartVisible({ ...base, type: "reasoning", text: "hmm", time: { start: 1 } } as Part)).toBe(false)
  })

  test("hides activity tools", () => {
    const hidden = ["read", "glob", "grep", "list", "bash", "shell", "webfetch", "websearch", "todowrite", "task"]
    hidden.forEach((name) => expect(workPartVisible(tool(name, {}))).toBe(false))
    expect(workPartVisible(tool("skill", { name: "docx" }))).toBe(false)
    expect(workPartVisible(tool("execute", { code: "1" }))).toBe(false)
    expect(workPartVisible(tool("mcp_slack_post", {}))).toBe(false)
  })

  test("keeps questions, including dismissed ones", () => {
    expect(workPartVisible(tool("question", { questions: [] }))).toBe(true)
    expect(workPartVisible(tool("question", { questions: [] }, "error"))).toBe(true)
  })

  test("shows file changes only under outputs/", () => {
    expect(workPartVisible(tool("write", { filePath: "/w/outputs/report.docx" }))).toBe(true)
    expect(workPartVisible(tool("edit", { filePath: "outputs\\deck.pptx" }))).toBe(true)
    expect(workPartVisible(tool("write", { filePath: "/w/.work/scratch.py" }))).toBe(false)
    expect(workPartVisible(tool("write", { filePath: "/w/my-outputs.md" }))).toBe(false)
    expect(workPartVisible(tool("write", { filePath: "/w/outputs/report.docx" }, "error"))).toBe(false)
  })
})

describe("workOutputChanges", () => {
  test("drops scratch files from a mixed patch", () => {
    const part = tool("apply_patch", {}, "completed", {
      files: [
        { filePath: "/w/.work/build.py", type: "add" },
        { filePath: "/w/outputs/summary.md", type: "add" },
      ],
    })
    expect(workOutputChanges(part)).toEqual([{ file: "summary.md", path: "/w/outputs/summary.md", kind: "create" }])
  })
})

describe("workFilePath", () => {
  test("resolves relative paths against the directory", () => {
    expect(workFilePath("/Users/me/project/", "outputs/report.docx")).toBe("/Users/me/project/outputs/report.docx")
    expect(workFilePath("/Users/me/project", "./outputs/a.csv")).toBe("/Users/me/project/outputs/a.csv")
    expect(workFilePath("/Users/me/project", "/tmp/outputs/a.csv")).toBe("/tmp/outputs/a.csv")
    expect(workFilePath("C:\\work", "D:\\outputs\\a.csv")).toBe("D:\\outputs\\a.csv")
  })
})

describe("workActivity", () => {
  test("is empty when nothing is running", () => {
    expect(workActivity([tool("read", { filePath: "/w/a.csv" })])).toBeUndefined()
    expect(workActivity([])).toBeUndefined()
  })

  test("describes the latest running tool", () => {
    const parts = [
      tool("read", { filePath: "/w/a.csv" }, "running"),
      tool("read", { filePath: "/w/sales_2026.csv" }, "running"),
    ]
    expect(workActivity(parts)).toEqual({ key: "ui.tool.work.status.reading", target: "sales_2026.csv" })
  })

  test("maps tools to friendly verbs", () => {
    expect(workActivity([tool("shell", { command: "python x.py" }, "running")])).toEqual({
      key: "ui.tool.work.status.running",
    })
    expect(workActivity([tool("websearch", {}, "pending")])).toEqual({ key: "ui.tool.work.status.researching" })
    expect(workActivity([tool("webfetch", {}, "running")])).toEqual({ key: "ui.tool.work.status.researching" })
    expect(workActivity([tool("todowrite", {}, "running")])).toEqual({ key: "ui.tool.work.status.planning" })
    expect(workActivity([tool("grep", {}, "running")])).toEqual({ key: "ui.tool.work.status.readingFiles" })
    expect(workActivity([tool("skill", { name: "xlsx" }, "running")])).toEqual({
      key: "ui.tool.work.status.loading",
      target: "xlsx",
    })
    expect(workActivity([tool("write", { filePath: "/w/outputs/report.docx" }, "running")])).toEqual({
      key: "ui.tool.work.status.writing",
      target: "report.docx",
    })
    expect(workActivity([tool("write", {}, "pending")])).toEqual({ key: "ui.tool.work.status.writingFiles" })
    expect(workActivity([tool("mcp_notion_search", {}, "running")])).toBeUndefined()
  })
})
