import { createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { Root } from "react-dom/client"

const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export function createOmniDictation(input: {
  scope: () => unknown
  insert: (text: string) => void
  working: () => boolean
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const [state, setState] = createStore<{
    phase: "idle" | "requesting" | "listening" | "processing"
    stream: MediaStream | null
    seconds: number
    error: string
  }>({ phase: "idle", stream: null, seconds: 0, error: "" })
  let recorder: MediaRecorder | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let generation = 0
  const available = () => !!platform.agentos?.transcribe
  const busy = () => state.phase !== "idle"
  const stopTracks = () => {
    clearInterval(timer)
    state.stream?.getTracks().forEach((track) => track.stop())
    setState("stream", null)
  }
  const cancel = () => {
    generation++
    if (recorder?.state === "recording") recorder.stop()
    recorder = undefined
    stopTracks()
    setState({ phase: "idle", seconds: 0 })
  }
  createEffect(on(input.scope, cancel, { defer: true }))
  onCleanup(cancel)

  async function start() {
    if (busy() || !available()) return
    const current = ++generation
    const scope = input.scope()
    setState({ phase: "requesting", error: "", seconds: 0 })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (current !== generation) return stream.getTracks().forEach((track) => track.stop())
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(MediaRecorder.isTypeSupported)
      if (!type) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error("Unsupported recording format")
      }
      recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 64_000 })
      const chunks: Blob[] = []
      let size = 0
      recorder.ondataavailable = (event) => {
        if (current !== generation || !event.data.size) return
        size += event.data.size
        if (size > MAX_AUDIO_BYTES) {
          cancel()
          setState("error", language.t("omni.voice.tooLong"))
          return
        }
        chunks.push(event.data)
      }
      recorder.onerror = () => {
        if (current !== generation) return
        cancel()
        setState("error", language.t("omni.voice.failed"))
      }
      recorder.onstop = async () => {
        if (current !== generation) return
        stopTracks()
        setState("phase", "processing")
        try {
          const audio = await new Blob(chunks, { type }).arrayBuffer()
          if (current !== generation) return
          const result = await platform.agentos!.transcribe!({ audio, type, id: crypto.randomUUID() })
          if (current !== generation || scope !== input.scope()) return
          if (result.ok) input.insert(result.text)
          else setState("error", language.t(`omni.voice.${result.reason}`))
        } catch {
          if (current === generation) setState("error", language.t("omni.voice.failed"))
        } finally {
          if (current === generation) setState("phase", "idle")
        }
      }
      setState({ stream, phase: "listening" })
      recorder.start(1000)
      timer = setInterval(() => {
        setState("seconds", (value) => value + 1)
        if (state.seconds >= 300 && recorder?.state === "recording") recorder.stop()
      }, 1000)
    } catch (error) {
      if (current !== generation) return
      stopTracks()
      setState({
        phase: "idle",
        error: language.t(
          error instanceof DOMException && error.name === "NotAllowedError" ? "omni.voice.denied" : "omni.voice.failed",
        ),
      })
    }
  }

  function Controls() {
    return (
      <Show when={available()}>
        <div class="flex items-center gap-1 mr-1" data-component="omni-dictation" data-state={state.phase}>
          <Show when={busy()}>
            <span role="status" class="text-[11px] text-v2-text-text-muted whitespace-nowrap px-1">
              {language.t(
                state.phase === "processing"
                  ? "omni.voice.processing"
                  : state.phase === "requesting"
                    ? "omni.voice.requesting"
                    : "omni.voice.listening",
              )}
              <Show when={state.phase === "listening"}>
                {" "}
                {Math.floor(state.seconds / 60)}:{String(state.seconds % 60).padStart(2, "0")}
              </Show>
            </span>
            <IconButtonV2
              type="button"
              size="small"
              variant="ghost"
              aria-label={language.t("omni.voice.cancel")}
              title={language.t("omni.voice.cancel")}
              onClick={cancel}
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" />
                </svg>
              }
            />
          </Show>
          <IconButtonV2
            type="button"
            variant="ghost"
            disabled={state.phase === "processing" || state.phase === "requesting"}
            aria-label={language.t(state.phase === "listening" ? "omni.voice.stop" : "omni.voice.start")}
            title={language.t(state.phase === "listening" ? "omni.voice.stop" : "omni.voice.start")}
            aria-pressed={state.phase === "listening"}
            onClick={() =>
              state.phase === "listening" ? recorder?.state === "recording" && recorder.stop() : void start()
            }
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <Show
                  when={state.phase === "listening"}
                  fallback={
                    <>
                      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" stroke="currentColor" />
                      <path d="M3.5 7a4.5 4.5 0 0 0 9 0M8 11.5v3m-2.5 0h5" stroke="currentColor" />
                    </>
                  }
                >
                  <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
                </Show>
              </svg>
            }
          />
        </div>
      </Show>
    )
  }

  function Effects() {
    let host!: HTMLDivElement
    let root: Root | undefined
    let disposed = false
    const [effects, setEffects] = createStore<{ render?: () => void }>({})
    onMount(async () => {
      if (!available()) return
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
              active: input.working() && !busy(),
              strength: 0.55,
              colorVariant: "colorful",
              theme: "auto",
            }),
            react.createElement(voice.VoiceBeam, {
              style,
              children: child(),
              stream: state.stream,
              active: state.phase === "listening" || state.phase === "processing",
              processing: state.phase === "processing",
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
  return { available, busy, Controls, Effects, error: () => state.error }
}
