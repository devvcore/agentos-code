import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore } from "solid-js/store"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { OmniVoiceEffects } from "./omni-voice-effects"
import "./omni-live.css"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { usePrompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { useSessionLayout } from "@/pages/session/session-layout"
import { Identifier } from "@/utils/id"
import { normalizeSessionInfo } from "@/utils/session"
import type { PromptInputControls } from "./prompt-input/contracts"
import { sendFollowupDraft } from "./prompt-input/submit"
import { liveDelegationPrompt, type LiveCaption } from "./omni-live-prompt"

type CodingRequest = { messageID: string; delegation?: string; delivered: boolean; blocked: boolean }
type Connection = {
  directory: string
  server: string
  worktree?: string
  promoting: boolean
  sessionID?: string
  id?: string
  stopped: boolean
  pc: RTCPeerConnection
  channel: RTCDataChannel
  audio: HTMLAudioElement
  mic?: MediaStream
  meter?: { context: AudioContext; destination: MediaStreamAudioDestinationNode }
  admission: Promise<unknown>
  draft: ReturnType<Binding["prompt"]["capture"]>
  timer?: ReturnType<typeof setTimeout>
  started: number
  captions: LiveCaption[]
  seen: Set<string>
  requests: Map<string, CodingRequest>
}

type Binding = {
  id: symbol
  controls: () => PromptInputControls
  worktree?: () => string | undefined
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  serverSync: ReturnType<typeof useServerSync>
  local: ReturnType<typeof useLocal>
  panel: ReturnType<typeof useSessionLayout>
  prompt: ReturnType<typeof usePrompt>
}

export type OmniLive = ReturnType<typeof createLiveController>

export const { provider: OmniLiveProvider, use: useOmniLive } = createSimpleContext({
  name: "OmniLive",
  init: () => {
    const [route, setRoute] = createStore<{ binding?: () => Binding }>({})
    const call = createLiveController(() => route.binding?.())
    return {
      call,
      bind(binding: Binding) {
        // Keep each route's ownership immutable. Store object merging would
        // mutate the old binding and let its cleanup clear the new route.
        setRoute("binding", () => () => binding)
        return () =>
          queueMicrotask(() => {
            if (route.binding?.().id === binding.id) setRoute("binding", undefined)
          })
      },
    }
  },
})

export function createOmniLive(input: { controls: () => PromptInputControls; worktree?: () => string | undefined }) {
  const context = useOmniLive()
  const release = context.bind({
    ...input,
    id: Symbol(),
    sdk: useSDK(),
    sync: useSync(),
    serverSync: useServerSync(),
    local: useLocal(),
    prompt: usePrompt(),
    panel: useSessionLayout(),
  })
  onCleanup(release)
  return context.call
}

function createLiveController(input: () => Binding | undefined) {
  const platform = usePlatform()
  const language = useLanguage()
  const sdk = () => input()!.sdk()
  const sync = () => input()!.sync()
  const navigate = useNavigate()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const [state, setState] = createStore({
    phase: "idle",
    muted: false,
    speaker: true,
    blocked: false,
    seconds: 0,
    dictating: false,
    error: "",
    caption: "",
    captions: [] as LiveCaption[],
    sessionID: "",
    server: "",
    typing: false,
    text: "",
    submitting: false,
    pushToTalk: false,
    stream: null as MediaStream | null,
  })
  let connection: Connection | undefined
  const active = () => state.phase !== "idle"
  const available = () => !!platform.agentos?.live
  const current = (call: Connection) => connection === call && !call.stopped

  function send(call: Connection, kind: string, content?: string, delegation?: string) {
    if (call.channel.readyState !== "open") return
    call.channel.send(
      JSON.stringify({
        type: `session.${kind}`,
        event_id: crypto.randomUUID(),
        ...(content !== undefined
          ? {
              content: new TextDecoder().decode(new TextEncoder().encode(content).slice(0, 470)),
              delegation_id: delegation ?? null,
            }
          : {}),
      }),
    )
  }
  function release(call: Connection) {
    clearTimeout(call.timer)
    call.mic?.getTracks().forEach((track) => track.stop())
    call.audio.pause()
    call.audio.srcObject = null
    call.channel.close()
    call.pc.close()
    void call.meter?.context.close()
    if (connection === call) {
      // A message left unsent during the call returns to the regular draft.
      if (state.text.trim()) {
        const prompt = call.draft
        const start = prompt
          .current()
          .reduce((total, part) => total + (part.type === "text" ? part.content.length : 0), 0)
        const content = (start ? "\n\n" : "") + state.text
        prompt.set([...prompt.current(), { type: "text", content, start, end: start + content.length }])
      }
      connection = undefined
      setState({ phase: "idle", stream: null, caption: "", pushToTalk: false, text: "" })
    }
  }
  async function end() {
    const call = connection
    if (!call || call.stopped) return
    call.stopped = true
    clearTimeout(call.timer)
    call.mic?.getTracks().forEach((track) => track.stop())
    setState({ phase: "ending", stream: null })
    send(call, "close")
    if (call.id) await platform.agentos!.live!({ action: "end", id: call.id }).catch(() => undefined)
    release(call)
  }
  const fail = (call: Connection, key: "failed" | "denied" | "auth" | "credits" | "conflict") => {
    if (connection !== call) return
    setState("error", language.t(`omni.live.${key}`))
    void end()
  }

  async function delegate(call: Connection, id: string, offset: number) {
    if (!current(call) || call.requests.has(id)) return
    const request: CodingRequest = {
      messageID: Identifier.ascending("message"),
      delegation: id,
      delivered: false,
      blocked: false,
    }
    call.requests.set(id, request)
    // A delegation carries timing metadata, never the task text. Wait for the
    // transcript to settle, then give the coding model the actual exchange so
    // short replies and corrections retain their meaning.
    let previous = ""
    let stable = 0
    for (let attempt = 0; attempt < 30 && stable < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (!current(call)) return
      const next = liveDelegationPrompt({ captions: call.captions, offset })?.text ?? ""
      stable = next && next === previous ? stable + 1 : 0
      previous = next
    }
    const prompt = liveDelegationPrompt({ captions: call.captions, offset })
    if (!prompt) {
      call.requests.delete(id)
      send(call, "thinking.append", "No new spoken request is available. Ask the caller to repeat it.", id)
      return
    }
    const accepted = await submit(call, prompt.text, request)
    if (accepted)
      prompt.captions.forEach((caption) => {
        caption.sealed = true
      })
  }

  function submit(call: Connection, text: string, request: CodingRequest) {
    // Admission is serialized, execution is not awaited: speaking and typing can
    // both steer a running agent without creating two first sessions.
    const next = call.admission.then(() => admit(call, text, request))
    call.admission = next.catch(() => undefined)
    return next
  }

  async function prepare(call: Connection) {
    if (call.sessionID) return
    const bound = input()!
    const scope = bound.sdk()
    const serverSync = bound.serverSync()
    const model = bound.controls().model.selection.current()
    if (!model) throw new Error("No coding model selected")
    const agent = bound.controls().agents.current
    const variant = bound.controls().model.selection.variant.current()
    if (!call.sessionID) {
      call.promoting = true
      if (call.worktree === "create") {
        const created = await scope.client.worktree.create({ directory: call.directory })
        if (!created.data?.directory) throw new Error("Workspace creation failed")
        call.directory = created.data.directory
      } else if (call.worktree && call.worktree !== "main") call.directory = call.worktree
      if (!current(call) || input()?.sdk().directory !== scope.directory) {
        void end()
        return
      }
      const session = normalizeSessionInfo(
        await scope.api.session.create({
          agent,
          model: { id: model.id, providerID: model.provider.id, variant },
          location: { directory: call.directory },
        }),
      )
      if (!current(call) || input()?.sdk().directory !== scope.directory) {
        void end()
        return
      }
      call.promoting = true
      call.sessionID = session.id
      // The server resolves symlinks (for example /tmp to /private/tmp on
      // macOS). The new route must match the admitted session's directory.
      call.directory = session.directory
      serverSync.session.remember(session)
      bound.local.session.promote(call.directory, session.id, {
        agent,
        model: { providerID: model.provider.id, modelID: model.id },
        variant: variant ?? null,
      })
      const target = bound.prompt.capture({ dir: base64Encode(call.directory), id: session.id })
      target.set(bound.prompt.current().slice())
      call.draft = target
      for (const item of bound.prompt.context.items()) target.context.add(item)
      if (search.draftId)
        tabs.promoteDraft(search.draftId, { server: tabs.draft(search.draftId).server, sessionId: session.id })
      else navigate(`/${base64Encode(call.directory)}/session/${session.id}`)
    }
    for (
      let attempt = 0;
      attempt < 100 && current(call) && input()?.controls().session.id !== call.sessionID;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (current(call) && input()?.controls().session.id !== call.sessionID) throw new Error("Session navigation failed")
  }

  async function admit(call: Connection, text: string, request: CodingRequest) {
    for (let attempt = 0; attempt < 40 && current(call) && call.promoting && !input(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!current(call) || !input() || !call.sessionID) return false
    const id = request.delegation
    const bound = input()!
    const scope = bound.sdk()
    const snapshot = bound.sync()
    const serverSync = bound.serverSync()
    const model = bound.controls().model.selection.current()
    if (!model) {
      fail(call, "failed")
      return
    }
    const agent = input()!.controls().agents.current
    const variant = input()!.controls().model.selection.variant.current()
    try {
      if (!current(call)) return
      const accepted = await sendFollowupDraft({
        api: scope.api.session,
        serverSync,
        sync: snapshot,
        messageID: request.messageID,
        optimisticBusy: true,
        draft: {
          sessionID: call.sessionID,
          sessionDirectory: call.directory,
          agent,
          model: { modelID: model.id, providerID: model.provider.id },
          variant,
          context: [],
          prompt: [{ type: "text", content: text, start: 0, end: text.length }],
        },
      })
      if (accepted === false) throw new Error("Request was not admitted")
      if (current(call))
        send(
          call,
          "thinking.append",
          id
            ? "I accepted the request and started working. Continue speaking as OmniCode in first person. Never mention a separate coding agent, client, delegation, or worker."
            : "The caller typed this request and I am already handling it. Do not delegate it again. Continue speaking as OmniCode in first person. Request: " +
                JSON.stringify(text),
          id,
        )
      return true
    } catch {
      request.delivered = true
      call.promoting = false
      if (current(call))
        send(
          call,
          "commentary.append",
          "I could not start that request. Tell the caller in first person to check the chat and try again.",
          id,
        )
      return false
    }
  }

  async function sendText() {
    const call = connection
    const text = state.text.trim()
    if (!call || !current(call) || state.phase !== "connected" || !text || state.submitting) return
    const request: CodingRequest = { messageID: Identifier.ascending("message"), delivered: false, blocked: false }
    call.requests.set(request.messageID, request)
    setState({ text: "", submitting: true, error: "" })
    const caption: LiveCaption = {
      role: "user",
      text,
      start: Date.now() - call.started,
      end: Date.now() - call.started,
      sealed: true,
    }
    call.captions.push(caption)
    call.captions = call.captions.slice(-100)
    setState(
      "captions",
      call.captions.map((item) => ({ ...item })),
    )
    const accepted = await submit(call, text, request)
    if (!accepted) {
      call.captions = call.captions.filter((item) => item !== caption)
      if (current(call)) {
        setState(
          "captions",
          call.captions.map((item) => ({ ...item })),
        )
        setState("text", (draft) => text + (draft ? "\n" + draft : ""))
        setState("error", language.t("omni.live.sendFailed"))
      } else {
        const start = call.draft
          .current()
          .reduce((total, part) => total + (part.type === "text" ? part.content.length : 0), 0)
        const content = (start ? "\n\n" : "") + text
        call.draft.set([...call.draft.current(), { type: "text", content, start, end: start + content.length }])
      }
    }
    setState("submitting", false)
  }

  createEffect(() => {
    state.phase
    const call = connection
    if (!call || call.stopped) return
    const changed = () => {
      const bound = input()
      if (!bound) return !call.promoting
      if (bound.sdk().scope !== call.server) return true
      if (call.promoting) return false
      return call.sessionID ? bound.controls().session.id !== call.sessionID : bound.sdk().directory !== call.directory
    }
    if (changed()) {
      // Router owners briefly disappear or expose their new params before the
      // replacement composer mounts. End only after a real navigation settles.
      const timer = setTimeout(() => {
        if (current(call) && changed()) void end()
      }, 250)
      onCleanup(() => clearTimeout(timer))
      return
    }
    if (!input()) return
    const sessionID = input()!.controls().session.id
    if (call.sessionID && sessionID === call.sessionID) {
      call.promoting = false
      // Promotion replaces the draft tab's prompt owner. Preserve unsent call
      // text in the new tab's live store, not its pre-navigation cache.
      call.draft = input()!.prompt.capture()
    }
    if (!call.sessionID) return
    const messages = sync().data.message[call.sessionID] ?? []
    const permissions = sync().data.permission[call.sessionID] ?? []
    const questions = sync().data.question[call.sessionID] ?? []
    for (const request of call.requests.values()) {
      const id = request.delegation
      if (request.delivered) continue
      if ((permissions.length || questions.length) && !request.blocked) {
        request.blocked = true
        send(
          call,
          "commentary.append",
          "I need the caller's attention in chat. Ask them in first person to review the pending permission or question so I can continue.",
          id,
        )
      }
      const replies = messages.filter(
        (message) => message.role === "assistant" && message.parentID === request.messageID,
      )
      const latest = replies.at(-1)
      if (!latest || latest.role !== "assistant" || !latest.time.completed || latest.finish === "tool-calls") continue
      const parts = sync().data.part[latest.id] ?? []
      const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      if (!text && !latest.error) continue
      request.delivered = true
      send(
        call,
        "commentary.append",
        latest.error
          ? "I could not finish that request. Tell the caller in first person to check the error in chat."
          : "This is my verified work result. Answer the caller directly in first person as OmniCode. Never introduce it as an update from another agent or mention a separate worker. Full details remain in chat: " +
              text,
        id,
      )
    }
  })

  async function start() {
    if (active() || state.dictating || !available() || !input()) return
    const pc = new RTCPeerConnection()
    const call: Connection = {
      directory: sdk().directory,
      server: sdk().scope,
      worktree: input()!.worktree?.(),
      sessionID: input()!.controls().session.id,
      stopped: false,
      promoting: false,
      pc,
      channel: pc.createDataChannel("oai-events"),
      audio: new Audio(),
      started: Date.now(),
      captions: [],
      seen: new Set(),
      requests: new Map(),
      admission: Promise.resolve(),
      draft: input()!.prompt.capture(),
    }
    connection = call
    setState({
      phase: "requesting",
      muted: false,
      speaker: true,
      blocked: false,
      error: "",
      caption: "",
      seconds: 0,
      captions: [],
      sessionID: call.sessionID ?? "",
      server: call.server,
      typing: false,
      pushToTalk: false,
    })
    call.audio.autoplay = true
    pc.ontrack = (event) => {
      if (!current(call)) return
      const remote = event.streams[0] ?? new MediaStream([event.track])
      call.audio.srcObject = remote
      if (call.meter) call.meter.context.createMediaStreamSource(remote).connect(call.meter.destination)
      void call.audio.play().catch(() => {
        if (current(call)) setState("blocked", true)
      })
    }
    pc.onconnectionstatechange = () => {
      if (current(call) && pc.connectionState === "failed") fail(call, "failed")
    }
    call.channel.onmessage = (message) => {
      if (!current(call)) return
      try {
        const event = JSON.parse(message.data)
        if (event.type === "session.started") setState("phase", "connected")
        if (event.type === "session.closed") {
          call.stopped = true
          release(call)
          return
        }
        if (event.type === "error") setState("error", language.t("omni.live.failed"))
        if (event.event_id && call.seen.has(event.event_id)) return
        if (event.event_id) call.seen.add(event.event_id)
        if (
          ["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type) &&
          typeof event.delta === "string"
        ) {
          const role = event.type === "session.input_transcript.delta" ? "user" : "assistant"
          const start = Number(event.start_ms || 0)
          const end = Number(event.end_ms || start)
          const previous = call.captions.at(-1)
          if (previous && previous.role === role && !previous.sealed && start <= previous.end + 900) {
            previous.text += event.delta
            previous.end = end
          } else call.captions.push({ role, text: event.delta, start, end, sealed: false })
          call.captions = call.captions.slice(-100)
          setState("caption", call.captions.at(-1)?.text ?? "")
          setState(
            "captions",
            call.captions.map((item) => ({ ...item })),
          )
        }
        if (
          event.type === "session.delegation.created" &&
          event.delegation?.target === "client" &&
          typeof event.delegation.id === "string"
        ) {
          void delegate(call, event.delegation.id, Number(event.offset_ms))
        }
      } catch {
        /* Ignore malformed provider events without echoing their payload. */
      }
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (!current(call)) {
        mic.getTracks().forEach((track) => track.stop())
        return
      }
      call.mic = mic
      await prepare(call)
      if (!current(call)) return
      setState({ sessionID: call.sessionID ?? "", server: call.server })
      input()!.panel.view().reviewPanel.open()
      input()!.panel.tabs().setActive("voice")
      // Mix only into an analysis stream, never the speakers or the outbound
      // microphone. VoiceBeam reacts to both sides without audio feedback.
      try {
        const context = new AudioContext()
        const destination = context.createMediaStreamDestination()
        context.createMediaStreamSource(mic).connect(destination)
        call.meter = { context, destination }
        void context.resume()
      } catch {
        /* Voice still works when an audio analyser is unavailable. */
      }
      setState({ phase: "connecting", stream: call.meter?.destination.stream ?? mic })
      mic.getTracks().forEach((track) => pc.addTrack(track, mic))
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve()
        const timeout = setTimeout(done, 10000)
        function done() {
          clearTimeout(timeout)
          pc.removeEventListener("icegatheringstatechange", changed)
          resolve()
        }
        function changed() {
          if (pc.iceGatheringState === "complete") done()
        }
        pc.addEventListener("icegatheringstatechange", changed)
      })
      if (!current(call)) return
      const history = (sync().data.message[call.sessionID ?? ""] ?? [])
        .slice(-16)
        .map(
          (message) =>
            `${message.role}: ${(sync().data.part[message.id] ?? [])
              .flatMap((p) => (p.type === "text" ? [p.text] : []))
              .join("\n")
              .slice(-1500)}`,
        )
        .join("\n")
        .slice(-10000)
      const result = await platform.agentos!.live!({
        action: "start",
        sdp: pc.localDescription!.sdp,
        context: `Project: ${call.directory}\n${history}`.slice(-12000),
      })
      if (!result.ok) {
        if (current(call)) fail(call, result.reason)
        return
      }
      call.id = result.id
      if (!current(call)) {
        await platform.agentos!.live!({ action: "end", id: result.id })
        return
      }
      await pc.setRemoteDescription({ type: "answer", sdp: result.sdp })
      const poll = async () => {
        if (!current(call)) return
        const status = await platform.agentos!.live!({ action: "status", id: call.id! }).catch(() => null)
        if (!current(call)) return
        if (!status || !status.ok) {
          fail(call, status?.reason ?? "failed")
          return
        }
        if (status.phase === "ended" || status.phase === "failed") {
          call.stopped = true
          release(call)
          return
        }
        if (status.phase === "connected") setState("phase", "connected")
        if (state.phase !== "connected" && Date.now() - call.started > 75000) {
          fail(call, "failed")
          return
        }
        setState("seconds", Math.floor((Date.now() - call.started) / 1000))
        call.timer = setTimeout(() => void poll(), 2000)
      }
      void poll()
    } catch (error) {
      if (current(call))
        fail(call, error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "failed")
    }
  }

  function mute() {
    const call = connection
    if (!call || state.phase !== "connected") return
    const muted = !state.muted
    call.mic?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
    send(call, muted ? "input_audio.mute" : "input_audio.unmute")
    setState({ muted, pushToTalk: false })
  }
  function finishPushToTalk() {
    const call = connection
    if (!state.pushToTalk) return
    setState("pushToTalk", false)
    if (!call || !current(call) || !state.muted) return
    call.mic?.getAudioTracks().forEach((track) => {
      track.enabled = false
    })
    send(call, "input_audio.mute")
  }
  const editable = (target: EventTarget | null) =>
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"]',
    )
  const keydown = (event: KeyboardEvent) => {
    if (
      event.code !== "Space" ||
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !state.muted ||
      state.phase !== "connected" ||
      editable(event.target)
    )
      return
    const call = connection
    if (!call || !current(call)) return
    event.preventDefault()
    event.stopPropagation()
    call.mic?.getAudioTracks().forEach((track) => {
      track.enabled = true
    })
    send(call, "input_audio.unmute")
    setState("pushToTalk", true)
  }
  const keyup = (event: KeyboardEvent) => {
    if (event.code !== "Space" || !state.pushToTalk) return
    event.preventDefault()
    event.stopPropagation()
    finishPushToTalk()
  }
  const visibility = () => {
    if (document.hidden) finishPushToTalk()
  }
  const focus = (event: FocusEvent) => {
    if (editable(event.target)) finishPushToTalk()
  }
  window.addEventListener("keydown", keydown, true)
  window.addEventListener("keyup", keyup, true)
  window.addEventListener("blur", finishPushToTalk)
  window.addEventListener("focusin", focus)
  document.addEventListener("visibilitychange", visibility)
  onCleanup(() => {
    window.removeEventListener("keydown", keydown, true)
    window.removeEventListener("keyup", keyup, true)
    window.removeEventListener("blur", finishPushToTalk)
    window.removeEventListener("focusin", focus)
    document.removeEventListener("visibilitychange", visibility)
  })
  function speaker() {
    const call = connection
    if (!call) return
    if (state.blocked) {
      void call.audio
        .play()
        .then(() => setState("blocked", false))
        .catch(() => {})
      return
    }
    call.audio.muted = state.speaker
    setState("speaker", !state.speaker)
  }
  onCleanup(() => {
    void end()
  })
  const leaving = () => {
    void end()
  }
  window.addEventListener("pagehide", leaving)
  onCleanup(() => window.removeEventListener("pagehide", leaving))

  function Controls() {
    return (
      <Show when={available()}>
        <IconButtonV2
          type="button"
          variant={active() ? "neutral" : "ghost-muted"}
          disabled={!active() && state.dictating}
          aria-label={language.t(active() ? "omni.live.end" : "omni.live.start")}
          title={language.t(active() ? "omni.live.end" : "omni.live.start")}
          aria-pressed={active()}
          data-component="omni-live-toggle"
          onClick={() => (active() ? void end() : void start())}
          icon={<Icon name="waveform" />}
        />
      </Show>
    )
  }
  function Panel() {
    let composer!: HTMLDivElement
    let text!: HTMLTextAreaElement
    onMount(() => composer.focus())
    createEffect(() => {
      if (state.typing) queueMicrotask(() => text?.focus())
    })
    const status = () =>
      state.phase === "connected"
        ? state.muted && !state.pushToTalk
          ? "omni.live.holdSpace"
          : "omni.voice.listening"
        : state.phase === "requesting"
          ? "omni.live.requesting"
          : state.phase === "ending"
            ? "omni.live.ending"
            : "omni.live.connecting"
    return (
      <section
        ref={composer}
        tabIndex={-1}
        data-component="omni-live-call"
        aria-label={language.t("omni.live.connected")}
      >
        <OmniVoiceEffects
          stream={state.stream}
          active={state.phase !== "ending"}
          processing={state.phase === "connecting" || state.phase === "requesting"}
        />
        <header data-slot="live-header">
          <div data-slot="live-title">
            <Icon name="waveform" />
            <span>{language.t("omni.live.connected")}</span>
            <span data-slot="live-timer">
              {Math.floor(state.seconds / 60)}:{String(state.seconds % 60).padStart(2, "0")}
            </span>
          </div>
          <div data-slot="live-options">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              aria-label={language.t("omni.live.type")}
              title={language.t("omni.live.type")}
              aria-pressed={state.typing}
              onClick={() => setState("typing", (value) => !value)}
              icon={<Icon name="edit" />}
            />
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              aria-label={language.t("omni.live.transcript")}
              title={language.t("omni.live.transcript")}
              aria-expanded={input()?.panel.view().reviewPanel.opened() && input()?.panel.tabs().active() === "voice"}
              aria-controls="session-side-panel-voice-tabpanel"
              data-live-transcript-toggle
              onClick={() => {
                input()?.panel.view().reviewPanel.open()
                input()?.panel.tabs().setActive("voice")
              }}
              icon={<Icon name="sidebar-right" />}
            />
          </div>
        </header>
        <div data-slot="live-center">
          <span role="status" data-slot="live-status">
            {language.t(status())}
          </span>
          <div data-slot="live-actions">
            <IconButtonV2
              type="button"
              variant="neutral"
              disabled={state.phase !== "connected"}
              aria-pressed={state.muted}
              aria-label={language.t(state.muted ? "omni.live.unmute" : "omni.live.mute")}
              title={language.t(state.muted ? "omni.live.unmute" : "omni.live.mute")}
              onClick={() => {
                mute()
                composer.focus()
              }}
              icon={<Icon name={state.muted && !state.pushToTalk ? "microphone-slash" : "microphone"} />}
            />
            <IconButtonV2
              type="button"
              variant="neutral"
              aria-pressed={!state.speaker}
              aria-label={language.t(
                state.blocked ? "omni.live.play" : state.speaker ? "omni.live.silence" : "omni.live.speaker",
              )}
              title={language.t(
                state.blocked ? "omni.live.play" : state.speaker ? "omni.live.silence" : "omni.live.speaker",
              )}
              onClick={speaker}
              icon={<Icon name={state.speaker ? "speaker-high" : "speaker-slash"} />}
            />
            <ButtonV2
              type="button"
              variant="outline"
              icon="phone-x"
              disabled={state.phase === "ending"}
              onClick={() => void end()}
            >
              {language.t("omni.live.end")}
            </ButtonV2>
          </div>
        </div>
        <Show when={state.typing}>
          <form
            data-slot="live-text"
            onSubmit={(event) => {
              event.preventDefault()
              void sendText()
            }}
          >
            <textarea
              ref={text}
              rows={2}
              value={state.text}
              aria-label={language.t("omni.live.message")}
              placeholder={language.t("omni.live.message")}
              onInput={(event) => setState("text", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault()
                  void sendText()
                }
              }}
            />
            <IconButtonV2
              type="submit"
              variant="contrast"
              disabled={!state.text.trim() || state.submitting || state.phase !== "connected"}
              aria-label={language.t("prompt.action.send")}
              title={language.t("prompt.action.send")}
              icon={<Icon name="arrow-up" />}
            />
          </form>
        </Show>
        <Show when={state.error}>
          <p data-slot="live-error" role="alert">
            {state.error}
          </p>
        </Show>
      </section>
    )
  }
  function Failure() {
    return (
      <Show when={!active() && state.error}>
        <p role="alert" class="text-12-regular text-text-weak">
          {state.error}
        </p>
      </Show>
    )
  }
  function Transcript() {
    let scroll!: HTMLDivElement
    let following = true
    createEffect(() => {
      state.captions.map((caption) => caption.text).join("")
      if (following)
        requestAnimationFrame(() => {
          if (scroll) scroll.scrollTop = scroll.scrollHeight
        })
    })
    return (
      <div data-component="omni-live-transcript" aria-label={language.t("omni.live.transcript")}>
        <div
          ref={scroll}
          data-slot="live-transcript-scroll"
          onScroll={() => {
            following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64
          }}
        >
          <Show
            when={state.captions.length}
            fallback={<p data-slot="live-transcript-empty">{language.t("omni.live.transcriptEmpty")}</p>}
          >
            <For each={state.captions}>
              {(caption) => (
                <article>
                  <span>{language.t(caption.role === "user" ? "omni.live.you" : "omni.live.omni")}</span>
                  <p>{caption.text.trim()}</p>
                </article>
              )}
            </For>
          </Show>
        </div>
      </div>
    )
  }
  return {
    active,
    hasVoice: (server: string, sessionID?: string) =>
      !!sessionID && state.server === server && state.sessionID === sessionID,
    setDictating: (value: boolean) => setState("dictating", value),
    Controls,
    Panel,
    Failure,
    Transcript,
  }
}
