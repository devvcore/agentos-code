import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { workAttachedOnly, workAttachments, workFileVersion, workOutputs, workPresents } from "./work-panel-data"

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

  test("lists a file attached twice once, keeping the newest", () => {
    const result = workAttachments({
      messages: [user("m1", 1), user("m2", 2)],
      parts: {
        m1: [attachment("p1", "m1", "/Users/me/Downloads/KXCO.pdf"), attachment("p2", "m1", "a.pdf")],
        m2: [attachment("p3", "m2", "/Users/me/Downloads/KXCO.pdf"), attachment("p4", "m2", "a.pdf")],
      },
    })
    expect(result.map((item) => item.partID)).toEqual(["p4", "p3"])
  })

  test("keeps different files that share a name but not a path or bytes", () => {
    const result = workAttachments({
      messages: [user("m1", 1)],
      parts: {
        m1: [
          attachment("p1", "m1", "/a/report.pdf"),
          attachment("p2", "m1", "/b/report.pdf"),
          attachment("p3", "m1", "report.pdf", "data:application/pdf;base64,AA=="),
          attachment("p4", "m1", "report.pdf", "data:application/pdf;base64,AB=="),
        ],
      },
    })
    expect(result.map((item) => item.partID)).toEqual(["p4", "p3", "p2", "p1"])
  })

  test("a part listed twice (optimistic and synced copies) is one row", () => {
    const part = attachment("p1", "m1", "/a/report.pdf")
    expect(workAttachments({ messages: [user("m1", 1)], parts: { m1: [part, { ...part }] } })).toHaveLength(1)
  })

  test("Attached leaves out files already listed as deliverables", () => {
    const attachments = workAttachments({
      messages: [user("m1", 1)],
      parts: { m1: [attachment("p1", "m1", "/Users/me/Downloads/KXCO.pdf"), attachment("p2", "m1", "b.pdf")] },
    })
    const outputs = [{ path: "/Users/me/Downloads/KXCO.pdf", name: "KXCO.pdf", folder: "/Users/me/Downloads", time: 2 }]
    expect(workAttachedOnly(attachments, outputs).map((item) => item.partID)).toEqual(["p2"])
  })
})

describe("workFileVersion", () => {
  const version = (path: string, parts: Part[]) =>
    workFileVersion({ directory: dir, path, messages: [message("msg")], parts: { msg: parts } })

  test("moves with every write, edit, patch, or present of the file", () => {
    const path = `${dir}/outputs/report.md`
    expect(version(path, [tool("a", "write", 1, { filePath: path })])).toBe(1)
    expect(version(path, [tool("a", "write", 1, { filePath: path }), tool("b", "edit", 5, { filePath: path })])).toBe(5)
    expect(
      version(path, [
        tool("a", "write", 1, { filePath: path }),
        tool("b", "apply_patch", 7, {}, { files: [{ filePath: "outputs/report.md", type: "update" }] }),
      ]),
    ).toBe(7)
    expect(version(path, [tool("a", "present_files", 3, {}, { files: [{ path }] })])).toBe(3)
  })

  test("ignores other files and read-only tools", () => {
    const path = `${dir}/notes/plan.md`
    expect(
      version(path, [
        tool("a", "write", 4, { filePath: `${dir}/outputs/other.md` }),
        tool("b", "read", 6, { filePath: path }),
        tool("c", "write", 2, { filePath: path }),
      ]),
    ).toBe(2)
  })

  test("moves when a script, subagent, or recalculation may have rewritten it", () => {
    const path = `${dir}/outputs/deck.pptx`
    for (const name of ["bash", "execute", "task", "spreadsheet_recalculate"])
      expect(version(path, [tool("a", "present_files", 1, {}, { files: [{ path }] }), tool("b", name, 9, {})])).toBe(9)
  })

  test("running tools do not count until they complete", () => {
    const running = { ...tool("b", "bash", 9, {}), state: { status: "running", input: {}, time: { start: 8 } } } as Part
    expect(version(`${dir}/outputs/a.md`, [running])).toBe(0)
  })
})

describe("workOutputs rewrites", () => {
  test("a presented file outside outputs/ keeps its row and takes the rewrite time", () => {
    const path = `${dir}/notes/plan.md`
    const result = run([
      tool("a", "present_files", 1, {}, { files: [{ path }] }),
      tool("b", "edit", 4, { filePath: path }),
    ])
    expect(result).toEqual([{ path, name: "plan.md", folder: "notes", time: 4 }])
  })

  test("writes outside outputs/ that were never presented stay unlisted", () => {
    expect(run([tool("a", "write", 1, { filePath: `${dir}/notes/plan.md` })])).toEqual([])
  })
})
