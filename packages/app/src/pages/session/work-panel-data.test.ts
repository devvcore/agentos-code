import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { workOutputs } from "./work-panel-data"

const dir = "/work/project"

function message(id: string) {
  return { id, sessionID: "ses", role: "assistant" } as Message
}

function tool(
  id: string,
  name: string,
  time: number,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): ToolPart {
  return {
    id,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    callID: id,
    tool: name,
    state: { status: "completed", input, output: "", title: "", metadata, time: { start: time - 1, end: time } },
  }
}

function run(parts: Part[]) {
  return workOutputs({ directory: dir, messages: [message("msg")], parts: { msg: parts } })
}

describe("workOutputs", () => {
  test("collects write outputs with relative folders", () => {
    expect(run([tool("a", "write", 1, { filePath: `${dir}/outputs/report.docx` })])).toEqual([
      { path: `${dir}/outputs/report.docx`, name: "report.docx", folder: "outputs", time: 1 },
    ])
  })

  test("resolves relative write paths against the project directory", () => {
    expect(run([tool("a", "write", 1, { filePath: "outputs/sub/data.csv" })])).toEqual([
      { path: `${dir}/outputs/sub/data.csv`, name: "data.csv", folder: "outputs/sub", time: 1 },
    ])
  })

  test("collects edit outputs from input or filediff metadata", () => {
    const result = run([
      tool("a", "edit", 1, { filePath: `${dir}/outputs/a.md` }),
      tool("b", "edit", 2, {}, { filediff: { file: `${dir}/outputs/b.md` } }),
    ])
    expect(result.map((item) => item.name)).toEqual(["b.md", "a.md"])
  })

  test("collects apply_patch files, honoring moves and deletes", () => {
    const result = run([
      tool("a", "write", 1, { filePath: `${dir}/outputs/gone.txt` }),
      tool(
        "b",
        "apply_patch",
        2,
        {},
        {
          files: [
            { filePath: `${dir}/outputs/deck.pptx`, type: "add" },
            { filePath: `${dir}/outputs/gone.txt`, type: "delete" },
            { filePath: `${dir}/outputs/old.xlsx`, type: "move", movePath: `${dir}/outputs/final/new.xlsx` },
            { type: "add" },
            "junk",
          ],
        },
      ),
    ])
    expect(result.map((item) => item.path)).toEqual([`${dir}/outputs/deck.pptx`, `${dir}/outputs/final/new.xlsx`])
  })

  test("keeps absolute outputs outside the project directory", () => {
    expect(run([tool("a", "write", 1, { filePath: "/Users/me/outputs/chart.png" })])).toEqual([
      { path: "/Users/me/outputs/chart.png", name: "chart.png", folder: "/Users/me/outputs", time: 1 },
    ])
  })

  test("excludes files outside an outputs folder", () => {
    expect(
      run([
        tool("a", "write", 1, { filePath: `${dir}/src/index.ts` }),
        tool("b", "write", 2, { filePath: `${dir}/outputs` }),
        tool("c", "write", 3, { filePath: `${dir}/my-outputs/x.pdf` }),
        tool("d", "read", 4, { filePath: `${dir}/outputs/read.pdf` }),
      ]),
    ).toEqual([])
  })

  test("dedupes by path, newest first", () => {
    const result = run([
      tool("a", "write", 1, { filePath: `${dir}/outputs/a.pdf` }),
      tool("b", "write", 2, { filePath: `${dir}/outputs/b.pdf` }),
      tool("c", "edit", 3, { filePath: `${dir}/outputs/a.pdf` }),
    ])
    expect(result.map((item) => [item.name, item.time])).toEqual([
      ["a.pdf", 3],
      ["b.pdf", 2],
    ])
  })

  test("ignores pending, running and errored parts", () => {
    const base = tool("a", "write", 1, { filePath: `${dir}/outputs/a.pdf` })
    const input = { filePath: `${dir}/outputs/a.pdf` }
    expect(
      run([
        { ...base, id: "p", state: { status: "pending", input, raw: "" } },
        { ...base, id: "r", state: { status: "running", input, time: { start: 1 } } },
        { ...base, id: "e", state: { status: "error", input, error: "boom", time: { start: 1, end: 2 } } },
        { id: "t", sessionID: "ses", messageID: "msg", type: "text", text: "hi" },
      ]),
    ).toEqual([])
  })

  test("handles sessions without messages", () => {
    expect(workOutputs({ directory: dir, messages: undefined, parts: {} })).toEqual([])
  })
})
