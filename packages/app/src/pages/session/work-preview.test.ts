import { describe, expect, test } from "bun:test"
import {
  PREVIEW_MAX_BYTES,
  previewApp,
  previewBytes,
  previewExtension,
  previewKind,
  previewMime,
  previewRelative,
  workPanelWidth,
  workPreview,
  workSessionWidth,
} from "./work-preview"

describe("work preview width", () => {
  test("panel is compact until a file is previewed", () => {
    expect(workPanelWidth(false)).toBe("340px")
    expect(workPanelWidth(true)).toBe("clamp(480px, 50%, 900px)")
  })

  test("session column leaves exactly the panel width plus the row gap", () => {
    expect(workSessionWidth(false)).toBe("calc(100% - 340px - 8px)")
    expect(workSessionWidth(true)).toBe("calc(100% - clamp(480px, 50%, 900px) - 8px)")
  })
})

describe("work preview store", () => {
  test("tracks the previewed file per session", () => {
    workPreview.open("ses_a", "/work/outputs/a.pdf")
    workPreview.open("ses_b", "/work/outputs/b.xlsx")
    expect(workPreview.path("ses_a")).toBe("/work/outputs/a.pdf")
    workPreview.close("ses_a")
    expect(workPreview.path("ses_a")).toBeUndefined()
    expect(workPreview.path("ses_b")).toBe("/work/outputs/b.xlsx")
  })
})

describe("previewKind", () => {
  test("maps extensions to renderers", () => {
    expect(previewKind("/w/outputs/Report.PDF")).toBe("pdf")
    expect(previewKind("/w/outputs/model.xlsx")).toBe("xlsx")
    expect(previewKind("/w/outputs/macro.xlsm")).toBe("xlsx")
    expect(previewKind("/w/outputs/memo.docx")).toBe("docx")
    expect(previewKind("/w/outputs/deck.pptx")).toBe("pptx")
    expect(previewKind("/w/outputs/legacy.ppt")).toBe("pptx")
    expect(previewKind("/w/outputs/data.csv")).toBe("csv")
    expect(previewKind("/w/outputs/data.tsv")).toBe("tsv")
    expect(previewKind("/w/outputs/chart.webp")).toBe("image")
    expect(previewKind("/w/outputs/logo.svg")).toBe("image")
    expect(previewKind("/w/outputs/notes.md")).toBe("text")
  })

  test("falls back to none for unknown, legacy Office, and extensionless files", () => {
    expect(previewKind("/w/outputs/archive.zip")).toBe("none")
    expect(previewKind("/w/outputs/old.doc")).toBe("none")
    expect(previewKind("/w/outputs/Makefile")).toBe("none")
    expect(previewKind("/w/outputs/.env")).toBe("none")
    expect(previewExtension("C:\\w\\outputs\\a.b.Xlsx")).toBe("xlsx")
  })
})

test("previewMime covers image types and defaults to octet-stream", () => {
  expect(previewMime("a.svg")).toBe("image/svg+xml")
  expect(previewMime("a.JPG")).toBe("image/jpeg")
  expect(previewMime("a.bin")).toBe("application/octet-stream")
})

test("previewApp names Office apps only", () => {
  expect(previewApp("memo.docx")).toBe("Word")
  expect(previewApp("deck.pptx")).toBe("PowerPoint")
  expect(previewApp("model.xlsx")).toBe("Excel")
  expect(previewApp("report.pdf")).toBeUndefined()
})

describe("previewRelative", () => {
  test("strips the session directory", () => {
    expect(previewRelative("/work/project/", "/work/project/outputs/a.pdf")).toBe("outputs/a.pdf")
    expect(previewRelative("C:\\work", "C:\\work\\outputs\\a.pdf")).toBe("outputs\\a.pdf")
  })

  test("keeps relative paths and rejects files outside the directory", () => {
    expect(previewRelative("/work/project", "./outputs/a.pdf")).toBe("outputs/a.pdf")
    expect(previewRelative("/work/project", "/work/other/outputs/a.pdf")).toBeUndefined()
    expect(previewRelative("/work/project", "/work/project-2/outputs/a.pdf")).toBeUndefined()
  })
})

describe("previewBytes", () => {
  test("decodes base64 binary content", () => {
    const result = previewBytes({ type: "binary", content: btoa("\u0000\u0001\u00ff%PDF"), encoding: "base64" })
    expect(result.type).toBe("bytes")
    if (result.type === "bytes") expect([...result.bytes]).toEqual([0, 1, 255, 37, 80, 68, 70])
  })

  test("re-encodes text content as UTF-8", () => {
    const result = previewBytes({ type: "text", content: "a,b\né,ü" })
    expect(result.type === "bytes" && new TextDecoder().decode(result.bytes)).toBe("a,b\né,ü")
  })

  test("refuses files over the cap without decoding them", () => {
    const content = "A".repeat(Math.ceil((PREVIEW_MAX_BYTES * 4) / 3) + 8)
    const result = previewBytes({ type: "binary", content, encoding: "base64" })
    expect(result.type).toBe("too-large")
    if (result.type === "too-large") expect(result.size).toBeGreaterThan(PREVIEW_MAX_BYTES)
  })

  test("accepts a file right at the cap", () => {
    const result = previewBytes({ type: "binary", content: btoa("x".repeat(3000)), encoding: "base64" })
    expect(result.type === "bytes" && result.bytes.byteLength).toBe(3000)
  })
})
