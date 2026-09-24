import { expect, test } from "bun:test"
import { luminance, readableInk } from "./contrast"

test("luminance parses hex and rgb colors", () => {
  expect(luminance("#fff")).toBeCloseTo(1)
  expect(luminance("#000000")).toBeCloseTo(0)
  expect(luminance("rgb(221, 235, 247)")).toBeGreaterThan(0.5)
  expect(luminance("rgba(0, 0, 0, 0)")).toBeUndefined()
  expect(luminance("var(--x)")).toBeUndefined()
  expect(luminance(undefined)).toBeUndefined()
})

test("readableInk darkens light text on light fills only", () => {
  expect(readableInk("#DDEBF7", "rgb(240, 240, 240)")).toBe("#1f1f1f")
  expect(readableInk("#DDEBF7", undefined)).toBe("#1f1f1f")
  expect(readableInk("#DDEBF7", "#C00000")).toBeUndefined()
  expect(readableInk("#1b1b1b", "#eeeeee")).toBeUndefined()
  expect(readableInk(undefined, "#eeeeee")).toBeUndefined()
})
