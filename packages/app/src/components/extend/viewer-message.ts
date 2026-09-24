import { createElement as h } from "react"

/** Centered status line shared by the React document viewers (loading and failure states). */
export function ViewerMessage(props: { text: string; tone?: "error" }) {
  return h(
    "div",
    {
      className: "flex h-full w-full items-center justify-center p-6 text-center text-14-regular",
      style: { color: props.tone === "error" ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted)" },
      role: props.tone === "error" ? "alert" : "status",
    },
    props.text,
  )
}
