/** Rendering caps: bigger tables show the top-left corner with a notice. */
export const SHEET_MAX_ROWS = 2000
export const SHEET_MAX_COLUMNS = 100

export type SheetModel = {
  /** rows[r][c], 0-based. */
  rows: string[][]
  columns: number
  /** Column widths in px. */
  widths: number[]
  /** Right-align columns that hold numbers. */
  numeric: boolean[]
  truncated: boolean
}

/** Spreadsheet column label for a 0-based index: 0 -> A, 26 -> AA. */
export function columnName(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26))
  return index < 26 ? letter : columnName(Math.floor(index / 26) - 1) + letter
}

/** Parse CSV/TSV text (RFC 4180 quoting) into rows of fields. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  const state = { row: [] as string[], field: "", quoted: false }
  const source = text.replace(/^﻿/, "")
  // Plain loop: a character state machine over files up to the preview size cap.
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (state.quoted) {
      if (char === '"' && source[index + 1] === '"') {
        state.field += '"'
        index++
        continue
      }
      if (char === '"') state.quoted = false
      else state.field += char
      continue
    }
    if (char === '"' && state.field === "") {
      state.quoted = true
      continue
    }
    if (char === delimiter) {
      state.row.push(state.field)
      state.field = ""
      continue
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++
      rows.push([...state.row, state.field])
      state.row = []
      state.field = ""
      continue
    }
    state.field += char
  }
  if (state.field !== "" || state.row.length > 0) rows.push([...state.row, state.field])
  return rows
}

/** Grid model for delimited text, capped at SHEET_MAX_ROWS x SHEET_MAX_COLUMNS. */
export function delimitedModel(text: string, delimiter: string): SheetModel {
  const parsed = parseDelimited(text, delimiter)
  const width = parsed.reduce((max, row) => Math.max(max, row.length), 0)
  const columns = Math.min(Math.max(width, 1), SHEET_MAX_COLUMNS)
  const rows = parsed.slice(0, SHEET_MAX_ROWS).map((row) => row.slice(0, columns))
  const sample = rows.slice(1, 201)
  return {
    rows,
    columns,
    widths: Array.from({ length: columns }, (_, index) =>
      Math.min(320, Math.max(64, ...rows.slice(0, 200).map((row) => (row[index]?.length ?? 0) * 7 + 16))),
    ),
    numeric: Array.from({ length: columns }, (_, index) => {
      // Blanks and dash placeholders ("-" for zero or n/a) don't decide the column type.
      const values = sample.map((row) => row[index] ?? "").filter((value) => !/^\s*[-–—]?\s*$/.test(value))
      return values.length > 0 && values.every((value) => NUMBER.test(value))
    }),
    truncated: parsed.length > SHEET_MAX_ROWS || width > SHEET_MAX_COLUMNS,
  }
}

// Plain, currency, percent, thousands-separated, or accounting-negative numbers.
const NUMBER = /^(?=.*\d)\s*[-+]?\(?[$€£¥]?\s*(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\)?%?\s*$/
