import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { workAttachments, workOutputs, workPresents } from "./work-panel-data"

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

describe("present_files", () => {
  const present = (id: string, time: number, paths: string[]) =>
    tool(id, "present_files", time, { paths }, { files: paths.map((path) => ({ path, name: path.split("/").pop() })) })

  test("lists presented files wherever they live in the project", () => {
    expect(run([present("a", 1, [`${dir}/sales.xlsx`, `${dir}/data/raw/q3.csv`])])).toEqual([
      { path: `${dir}/sales.xlsx`, name: "sales.xlsx", folder: "", time: 1 },
      { path: `${dir}/data/raw/q3.csv`, name: "q3.csv", folder: "data/raw", time: 1 },
    ])
  })

  test("dedupes presented files with outputs writes, newest first", () => {
    const result = run([
      tool("a", "write", 1, { filePath: `${dir}/outputs/report.pdf` }),
      tool("b", "write", 2, { filePath: `${dir}/outputs/chart.png` }),
      present("c", 3, [`${dir}/outputs/report.pdf`]),
    ])
    expect(result.map((item) => [item.name, item.time])).toEqual([
      ["report.pdf", 3],
      ["chart.png", 2],
    ])
  })

  test("ignores malformed metadata", () => {
    expect(run([tool("a", "present_files", 1, {}, { files: [{ name: "x" }, "nope", null] })])).toEqual([])
    expect(run([tool("a", "present_files", 1, {}, {})])).toEqual([])
  })

  test("workPresents lists completed parts in order with their paths", () => {
    const running = { ...present("r", 3, []), state: { status: "running", input: {}, time: { start: 1 } } } as ToolPart
    expect(
      workPresents({
        messages: [message("msg")],
        parts: {
          msg: [
            present("a", 1, [`${dir}/a.xlsx`]),
            tool("w", "write", 2, { filePath: `${dir}/outputs/b.pdf` }),
            running,
            present("c", 4, [`${dir}/c.docx`, `${dir}/d.pptx`]),
          ],
        },
      }),
    ).toEqual([
      { id: "a", paths: [`${dir}/a.xlsx`] },
      { id: "c", paths: [`${dir}/c.docx`, `${dir}/d.pptx`] },
    ])
    expect(workPresents({ messages: undefined, parts: {} })).toEqual([])
  })
})

describe("workAttachments", () => {
  const user = (id: string, created: number) => ({ id, sessionID: "ses", role: "user", time: { created } }) as Message
  const attachment = (id: string, messageID: string, filename: string, url = "data:application/pdf;base64,AA==") =>
    ({ id, sessionID: "ses", messageID, type: "file", mime: "application/pdf", filename, url }) as Part

  test("lists uploaded attachments newest first with their folder when known", () => {
    const result = workAttachments({
      messages: [user("m1", 1), user("m2", 2)],
      parts: {
        m1: [attachment("p1", "m1", "/Users/me/Downloads/KXCO.pdf")],
        m2: [attachment("p2", "m2", "notes.pdf")],
      },
    })
    expect(result).toEqual([
      {
        messageID: "m2",
        partID: "p2",
        name: "notes.pdf",
        mime: "application/pdf",
        path: undefined,
        folder: "",
        time: 2,
      },
      {
        messageID: "m1",
        partID: "p1",
        name: "KXCO.pdf",
        mime: "application/pdf",
        path: "/Users/me/Downloads/KXCO.pdf",
        folder: "Downloads",
        time: 1,
      },
    ])
  })

  test("skips assistant files, file:// references, and inline @mentions", () => {
    const mention = {
      ...attachment("p3", "m1", "src/a.ts"),
      source: { type: "file", path: "src/a.ts", text: { value: "@src/a.ts", start: 0, end: 9 } },
    } as Part
    const result = workAttachments({
      messages: [user("m1", 1), message("a1")],
      parts: {
        m1: [attachment("p2", "m1", "/x/y.pdf", "file:///x/y.pdf"), mention],
        a1: [attachment("p4", "a1", "/x/z.pdf")],
      },
    })
    expect(result).toEqual([])
  })
})
