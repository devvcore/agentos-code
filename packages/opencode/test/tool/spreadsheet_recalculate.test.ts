import { describe, expect, test } from "bun:test"
import path from "path"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { recalculate, SpreadsheetRecalculateTool } from "../../src/tool/spreadsheet_recalculate"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

type Cell = number | string | { f: string; t?: string; si?: string; ref?: string; s?: number }

function sheet(rows: Cell[][]) {
  const cells = rows
    .map((row, r) => {
      const inner = row
        .map((cell, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`
          if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`
          if (typeof cell === "string") return `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`
          const attrs = [cell.t && ` t="${cell.t}"`, cell.ref && ` ref="${cell.ref}"`, cell.si && ` si="${cell.si}"`]
            .filter(Boolean)
            .join("")
          const body = cell.f ? `<f${attrs}>${cell.f}</f>` : `<f${attrs}/>`
          return `<c r="${ref}"${cell.s === undefined ? "" : ` s="${cell.s}"`}>${body}<v></v></c>`
        })
        .join("")
      return `<row r="${r + 1}">${inner}</row>`
    })
    .join("")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetData>${cells}</sheetData></worksheet>`
}

// A workbook as openpyxl writes it: formulas with empty cached values, plus parts that must survive untouched.
function fixture() {
  const data = sheet([
    ["Region", "Units", "Price"],
    ["East", 10, 2.5],
    ["West", 4, 10],
    ["East", 6, 3],
  ])
  const calc = sheet([
    ["Total units", { f: "SUM(Data!B2:B4)" }],
    ["East units", { f: 'SUMIFS(Data!B2:B4,Data!A2:A4,"East")' }],
    ["West price", { f: 'INDEX(Data!C2:C4,MATCH("West",Data!A2:A4,0))' }],
    ["East share", { f: "B2/B1", s: 1 }],
    ["Big?", { f: 'IF(B1&gt;15,"big","small")' }],
    ["Rounded", { f: "ROUND(B3/3,2)" }],
    ["Broken", { f: "B1/0" }],
    ["Line 1", { f: "Data!B2*Data!C2", t: "shared", ref: "B8:B10", si: "0" }],
    ["Line 2", { f: "", t: "shared", si: "0" }],
    ["Line 3", { f: "", t: "shared", si: "0" }],
    ["Check", { f: "B1=20" }],
    ["Future", { f: "_xlfn.REGEXTEST(A1,&quot;T&quot;)" }],
    ["Typo", { f: "SUMM(B1:B2)" }],
    ["Live", { f: 'WEBSERVICE("https://example.com")' }],
  ])
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Calc" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="Units">Data!$B$2:$B$4</definedName></definedNames></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="10" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(data),
    "xl/worksheets/sheet2.xml": strToU8(calc),
  })
}

const part = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name])
const cell = (xml: string, ref: string) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(xml)?.[0]

describe("spreadsheet_recalculate engine", () => {
  test("writes cached values next to the formulas and reports errors and unsupported functions", async () => {
    const input = fixture()
    const out = await recalculate(input)
    const calc = part(out.bytes, "xl/worksheets/sheet2.xml")

    expect(cell(calc, "B1")).toBe(`<c r="B1"><f>SUM(Data!B2:B4)</f><v>20</v></c>`)
    expect(cell(calc, "B2")).toBe(`<c r="B2"><f>SUMIFS(Data!B2:B4,Data!A2:A4,"East")</f><v>16</v></c>`)
    expect(cell(calc, "B3")).toBe(`<c r="B3"><f>INDEX(Data!C2:C4,MATCH("West",Data!A2:A4,0))</f><v>10</v></c>`)
    expect(cell(calc, "B4")).toBe(`<c r="B4" s="1"><f>B2/B1</f><v>0.8</v></c>`)
    expect(cell(calc, "B5")).toBe(`<c r="B5" t="str"><f>IF(B1&gt;15,"big","small")</f><v>big</v></c>`)
    expect(cell(calc, "B6")).toBe(`<c r="B6"><f>ROUND(B3/3,2)</f><v>3.33</v></c>`)
    expect(cell(calc, "B7")).toBe(`<c r="B7" t="e"><f>B1/0</f><v>#DIV/0!</v></c>`)
    expect(cell(calc, "B8")).toBe(`<c r="B8"><f t="shared" ref="B8:B10" si="0">Data!B2*Data!C2</f><v>25</v></c>`)
    expect(cell(calc, "B9")).toBe(`<c r="B9"><f t="shared" si="0"/><v>40</v></c>`)
    expect(cell(calc, "B10")).toBe(`<c r="B10"><f t="shared" si="0"/><v>18</v></c>`)
    expect(cell(calc, "B11")).toBe(`<c r="B11" t="b"><f>B1=20</f><v>1</v></c>`)
    // Unsupported cells keep their original XML.
    expect(cell(calc, "B12")).toBe(`<c r="B12"><f>_xlfn.REGEXTEST(A1,&quot;T&quot;)</f><v></v></c>`)

    expect(out.result.status).toBe("errors")
    expect(out.result.formulas).toBe(14)
    expect(out.result.errors).toEqual([{ sheet: "Calc", cell: "B7", formula: "=B1/0", value: "#DIV/0!" }])
    expect(out.result.unsupported).toEqual([
      { sheet: "Calc", cell: "B12", function: "REGEXTEST" },
      { sheet: "Calc", cell: "B13", function: "SUMM" },
      { sheet: "Calc", cell: "B14", function: "WEBSERVICE" },
    ])

    // Excel still recalculates on open, and every untouched part keeps its exact bytes.
    expect(part(out.bytes, "xl/workbook.xml")).toContain(`<calcPr fullCalcOnLoad="1"/></workbook>`)
    expect(part(out.bytes, "xl/workbook.xml")).toContain(`<definedName name="Units">Data!$B$2:$B$4</definedName>`)
    const before = unzipSync(input)
    const after = unzipSync(out.bytes)
    expect(Object.keys(after)).toEqual(Object.keys(before))
    for (const name of Object.keys(before).filter((name) => name !== "xl/workbook.xml" && !name.includes("sheet2")))
      expect(strFromU8(after[name])).toBe(strFromU8(before[name]))
  })

  test("is idempotent and reports ok once the error is fixed", async () => {
    const first = await recalculate(fixture())
    const second = await recalculate(first.bytes)
    expect(second.bytes).toEqual(first.bytes)
    expect(second.result).toEqual(first.result)

    const fixed = zipSync({
      ...unzipSync(first.bytes),
      "xl/worksheets/sheet2.xml": strToU8(
        part(first.bytes, "xl/worksheets/sheet2.xml")
          .replace("<f>B1/0</f>", "<f>IF(B1=0,0,B2/B1)</f>")
          .replace(/<row r="1[234]">[\s\S]*?<\/row>/g, ""),
      ),
    })
    const out = await recalculate(fixed)
    expect(out.result).toEqual({ status: "ok", formulas: 11, errors: [], unsupported: [] })
    expect(cell(part(out.bytes, "xl/worksheets/sheet2.xml"), "B7")).toBe(`<c r="B7"><f>IF(B1=0,0,B2/B1)</f><v>0.8</v></c>`)
  })

  test("sets fullCalcOnLoad on an existing calcPr", async () => {
    const files = unzipSync(fixture())
    files["xl/workbook.xml"] = strToU8(
      strFromU8(files["xl/workbook.xml"]).replace("</workbook>", `<calcPr calcId="124519" fullCalcOnLoad="0"/></workbook>`),
    )
    const out = await recalculate(zipSync(files))
    expect(part(out.bytes, "xl/workbook.xml")).toContain(`<calcPr calcId="124519" fullCalcOnLoad="1"/>`)
  })
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node])),
)

describe("tool.spreadsheet_recalculate", () => {
  it.instance("recalculates the workbook in place and returns the JSON report", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "outputs", "model.xlsx")
      yield* Effect.promise(() => Bun.write(file, fixture()))
      const info = yield* SpreadsheetRecalculateTool
      const tool = yield* info.init()
      const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const result = yield* tool.execute(
        { path: "outputs/model.xlsx" },
        {
          sessionID: SessionID.make("ses_test"),
          messageID: MessageID.make("msg_test"),
          callID: "",
          agent: "work",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (req) => Effect.sync(() => void asks.push(req)),
        },
      )
      const report = JSON.parse(result.output)
      expect(report.status).toBe("errors")
      expect(report.formulas).toBe(14)
      expect(report.errors).toEqual([{ sheet: "Calc", cell: "B7", formula: "=B1/0", value: "#DIV/0!" }])
      expect(result.metadata).toMatchObject({ filepath: file, status: "errors", formulas: 14, errors: 1, unsupported: 3 })
      expect(asks.map((item) => item.permission)).toEqual(["edit"])
      const saved = new Uint8Array(yield* Effect.promise(() => Bun.file(file).arrayBuffer()))
      expect(cell(part(saved, "xl/worksheets/sheet2.xml"), "B1")).toBe(`<c r="B1"><f>SUM(Data!B2:B4)</f><v>20</v></c>`)
    }),
  )
})
