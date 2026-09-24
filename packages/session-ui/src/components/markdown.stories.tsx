// @ts-nocheck
import * as mod from "./markdown"
import { create } from "@opencode-ai/ui/storybook/scaffold"
import { markdown } from "@opencode-ai/ui/storybook/fixtures"

const docs = `### Overview
Render sanitized Markdown with code blocks, inline code, and safe links.

Pair with \`Code\` for standalone code views.

### API
- Required: \`text\` Markdown string.
- Uses the Marked context provider for parsing and sanitization.

### Variants and states
- Code blocks include copy buttons when rendered.

### Behavior
- Sanitizes HTML and auto-converts inline URL code to links.
- Adds copy buttons to code blocks.

### Accessibility
- Copy buttons include aria-labels from i18n.
- TODO: confirm link target behavior in sanitized output.

### Theming/tokens
- Uses \`data-component="markdown"\` and related slots for styling.

`

const story = create({
  title: "UI/Markdown",
  mod,
  args: {
    text: markdown,
  },
})

export default {
  title: "UI/Markdown",
  id: "components-markdown",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic

const chart = (spec: object) => "```chart\n" + JSON.stringify(spec, null, 2) + "\n```\n"

export const Charts = {
  args: {
    text: [
      "Revenue grew every quarter.\n",
      chart({
        type: "bar",
        title: "Revenue by quarter (USD)",
        labels: ["Q1", "Q2", "Q3", "Q4"],
        datasets: [
          { label: "2024", data: [98000, 112000, 121500, 140200] },
          { label: "2025", data: [120000, 135500, 151200, 168900] },
        ],
        yLabel: "Revenue",
        format: "currency",
      }),
      chart({
        type: "area",
        title: "Signups by channel",
        stacked: true,
        labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
        datasets: [
          { label: "Organic", data: [120, 150, 170, 160, 190, 230] },
          { label: "Paid", data: [80, 95, 90, 120, 140, 150] },
        ],
      }),
      chart({
        type: "doughnut",
        title: "Spend mix",
        labels: ["Payroll", "Cloud", "Marketing", "Other"],
        datasets: [{ label: "Share", data: [54, 18, 20, 8] }],
        format: "percent",
      }),
      chart({ type: "radar", labels: [], datasets: [] }),
    ].join("\n"),
  },
}
