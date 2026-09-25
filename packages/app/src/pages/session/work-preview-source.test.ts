import { describe, expect, test } from "bun:test"
import type { FilePart, Part } from "@opencode-ai/sdk/v2"
import { PREVIEW_MAX_BYTES } from "./work-preview"
import {
  findFilePart,
  loadPreview,
  previewBlobURL,
  previewBytesEqual,
  previewDataURL,
  previewImageSource,
  previewKindFor,
  previewName,
  previewPath,
  workAttachmentPart,
  workAttachmentResolve,
  workAttachmentSource,
  workAttachmentTarget,
  workDraftRef,
  workPreviewSourceEqual,
  type WorkPreviewRead,
  type WorkPreviewSource,
} from "./work-preview-source"

const dir = "/work/project"
const pdf = "%PDF-1.7 hello"
const pdfURL = `data:application/pdf;base64,${btoa(pdf)}`

function file(input: Partial<FilePart> = {}): FilePart {
  return {
    id: "prt_file",
    sessionID: "ses",
    messageID: "msg_user",
    type: "file",
    mime: "application/pdf",
    filename: "/Users/me/Downloads/KXCO.pdf",
    url: pdfURL,
    ...input,
  }
}

const decode = (value: { type: string; bytes?: Uint8Array }) => new TextDecoder().decode(value.bytes)

function reader() {
  const calls: string[] = []
  const read: WorkPreviewRead = async (path) => {
    calls.push(path)
    return { type: "text", content: "a,b\n1,2" }
  }
  return { calls, read }
}

describe("previewDataURL", () => {
  test("decodes base64 data URLs", () => {
    const result = previewDataURL(pdfURL)
    expect(result?.type).toBe("bytes")
    expect(decode(result as { type: "bytes"; bytes: Uint8Array })).toBe(pdf)
  })

  test("decodes percent-encoded data URLs as UTF-8 text", () => {
    const result = previewDataURL(`data:text/plain,${encodeURIComponent("héllo, world")}`)
    expect(decode(result as { type: "bytes"; bytes: Uint8Array })).toBe("héllo, world")
  })

  test("reports oversized payloads without decoding them", () => {
    const payload = "A".repeat(Math.ceil((PREVIEW_MAX_BYTES * 4) / 3) + 8)
    const result = previewDataURL(`data:application/pdf;base64,${payload}`)
    expect(result?.type).toBe("too-large")
    expect((result as { size: number }).size).toBeGreaterThan(PREVIEW_MAX_BYTES)
  })

  test("rejects non-data and malformed URLs", () => {
    expect(previewDataURL("file:///tmp/a.pdf")).toBeUndefined()
    expect(previewDataURL("data:application/pdf;base64")).toBeUndefined()
  })
})

describe("previewKindFor", () => {
  test("prefers the extension", () => {
    expect(previewKindFor("KXCO.pdf", "application/octet-stream")).toBe("pdf")
    expect(previewKindFor("data.csv", "text/plain")).toBe("csv")
  })

  test("falls back to the MIME type", () => {
    expect(previewKindFor("report", "application/pdf")).toBe("pdf")
    expect(previewKindFor("script.py", "text/plain")).toBe("text")
    expect(previewKindFor("photo", "image/png")).toBe("image")
    expect(previewKindFor("archive.zip", "application/zip")).toBe("none")
  })
})

describe("workAttachmentSource", () => {
  test("uploaded files preview from their inline bytes and keep the on-disk path for Open", () => {
    expect(workAttachmentSource(file())).toEqual({
      type: "inline",
      name: "KXCO.pdf",
      mime: "application/pdf",
      url: pdfURL,
      path: "/Users/me/Downloads/KXCO.pdf",
    })
  })

  test("a bare filename has no on-disk path", () => {
    const source = workAttachmentSource(file({ filename: "KXCO.pdf" }))
    expect(source).toMatchObject({ type: "inline", name: "KXCO.pdf" })
    expect(previewPath(source)).toBeUndefined()
  })

  test("file:// URLs become path sources", () => {
    expect(workAttachmentSource(file({ url: "file:///work/project/My%20File.pdf" }))).toEqual({
      type: "path",
      path: "/work/project/My File.pdf",
    })
  })
})

describe("loadPreview", () => {
  test("inline attachments from outside the project decode locally, never via the server", async () => {
    const { calls, read } = reader()
    const result = await loadPreview(workAttachmentSource(file()), { directory: dir, read })
    expect(result.type).toBe("bytes")
    expect(decode(result as { type: "bytes"; bytes: Uint8Array })).toBe(pdf)
    expect(calls).toEqual([])
  })

  test("inline attachments over the size cap are too large", async () => {
    const { read } = reader()
    const big = `data:application/pdf;base64,${"A".repeat(Math.ceil((PREVIEW_MAX_BYTES * 4) / 3) + 8)}`
    expect((await loadPreview(workAttachmentSource(file({ url: big })), { directory: dir, read })).type).toBe(
      "too-large",
    )
  })

  test("project paths are read relative to the session directory", async () => {
    const { calls, read } = reader()
    const result = await loadPreview({ type: "path", path: `${dir}/outputs/data.csv` }, { directory: dir, read })
    expect(result.type).toBe("bytes")
    expect(calls).toEqual(["outputs/data.csv"])
  })

  test("paths outside the project are not sent to the server", async () => {
    const { calls, read } = reader()
    const result = await loadPreview({ type: "path", path: "/Users/me/Downloads/KXCO.pdf" }, { directory: dir, read })
    expect(result).toEqual({ type: "outside" })
    expect(calls).toEqual([])
  })

  test("unknown types are unsupported and missing attachments unavailable", async () => {
    const { read } = reader()
    const zip = workAttachmentSource(file({ filename: "a.zip", mime: "application/zip" }))
    expect(await loadPreview(zip, { directory: dir, read })).toEqual({ type: "unsupported" })
    expect(await loadPreview({ type: "missing" }, { directory: dir, read })).toEqual({ type: "unavailable" })
  })

  test("inline sources whose URL carries no bytes are unavailable", async () => {
    const { read } = reader()
    const source = { type: "inline" as const, name: "KXCO.pdf", mime: "application/pdf", url: "https://x/y.pdf" }
    expect(await loadPreview(source, { directory: dir, read })).toEqual({ type: "unavailable" })
  })
})

describe("attachment references", () => {
  test("re-resolve the file part from sync data", () => {
    const parts: Record<string, Part[] | undefined> = {
      msg_user: [{ id: "prt_text", sessionID: "ses", messageID: "msg_user", type: "text", text: "hi" }, file()],
    }
    expect(workAttachmentPart({ messageID: "msg_user", partID: "prt_file" }, parts)?.url).toBe(pdfURL)
    expect(workAttachmentPart({ messageID: "msg_user", partID: "prt_text" }, parts)).toBeUndefined()
    expect(workAttachmentPart({ messageID: "msg_gone", partID: "prt_file" }, parts)).toBeUndefined()
    expect(findFilePart({ messageID: "msg_user", partID: "prt_file" }, undefined)).toBeUndefined()
  })

  test("Work mode clicks target the panel; other modes keep the platform behaviour", () => {
    expect(workAttachmentTarget(file(), { work: true, sessionID: "ses" })).toEqual({
      messageID: "msg_user",
      partID: "prt_file",
    })
    expect(workAttachmentTarget(file(), { work: false, sessionID: "ses" })).toBeUndefined()
    expect(workAttachmentTarget(file(), { work: true, sessionID: undefined })).toBeUndefined()
    expect(workAttachmentTarget(file(), { work: true, sessionID: "other" })).toBeUndefined()
  })
})

describe("source helpers", () => {
  test("names and equality", () => {
    const inline = workAttachmentSource(file())
    expect(previewName(inline)).toBe("KXCO.pdf")
    expect(previewName({ type: "path", path: `${dir}/outputs/a.csv` })).toBe("a.csv")
    expect(previewName({ type: "missing" })).toBe("")
    expect(workPreviewSourceEqual(inline, workAttachmentSource(file()))).toBe(true)
    expect(workPreviewSourceEqual(inline, workAttachmentSource(file({ filename: "other.pdf" })))).toBe(false)
    expect(workPreviewSourceEqual({ type: "path", path: "/a" }, { type: "path", path: "/a" })).toBe(true)
    expect(workPreviewSourceEqual({ type: "path", path: "/a" }, inline)).toBe(false)
    expect(workPreviewSourceEqual(undefined, undefined)).toBe(true)
  })
})

describe("markdown", () => {
  test("markdown files render as markdown by extension or MIME type", () => {
    expect(previewKindFor("notes.md", "text/plain")).toBe("markdown")
    expect(previewKindFor("NOTES", "text/markdown")).toBe("markdown")
    expect(previewKindFor("notes.txt", "text/plain")).toBe("text")
  })

  test("relative images resolve against the markdown file's folder", () => {
    const source: WorkPreviewSource = { type: "path", path: `${dir}/outputs/report/summary.md` }
    expect(previewImageSource(source, "chart.png")).toBe(`${dir}/outputs/report/chart.png`)
    expect(previewImageSource(source, "./img/chart.png")).toBe(`${dir}/outputs/report/img/chart.png`)
    expect(previewImageSource(source, "../chart.png")).toBe(`${dir}/outputs/report/../chart.png`)
  })

  test("absolute, remote, and data: images pass through, as does a file without a location", () => {
    const source: WorkPreviewSource = { type: "path", path: `${dir}/outputs/summary.md` }
    expect(previewImageSource(source, "/abs/chart.png")).toBe("/abs/chart.png")
    expect(previewImageSource(source, "https://x.test/a.png")).toBe("https://x.test/a.png")
    expect(previewImageSource(source, "data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==")
    const inline: WorkPreviewSource = { type: "inline", name: "a.md", mime: "text/plain", url: "data:," }
    expect(previewImageSource(inline, "chart.png")).toBe("chart.png")
  })
})

describe("reloads", () => {
  test("previewBytesEqual compares content, not identity", () => {
    expect(previewBytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(previewBytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(previewBytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })
})

describe("attachments that are not synced yet", () => {
  const ref = { messageID: "msg_user", partID: "prt_file" }

  test("a just-sent attachment previews from the clicked copy until sync data has it", () => {
    expect(workAttachmentResolve({ ref, local: file() })).toEqual(workAttachmentSource(file()))
    const synced = file({ filename: "/Users/me/Downloads/Other.pdf" })
    expect(workAttachmentResolve({ ref, synced, local: file() })).toEqual(workAttachmentSource(synced))
  })

  test("without a copy it waits for the fetched message instead of showing nothing", () => {
    expect(workAttachmentResolve({ ref })).toBeUndefined()
    expect(workAttachmentResolve({ ref, fetched: { ref: { ...ref, partID: "prt_other" } } })).toBeUndefined()
    expect(workAttachmentResolve({ ref, fetched: { ref: { ...ref }, part: file() } })).toEqual(
      workAttachmentSource(file()),
    )
    expect(workAttachmentResolve({ ref, fetched: { ref: { ...ref } } })).toEqual({ type: "missing" })
  })

  test("a composer draft resolves only from its copy", () => {
    const draft = workDraftRef("att_1")
    expect(workAttachmentResolve({ ref: draft })).toEqual({ type: "missing" })
    expect(
      workAttachmentResolve({ ref: draft, local: { url: "blob:x", mime: "application/pdf", filename: "/d/a.pdf" } }),
    ).toEqual({ type: "inline", name: "a.pdf", mime: "application/pdf", url: "blob:x", path: "/d/a.pdf" })
  })

  test("blob: URLs from the composer load their bytes", async () => {
    const load = (async () => new Response(new Blob([pdf]))) as unknown as typeof fetch
    const loaded = await previewBlobURL("blob:x", load)
    expect(loaded.type).toBe("bytes")
    expect(decode(loaded as { type: string; bytes: Uint8Array })).toBe(pdf)
    const gone = (async () => {
      throw new TypeError("revoked")
    }) as unknown as typeof fetch
    expect(await previewBlobURL("blob:x", gone)).toEqual({ type: "unavailable" })
    const source: WorkPreviewSource = { type: "inline", name: "a.pdf", mime: "application/pdf", url: "blob:x" }
    const read = reader()
    expect((await loadPreview(source, { directory: dir, read: read.read, fetch: load })).type).toBe("bytes")
    expect(read.calls).toEqual([])
  })
})

