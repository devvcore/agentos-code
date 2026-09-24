import path from "path"
import { fileURLToPath } from "url"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"

// Roughly 25k tokens of extracted text before the agent is pointed at the original file.
export const PDF_TEXT_BUDGET = 100_000
const CACHE_LIMIT = 16
const cache = new Map<string, Promise<string[] | Error>>()

/**
 * Absolute paths of local files the user explicitly attached to their messages.
 * Tools may read exactly these files without an external_directory prompt; nothing
 * else in their directories is covered.
 */
export function paths(messages: SessionV1.WithParts[]) {
  return new Set(
    messages
      .filter((msg) => msg.info.role === "user")
      .flatMap((msg) => msg.parts)
      .flatMap((part) => (part.type === "file" && part.mime !== "application/x-directory" ? [local(part)] : []))
      .filter((item) => item !== undefined)
      .map(normalize),
  )
}

/**
 * The on-disk location of an attached file, when the client told us. Desktop
 * attachments arrive as data URLs whose filename is the absolute source path;
 * @-mentioned files arrive as file:// URLs or with a file source.
 */
export function local(part: Pick<SessionV1.FilePart, "url" | "filename" | "source">) {
  const source = part.source?.type === "file" || part.source?.type === "symbol" ? part.source.path : undefined
  // Only host-less file URLs map to a local path; fileURLToPath throws on others.
  const url = part.url.startsWith("file:///") ? fileURLToPath(new URL(part.url)) : undefined
  return [source, url, part.filename].find((item) => item !== undefined && path.isAbsolute(item))
}

export function normalize(filepath: string) {
  return process.platform === "win32" ? FSUtil.normalizePath(filepath) : path.resolve(filepath)
}

/**
 * Text stand-in for a PDF the selected model cannot take as a document: the
 * extracted text layer, page-delimited and budgeted, with the original path so
 * the agent can go deeper with its own tools.
 */
export const pdfText = Effect.fnUntraced(function* (input: { url: string; filename?: string; path?: string }) {
  const name = path.basename(input.path ?? input.filename ?? "document.pdf")
  const pages = yield* Effect.promise(() => extract(input.url))
  const where = input.path ? `, original at ${input.path}` : ""

  if (pages instanceof Error) {
    const next = input.path
      ? `The original is at ${input.path}; try the pdf skill's tools on it.`
      : "Ask the user for a text version if its content is needed."
    return `Attached PDF "${name}" could not be opened for text extraction (${pages.message}). ${next}`
  }

  const count = `${pages.length} ${pages.length === 1 ? "page" : "pages"}`
  if (pages.every((page) => page.trim() === "")) {
    const next = input.path
      ? `To read it, run OCR on ${input.path} (see the pdf skill).`
      : "Ask the user for a text version if its content is needed."
    return `Attached PDF "${name}" (${count}${where}) has no text layer; it is probably scanned images. ${next}`
  }

  const total = pages.reduce((sum, page) => sum + page.length, 0)
  const shown = pages.reduce(
    (acc, page, index) => {
      const room = PDF_TEXT_BUDGET - acc.chars
      if (room <= 0) return acc
      const text = page.length > room ? page.slice(0, room) : page
      return {
        chars: acc.chars + text.length,
        last: index + 1,
        body: [...acc.body, `--- Page ${index + 1} ---\n${text}`],
      }
    },
    { chars: 0, last: 0, body: [] as string[] },
  )
  const header = `Attached PDF "${name}" (${count}${where}). Extracted text:`
  if (shown.chars >= total) return [header, ...shown.body].join("\n\n")

  const rest = input.path
    ? `The full file is at ${input.path}; read it with your tools for the remaining content.`
    : "The remaining content is not included."
  const note = `[Text truncated at ${PDF_TEXT_BUDGET.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters, through page ${shown.last} of ${pages.length}. ${rest}]`
  return [header, ...shown.body, note].join("\n\n")
})

// Model messages are rebuilt every provider turn, so extraction is memoized by content.
function extract(url: string) {
  const key = Bun.hash(url).toString()
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const next = load(url).catch((error) => (error instanceof Error ? error : new Error(String(error))))
  cache.set(key, next)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return next
}

async function load(url: string) {
  const { extractText, getDocumentProxy } = await import("unpdf")
  const bytes = url.startsWith("file:")
    ? new Uint8Array(await Bun.file(fileURLToPath(new URL(url))).arrayBuffer())
    : new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"))
  const result = await extractText(await getDocumentProxy(bytes, { verbosity: 0 }), { mergePages: false })
  return result.text
}

export * as SessionAttachment from "./attachment"
