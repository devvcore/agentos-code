import { expect, test } from "bun:test"
import { createMarkdownParser } from "./marked-parser"

const parser = createMarkdownParser((code, language) => `<pre data-language="${language}">${code}</pre>`)

test("renders links with application attributes", async () => {
  expect(await parser.parse("[OpenCode](https://opencode.ai)")).toBe(
    '<p><a href="https://opencode.ai" class="external-link" target="_blank" rel="noopener noreferrer">OpenCode</a></p>\n',
  )
})

test("renders inline and block math", async () => {
  expect(await parser.parse("\\(x^2\\)")).toContain('<span class="katex">')
  expect(await parser.parse("$$\nx^2\n$$\n")).toContain('<span class="katex-display">')
})

test("uses the configured code highlighter", async () => {
  expect(await parser.parse("```ts\nconst value = 1\n```\n")).toBe('<pre data-language="ts">const value = 1</pre>\n')
})

test("renders chart fences as chart hosts with escaped source", async () => {
  expect(await parser.parse('```chart\n{"title":"<b>"}\n```\n')).toBe(
    '<div data-component="markdown-chart"><div data-slot="markdown-chart-source" hidden>{&quot;title&quot;:&quot;&lt;b&gt;&quot;}</div></div>\n',
  )
})

test("defers local images to the host resolver and keeps remote images", async () => {
  expect(await parser.parse('![Revenue "trend"](outputs/revenue.png)')).toBe(
    '<p><img data-markdown-src="outputs/revenue.png" alt="Revenue &quot;trend&quot;"></p>\n',
  )
  expect(await parser.parse("![Logo](https://example.com/logo.png)")).toBe(
    '<p><img src="https://example.com/logo.png" alt="Logo"></p>\n',
  )
})
