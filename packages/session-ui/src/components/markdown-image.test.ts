import { describe, expect, test } from "bun:test"
import {
  createMarkdownImageResolver,
  isRemoteImage,
  MARKDOWN_IMAGE_MAX_BYTES,
  markdownImageDataUrl,
  markdownImagePath,
} from "./markdown-image"

describe("markdownImagePath", () => {
  const root = "/Users/me/project"

  test("allows relative and absolute images inside the project", () => {
    expect(markdownImagePath("outputs/revenue.png", root)).toBe("outputs/revenue.png")
    expect(markdownImagePath("./outputs/chart.SVG", root)).toBe("outputs/chart.SVG")
    expect(markdownImagePath("/Users/me/project/outputs/a.jpeg", root)).toBe("outputs/a.jpeg")
    expect(markdownImagePath("file:///Users/me/project/a.webp", root)).toBe("a.webp")
    expect(markdownImagePath("outputs/my%20chart.png?v=2#top", root)).toBe("outputs/my chart.png")
    expect(markdownImagePath("outputs/../charts/a.gif", root)).toBe("charts/a.gif")
    expect(markdownImagePath("outputs/a.png", "/Users/me/project/")).toBe("outputs/a.png")
  })

  test("rejects paths that escape the project", () => {
    expect(markdownImagePath("../secret.png", root)).toBeUndefined()
    expect(markdownImagePath("outputs/../../other/a.png", root)).toBeUndefined()
    expect(markdownImagePath("/Users/me/project-other/a.png", root)).toBeUndefined()
    expect(markdownImagePath("/etc/a.png", root)).toBeUndefined()
    expect(markdownImagePath("/Users/me/project", root)).toBeUndefined()
  })

  test("rejects non-image files and other schemes", () => {
    expect(markdownImagePath("outputs/report.pdf", root)).toBeUndefined()
    expect(markdownImagePath(".env", root)).toBeUndefined()
    expect(markdownImagePath("outputs/image", root)).toBeUndefined()
    expect(markdownImagePath("javascript:alert(1).png", root)).toBeUndefined()
    expect(markdownImagePath("ftp://host/a.png", root)).toBeUndefined()
    expect(markdownImagePath("https://example.com/a.png", root)).toBeUndefined()
    expect(markdownImagePath("", root)).toBeUndefined()
  })

  test("handles Windows paths case-insensitively", () => {
    expect(markdownImagePath("C:\\Work\\Proj\\outputs\\a.png", "c:\\work\\proj")).toBe("outputs/a.png")
    expect(markdownImagePath("outputs\\b.png", "C:\\Work\\Proj")).toBe("outputs/b.png")
    expect(markdownImagePath("D:\\Other\\a.png", "C:\\Work\\Proj")).toBeUndefined()
  })

  test("detects remote images", () => {
    expect(isRemoteImage("https://example.com/a.png")).toBe(true)
    expect(isRemoteImage("data:image/png;base64,AAAA")).toBe(true)
    expect(isRemoteImage("outputs/a.png")).toBe(false)
  })
})

describe("markdownImageDataUrl", () => {
  test("builds data URLs for binary and svg images", () => {
    expect(markdownImageDataUrl("a.png", { type: "binary", content: "AAAA", encoding: "base64", mimeType: "image/png" })).toBe(
      "data:image/png;base64,AAAA",
    )
    expect(markdownImageDataUrl("a.jpg", { type: "binary", content: "AAAA", encoding: "base64" })).toBe(
      "data:image/jpeg;base64,AAAA",
    )
    expect(markdownImageDataUrl("a.svg", { type: "text", content: "<svg/>" })).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
    )
  })

  test("rejects empty, oversized, and text-as-raster content", () => {
    expect(markdownImageDataUrl("a.png", { type: "text", content: "" })).toBeUndefined()
    expect(markdownImageDataUrl("a.png", { type: "text", content: "not an image" })).toBeUndefined()
    expect(
      markdownImageDataUrl("a.png", {
        content: "A".repeat(Math.ceil((MARKDOWN_IMAGE_MAX_BYTES * 4) / 3) + 8),
        encoding: "base64",
      }),
    ).toBeUndefined()
  })
})

test("resolver only reads allowed paths and dedupes reads", async () => {
  const reads: string[] = []
  const resolve = createMarkdownImageResolver({
    directory: () => "/p",
    read: async (path) => {
      reads.push(path)
      return { content: "AAAA", encoding: "base64", mimeType: "image/png" }
    },
  })
  expect(await resolve("../x.png")).toBeUndefined()
  expect(await Promise.all([resolve("a.png"), resolve("/p/a.png")])).toEqual([
    "data:image/png;base64,AAAA",
    "data:image/png;base64,AAAA",
  ])
  expect(reads).toEqual(["a.png"])
})
