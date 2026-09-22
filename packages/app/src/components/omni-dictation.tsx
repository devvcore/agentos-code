import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { OmniVoiceEffects } from "./omni-voice-effects"

const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export function createOmniDictation(input: {
  disabled?: () => boolean
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
    if (busy() || input.disabled?.() || !available()) return
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
        <div class="flex items-center gap-1" data-component="omni-dictation" data-state={state.phase}>
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
              variant="ghost-muted"
              aria-label={language.t("omni.voice.cancel")}
              title={language.t("omni.voice.cancel")}
              onClick={cancel}
              icon={<Icon name="xmark-small" />}
            />
          </Show>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            disabled={input.disabled?.() || state.phase === "processing" || state.phase === "requesting"}
            aria-label={language.t(state.phase === "listening" ? "omni.voice.stop" : "omni.voice.start")}
            title={language.t(state.phase === "listening" ? "omni.voice.stop" : "omni.voice.start")}
            aria-pressed={state.phase === "listening"}
            onClick={() =>
              state.phase === "listening" ? recorder?.state === "recording" && recorder.stop() : void start()
            }
            icon={<Icon name={state.phase === "listening" ? "stop" : "microphone"} />}
          />
        </div>
      </Show>
    )
  }

  function Effects() {
    return (
      <Show when={available()}>
        <OmniVoiceEffects
          stream={state.stream}
          active={state.phase === "listening" || state.phase === "processing"}
          processing={state.phase === "processing"}
          working={input.working() && !busy()}
        />
      </Show>
    )
  }
  return { available, busy, Controls, Effects, error: () => state.error }
}
