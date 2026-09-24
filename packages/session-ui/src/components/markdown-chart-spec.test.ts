import { describe, expect, test } from "bun:test"
import { CHART_MAX_DATASETS, formatChartValue, parseChartSpec } from "./markdown-chart-spec"

const bar = {
  type: "bar",
  title: "Revenue by quarter",
  labels: ["Q1", "Q2", "Q3"],
  datasets: [{ label: "2025", data: [1.2, 1.5, 1.9] }],
}

function parse(value: unknown) {
  return parseChartSpec(JSON.stringify(value))
}

describe("parseChartSpec", () => {
  test("accepts a minimal spec and fills defaults", () => {
    expect(parse(bar)).toEqual({
      ok: true,
      spec: {
        type: "bar",
        title: "Revenue by quarter",
        labels: ["Q1", "Q2", "Q3"],
        datasets: [{ label: "2025", data: [1.2, 1.5, 1.9] }],
        xLabel: undefined,
        yLabel: undefined,
        stacked: false,
        format: "number",
        currency: "USD",
      },
    })
  })

  test("accepts every chart type and optional fields", () => {
    for (const type of ["bar", "line", "area", "pie", "doughnut"])
      expect(parse({ ...bar, type }).ok).toBe(true)
    const result = parse({
      ...bar,
      type: "area",
      stacked: true,
      format: "currency",
      currency: "eur",
      xLabel: "Quarter",
      yLabel: "Revenue (EUR m)",
      datasets: [{ data: [1, 2, 3] }, { label: "B", data: [3, 2, 1] }],
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.spec.currency).toBe("EUR")
    expect(result.spec.stacked).toBe(true)
    expect(result.spec.datasets[0]?.label).toBe("")
    expect(result.spec.yLabel).toBe("Revenue (EUR m)")
  })

  test("requires numeric labels for scatter", () => {
    expect(parse({ ...bar, type: "scatter" })).toEqual({ ok: false, error: "scatter-labels" })
    expect(parse({ ...bar, type: "scatter", labels: [1, 2, 3] }).ok).toBe(true)
  })

  test("rejects malformed specs with a reason", () => {
    expect(parseChartSpec('{"type": "bar", "labels": [')).toEqual({ ok: false, error: "json" })
    expect(parseChartSpec("[1, 2]")).toEqual({ ok: false, error: "object" })
    expect(parse({ ...bar, type: "radar" })).toEqual({ ok: false, error: "type" })
    expect(parse({ ...bar, labels: [] })).toEqual({ ok: false, error: "labels" })
    expect(parse({ ...bar, labels: [{ a: 1 }, "b", "c"] })).toEqual({ ok: false, error: "labels" })
    expect(parse({ ...bar, datasets: [] })).toEqual({ ok: false, error: "datasets" })
    expect(parse({ ...bar, datasets: [{ label: "x", data: [1, "2", 3] }] })).toEqual({ ok: false, error: "dataset" })
    expect(parse({ ...bar, datasets: [{ label: 5, data: [1, 2, 3] }] })).toEqual({ ok: false, error: "dataset" })
    expect(parse({ ...bar, datasets: [{ label: "x", data: [1, 2] }] })).toEqual({ ok: false, error: "data-length" })
    expect(parse({ ...bar, format: "bytes" })).toEqual({ ok: false, error: "format" })
    expect(parse({ ...bar, format: "currency", currency: "dollars" })).toEqual({ ok: false, error: "currency" })
  })

  test("enforces dataset and point limits", () => {
    const datasets = Array.from({ length: CHART_MAX_DATASETS + 1 }, (_, index) => ({
      label: String(index),
      data: [1, 2, 3],
    }))
    expect(parse({ ...bar, datasets })).toEqual({ ok: false, error: "too-many-datasets" })
    const labels = Array.from({ length: 1001 }, (_, index) => index)
    expect(
      parse({
        type: "line",
        labels,
        datasets: [
          { label: "a", data: labels },
          { label: "b", data: labels },
        ],
      }),
    ).toEqual({ ok: false, error: "too-many-points" })
    expect(parse({ type: "line", labels, datasets: [{ label: "a", data: labels }] }).ok).toBe(true)
  })
})

describe("formatChartValue", () => {
  test("formats numbers, currency, and percentage points", () => {
    expect(formatChartValue(1234.567, { format: "number", currency: "USD" }, "en-US")).toBe("1,234.57")
    expect(formatChartValue(1234.5, { format: "currency", currency: "USD" }, "en-US")).toBe("$1,234.50")
    expect(formatChartValue(42.5, { format: "percent", currency: "USD" }, "en-US")).toBe("42.5%")
    expect(formatChartValue(1_500_000, { format: "currency", currency: "USD" }, "en-US", true)).toBe("$1.5M")
  })
})
