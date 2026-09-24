import type { UiI18n } from "@opencode-ai/ui/context/i18n"
import type { Chart, ChartConfiguration } from "chart.js"
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { formatChartValue, parseChartSpec, type ChartSpec } from "./markdown-chart-spec"

// Mounted by the markdown renderer (outside the component tree, so i18n arrives as a prop) for every
// ```chart fence. Props are fixed for the life of a mount; the renderer remounts when the source changes.
export function MarkdownChart(props: { source: string; pending: boolean; i18n: UiI18n }) {
  const result = props.pending ? undefined : parseChartSpec(props.source)
  return (
    <Switch>
      <Match when={!result}>
        <div data-slot="markdown-chart-placeholder" role="status" aria-busy="true">
          <span data-slot="markdown-chart-sr">{props.i18n.t("ui.markdown.chart.loading")}</span>
        </div>
      </Match>
      <Match when={result?.ok ? result.spec : undefined}>
        {(spec) => <ChartView spec={spec()} i18n={props.i18n} source={props.source} />}
      </Match>
      <Match when={result && !result.ok}>
        <ChartError source={props.source} i18n={props.i18n} reason={result && !result.ok ? result.error : undefined} />
      </Match>
    </Switch>
  )
}

function ChartError(props: { source: string; i18n: UiI18n; reason?: string }) {
  return (
    <div data-slot="markdown-chart-error" data-reason={props.reason}>
      <div data-slot="markdown-chart-error-title">{props.i18n.t("ui.markdown.chart.error")}</div>
      <details>
        <summary>{props.i18n.t("ui.markdown.chart.source")}</summary>
        <div data-slot="markdown-chart-json">{props.source}</div>
      </details>
    </div>
  )
}

function ChartView(props: { spec: ChartSpec; i18n: UiI18n; source: string }) {
  const [failed, setFailed] = createSignal(false)
  const locale = props.i18n.locale()
  const label = props.spec.title ?? props.i18n.t("ui.markdown.chart.label")
  const circular = props.spec.type === "pie" || props.spec.type === "doughnut"
  let host: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined

  onMount(() => {
    const state: { chart?: Chart; disposed: boolean; theme?: string } = { disposed: false }
    const draw = (library: typeof Chart) => {
      if (state.disposed || !host || !canvas) return
      const theme = chartTheme(host)
      const key = JSON.stringify(theme)
      if (state.chart && state.theme === key) return
      state.theme = key
      state.chart?.destroy()
      library.defaults.font.family = theme.font
      state.chart = new library(canvas, chartConfig(props.spec, theme, locale))
    }
    const observer = new MutationObserver(() => void loadChart().then(draw))
    loadChart().then(
      (library) => {
        draw(library)
        // Theme and light/dark switches change the CSS tokens the chart colors are read from.
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-color-scheme", "data-theme", "class"],
        })
      },
      () => setFailed(true),
    )
    onCleanup(() => {
      state.disposed = true
      observer.disconnect()
      state.chart?.destroy()
    })
  })

  return (
    <Show when={!failed()} fallback={<ChartError source={props.source} i18n={props.i18n} />}>
      <figure data-slot="markdown-chart-figure" data-chart-type={props.spec.type}>
        <Show when={props.spec.title}>
          <figcaption data-slot="markdown-chart-title">{props.spec.title}</figcaption>
        </Show>
        <div data-slot="markdown-chart-canvas" data-circular={circular ? "true" : undefined} ref={host}>
          <canvas ref={canvas} role="img" aria-label={label} />
        </div>
        <table data-slot="markdown-chart-sr">
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{props.spec.xLabel ?? props.i18n.t("ui.markdown.chart.category")}</th>
              <For each={props.spec.datasets}>
                {(dataset) => <th scope="col">{dataset.label || props.spec.yLabel || label}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.spec.labels}>
              {(category, index) => (
                <tr>
                  <th scope="row">{category}</th>
                  <For each={props.spec.datasets}>
                    {(dataset) => <td>{formatChartValue(dataset.data[index()] ?? 0, props.spec, locale)}</td>}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </figure>
    </Show>
  )
}

type ChartTheme = ReturnType<typeof chartTheme>

const fallbackPalette = ["#3250df", "#e4712f", "#2eaf5a", "#623be2", "#e4429e", "#0096b8", "#d8a21c", "#d92e3c"]

function chartTheme(host: HTMLElement) {
  const style = getComputedStyle(host)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    palette: fallbackPalette.map((color, index) => read(`--markdown-chart-${index + 1}`, color)),
    text: read("--markdown-chart-text", "#555"),
    muted: read("--markdown-chart-muted", "#888"),
    grid: read("--markdown-chart-grid", "rgba(128, 128, 128, 0.2)"),
    surface: read("--markdown-chart-surface", "#fff"),
    tooltip: read("--markdown-chart-tooltip", "#111"),
    tooltipText: read("--markdown-chart-tooltip-text", "#fff"),
    font: style.fontFamily || "sans-serif",
  }
}

function chartConfig(spec: ChartSpec, theme: ChartTheme, locale: string) {
  const color = (index: number) => theme.palette[index % theme.palette.length]!
  const circular = spec.type === "pie" || spec.type === "doughnut"
  const scatter = spec.type === "scatter"
  const format = (value: number, compact = false) => formatChartValue(value, spec, locale, compact)
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  const axisTitle = (text: string | undefined) => ({ display: !!text, text, color: theme.muted })
  const datasets = spec.datasets.map((dataset, index) => {
    if (circular)
      return {
        label: dataset.label,
        data: dataset.data,
        backgroundColor: spec.labels.map((_, item) => color(item)),
        borderColor: theme.surface,
        borderWidth: 2,
      }
    if (scatter)
      return {
        label: dataset.label,
        data: dataset.data.map((y, item) => ({ x: Number(spec.labels[item]), y })),
        backgroundColor: color(index),
        borderColor: color(index),
        pointRadius: 3,
      }
    if (spec.type === "bar")
      return {
        label: dataset.label,
        data: dataset.data,
        backgroundColor: color(index),
        borderRadius: 3,
        maxBarThickness: 48,
      }
    return {
      label: dataset.label,
      data: dataset.data,
      borderColor: color(index),
      backgroundColor: spec.type === "area" ? withAlpha(color(index), 0.22) : color(index),
      fill: spec.type === "area" ? (spec.stacked && index > 0 ? "-1" : "origin") : false,
      tension: 0.25,
      borderWidth: 2,
      pointRadius: spec.labels.length > 40 ? 0 : 2.5,
      pointHoverRadius: 4,
    }
  })

  return {
    type: spec.type === "area" ? "line" : spec.type,
    data: { labels: scatter ? undefined : spec.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduced ? false : { duration: 350 },
      interaction: { mode: circular || scatter ? "nearest" : "index", intersect: circular },
      plugins: {
        legend: {
          display: circular || spec.datasets.length > 1,
          position: "bottom",
          labels: { color: theme.text, usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 14 },
        },
        tooltip: {
          backgroundColor: theme.tooltip,
          titleColor: theme.tooltipText,
          bodyColor: theme.tooltipText,
          padding: 8,
          cornerRadius: 6,
          callbacks: {
            label: (item: { dataset: { label?: string }; label: string; parsed: number | { y: number } }) => {
              const value = format(typeof item.parsed === "number" ? item.parsed : item.parsed.y)
              const name = circular ? item.label : item.dataset.label
              return name ? `${name}: ${value}` : value
            },
          },
        },
      },
      scales: circular
        ? undefined
        : {
            x: {
              type: scatter ? "linear" : "category",
              stacked: spec.stacked,
              title: axisTitle(spec.xLabel),
              grid: { display: scatter, color: theme.grid },
              border: { color: theme.grid },
              ticks: { color: theme.muted, maxRotation: 0, autoSkip: true },
            },
            y: {
              stacked: spec.stacked,
              beginAtZero: spec.type !== "line" && !scatter,
              title: axisTitle(spec.yLabel),
              grid: { color: theme.grid },
              border: { display: false },
              ticks: { color: theme.muted, callback: (value: string | number) => format(Number(value), true) },
            },
          },
    },
  } as ChartConfiguration
}

// Chart.js is only needed once a chart is on screen, so it stays out of the main bundle. Only the
// controllers the spec can produce are registered to keep the lazy chunk small.
let library: Promise<typeof Chart> | undefined

function loadChart() {
  return (library ??= importChart().catch((error) => {
    library = undefined
    throw error
  }))
}

async function importChart() {
  const {
    ArcElement,
    BarController,
    BarElement,
    CategoryScale,
    Chart,
    DoughnutController,
    Filler,
    Legend,
    LineController,
    LineElement,
    LinearScale,
    PieController,
    PointElement,
    ScatterController,
    Tooltip,
  } = await import("chart.js")
  Chart.register(
    ArcElement,
    BarController,
    BarElement,
    CategoryScale,
    DoughnutController,
    Filler,
    Legend,
    LineController,
    LineElement,
    LinearScale,
    PieController,
    PointElement,
    ScatterController,
    Tooltip,
  )
  return Chart
}

function withAlpha(color: string, alpha: number) {
  const hex = color.match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (hex && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
    const full = hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex.slice(0, 6)
    const channel = (offset: number) => parseInt(full.slice(offset, offset + 2), 16)
    return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
  return color
}
