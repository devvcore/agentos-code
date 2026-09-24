/**
 * Pick a readable text color for a filled spreadsheet cell in dark mode. Night rendering lightens
 * default text but keeps workbook fills, which leaves light-on-light header rows. Returns a dark
 * ink when the fill is light and the text is light too; otherwise undefined (keep the style).
 */
export function readableInk(background: unknown, color: unknown) {
  const fill = luminance(background)
  if (fill === undefined || fill < 0.5) return undefined
  const ink = luminance(color)
  if (ink !== undefined && ink < 0.5) return undefined
  return "#1f1f1f"
}

/** Relative luminance (0-1) of a #rgb/#rrggbb/rgb()/rgba() color; undefined when unknown or transparent. */
export function luminance(value: unknown) {
  if (typeof value !== "string") return undefined
  const channels = parse(value.trim().toLowerCase())
  if (!channels) return undefined
  const [r, g, b] = channels.map((channel) => {
    const unit = channel / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function parse(value: string) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex
    return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16))
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value)
  if (!rgb) return undefined
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
  if (alpha < 0.5) return undefined
  return [rgb[1], rgb[2], rgb[3]].map(Number)
}
