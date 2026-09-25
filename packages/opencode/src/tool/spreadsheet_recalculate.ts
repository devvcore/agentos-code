import path from "path"
import { fileURLToPath } from "url"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import sheetsWasm from "@dukelib/sheets-wasm/duke_sheets_wasm_bg.wasm" with { type: "file" }
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./spreadsheet_recalculate.txt"
import * as Tool from "./tool"

// Recalculates an .xlsx/.xlsm with the duke-sheets engine (Rust compiled to wasm, MIT) and writes
// the results back as cached values. Only the <v> element and t attribute of formula cells change in
// the sheet XML, plus fullCalcOnLoad in workbook.xml; every other zip part keeps its exact bytes, so
// styles, charts, defined names, drawings, and VBA survive untouched.

export const EXTENSIONS = new Set([".xlsx", ".xlsm", ".xltx", ".xltm"])

// The engine evaluates these, but they need live data, a server, or a pivot cache, so a
// locally computed value would be wrong.
const EXTERNAL = new Set([
  "WEBSERVICE",
  "RTD",
  "STOCKHISTORY",
  "IMAGE",
  "GETPIVOTDATA",
  "COPILOT",
  "CUBEVALUE",
  "CUBEMEMBER",
  "CUBESET",
  "CUBESETCOUNT",
  "CUBERANKEDMEMBER",
  "CUBEMEMBERPROPERTY",
  "CUBEKPIMEMBER",
])

const LIST_LIMIT = 50

export type Result = {
  status: "ok" | "errors"
  formulas: number
  errors: { sheet: string; cell: string; formula: string; value: string }[]
  unsupported: { sheet: string; cell: string; function: string }[]
}

type Engine = typeof import("@dukelib/sheets-wasm")

const engine = (() => {
  const state: { loaded?: Promise<Engine> } = {}
  return () => {
    state.loaded ??= (async () => {
      const mod = await import("@dukelib/sheets-wasm")
      const file = path.isAbsolute(sheetsWasm) ? sheetsWasm : fileURLToPath(new URL(sheetsWasm, import.meta.url))
      mod.initSync({ module: await Bun.file(file).arrayBuffer() })
      return mod
    })()
    return state.loaded
  }
})()

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10))
    return ENTITIES[entity] ?? match
  })
const escape = (text: string) =>
  text
    // Characters XML 1.0 cannot carry at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
const attr = (attrs: string, name: string) => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)
  return match ? decode(match[1]) : undefined
}

function address(ref: string) {
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref.toUpperCase())
  if (!match) return undefined
  const col = [...match[1]].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0) - 1
  return { row: Number(match[2]) - 1, col }
}

// Resolves a relationship target against the part that owns the relationship.
function resolve(owner: string, target: string) {
  if (target.startsWith("/")) return target.slice(1)
  return path.posix.normalize(path.posix.join(path.posix.dirname(owner), target))
}

function relationships(files: Record<string, Uint8Array>, owner: string, strFromU8: (data: Uint8Array) => string) {
  const name = path.posix.join(path.posix.dirname(owner), "_rels", `${path.posix.basename(owner)}.rels`)
  const xml = files[name] ? strFromU8(files[name]) : ""
  return new Map(
    [...xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)].flatMap((match) => {
      const id = attr(match[1], "Id")
      const target = attr(match[1], "Target")
      if (!id || !target || attr(match[1], "TargetMode") === "External") return []
      return [[id, { type: attr(match[1], "Type") ?? "", target: resolve(owner, target) }] as const]
    }),
  )
}

// Function names a formula calls, with Excel's future-function prefixes removed. String literals and
// quoted sheet names are blanked first so their contents cannot look like calls.
function functions(formula: string) {
  const code = formula.replace(/"(?:[^"]|"")*"/g, '""').replace(/'(?:[^']|'')*'/g, "''")
  return [
    ...new Set(
      [...code.matchAll(/(?<![A-Za-z0-9_.!$:])([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map((match) =>
        match[1].toUpperCase().replace(/^(_XLFN\.)?(_XLWS\.)?/, ""),
      ),
    ),
  ].filter((name) => name.length > 0)
}

// The engine rejects a formula that calls a function it does not know, and that failure escapes
// IFERROR. A known function returns something other than an error for at least one arity once wrapped
// in IFERROR, so probing arities 0 through 6 separates "unknown" from "bad arguments".
function unsupportedFunctions(mod: Engine, names: string[]) {
  const probe = names.filter((name) => !EXTERNAL.has(name))
  if (probe.length === 0) return new Set(names)
  const wb = new mod.Workbook()
  try {
    wb.addSheet("probe")
    const sheet = wb.getSheet(0)
    probe.forEach((name, row) =>
      [0, 1, 2, 3, 4, 5, 6].forEach((arity) =>
        sheet.setFormula(
          `${String.fromCharCode(65 + arity)}${row + 1}`,
          `=IFERROR(${name}(${Array(arity).fill("1").join(",")}),0)`,
        ),
      ),
    )
    wb.calculate({})
    return new Set([
      ...names.filter((name) => EXTERNAL.has(name)),
      ...probe.filter((name, row) => [0, 1, 2, 3, 4, 5, 6].every((col) => sheet.getCalculatedValueAt(row, col).is_error)),
    ])
  } finally {
    wb.free()
  }
}

export async function recalculate(bytes: Uint8Array) {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import("fflate")
  const mod = await engine()
  const files = unzipSync(bytes)
  const main = [...relationships(files, "", strFromU8).values()].find((rel) => rel.type.endsWith("/officeDocument"))
  if (!main || !files[main.target]) throw new Error("Not a spreadsheet package: missing the workbook part")
  const workbookXml = strFromU8(files[main.target])
  const rels = relationships(files, main.target, strFromU8)
  const sheets = [...workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)].flatMap((match) => {
    const name = attr(match[1], "name")
    const id = attr(match[1], "r:id")
    const part = id ? rels.get(id) : undefined
    if (!name || !part || !part.type.endsWith("/worksheet") || !files[part.target]) return []
    return [{ name, part: part.target }]
  })

  const wb = mod.Workbook.fromBytes(bytes)
  try {
    wb.calculate({})
    const result: Result = { status: "ok", formulas: 0, errors: [], unsupported: [] }
    const edits = sheets.map((sheet) => {
      const index = wb.sheetIndex(sheet.name)
      const ws = index === undefined ? undefined : wb.getSheet(index)
      const xml = strFromU8(files[sheet.part])
      const cells = [...xml.matchAll(/<((?:\w+:)?)c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/g)]
      // Array formulas cache a value in every cell of their range; only the anchor carries <f>.
      const arrays = cells.flatMap((match) => {
        const ref = /<(?:\w+:)?f\b[^>]*\bt="array"[^>]*\bref="([^"]+)"/.exec(match[3] ?? "")?.[1]
        const [start, end] = (ref ?? "").split(":").map(address)
        return start && end ? [{ start, end }] : []
      })
      const names = new Set(
        cells.flatMap((match) => {
          const text = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/.exec(match[3] ?? "")?.[1]
          return text ? functions(decode(text)) : []
        }),
      )
      const unsupported = names.size ? unsupportedFunctions(mod, [...names]) : new Set<string>()
      const next = xml.replace(
        /<((?:\w+:)?)c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/g,
        (whole, prefix: string, attrs: string, inner: string | undefined) => {
          const ref = attr(attrs, "r")
          const at = ref ? address(ref) : undefined
          if (!ws || !ref || !at) return whole
          const formula = inner ? /<(?:\w+:)?f\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/(?:\w+:)?f>)/.exec(inner)?.[0] : undefined
          const spilled =
            !formula &&
            arrays.some(
              (range) =>
                at.row >= range.start.row &&
                at.row <= range.end.row &&
                at.col >= range.start.col &&
                at.col <= range.end.col &&
                !(at.row === range.start.row && at.col === range.start.col),
            )
          if (!formula && !spilled) return whole
          const text = formula
            ? (ws.getFormulaAt(at.row, at.col) ??
              decode(/>([\s\S]*?)<\/(?:\w+:)?f>/.exec(formula)?.[1] ?? "").replace(/^(?!=)/, "="))
            : ""
          if (formula) {
            result.formulas++
            const missing = functions(text).filter((name) => unsupported.has(name))
            if (missing.length) {
              result.unsupported.push(...missing.map((name) => ({ sheet: sheet.name, cell: ref, function: name })))
              return whole
            }
          }
          const value = ws.getCalculatedValueAt(at.row, at.col)
          const cached = (() => {
            if (value.is_error) return { t: "e", v: value.asError() ?? "#VALUE!" }
            if (value.is_boolean) return { t: "b", v: value.asBoolean() ? "1" : "0" }
            if (value.is_text) return { t: "str", v: value.asText() ?? "" }
            const number = value.asNumber()
            if (value.is_number && number !== undefined)
              return Number.isFinite(number) ? { t: undefined, v: String(number) } : { t: "e", v: "#NUM!" }
            return undefined
          })()
          value.free()
          if (formula && cached?.t === "e")
            result.errors.push({ sheet: sheet.name, cell: ref, formula: text, value: cached.v })
          const base = attrs.replace(/\s+t="[^"]*"/, "")
          const open = `<${prefix}c${base}${cached?.t ? ` t="${cached.t}"` : ""}>`
          const rest = (inner ?? "")
            .replace(formula ?? "", "")
            .replace(/<(?:\w+:)?v\b[^>]*\/>|<(?:\w+:)?v\b[^>]*>[\s\S]*?<\/(?:\w+:)?v>/, "")
            .replace(/<(?:\w+:)?is\b[^>]*>[\s\S]*?<\/(?:\w+:)?is>/, "")
          const v = cached ? `<${prefix}v>${escape(cached.v)}</${prefix}v>` : ""
          return `${open}${formula ?? ""}${v}${rest}</${prefix}c>`
        },
      )
      return { part: sheet.part, xml: next, changed: next !== xml }
    })

    // Excel and LibreOffice still recalculate on open; the cached values serve every other reader.
    const calcPr = /<((?:\w+:)?)calcPr\b([^>]*?)(\/?)>/.exec(workbookXml)
    const workbook = calcPr
      ? workbookXml.replace(
          calcPr[0],
          `<${calcPr[1]}calcPr${calcPr[2].replace(/\s+fullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"${calcPr[3]}>`,
        )
      : workbookXml.replace(
          /<((?:\w+:)?)(oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/((?:\w+:)?)workbook>/,
          (match, prefix: string | undefined, _name, closing: string | undefined) =>
            `<${prefix ?? closing ?? ""}calcPr fullCalcOnLoad="1"/>${match}`,
        )

    const changed = new Map([
      ...edits.filter((edit) => edit.changed).map((edit) => [edit.part, strToU8(edit.xml)] as const),
      ...(workbook !== workbookXml ? [[main.target, strToU8(workbook)] as const] : []),
    ])
    result.status = result.errors.length ? "errors" : "ok"
    return {
      result,
      bytes: changed.size
        ? zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, changed.get(name) ?? data])))
        : bytes,
    }
  } finally {
    wb.free()
  }
}

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "The .xlsx or .xlsm workbook to recalculate, absolute or relative to the project directory",
  }),
})

type Metadata = {
  filepath: string
  status: Result["status"]
  formulas: number
  errors: number
  unsupported: number
}

export const SpreadsheetRecalculateTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service>(
  "spreadsheet_recalculate",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.path) ? params.path : path.resolve(instance.directory, params.path)
          if (!EXTENSIONS.has(path.extname(filepath).toLowerCase()))
            return yield* Effect.fail(
              new Error(`spreadsheet_recalculate works on .xlsx and .xlsm files, not ${path.basename(filepath)}`),
            )
          yield* assertExternalDirectoryEffect(ctx, filepath)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath },
          })
          if (!(yield* fs.existsSafe(filepath))) return yield* Effect.fail(new Error(`File not found: ${filepath}`))

          const out = yield* Effect.tryPromise({
            try: async () => recalculate(new Uint8Array(await Bun.file(filepath).arrayBuffer())),
            catch: (error) =>
              new Error(
                `Could not recalculate ${path.basename(filepath)}: ${error instanceof Error ? error.message : String(error)}`,
              ),
          })
          yield* Effect.promise(() => Bun.write(filepath, out.bytes))

          const report = {
            ...out.result,
            errors: out.result.errors.slice(0, LIST_LIMIT),
            unsupported: out.result.unsupported.slice(0, LIST_LIMIT),
            ...(out.result.errors.length > LIST_LIMIT && { errors_total: out.result.errors.length }),
            ...(out.result.unsupported.length > LIST_LIMIT && { unsupported_total: out.result.unsupported.length }),
          }
          return {
            title: `${path.basename(filepath)} (${out.result.formulas} formulas, ${out.result.errors.length} errors)`,
            metadata: {
              filepath,
              status: out.result.status,
              formulas: out.result.formulas,
              errors: out.result.errors.length,
              unsupported: out.result.unsupported.length,
            },
            output: JSON.stringify(report, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
