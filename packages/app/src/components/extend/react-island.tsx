import { type JSX, Show, createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { ComponentType } from "react"
import type { Root } from "react-dom/client"

/**
 * Mounts a lazily loaded React component inside Solid (same pattern as OmniVoiceEffects).
 * React, ReactDOM, and the component module load on mount so they stay out of the main bundle;
 * the React root re-renders when `props` changes and unmounts with the Solid owner.
 */
export function ReactIsland<P extends object>(props: {
  load: () => Promise<ComponentType<P>>
  props: P
  class?: string
  fallback?: JSX.Element
  error?: (cause: unknown) => JSX.Element
}) {
  let host!: HTMLDivElement
  let root: Root | undefined
  let disposed = false
  const [state, setState] = createStore<{ render?: () => void; failed?: boolean; cause?: unknown }>({})
  const fail = (cause: unknown) => setState({ failed: true, cause })

  onMount(() => {
    Promise.all([import("react"), import("react-dom/client"), props.load()]).then(([react, dom, component]) => {
      if (disposed) return
      root = dom.createRoot(host, { onUncaughtError: fail })
      setState("render", () => () => root!.render(react.createElement(component, props.props)))
    }, fail)
  })
  createEffect(() => state.render?.())
  onCleanup(() => {
    disposed = true
    root?.unmount()
  })

  return (
    <>
      <Show when={state.failed}>{props.error?.(state.cause)}</Show>
      <Show when={!state.render && !state.failed}>{props.fallback}</Show>
      <div ref={host} class={props.class} classList={{ hidden: state.failed }} />
    </>
  )
}
