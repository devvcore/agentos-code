import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { strToU8, zipSync } from "fflate"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
        Truncate.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const exec = Effect.fn("ReadOfficeTest.exec")(function* (dir: string, args: Tool.InferParameters<typeof ReadTool>) {
  const info = yield* ReadTool
  const tool = yield* info.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const fail = Effect.fn("ReadOfficeTest.fail")(function* (dir: string, args: Tool.InferParameters<typeof ReadTool>) {
  const exit = yield* exec(dir, args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const put = Effect.fn("ReadOfficeTest.put")(function* (p: string, content: string | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])))

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const rels = (items: [string, string, string][]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`
const root = (target: string) => rels([["rId1", "officeDocument", target]])

const cell = (ref: string, inner: string, attrs = "") => `<c r="${ref}"${attrs}>${inner}</c>`

const xlsx = (extraRows = 0) =>
  zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": root("xl/workbook.xml"),
    "xl/workbook.xml": `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><workbookPr/><sheets><sheet name="Site Report" sheetId="1" r:id="rId1"/><sheet name="Log" sheetId="2" r:id="rId2"/><sheet name="Scratch" sheetId="3" state="hidden" r:id="rId3"/></sheets><definedNames><definedName name="Total">'Site Report'!$C$5</definedName></definedNames></workbook>`,
    "xl/_rels/workbook.xml.rels": rels([
      ["rId1", "worksheet", "worksheets/sheet1.xml"],
      ["rId2", "worksheet", "worksheets/sheet2.xml"],
      ["rId3", "worksheet", "worksheets/sheet3.xml"],
      ["rId4", "sharedStrings", "sharedStrings.xml"],
      ["rId5", "styles", "styles.xml"],
    ]),
    "xl/sharedStrings.xml": `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Site</t></si><si><t>Visited</t></si><si><t>Visits</t></si><si><r><t>North </t></r><r><rPr><b/></rPr><t>Yard</t></r></si><si><t>South &amp; East</t></si><si><t>Total</t></si></sst>`,
    "xl/styles.xml": `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1">${cell("A1", "<v>0</v>", ' t="s"')}${cell("B1", "<v>1</v>", ' t="s"')}${cell("C1", "<v>2</v>", ' t="s"')}${cell("D1", "<is><t>Note | pipe</t></is>", ' t="inlineStr"')}</row>
      <row r="2">${cell("A2", "<v>3</v>", ' t="s"')}${cell("B2", "<v>46266</v>", ' s="1"')}${cell("C2", "<v>120</v>")}${cell("D2", "<f>C2*2</f><v>240</v>")}</row>
      <row r="3">${cell("A3", "<v>4</v>", ' t="s"')}${cell("B3", "<v>46267.5</v>", ' s="2"')}${cell("C3", "<v>80.5</v>")}${cell("D3", '<f t="shared" ref="D3:D4" si="0">C3*2</f><v>161</v>')}</row>
      <row r="4">${cell("C4", "<v>1</v>", ' t="b"')}${cell("D4", '<f t="shared" si="0"/><v>2</v>')}</row>
      <row r="5">${cell("A5", "<v>5</v>", ' t="s"')}${cell("C5", "<f>SUM(C2:C3)</f><v>200.5</v>")}${cell("D5", "<f>SUM(D2:D4)</f>")}</row>
    </sheetData><mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells></worksheet>`,
    "xl/worksheets/sheet2.xml": `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from(
      { length: extraRows },
      (_, i) =>
        `<row r="${i + 1}">${cell(`A${i + 1}`, `<v>${i + 1}</v>`)}${cell(`B${i + 1}`, `<is><t>entry ${i + 1}</t></is>`, ' t="inlineStr"')}</row>`,
    ).join("")}</sheetData></worksheet>`,
    "xl/worksheets/sheet3.xml": `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
  })

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}"`
const para = (inner: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inner}</w:p>`
const run = (value: string) => `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`
const listItem = (numId: number, value: string) =>
  para(run(value), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`)
const tc = (value: string) => `<w:tc>${para(run(value))}</w:tc>`

const docx = () =>
  zip({
    "_rels/.rels": root("word/document.xml"),
    "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${REL}/comments" Target="comments.xml"/><Relationship Id="rId4" Type="${REL}/hyperlink" Target="https://example.com/report" TargetMode="External"/></Relationships>`,
    "word/styles.xml": `${XML}<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    "word/numbering.xml": `${XML}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    "word/comments.xml": `${XML}<w:comments ${W}><w:comment w:id="0" w:author="Dana" w:date="2026-09-01T10:00:00Z">${para(run("Please double-check this figure."))}</w:comment></w:comments>`,
    "word/document.xml": `${XML}<w:document ${W}><w:body>
      ${para(run("Site Report"), '<w:pStyle w:val="Heading1"/>')}
      ${para(`${run("Summary of visits. See ")}<w:hyperlink r:id="rId4">${run("the portal")}</w:hyperlink>${run(".")}`)}
      ${para(run("Findings"), '<w:pStyle w:val="Heading2"/>')}
      ${listItem(1, "Fence damaged")}
      ${listItem(1, "Gate unlocked")}
      ${listItem(2, "Repair fence")}
      ${listItem(2, "Lock gate")}
      <w:tbl><w:tr>${tc("Site")}${tc("Visits")}</w:tr><w:tr>${tc("North")}${tc("120")}</w:tr></w:tbl>
      ${para(`${run("Budget is ")}<w:del w:id="1" w:author="Sam"><w:r><w:delText>$10k</w:delText></w:r></w:del><w:ins w:id="2" w:author="Sam">${run("$12k")}</w:ins><w:r><w:commentReference w:id="0"/></w:r>`)}
      <w:sectPr/></w:body></w:document>`,
  })

const P = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`
const shape = (ph: string, paragraphs: string[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${paragraphs
    .map((value) => `<a:p><a:r><a:t>${value}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`

const pptx = () =>
  zip({
    "_rels/.rels": root("ppt/presentation.xml"),
    "ppt/presentation.xml": `${XML}<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([
      ["rId2", "slide", "slides/slide1.xml"],
      ["rId3", "slide", "slides/slide2.xml"],
    ]),
    "ppt/slides/slide1.xml": `${XML}<p:sld ${P}><p:cSld><p:spTree>${shape('<p:ph type="body" idx="1"/>', ["Visits up 12%", "Two incidents"])}${shape('<p:ph type="title"/>', ["Q3 Site Review"])}${shape("", ["Confidential"])}</p:spTree></p:cSld></p:sld>`,
    "ppt/slides/_rels/slide1.xml.rels": rels([["rId1", "notesSlide", "../notesSlides/notesSlide1.xml"]]),
    "ppt/notesSlides/notesSlide1.xml": `${XML}<p:notes ${P}><p:cSld><p:spTree>${shape('<p:ph type="sldImg"/>', [])}${shape('<p:ph type="body" idx="1"/>', ["Mention the north yard fence."])}</p:spTree></p:cSld></p:notes>`,
    "ppt/slides/slide2.xml": `${XML}<p:sld ${P} show="0"><p:cSld><p:spTree>${shape('<p:ph type="title"/>', ["Appendix"])}<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Site</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Visits</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>North</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>120</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
  })

describe("tool.read office documents", () => {
  it.live("renders an xlsx workbook with values, formulas, and dates", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "Site Report 2026-09.xlsx")
      yield* put(file, xlsx(3))

      const result = yield* exec(dir, { filePath: file })
      expect(result.output).toContain("<type>office document rendered as text (xlsx)</type>")
      expect(result.output).toContain("# Workbook: 3 sheets")
      expect(result.output).toContain("Defined names: Total = 'Site Report'!$C$5")
      expect(result.output).toContain(
        '- Sheet 1 "Site Report": A1:D5, 5 rows x 4 columns, 5 non-empty rows, 5 formulas, merged: A5:B5 (starts at line 8)',
      )
      expect(result.output).toContain('- Sheet 3 "Scratch" (hidden): empty')
      expect(result.output).toContain("8: ## Sheet 1: Site Report")
      expect(result.output).toContain("| row | A | B | C | D |")
      expect(result.output).toContain("| 1 | Site | Visited | Visits | Note \\| pipe |")
      expect(result.output).toContain("| 2 | North Yard | 2026-09-01 | 120 | =C2*2 → 240 |")
      expect(result.output).toContain("| 3 | South & East | 2026-09-02 12:00 | 80.5 | =C3*2 → 161 |")
      expect(result.output).toContain("| 4 |  |  | TRUE | =C4*2 → 2 |")
      expect(result.output).toContain("| 5 | Total |  | =SUM(C2:C3) → 200.5 | =SUM(D2:D4) |")
      expect(result.output).toContain("| 3 | entry 3 |")
      expect(result.output).toContain("(End of file")
      expect(result.metadata.truncated).toBe(false)
    }),
  )

  it.live("pages large workbooks by rendered line and suggests python", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "big.xlsm")
      yield* put(file, xlsx(3000))

      const first = yield* exec(dir, { filePath: file })
      expect(first.metadata.truncated).toBe(true)
      expect(first.output).toMatch(/Output capped at 50 KB\. Showing lines 1-\d+\. Use offset=\d+ to continue\./)
      expect(first.output).toContain("use Python")

      const page = yield* exec(dir, { filePath: file, offset: 2500, limit: 3 })
      expect(page.output).toMatch(/2500: \| \d+ \| \d+ \| entry \d+ \|/)
      expect(page.output).toContain("Showing lines 2500-2502")
      expect(page.output).not.toContain("2503:")
    }),
  )

  it.live("renders a docx with headings, lists, tables, tracked changes, and comments", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "report.docx")
      yield* put(file, docx())

      const result = yield* exec(dir, { filePath: file })
      expect(result.output).toContain("<type>office document rendered as text (docx)</type>")
      expect(result.output).toContain("1: # Site Report")
      expect(result.output).toContain("Summary of visits. See [the portal](https://example.com/report).")
      expect(result.output).toContain("## Findings")
      expect(result.output).toContain("- Fence damaged\n")
      expect(result.output).toMatch(/\d+: - Gate unlocked\n\d+: 1\. Repair fence\n\d+: 2\. Lock gate/)
      expect(result.output).toContain("| Site | Visits |")
      expect(result.output).toContain("| --- | --- |")
      expect(result.output).toContain("| North | 120 |")
      expect(result.output).toContain("Budget is $12k[comment 0]")
      expect(result.output).not.toContain("Budget is $10k")
      expect(result.output).toContain("## Tracked changes (2;")
      expect(result.output).toContain('- deletion by Sam: "$10k"')
      expect(result.output).toContain('- insertion by Sam: "$12k"')
      expect(result.output).toContain("- [comment 0] Dana (2026-09-01): Please double-check this figure.")
    }),
  )

  it.live("renders a pptx slide by slide with titles, tables, and speaker notes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "deck.pptx")
      yield* put(file, pptx())

      const result = yield* exec(dir, { filePath: file })
      expect(result.output).toContain("1: # Presentation: 2 slides")
      expect(result.output).toMatch(
        /--- Slide 1 ---\n\d+: # Q3 Site Review\n\d+: - Visits up 12%\n\d+: - Two incidents\n\d+: Confidential\n\d+: Speaker notes:\n\d+: Mention the north yard fence\./,
      )
      expect(result.output).toContain("--- Slide 2 --- (hidden)")
      expect(result.output).toContain("| North | 120 |")
    }),
  )

  it.live("reports a clear error for corrupt office files", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "broken.xlsx"), "not really a spreadsheet")

      const err = yield* fail(dir, { filePath: path.join(dir, "broken.xlsx") })
      expect(err.message).toContain("Cannot read Office document")
    }),
  )

  it.live("still rejects legacy binary office formats and other binaries", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "old.xls"), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01]))
      yield* put(path.join(dir, "archive.zip"), zip({ "a.xml": "<a/>" }))

      const legacy = yield* fail(dir, { filePath: path.join(dir, "old.xls") })
      expect(legacy.message).toContain("Cannot read binary file")
      expect(legacy.message).toContain("legacy binary Office format")

      const archive = yield* fail(dir, { filePath: path.join(dir, "archive.zip") })
      expect(archive.message).toBe(`Cannot read binary file: ${path.join(dir, "archive.zip")}`)
    }),
  )
})
