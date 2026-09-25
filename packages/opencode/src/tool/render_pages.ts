import path from "path"
import os from "os"
import { mkdtemp, rm, stat } from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import pdfiumWasm from "@embedpdf/pdfium/pdfium.wasm" with { type: "file" }
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { InstanceState } from "@/effect/instance-state"
import { WorkPython } from "@/work/python"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./render_pages.txt"
import * as Tool from "./tool"

// Renders PDF pages to images with PDFium compiled to wasm (@embedpdf/pdfium, MIT; PDFium is Apache-2.0)
// and encodes them with photon's wasm, both embedded in the compiled CLI, so the model can look at its own
// output without LibreOffice, poppler, or PyMuPDF. Office files go through LibreOffice to PDF first, when
// LibreOffice is installed.

export const MAX_PAGES = 12
// Longest edge of a rendered page at scale 1: a 16:9 slide is 1280x720, a letter page 989x1280.
export const MAX_EDGE = 1280
const LIMIT_EDGE = 2000
// Base64 budget per image; larger PNGs (photo-heavy slides) are re-encoded as JPEG.
const MAX_PNG_BYTES = 2 * 1024 * 1024
const CONVERT_TIMEOUT_MS = 180_000

export const OFFICE = new Set([".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".doc", ".ppt", ".xls", ".rtf"])

export type Page = { page: number; width: number; height: number; mime: string; data: Uint8Array }

type Pdfium = Awaited<ReturnType<typeof import("@embedpdf/pdfium").init>>
type Photon = typeof import("@silvia-odwyer/photon-node")

const engines = (() => {
  const state: { loaded?: Promise<{ pdfium: Pdfium; photon: Photon }> } = {}
  return () => {
    state.loaded ??= (async () => {
      const file = (url: string) => (path.isAbsolute(url) ? url : fileURLToPath(new URL(url, import.meta.url)))
      // Patched photon-node reads this during module init so compiled binaries use the embedded wasm.
      ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
        file(photonWasm)
      const { init } = await import("@embedpdf/pdfium")
      const pdfium = await init({ wasmBinary: await Bun.file(file(pdfiumWasm)).arrayBuffer() })
      pdfium.PDFiumExt_Init()
      return { pdfium, photon: await import("@silvia-odwyer/photon-node") }
    })()
    state.loaded.catch(() => {
      state.loaded = undefined
    })
    return state.loaded
  }
})()

const PDF_ERRORS: Record<number, string> = {
  2: "the file is missing or cannot be opened",
  3: "it is not a PDF or is corrupted",
  4: "it is password protected",
  5: "its security scheme is not supported",
}

// Renders the requested 1-based pages (default: the first MAX_PAGES). Pages past the end are ignored.
// Every call below is synchronous, so concurrent renders never interleave inside the wasm instance.
export async function render(bytes: Uint8Array, options: { pages?: readonly number[]; scale?: number } = {}) {
  const { pdfium, photon } = await engines()
  const heap = () => (pdfium.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8
  const buffer = pdfium.pdfium.wasmExports.malloc(bytes.length)
  heap().set(bytes, buffer)
  const doc = pdfium.FPDF_LoadMemDocument(buffer, bytes.length, "")
  try {
    if (!doc) {
      const code = pdfium.FPDF_GetLastError()
      throw new Error(`PDF could not be opened: ${PDF_ERRORS[code] ?? `PDFium error ${code}`}`)
    }
    const total = pdfium.FPDF_GetPageCount(doc)
    const requested = [...new Set(options.pages ?? Array.from({ length: MAX_PAGES }, (_, i) => i + 1))]
    const selected = requested.filter((page) => Number.isInteger(page) && page >= 1 && page <= total)
    const scale = Math.min(Math.max(options.scale ?? 1, 0.1), 2)
    const images = selected.slice(0, MAX_PAGES).map((number): Page => {
      const page = pdfium.FPDF_LoadPage(doc, number - 1)
      if (!page) throw new Error(`Page ${number} could not be loaded`)
      try {
        const w = pdfium.FPDF_GetPageWidthF(page)
        const h = pdfium.FPDF_GetPageHeightF(page)
        const zoom = Math.min((MAX_EDGE / Math.max(w, h)) * scale, LIMIT_EDGE / Math.max(w, h))
        const width = Math.max(1, Math.round(w * zoom))
        const height = Math.max(1, Math.round(h * zoom))
        const bitmap = pdfium.FPDFBitmap_Create(width, height, 1)
        if (!bitmap) throw new Error(`Page ${number} is too large to render`)
        try {
          pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
          // FPDF_ANNOT draws annotations and filled form fields; FPDF_REVERSE_BYTE_ORDER yields RGBA.
          pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x01 | 0x10)
          const start = pdfium.FPDFBitmap_GetBuffer(bitmap)
          const stride = pdfium.FPDFBitmap_GetStride(bitmap)
          const pixels = new Uint8Array(width * height * 4)
          const source = heap()
          Array.from({ length: height }).forEach((_, row) =>
            pixels.set(source.subarray(start + row * stride, start + row * stride + width * 4), row * width * 4),
          )
          const image = new photon.PhotonImage(pixels, width, height)
          try {
            const png = image.get_bytes()
            if (png.length <= MAX_PNG_BYTES) return { page: number, width, height, mime: "image/png", data: png }
            return { page: number, width, height, mime: "image/jpeg", data: image.get_bytes_jpeg(85) }
          } finally {
            image.free()
          }
        } finally {
          pdfium.FPDFBitmap_Destroy(bitmap)
        }
      } finally {
        pdfium.FPDF_ClosePage(page)
      }
    })
    return {
      total,
      images,
      skipped: requested.filter((page) => !selected.includes(page)),
      truncated: selected.length > MAX_PAGES,
    }
  } finally {
    if (doc) pdfium.FPDF_CloseDocument(doc)
    pdfium.pdfium.wasmExports.free(buffer)
  }
}

// LibreOffice is detected, never downloaded here. The managed location is where a future Work runtime
// install puts it, next to the managed Python.
export const LibreOffice = {
  managed() {
    const dir = path.join(WorkPython.root(), "libreoffice")
    if (process.platform === "darwin") return path.join(dir, "LibreOffice.app", "Contents", "MacOS", "soffice")
    if (process.platform === "win32") return path.join(dir, "program", "soffice.exe")
    return path.join(dir, "program", "soffice")
  },
  async find() {
    const candidates = [
      Bun.which("soffice"),
      Bun.which("libreoffice"),
      process.platform === "darwin" ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : undefined,
      process.platform === "win32" ? "C:\\Program Files\\LibreOffice\\program\\soffice.exe" : undefined,
      LibreOffice.managed(),
    ].filter((item): item is string => !!item)
    for (const candidate of candidates) {
      if (
        await stat(candidate).then(
          (info) => info.isFile(),
          () => false,
        )
      )
        return candidate
    }
  },
}

export function unavailable(ext: string) {
  return `Visual rendering of ${ext} needs LibreOffice, which isn't installed. Skip the visual check; rely on the structural checks in the skill and tell the user the layout wasn't visually verified. Do not use remote computers or sandboxes to render.`
}

async function convert(soffice: string, filepath: string, abort: AbortSignal) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "render-pages-"))
  try {
    // A private profile so a LibreOffice window the user has open doesn't swallow the conversion.
    const proc = Bun.spawn(
      [
        soffice,
        `-env:UserInstallation=${pathToFileURL(path.join(dir, "profile")).href}`,
        "--headless",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        filepath,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.any([abort, AbortSignal.timeout(CONVERT_TIMEOUT_MS)]),
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const pdf = Bun.file(path.join(dir, `${path.parse(filepath).name}.pdf`))
    if (code !== 0 || !(await pdf.exists()))
      throw new Error(
        `LibreOffice could not convert ${path.basename(filepath)} to PDF: ${(err || out).trim() || `exit ${code}`}`,
      )
    return new Uint8Array(await pdf.arrayBuffer())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// "1-5", "1, 3, 7-9"
function ranges(pages: number[]) {
  return pages
    .reduce<number[][]>((acc, page) => {
      const last = acc.at(-1)
      if (last && page === last[last.length - 1] + 1) last.push(page)
      else acc.push([page])
      return acc
    }, [])
    .map((run) => (run.length > 1 ? `${run[0]}-${run[run.length - 1]}` : `${run[0]}`))
    .join(", ")
}

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "The PDF or Office file to render, absolute or relative to the project directory",
  }),
  pages: Schema.optional(
    Schema.Array(Schema.Number).annotate({
      description: `1-based page or slide numbers to render (at most ${MAX_PAGES} per call). Defaults to the first ${MAX_PAGES}.`,
    }),
  ),
  scale: Schema.optional(
    Schema.Number.annotate({
      description: `Image size relative to the default (${MAX_EDGE}px on the longest edge). Use 0.5 for a cheap overview of many pages, up to 1.5 to read small print.`,
    }),
  ),
})

type Metadata = {
  filepath: string
  total: number
  pages: number[]
  converted: boolean
}

export const RenderPagesTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service>(
  "render_pages",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.path) ? params.path : path.resolve(instance.directory, params.path)
          const name = path.basename(filepath)
          const ext = path.extname(filepath).toLowerCase()
          if (ext !== ".pdf" && !OFFICE.has(ext))
            return yield* Effect.fail(
              new Error(
                `render_pages renders .pdf, .docx, .pptx, .xlsx, .odt, .odp, and .ods files, not ${name}. For an image, use the read tool.`,
              ),
            )
          yield* assertExternalDirectoryEffect(ctx, filepath, { read: true })
          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {},
          })
          if (!(yield* fs.existsSafe(filepath))) return yield* Effect.fail(new Error(`File not found: ${filepath}`))

          const soffice = ext === ".pdf" ? undefined : yield* Effect.promise(() => LibreOffice.find())
          if (ext !== ".pdf" && !soffice) return yield* Effect.fail(new Error(unavailable(ext)))

          const result = yield* Effect.tryPromise({
            try: async () =>
              render(
                soffice
                  ? await convert(soffice, filepath, ctx.abort)
                  : new Uint8Array(await Bun.file(filepath).arrayBuffer()),
                { pages: params.pages, scale: params.scale },
              ),
            catch: (error) =>
              new Error(`Could not render ${name}: ${error instanceof Error ? error.message : String(error)}`),
          })

          const shown = result.images.map((image) => image.page)
          const notes = [
            result.skipped.length
              ? `Skipped ${result.skipped.join(", ")}: the document has ${result.total} page${result.total === 1 ? "" : "s"}.`
              : undefined,
            result.truncated || (!params.pages && result.total > MAX_PAGES)
              ? `At most ${MAX_PAGES} pages render per call; pass \`pages\` to see the rest.`
              : undefined,
            soffice
              ? "Rendered through LibreOffice, so fonts and spacing can differ slightly from Microsoft Office; broken layout will not."
              : undefined,
          ].filter(Boolean)
          const summary = shown.length
            ? `Rendered page${shown.length === 1 ? "" : "s"} ${ranges(shown)} of ${result.total} of "${name}"`
            : `No pages rendered: "${name}" has ${result.total} page${result.total === 1 ? "" : "s"}`
          return {
            title: `${name} (${shown.length ? `pages ${ranges(shown)}` : "no pages"})`,
            metadata: { filepath, total: result.total, pages: shown, converted: !!soffice },
            output: [
              summary,
              ...result.images.map((image) => `Page ${image.page}: ${image.width}x${image.height}`),
              ...notes,
            ].join("\n"),
            attachments: result.images.map((image) => ({
              type: "file" as const,
              mime: image.mime,
              filename: `${path.parse(name).name}-page-${image.page}.${image.mime === "image/png" ? "png" : "jpg"}`,
              url: `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`,
            })),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
