import { describe, expect, test } from "bun:test"
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, columnName, delimitedModel, parseDelimited } from "./work-preview-sheet"

test("columnName follows spreadsheet lettering", () => {
  expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
    "A",
    "B",
    "Z",
    "AA",
    "AB",
    "AZ",
    "BA",
    "ZZ",
    "AAA",
  ])
})

describe("parseDelimited", () => {
  test("handles quotes, escaped quotes, embedded delimiters and newlines", () => {
    const text = 'name,notes,amount\r\n"Smith, J","said ""hi""\nthen left",12.5\nDoe,,-3\n'
    expect(parseDelimited(text, ",")).toEqual([
      ["name", "notes", "amount"],
      ["Smith, J", 'said "hi"\nthen left', "12.5"],
      ["Doe", "", "-3"],
    ])
  })

  test("supports tabs, a BOM, and a last line without newline", () => {
    expect(parseDelimited("\uFEFFa\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })
})

describe("delimitedModel", () => {
  test("right-aligns numeric columns only", () => {
    const model = delimitedModel('item,price,share,code\nA,"$1,200.50",12%,x1\nB,(30),3.5%,x2\n', ",")
    expect(model.columns).toBe(4)
    expect(model.numeric).toEqual([false, true, true, false])
    expect(model.truncated).toBe(false)
  })

  test("ignores dash placeholders when detecting numeric columns", () => {
    const clean = delimitedModel('price,share\n"$1,200.50",12%\n(30),3.5%\n-,\n', ",")
    expect(clean.numeric).toEqual([true, true])
  })

  test("caps rows and columns with a truncation flag", () => {
    const wide = Array.from({ length: SHEET_MAX_COLUMNS + 5 }, (_, index) => `c${index}`).join(",")
    const rows = Array.from({ length: SHEET_MAX_ROWS + 10 }, () => wide).join("\n")
    const model = delimitedModel(rows, ",")
    expect(model.rows.length).toBe(SHEET_MAX_ROWS)
    expect(model.columns).toBe(SHEET_MAX_COLUMNS)
    expect(model.rows[0].length).toBe(SHEET_MAX_COLUMNS)
    expect(model.truncated).toBe(true)
  })

  test("sizes columns from content within bounds", () => {
    const model = delimitedModel(`a,${"x".repeat(200)}\n1,2`, ",")
    expect(model.widths[0]).toBe(64)
    expect(model.widths[1]).toBe(320)
  })
})
