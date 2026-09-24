// Local images in assistant markdown (`![Revenue](outputs/revenue.png)`) point at project files the
// browser cannot load directly. The parser keeps them as `data-markdown-src`; the app resolves them to
// data URLs through the DataProvider, restricted to image files inside the project directory.

export const MARKDOWN_IMAGE_MAX_BYTES = 10 * 1024 * 1024

const extensions: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
}

export function isRemoteImage(src: string) {
  return /^(https?:|data:|blob:)/i.test(src.trim())
}

// Returns the project-relative path for an allowed local image, or undefined when the source is
// remote, not an image, or resolves outside `directory`.
export function markdownImagePath(src: string, directory: string) {
  const raw = src.trim()
  if (!raw || isRemoteImage(raw)) return
  const value = decode(raw.replace(/[?#].*$/, "")).replace(/^file:\/\//i, "")
  // Any other URL scheme (javascript:, ftp:, ...) is rejected; Windows drive letters are allowed.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return
  if (!imageMime(value)) return
  const root = normalize(directory)
  if (!root) return
  const absolute = normalize(absolutePath(value) ? value : `${root}/${value}`)
  const insensitive = /^[a-z]:/i.test(root)
  const prefix = `${root.replace(/\/$/, "")}/`
  const inside = insensitive
    ? absolute.toLowerCase().startsWith(prefix.toLowerCase())
    : absolute.startsWith(prefix)
  if (!inside) return
  return absolute.slice(prefix.length) || undefined
}

export function imageMime(path: string) {
  return extensions[path.split(".").at(-1)?.toLowerCase() ?? ""]
}

type FileContent = {
  type?: string
  content?: string
  encoding?: string
  mimeType?: string
}

export function markdownImageDataUrl(path: string, file: FileContent | undefined) {
  const mime = imageMime(path)
  if (!mime || !file?.content) return
  if (file.encoding === "base64") {
    if (Math.floor((file.content.length * 3) / 4) > MARKDOWN_IMAGE_MAX_BYTES) return
    return `data:${file.mimeType?.startsWith("image/") ? file.mimeType : mime};base64,${file.content}`
  }
  // SVG is text, so the server returns it undecoded.
  if (mime !== "image/svg+xml" || file.content.length > MARKDOWN_IMAGE_MAX_BYTES) return
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`
}

// Dedupes concurrent reads and briefly reuses results so remounting a message (virtualized
// timeline) does not re-read every image, while still picking up an image the agent regenerates.
export function createMarkdownImageResolver(input: {
  directory: () => string
  read: (path: string) => Promise<FileContent | undefined>
}) {
  const cache = new Map<string, { at: number; value: Promise<string | undefined> }>()
  return (src: string) => {
    const directory = input.directory()
    const path = markdownImagePath(src, directory)
    if (!path) return Promise.resolve(undefined)
    const key = `${directory}\n${path}`
    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < 15_000) return cached.value
    const value = input.read(path).then(
      (file) => markdownImageDataUrl(path, file),
      () => undefined,
    )
    cache.delete(key)
    cache.set(key, { at: Date.now(), value })
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return value
  }
}

function decode(value: string) {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

function absolutePath(value: string) {
  return value.startsWith("/") || value.startsWith("\\") || /^[a-z]:[\\/]/i.test(value)
}

function normalize(value: string) {
  const parts = value.replace(/\\/g, "/").split("/")
  const drive = /^[a-z]:$/i.test(parts[0] ?? "") ? parts.shift() : undefined
  const absolute = drive !== undefined || value.startsWith("/") || value.startsWith("\\")
  const segments = parts.reduce<string[]>((result, part) => {
    if (!part || part === ".") return result
    if (part === "..") return result.slice(0, -1)
    return [...result, part]
  }, [])
  const joined = segments.join("/")
  if (drive !== undefined) return `${drive}/${joined}`
  return absolute ? `/${joined}` : joined
}
