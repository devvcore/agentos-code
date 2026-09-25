import path from "path"

// Renders Office Open XML documents (.xlsx/.xlsm, .docx, .pptx) as plain text lines so the
// read tool can page them like any other file. OOXML is a zip of XML parts; fflate unzips it
// and a small XML reader below walks the parts, which keeps the compiled binary lean.

export const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xltx", ".xltm"])
export const DOCUMENT_EXTENSIONS = new Set([".docx", ".docm", ".dotx", ".dotm"])
export const PRESENTATION_EXTENSIONS = new Set([".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm"])
export const LEGACY_EXTENSIONS = new Set([".xls", ".doc", ".ppt"])

export function supported(filepath: string) {
  const ext = path.extname(filepath).toLowerCase()
  return SPREADSHEET_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext) || PRESENTATION_EXTENSIONS.has(ext)
}

export function legacy(filepath: string) {
  return LEGACY_EXTENSIONS.has(path.extname(filepath).toLowerCase())
}

export async function render(filepath: string, bytes: Uint8Array) {
  const { unzipSync, strFromU8 } = await import("fflate")
  const files = unzipSync(bytes, { filter: (file) => file.name.endsWith(".xml") || file.name.endsWith(".rels") })
  const parts = new Map(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]))
  const pkg = { part: (name: string) => (parts.has(name) ? parse(parts.get(name)!) : undefined), rels: rels(parts) }
  const main = [...pkg.rels("").values()].find((rel) => rel.type.endsWith("/officeDocument"))?.target
  if (!main) throw new Error("not an Office Open XML package (missing officeDocument relationship)")

  const ext = path.extname(filepath).toLowerCase()
  if (SPREADSHEET_EXTENSIONS.has(ext)) return workbook(pkg, main)
  if (DOCUMENT_EXTENSIONS.has(ext)) return document(pkg, main)
  return presentation(pkg, main)
}

type XmlNode = { name: string; attrs: Record<string, string>; children: (XmlNode | string)[] }
type Package = {
  part: (name: string) => XmlNode | undefined
  rels: (part: string) => Map<string, { type: string; target: string; external: boolean }>
}

// ---------------------------------------------------------------------------------------------
// XML

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }

function decode(text: string) {
  if (!text.includes("&")) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10))
    return ENTITIES[entity] ?? match
  })
}

// Element names drop their namespace prefix (w:p -> p); attributes keep theirs (r:id).
function parse(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf("<", i)
    if (lt === -1) {
      top().children.push(decode(xml.slice(i)))
      break
    }
    if (lt > i) top().children.push(decode(xml.slice(i, lt)))
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt)
      top().children.push(xml.slice(lt + 9, end === -1 ? xml.length : end))
      i = end === -1 ? xml.length : end + 3
      continue
    }
    // Find the tag end while skipping quoted attribute values, which may legally contain ">".
    let gt = lt + 1
    let quote = ""
    while (gt < xml.length) {
      const ch = xml[gt]
      if (quote) {
        if (ch === quote) quote = ""
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === ">") break
      gt++
    }
    const tag = xml.slice(lt + 1, gt)
    i = gt + 1
    if (tag.startsWith("?") || tag.startsWith("!")) continue
    if (tag.startsWith("/")) {
      const name = local(tag.slice(1).trim())
      const index = stack.findLastIndex((node) => node.name === name)
      if (index > 0) stack.length = index
      continue
    }
    const selfClosing = tag.endsWith("/")
    const body = selfClosing ? tag.slice(0, -1) : tag
    const space = body.search(/\s/)
    const node: XmlNode = {
      name: local(space === -1 ? body : body.slice(0, space)),
      attrs: Object.fromEntries(
        Array.from(space === -1 ? [] : body.slice(space).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)).map(
          (match) => [match[1], decode(match[2] ?? match[3] ?? "")],
        ),
      ),
      children: [],
    }
    top().children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

function local(name: string) {
  const colon = name.indexOf(":")
  return colon === -1 ? name : name.slice(colon + 1)
}

function attr(node: XmlNode | undefined, name: string) {
  if (!node) return undefined
  if (name in node.attrs) return node.attrs[name]
  return Object.entries(node.attrs).find(([key]) => local(key) === name)?.[1]
}

// Relationship ids are always namespaced (r:id); plain `id` attributes on the same element mean something else.
function rid(node: XmlNode) {
  return Object.entries(node.attrs).find(([key]) => key.includes(":") && local(key) === "id")?.[1]
}

function elements(node: XmlNode | undefined, name?: string) {
  if (!node) return []
  return node.children.filter((child): child is XmlNode => typeof child !== "string" && (!name || child.name === name))
}

function child(node: XmlNode | undefined, name: string) {
  return elements(node, name)[0]
}

function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
  return elements(node).flatMap((item) => (item.name === name ? [item] : descendants(item, name)))
}

function first(node: XmlNode | undefined, name: string): XmlNode | undefined {
  for (const item of elements(node)) {
    if (item.name === name) return item
    const found = first(item, name)
    if (found) return found
  }
  return undefined
}

function text(node: XmlNode | undefined): string {
  if (!node) return ""
  return node.children.map((item) => (typeof item === "string" ? item : text(item))).join("")
}

function rels(parts: Map<string, string>) {
  return (part: string) => {
    const dir = path.posix.dirname(part)
    const file = path.posix.join(dir === "." ? "" : dir, "_rels", `${path.posix.basename(part)}.rels`)
    const xml = parts.get(part === "" ? "_rels/.rels" : file)
    if (!xml) return new Map<string, { type: string; target: string; external: boolean }>()
    return new Map(
      descendants(parse(xml), "Relationship").map((rel) => {
        const target = rel.attrs.Target ?? ""
        const external = rel.attrs.TargetMode === "External"
        return [
          rel.attrs.Id ?? "",
          {
            type: rel.attrs.Type ?? "",
            external,
            target: external
              ? target
              : target.startsWith("/")
                ? target.slice(1)
                : path.posix.normalize(path.posix.join(dir === "." ? "" : dir, target)),
          },
        ]
      }),
    )
  }
}

function oneLine(value: string) {
  return value.replace(/\r\n|\r|\n/g, "\\n").replace(/\|/g, "\\|")
}

function table(rows: string[][]) {
  const width = Math.max(1, ...rows.map((row) => row.length))
  const pad = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => oneLine(row[i] ?? "")).join(" | ")} |`
  return [pad(rows[0] ?? []), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(pad)]
}

// ---------------------------------------------------------------------------------------------
// Spreadsheets

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58])
const BUILTIN_TIME_FORMATS = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56])

function column(letters: string) {
  return letters.split("").reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0)
}

function letters(col: number): string {
  return col <= 0 ? "" : letters(Math.floor((col - 1) / 26)) + String.fromCharCode(65 + ((col - 1) % 26))
}

// Shared formulas store the text once on the anchor cell; dependents shift its relative references.
function shift(formula: string, rows: number, cols: number) {
  return formula
    .split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(
            /(^|[^A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g,
            (_match, lead: string, colAbs: string, col: string, rowAbs: string, row: string) =>
              lead +
              colAbs +
              (colAbs ? col : letters(column(col) + cols)) +
              rowAbs +
              (rowAbs ? row : String(Number(row) + rows)),
          ),
    )
    .join("")
}

function dateKind(id: number, code: string | undefined) {
  if (BUILTIN_DATE_FORMATS.has(id)) return id === 22 ? "datetime" : "date"
  if (BUILTIN_TIME_FORMATS.has(id)) return "time"
  if (!code) return undefined
  const cleaned = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
  const time = /[hs]/i.test(cleaned)
  const date = /[dy]/i.test(cleaned) || (/m/i.test(cleaned) && !time)
  if (date && time) return "datetime"
  if (date) return "date"
  if (time) return "time"
  return undefined
}

function serialDate(serial: number, kind: string, date1904: boolean) {
  const seconds = Math.round(serial * 86400)
  const two = (n: number) => String(n).padStart(2, "0")
  const clock = (total: number) => {
    const s = ((total % 60) + 60) % 60
    const m = Math.floor(total / 60) % 60
    return `${two(Math.floor(total / 3600))}:${two(m)}${s ? `:${two(s)}` : ""}`
  }
  if (kind === "time") return clock(seconds)
  const date = new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + seconds * 1000)
  if (Number.isNaN(date.getTime())) return String(serial)
  const day = date.toISOString().slice(0, 10)
  const rest = seconds - Math.floor(seconds / 86400) * 86400
  return kind === "datetime" && rest ? `${day} ${clock(rest)}` : day
}

function workbook(pkg: Package, main: string) {
  const book = pkg.part(main)
  const rel = pkg.rels(main)
  const byType = (suffix: string) => [...rel.values()].find((item) => item.type.endsWith(suffix))?.target
  const date1904 = ["1", "true"].includes(attr(first(book, "workbookPr"), "date1904") ?? "")

  const sharedPart = byType("/sharedStrings")
  const shared = elements(first(sharedPart ? pkg.part(sharedPart) : undefined, "sst"), "si").map((si) =>
    // Rich text runs hold the visible text; rPh holds phonetic hints that are not displayed.
    [...elements(si, "t"), ...elements(si, "r").flatMap((run) => elements(run, "t"))].map(text).join(""),
  )

  const stylesPart = byType("/styles")
  const styles = stylesPart ? pkg.part(stylesPart) : undefined
  const codes = new Map(
    elements(first(styles, "numFmts"), "numFmt").map((fmt) => [Number(attr(fmt, "numFmtId")), attr(fmt, "formatCode")]),
  )
  const formats = elements(first(styles, "cellXfs"), "xf").map((xf) => {
    const id = Number(attr(xf, "numFmtId") ?? 0)
    return dateKind(id, codes.get(id))
  })

  const sheets = elements(first(book, "sheets"), "sheet").map((sheet, index) => {
    const name = attr(sheet, "name") ?? `Sheet${index + 1}`
    const state = attr(sheet, "state")
    const target = rel.get(rid(sheet) ?? "")
    const worksheet = target ? pkg.part(target.target) : undefined
    const data = first(worksheet, "sheetData")
    if (!data || !target?.type.endsWith("/worksheet")) {
      return { name, state, summary: "not a worksheet (chart or dialog sheet)", lines: [] as string[] }
    }

    const masters = new Map<string, { formula: string; row: number; col: number }>()
    const cells = new Map<number, Map<number, string>>()
    const bounds = { minRow: Infinity, maxRow: 0, minCol: Infinity, maxCol: 0, formulas: 0 }
    elements(data, "row").reduce((prevRow, row) => {
      const rowNumber = Number(attr(row, "r") ?? prevRow + 1)
      elements(row, "c").reduce((prevCol, cell) => {
        const ref = attr(cell, "r")?.match(/^\$?([A-Z]+)\$?(\d+)$/)
        const col = ref ? column(ref[1]) : prevCol + 1
        const type = attr(cell, "t")
        const raw = text(child(cell, "v"))
        const value = (() => {
          if (type === "s") return shared[Number(raw)] ?? ""
          if (type === "inlineStr") return descendants(child(cell, "is"), "t").map(text).join("")
          if (type === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw
          if (type === "e" || type === "str" || type === "d" || raw === "") return raw
          const kind = formats[Number(attr(cell, "s") ?? 0)]
          const num = Number(raw)
          return kind && Number.isFinite(num) ? serialDate(num, kind, date1904) : raw
        })()
        const f = child(cell, "f")
        const formula = (() => {
          if (!f) return undefined
          const body = text(f)
          const si = attr(f, "si")
          if (attr(f, "t") !== "shared" || si === undefined) return body || undefined
          if (body) {
            masters.set(si, { formula: body, row: rowNumber, col })
            return body
          }
          const master = masters.get(si)
          return master ? shift(master.formula, rowNumber - master.row, col - master.col) : undefined
        })()
        if (formula) bounds.formulas++
        const shown = formula ? (value === "" ? `=${formula}` : `=${formula} → ${value}`) : value
        if (shown === "") return col
        if (!cells.has(rowNumber)) cells.set(rowNumber, new Map())
        cells.get(rowNumber)!.set(col, shown)
        bounds.minRow = Math.min(bounds.minRow, rowNumber)
        bounds.maxRow = Math.max(bounds.maxRow, rowNumber)
        bounds.minCol = Math.min(bounds.minCol, col)
        bounds.maxCol = Math.max(bounds.maxCol, col)
        return col
      }, 0)
      return rowNumber
    }, 0)

    if (cells.size === 0) return { name, state, summary: "empty", lines: [] as string[] }
    const cols = Array.from({ length: bounds.maxCol - bounds.minCol + 1 }, (_, i) => bounds.minCol + i)
    const range = `${letters(bounds.minCol)}${bounds.minRow}:${letters(bounds.maxCol)}${bounds.maxRow}`
    const merged = elements(first(worksheet, "mergeCells"), "mergeCell")
      .map((item) => attr(item, "ref"))
      .filter((item) => item !== undefined)
    return {
      name,
      state,
      summary: [
        `${range}`,
        `${bounds.maxRow - bounds.minRow + 1} rows x ${cols.length} columns`,
        `${cells.size} non-empty rows`,
        bounds.formulas ? `${bounds.formulas} formula${bounds.formulas === 1 ? "" : "s"}` : undefined,
        merged.length ? `merged: ${merged.slice(0, 10).join(", ")}${merged.length > 10 ? ", ..." : ""}` : undefined,
      ]
        .filter(Boolean)
        .join(", "),
      lines: table([
        ["row", ...cols.map(letters)],
        ...[...cells.keys()]
          .sort((a, b) => a - b)
          .map((row) => [String(row), ...cols.map((col) => cells.get(row)!.get(col) ?? "")]),
      ]),
    }
  })

  const names = elements(first(book, "definedNames"), "definedName")
    .filter((item) => !attr(item, "name")?.startsWith("_xlnm._FilterDatabase"))
    .map((item) => `${attr(item, "name")} = ${text(item)}`)
  // The overview lists the line where each sheet starts so the agent can jump there with offset.
  const intro = [
    `# Workbook: ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}`,
    "Cells show values; formulas appear as `=FORMULA → cached value`. Dates are ISO formatted. Pipes in cells are escaped as \\|, newlines as \\n.",
    ...(names.length ? [`Defined names: ${names.slice(0, 20).join("; ")}${names.length > 20 ? "; ..." : ""}`] : []),
  ]
  const headerLength = intro.length + sheets.length + 1
  const starts = sheets.reduce(
    (acc, sheet) => [...acc, acc[acc.length - 1] + 2 + Math.max(sheet.lines.length, 1)],
    [headerLength + 1],
  )
  return [
    ...intro,
    ...sheets.map(
      (sheet, index) =>
        `- Sheet ${index + 1} "${sheet.name}"${sheet.state && sheet.state !== "visible" ? ` (${sheet.state})` : ""}: ${sheet.summary} (starts at line ${starts[index]})`,
    ),
    "",
    ...sheets.flatMap((sheet, index) => [
      `## Sheet ${index + 1}: ${sheet.name}`,
      ...(sheet.lines.length ? sheet.lines : [`(${sheet.summary})`]),
      "",
    ]),
  ]
}

// ---------------------------------------------------------------------------------------------
// Word documents

function document(pkg: Package, main: string) {
  const body = first(pkg.part(main), "body")
  const rel = pkg.rels(main)
  const byType = (suffix: string) => [...rel.values()].find((item) => item.type.endsWith(suffix))?.target

  const stylesPart = byType("/styles")
  const styles = new Map(
    elements(first(stylesPart ? pkg.part(stylesPart) : undefined, "styles"), "style").map((style) => {
      const ppr = child(style, "pPr")
      return [
        attr(style, "styleId") ?? "",
        {
          name: attr(child(style, "name"), "val") ?? "",
          outline: attr(child(ppr, "outlineLvl"), "val"),
          numId: attr(first(ppr, "numId"), "val"),
          ilvl: attr(first(ppr, "ilvl"), "val"),
        },
      ]
    }),
  )

  const numberingPart = byType("/numbering")
  const numbering = numberingPart ? pkg.part(numberingPart) : undefined
  const abstracts = new Map(
    descendants(numbering, "abstractNum").map((item) => [
      attr(item, "abstractNumId") ?? "",
      new Map(elements(item, "lvl").map((lvl) => [attr(lvl, "ilvl") ?? "0", attr(child(lvl, "numFmt"), "val")])),
    ]),
  )
  const lists = new Map(
    descendants(numbering, "num").map((item) => [
      attr(item, "numId") ?? "",
      abstracts.get(attr(child(item, "abstractNumId"), "val") ?? ""),
    ]),
  )
  const counters = new Map<string, number[]>()

  const changes: string[] = []
  const inline = (node: XmlNode): string =>
    elements(node)
      .map((item) => {
        switch (item.name) {
          case "t":
            return text(item)
          case "tab":
            return "\t"
          case "br":
          case "cr":
            return "\n"
          case "noBreakHyphen":
            return "-"
          case "del":
          case "moveFrom": {
            const removed = descendants(item, "delText").map(text).join("") || descendants(item, "t").map(text).join("")
            if (removed) changes.push(`- deletion by ${attr(item, "author") ?? "unknown"}: "${removed}"`)
            return ""
          }
          case "ins":
          case "moveTo": {
            const added = inline(item)
            if (added) changes.push(`- insertion by ${attr(item, "author") ?? "unknown"}: "${added}"`)
            return added
          }
          case "hyperlink": {
            const label = inline(item)
            const target = rel.get(rid(item) ?? "")
            return target?.external && label ? `[${label}](${target.target})` : label
          }
          case "commentReference":
            return `[comment ${attr(item, "id")}]`
          case "footnoteReference":
          case "endnoteReference":
            return `[^${attr(item, "id")}]`
          case "drawing":
          case "pict": {
            const alt = attr(first(item, "docPr"), "descr") || attr(first(item, "docPr"), "title")
            return alt ? `[image: ${alt}]` : "[image]"
          }
          case "delText":
          case "instrText":
          case "rPr":
          case "pPr":
          case "fldChar":
            return ""
          default:
            return inline(item)
        }
      })
      .join("")

  const paragraph = (p: XmlNode) => {
    const ppr = child(p, "pPr")
    const style = styles.get(attr(child(ppr, "pStyle"), "val") ?? "")
    const content = inline(p).trim()
    if (!content) return undefined
    const heading =
      style?.name.match(/^heading\s*(\d)$/i)?.[1] ??
      (style?.name.toLowerCase() === "title" ? "1" : undefined) ??
      (() => {
        const outline = attr(child(ppr, "outlineLvl"), "val") ?? style?.outline
        return outline !== undefined && Number(outline) < 9 ? String(Number(outline) + 1) : undefined
      })()
    if (heading) return `${"#".repeat(Math.min(Number(heading), 6))} ${content}`
    const numId = attr(first(child(ppr, "numPr"), "numId"), "val") ?? style?.numId
    const level = Number(attr(first(child(ppr, "numPr"), "ilvl"), "val") ?? style?.ilvl ?? 0)
    const format = numId && numId !== "0" ? lists.get(numId)?.get(String(level)) : undefined
    if (!numId || numId === "0") return content
    const indent = "  ".repeat(level)
    if (format === "bullet" || format === undefined) return `${indent}- ${content}`
    if (format === "none") return `${indent}${content}`
    const counts = counters.get(numId) ?? []
    const next = [...counts.slice(0, level), (counts[level] ?? 0) + 1]
    counters.set(numId, next)
    return `${indent}${next[level]}. ${content}`
  }

  const cellText = (cell: XmlNode) =>
    descendants(cell, "p")
      .map((p) => inline(p).trim())
      .filter(Boolean)
      .join("<br>")

  const tableLines = (tbl: XmlNode) =>
    table(
      elements(tbl, "tr").map((tr) =>
        elements(tr, "tc").flatMap((tc) => {
          const props = child(tc, "tcPr")
          const span = Number(attr(child(props, "gridSpan"), "val") ?? 1)
          const merged = child(props, "vMerge")
          const value = merged && attr(merged, "val") !== "restart" ? "" : cellText(tc)
          return [value, ...Array.from({ length: Math.max(span - 1, 0) }, () => "")]
        }),
      ),
    )

  const blocks = (node: XmlNode | undefined): string[][] =>
    elements(node).flatMap((item) => {
      if (item.name === "p") {
        const line = paragraph(item)
        return line === undefined ? [] : [line.split("\n")]
      }
      if (item.name === "tbl") return [tableLines(item)]
      if (item.name === "sdt") return blocks(child(item, "sdtContent"))
      if (item.name === "customXml" || item.name === "ins" || item.name === "moveTo") return blocks(item)
      return []
    })

  // Blank lines separate blocks, but consecutive list items stay together.
  const lines = blocks(body).flatMap((block, index, all) => {
    const list = (value: string[] | undefined) => value?.length === 1 && /^\s*(-|\d+\.) /.test(value[0])
    return index < all.length - 1 && !(list(block) && list(all[index + 1])) ? [...block, ""] : block
  })

  const commentsPart = byType("/comments")
  const comments = elements(first(commentsPart ? pkg.part(commentsPart) : undefined, "comments"), "comment").map(
    (item) =>
      `- [comment ${attr(item, "id")}] ${attr(item, "author") ?? "unknown"}${attr(item, "date") ? ` (${attr(item, "date")!.slice(0, 10)})` : ""}: ${descendants(
        item,
        "p",
      )
        .map((p) => inline(p).trim())
        .filter(Boolean)
        .join(" ")}`,
  )

  return [
    ...lines,
    ...(changes.length
      ? [
          "",
          `## Tracked changes (${changes.length}; text above shows insertions accepted and deletions removed)`,
          ...changes.slice(0, 50).map((item) => (item.length > 300 ? item.slice(0, 300) + '..."' : item)),
          ...(changes.length > 50 ? [`- ... ${changes.length - 50} more`] : []),
        ]
      : []),
    ...(comments.length ? ["", `## Comments (${comments.length})`, ...comments] : []),
  ]
}

// ---------------------------------------------------------------------------------------------
// Presentations

function presentation(pkg: Package, main: string) {
  const rel = pkg.rels(main)
  const slides = elements(first(pkg.part(main), "sldIdLst"), "sldId")
    .map((item) => rel.get(rid(item) ?? "")?.target)
    .filter((item) => item !== undefined)

  const paragraphs = (body: XmlNode | undefined, bullets: boolean) =>
    elements(body, "p").flatMap((p) => {
      const content = elements(p)
        .map((item) => {
          if (item.name === "r" || item.name === "fld") return text(child(item, "t"))
          if (item.name === "br") return "\n"
          return ""
        })
        .join("")
        .trim()
      if (!content) return []
      const indent = "  ".repeat(Number(attr(child(p, "pPr"), "lvl") ?? 0))
      return content.split("\n").map((line) => `${indent}${bullets ? "- " : ""}${line}`)
    })

  const shapes = (tree: XmlNode | undefined): { title: boolean; lines: string[] }[] =>
    elements(tree).flatMap((item) => {
      if (item.name === "grpSp") return shapes(item)
      if (item.name === "sp") {
        const ph = first(child(item, "nvSpPr"), "ph")
        const type = attr(ph, "type")
        const title = type === "title" || type === "ctrTitle"
        const lines = paragraphs(
          child(item, "txBody"),
          ph !== undefined && (type === undefined || type === "body" || type === "obj"),
        )
        if (!lines.length) return []
        return [{ title, lines: title ? [`# ${lines.map((line) => line.trim()).join(" ")}`] : lines }]
      }
      if (item.name === "graphicFrame") {
        const tbl = first(item, "tbl")
        if (tbl) {
          return [
            {
              title: false,
              lines: table(
                elements(tbl, "tr").map((tr) =>
                  elements(tr, "tc").map((tc) =>
                    paragraphs(child(tc, "txBody"), false)
                      .map((line) => line.trim())
                      .join("<br>"),
                  ),
                ),
              ),
            },
          ]
        }
        if (first(item, "chart")) {
          const name = attr(first(item, "cNvPr"), "name")
          return [{ title: false, lines: [`[chart${name ? `: ${name}` : ""}]`] }]
        }
        return []
      }
      if (item.name === "pic") {
        const alt = attr(first(item, "cNvPr"), "descr")
        return alt ? [{ title: false, lines: [`[image: ${alt}]`] }] : []
      }
      return []
    })

  return [
    `# Presentation: ${slides.length} slide${slides.length === 1 ? "" : "s"}`,
    "",
    ...slides.flatMap((target, index) => {
      const slide = pkg.part(target)
      const content = shapes(first(slide, "spTree"))
      const hidden = attr(first(slide, "sld"), "show") === "0"
      const notesTarget = [...pkg.rels(target).values()].find((item) => item.type.endsWith("/notesSlide"))?.target
      const notes = elements(first(notesTarget ? pkg.part(notesTarget) : undefined, "spTree"), "sp")
        .filter((sp) => attr(first(child(sp, "nvSpPr"), "ph"), "type") === "body")
        .flatMap((sp) => paragraphs(child(sp, "txBody"), false))
      return [
        `--- Slide ${index + 1} ---${hidden ? " (hidden)" : ""}`,
        ...content.filter((item) => item.title).flatMap((item) => item.lines),
        ...content.filter((item) => !item.title).flatMap((item) => item.lines),
        ...(notes.length ? ["Speaker notes:", ...notes] : []),
        "",
      ]
    }),
  ]
}

export * as Office from "./office"
