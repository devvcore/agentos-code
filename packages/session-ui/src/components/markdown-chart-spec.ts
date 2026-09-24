// Spec for ```chart fenced blocks in assistant markdown. Kept small and forgiving about optional
// fields so models can emit it reliably; anything structurally wrong is rejected with a reason code.

export const CHART_TYPES = ["bar", "line", "area", "pie", "doughnut", "scatter"] as const
export const CHART_FORMATS = ["number", "currency", "percent"] as const
export const CHART_MAX_DATASETS = 12
export const CHART_MAX_POINTS = 2000

export type ChartType = (typeof CHART_TYPES)[number]
export type ChartFormat = (typeof CHART_FORMATS)[number]

export type ChartSpec = {
  type: ChartType
  title?: string
  labels: (string | number)[]
  datasets: { label: string; data: number[] }[]
  xLabel?: string
  yLabel?: string
  stacked: boolean
  format: ChartFormat
  currency: string
}

export type ChartSpecError =
  | "json"
  | "object"
  | "type"
  | "labels"
  | "datasets"
  | "too-many-datasets"
  | "dataset"
  | "data-length"
  | "too-many-points"
  | "scatter-labels"
  | "format"
  | "currency"

export type ChartSpecResult = { ok: true; spec: ChartSpec } | { ok: false; error: ChartSpecError }

export function parseChartSpec(source: string): ChartSpecResult {
  const value = parseJson(source)
  if (value === undefined) return { ok: false, error: "json" }
  if (!isRecord(value)) return { ok: false, error: "object" }
  if (!isChartType(value.type)) return { ok: false, error: "type" }

  const labels = value.labels
  if (!Array.isArray(labels) || labels.length === 0 || !labels.every(isLabel)) return { ok: false, error: "labels" }

  const datasets = value.datasets
  if (!Array.isArray(datasets) || datasets.length === 0) return { ok: false, error: "datasets" }
  if (datasets.length > CHART_MAX_DATASETS) return { ok: false, error: "too-many-datasets" }
  if (!datasets.every(isDataset)) return { ok: false, error: "dataset" }
  if (datasets.some((dataset) => dataset.data.length !== labels.length)) return { ok: false, error: "data-length" }
  if (datasets.reduce((total, dataset) => total + dataset.data.length, 0) > CHART_MAX_POINTS)
    return { ok: false, error: "too-many-points" }
  if (value.type === "scatter" && !labels.every((label) => typeof label === "number"))
    return { ok: false, error: "scatter-labels" }

  const format = value.format ?? "number"
  if (!isChartFormat(format)) return { ok: false, error: "format" }
  const currency = value.currency ?? "USD"
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return { ok: false, error: "currency" }

  return {
    ok: true,
    spec: {
      type: value.type,
      title: text(value.title),
      labels,
      datasets: datasets.map((dataset) => ({ label: text(dataset.label) ?? "", data: dataset.data })),
      xLabel: text(value.xLabel),
      yLabel: text(value.yLabel),
      stacked: value.stacked === true,
      format,
      currency: currency.toUpperCase(),
    },
  }
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isChartType(value: unknown): value is ChartType {
  return CHART_TYPES.some((type) => type === value)
}

function isChartFormat(value: unknown): value is ChartFormat {
  return CHART_FORMATS.some((format) => format === value)
}

function isLabel(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

function isDataset(value: unknown): value is { label?: unknown; data: number[] } {
  if (!isRecord(value)) return false
  if (value.label !== undefined && typeof value.label !== "string") return false
  return Array.isArray(value.data) && value.data.every((item) => typeof item === "number" && Number.isFinite(item))
}

function text(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 200) : undefined
}

// Percent values are given in percentage points (42.5 means 42.5%), which is how models and
// spreadsheets usually report them.
export function formatChartValue(value: number, spec: Pick<ChartSpec, "format" | "currency">, locale: string, compact = false) {
  const notation = compact ? "compact" : "standard"
  if (spec.format === "percent")
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1, notation }).format(value / 100)
  if (spec.format === "currency")
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: spec.currency,
      notation,
      maximumFractionDigits: compact ? 1 : 2,
    }).format(value)
  return new Intl.NumberFormat(locale, { maximumFractionDigits: compact ? 1 : 2, notation }).format(value)
}
