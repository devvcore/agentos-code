import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LibreOffice, MAX_EDGE, RenderPagesTool, render } from "../../src/tool/render_pages"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// A minimal PDF: each page says "Page N" and has a blue square; `landscape` pages are 16:9 slides.
function pdf(pages: number, landscape = false) {
  const size = landscape ? "0 0 960 540" : "0 0 612 792"
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    ...Array.from({ length: pages }).flatMap((_, i) => {
      const stream = `BT /F1 48 Tf 72 400 Td (Page ${i + 1}) Tj ET 0 0 1 rg 72 72 200 200 re f`
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [${size}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ]
    }),
  ]
  const body = objects.reduce(
    (acc, object, i) => ({
      text: `${acc.text}${i + 1} 0 obj\n${object}\nendobj\n`,
      offsets: [...acc.offsets, acc.text.length],
    }),
    { text: "%PDF-1.4\n", offsets: [] as number[] },
  )
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...body.offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.text.length}\n%%EOF\n`,
  ].join("")
  return new TextEncoder().encode(body.text + xref)
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node])),
)

const run = Effect.fn("RenderPagesTest.run")(function* (params: { path: string; pages?: number[]; scale?: number }) {
  const info = yield* RenderPagesTool
  const tool = yield* info.init()
  const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const exit = yield* tool
    .execute(params, {
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      callID: "",
      agent: "work",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) => Effect.sync(() => void asks.push(req)),
    })
    .pipe(Effect.exit)
  return { exit, asks }
})

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected render_pages to fail")
  const err = Cause.squash(exit.cause)
  return err instanceof Error ? err.message : String(err)
}

const decode = (url: string) => Buffer.from(url.replace(/^data:[^,]+,/, ""), "base64")

// PNG width and height live in the IHDR chunk at bytes 16-23.
const dimensions = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

afterEach(() => {
  spyOn(LibreOffice, "find").mockRestore()
})

describe("render_pages.render", () => {
  test("renders pages with the blue square where the PDF draws it", async () => {
    const result = await render(pdf(2))
    expect(result.total).toBe(2)
    expect(result.images.map((image) => image.page)).toEqual([1, 2])
    const first = result.images[0]
    expect(first.mime).toBe("image/png")
    expect(Math.max(first.width, first.height)).toBe(MAX_EDGE)
    expect(dimensions(Buffer.from(first.data))).toEqual({ width: first.width, height: first.height })
    // The square's center, (172, 172) in PDF points from the bottom left, must come out blue, not red.
    const photon = await import("@silvia-odwyer/photon-node")
    const image = photon.PhotonImage.new_from_byteslice(first.data)
    const zoom = MAX_EDGE / 792
    const at = (Math.round((792 - 172) * zoom) * image.get_width() + Math.round(172 * zoom)) * 4
    expect([...image.get_raw_pixels().slice(at, at + 3)]).toEqual([0, 0, 255])
    image.free()
  })

  test("scale shrinks the images and skips pages past the end", async () => {
    const result = await render(pdf(3, true), { pages: [3, 9], scale: 0.5 })
    expect(result.images.map((image) => [image.page, image.width, image.height])).toEqual([[3, 640, 360]])
    expect(result.skipped).toEqual([9])
  })

  test("reports a file that is not a PDF", async () => {
    await expect(render(new TextEncoder().encode("not a pdf"))).rejects.toThrow("not a PDF or is corrupted")
  })
})

describe("tool.render_pages", () => {
  it.instance("returns every page as an image attachment", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "outputs", "report.pdf"), pdf(5)))
      const { exit, asks } = yield* run({ path: "outputs/report.pdf" })
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
      const result = exit.value
      expect(result.output.split("\n")[0]).toBe(`Rendered pages 1-5 of 5 of "report.pdf"`)
      expect(result.attachments).toHaveLength(5)
      for (const attachment of result.attachments ?? []) {
        expect(attachment.mime).toBe("image/png")
        const size = dimensions(decode(attachment.url))
        expect(size.width).toBeLessThanOrEqual(MAX_EDGE)
        expect(size.height).toBeLessThanOrEqual(MAX_EDGE)
      }
      expect(result.metadata).toMatchObject({ total: 5, pages: [1, 2, 3, 4, 5], converted: false })
      expect(asks.map((item) => item.permission)).toEqual(["read"])
    }),
  )

  it.instance("renders only the requested pages and caps a call at 12", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "deck.pdf"), pdf(20, true)))

      const some = yield* run({ path: "deck.pdf", pages: [2, 4, 5, 6, 30] })
      if (Exit.isFailure(some.exit)) throw Cause.squash(some.exit.cause)
      expect(some.exit.value.output).toContain(`Rendered pages 2, 4-6 of 20 of "deck.pdf"`)
      expect(some.exit.value.output).toContain("Skipped 30")
      expect(some.exit.value.attachments).toHaveLength(4)

      const all = yield* run({ path: "deck.pdf" })
      if (Exit.isFailure(all.exit)) throw Cause.squash(all.exit.cause)
      expect(all.exit.value.attachments).toHaveLength(12)
      expect(all.exit.value.output).toContain(`Rendered pages 1-12 of 20 of "deck.pdf"`)
      expect(all.exit.value.output).toContain("pass `pages` to see the rest")
    }),
  )

  it.instance("fails fast on an Office file when LibreOffice is not installed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "Deck.pptx"), "PK"))
      const find = spyOn(LibreOffice, "find").mockResolvedValue(undefined)
      const { exit } = yield* run({ path: "Deck.pptx" })
      expect(find).toHaveBeenCalled()
      expect(failure(exit)).toBe(
        "Visual rendering of .pptx needs LibreOffice, which isn't installed. Skip the visual check; rely on the structural checks in the skill and tell the user the layout wasn't visually verified. Do not use remote computers or sandboxes to render.",
      )
    }),
  )

  it.instance("rejects file types it cannot render", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "notes.txt"), "hello"))
      const { exit, asks } = yield* run({ path: "notes.txt" })
      expect(failure(exit)).toContain("not notes.txt")
      expect(asks).toEqual([])
    }),
  )
})
