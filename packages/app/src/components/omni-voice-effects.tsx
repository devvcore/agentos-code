import { createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { Root } from "react-dom/client"

// Keep the library's React animation isolated from Solid's composer lifecycle.
// The caller owns the audio stream; unmounting the effect never stops a call.
export function OmniVoiceEffects(props: {
  stream?: MediaStream | null
  active: boolean
  processing?: boolean
  working?: boolean
}) {
  let host!: HTMLDivElement
  let root: Root | undefined
  let disposed = false
  const [effects, setEffects] = createStore<{ render?: () => void }>({})
  onMount(async () => {
    const [react, dom, voice, beam] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("voice-glow"),
      import("border-beam"),
    ])
    if (disposed) return
    root = dom.createRoot(host)
    setEffects("render", () => () => {
      const style = {
        position: "absolute" as const,
        inset: 0,
        width: "100%",
        height: "100%",
        borderRadius: 12,
        pointerEvents: "none" as const,
      }
      const child = () => react.createElement("div", { style: { width: "100%", height: "100%", borderRadius: 12 } })
      root!.render(
        react.createElement(
          react.Fragment,
          null,
          react.createElement(beam.BorderBeam, {
            style,
            children: child(),
            active: !!props.working && !props.active,
            strength: 0.55,
            colorVariant: "colorful",
            theme: "auto",
          }),
          react.createElement(voice.VoiceBeam, {
            style,
            children: child(),
            stream: props.stream,
            active: props.active,
            processing: props.processing,
            strength: 0.7,
            theme: "auto",
          }),
        ),
      )
    })
  })
  createEffect(() => effects.render?.())
  onCleanup(() => {
    disposed = true
    root?.unmount()
  })
  return (
    <div
      ref={host}
      class="pointer-events-none absolute inset-0 z-20 rounded-xl"
      aria-hidden="true"
      data-component="omni-voice-effects"
    />
  )
}
