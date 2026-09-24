/**
 * Omniwork side panel, shaped like Claude.ai artifacts: closed by default, a compact list of the
 * session's deliverables, or a wide preview of one file. `useWorkPanel` owns which view is shown;
 * this component renders it and drives auto-open (`present_files` parts immediately, new
 * deliverables when a turn ends).
 *
 * Mount it in session.tsx in place of `<SessionSidePanel ... />` while the session is in Work mode:
 *
 *   <Show when={params.id}>{(id) => <WorkPanel sessionID={id()} />}</Show>
 *
 * Below the desktop breakpoint there is no side panel; a preview opens as a full-screen sheet.
 */
import {
  For,
  type JSX,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { makeEventListener } from "@solid-primitives/event-listener"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { typeLabel } from "@opencode-ai/session-ui/message-file"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { errorMessage } from "@/pages/layout/helpers"
import {
  workAttachments,
  workOutputs,
  workPresents,
  type WorkAttachment,
  type WorkOutput,
} from "@/pages/session/work-panel-data"
import { workPanelWidth, type WorkAttachmentRef } from "@/pages/session/work-panel-state"
import { previewApp, useWorkPanel } from "@/pages/session/work-preview"
import {
  findFilePart,
  previewPath,
  workAttachmentPart,
  workAttachmentSource,
  workPreviewSourceEqual,
  type WorkPreviewSource,
} from "@/pages/session/work-preview-source"
import { WorkPreview } from "@/pages/session/work-preview-view"
import { fileManagerApp } from "@/utils/file-manager"
import { getRelativeTime } from "@/utils/time"
import { showToast } from "@/utils/toast"

/** The session's deliverables, newest first. Shared by the panel and the header Files button. */
export function useWorkOutputs(sessionID: () => string | undefined) {
  const sync = useSync()
  const sdk = useSDK()
  return createMemo(() => {
    const id = sessionID()
    if (!id) return []
    return workOutputs({ directory: sdk().directory, messages: sync().data.message[id], parts: sync().data.part })
  })
}

/** Files the user attached in this session, newest first. Listed under "Attached" in Files. */
export function useWorkAttachments(sessionID: () => string | undefined) {
  const sync = useSync()
  return createMemo(() => {
    const id = sessionID()
    if (!id) return []
    return workAttachments({ messages: sync().data.message[id], parts: sync().data.part })
  })
}

export function WorkPanel(props: { sessionID: string }) {
  const sync = useSync()
  const sdk = useSDK()
  const platform = usePlatform()
  const server = useServer()
  const settings = useSettings()
  const language = useLanguage()
  const panel = useWorkPanel()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const local = createMemo(() => platform.platform === "desktop" && server.isLocal())
  const canOpen = createMemo(() => local() && !!platform.openPath)
  const canReveal = createMemo(() => local() && !!platform.revealPath)
  const revealLabel = createMemo(() =>
    language.t(fileManagerApp(platform.platform === "desktop" && platform.os ? platform.os : "unknown").actionLabel),
  )

  const view = createMemo(() => panel.view(props.sessionID))
  const previewing = createMemo(() => panel.path(props.sessionID))
  const attachment = createMemo(() => panel.attachment(props.sessionID), undefined, {
    equals: (a, b) => a?.messageID === b?.messageID && a?.partID === b?.partID,
  })
  const outputs = useWorkOutputs(() => props.sessionID)
  const attachments = useWorkAttachments(() => props.sessionID)
  const presents = createMemo(
    () => workPresents({ messages: sync().data.message[props.sessionID], parts: sync().data.part }),
    [],
    { equals: (a, b) => a.length === b.length && a.every((item, index) => item.id === b[index].id) },
  )
  const busy = createMemo(() => sync().data.session_working(props.sessionID))
  const loaded = createMemo(() => panel.ready() && !!sync().data.message[props.sessionID])

  // An attachment preview persists only its message/part reference. Resolve it from sync data,
  // and fetch the message when it is outside the loaded history (e.g. after a reload).
  const synced = createMemo(() => {
    const ref = attachment()
    return ref ? workAttachmentPart(ref, sync().data.part) : undefined
  })
  const [fetched] = createResource(
    () => {
      const ref = attachment()
      if (!ref || synced() || !loaded()) return false
      return ref
    },
    (ref: WorkAttachmentRef) =>
      sdk()
        .client.session.message({ sessionID: props.sessionID, messageID: ref.messageID })
        .then((result) => ({ ref, part: findFilePart(ref, result.data?.parts) }))
        .catch(() => ({ ref, part: undefined })),
  )
  const source = createMemo<WorkPreviewSource | undefined>(
    () => {
      const path = previewing()
      if (path) return { type: "path", path }
      const ref = attachment()
      if (!ref) return
      const part = synced()
      if (part) return workAttachmentSource(part)
      const result = fetched.state === "ready" ? fetched() : undefined
      if (!result || result.ref !== ref) return
      return result.part ? workAttachmentSource(result.part) : { type: "missing" }
    },
    undefined,
    { equals: workPreviewSourceEqual },
  )

  // Auto-open. History present when a session is first observed is only remembered; a
  // `present_files` part opens its file as soon as it completes during a turn; a turn that ends
  // with a new deliverable opens it unless the user is already previewing or closed the panel.
  // Phones only remember, so a finished turn never throws a full-screen sheet over the chat.
  createEffect(
    on(
      () => [props.sessionID, loaded(), busy(), presents()] as const,
      ([id, ready, working, list], prev) => {
        if (!ready) return
        const paths = untrack(outputs).map((item) => item.path)
        const quiet = !untrack(isDesktop)
        const same = prev?.[0] === id && prev[1]
        const ended = !!same && prev[2] && !working
        panel.dispatch(id, { type: "seed", outputs: paths, presents: list })
        if (same && !prev[2] && working) panel.dispatch(id, { type: "turnStart" })
        panel.dispatch(id, { type: "present", presents: list, quiet: quiet || !(working || ended) })
        if (ended) panel.dispatch(id, { type: "turnEnd", outputs: paths, quiet })
      },
    ),
  )

  // Esc closes the whole panel unless focus is in a field or a dialog handles it first.
  makeEventListener(window, "keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || view() === "closed") return
    if (!isDesktop() && !previewing()) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea, select, [role=dialog]"))
    )
      return
    panel.close(props.sessionID)
  })

  const failed = (cause: unknown) =>
    showToast({
      variant: "error",
      title: language.t("omni.work.outputs.openFailed"),
      description: errorMessage(cause, language.t("common.requestFailed")),
    })

  const open = (path: string) => {
    if (!canOpen() || !platform.openPath) return
    platform.openPath(path).catch(failed)
  }

  const reveal = (path: string) => {
    if (!canReveal() || !platform.revealPath) return
    platform.revealPath(path).then((revealed) => {
      if (!revealed) showToast({ variant: "error", title: language.t("omni.work.outputs.missing") })
    }, failed)
  }

  const preview = (value: WorkPreviewSource, back?: () => void) => {
    const path = previewPath(value)
    return (
      <WorkPreview
        source={value}
        version={value.type === "path" ? outputs().find((item) => item.path === value.path)?.time : undefined}
        onOpen={canOpen() && path ? () => open(path) : undefined}
        onBack={back}
        onClose={() => panel.close(props.sessionID)}
      />
    )
  }
  // Shown for the moment an attachment reference is still resolving.
  const resolving = (): JSX.Element => (
    <div class="flex h-full items-center justify-center gap-2 text-14-regular text-v2-text-text-muted" role="status">
      <LoaderV2 />
      {language.t("omni.work.preview.loading")}
    </div>
  )
  const previewOpen = createMemo(() => !!previewing() || !!attachment())

  return (
    <Show
      when={isDesktop()}
      fallback={
        <Show when={previewOpen()}>
          <Portal>
            <div class="fixed inset-0 z-50 flex flex-col bg-v2-background-bg-base">
              <Show when={source()} fallback={resolving()}>
                {(value) => preview(value())}
              </Show>
            </div>
          </Portal>
        </Show>
      }
    >
      <aside
        id="work-panel"
        aria-label={language.t("omni.work.panel")}
        aria-hidden={view() === "closed"}
        class="relative min-w-0 h-full shrink-0 flex flex-col overflow-hidden transition-[width,margin] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ width: workPanelWidth(view()) }}
        classList={{
          // Cancel the row gap while collapsed so the session column truly fills the row.
          "-ml-2": view() === "closed" && settings.general.newLayoutDesigns(),
          "bg-v2-background-bg-base rounded-[10px]": settings.general.newLayoutDesigns(),
          "shadow-[var(--v2-elevation-raised)]": settings.general.newLayoutDesigns() && view() !== "closed",
          "bg-background-base": !settings.general.newLayoutDesigns(),
          "border-l border-border-weaker-base": !settings.general.newLayoutDesigns() && view() !== "closed",
        }}
      >
        <Show when={previewOpen()}>
          <Show when={source()} fallback={resolving()}>
            {(value) => preview(value(), () => panel.back(props.sessionID))}
          </Show>
        </Show>
        <Show when={view() === "files"}>
          <WorkFiles
            directory={sdk().directory}
            outputs={outputs()}
            attachments={attachments()}
            canOpen={canOpen()}
            canReveal={canReveal()}
            revealLabel={revealLabel()}
            onPreview={(path) => panel.open(props.sessionID, path)}
            onPreviewAttachment={(ref) => panel.openAttachment(props.sessionID, ref)}
            onOpen={open}
            onReveal={reveal}
            onClose={() => panel.close(props.sessionID)}
          />
        </Show>
      </aside>
    </Show>
  )
}

function WorkFiles(props: {
  directory: string
  outputs: WorkOutput[]
  attachments: WorkAttachment[]
  canOpen: boolean
  canReveal: boolean
  revealLabel: string
  onPreview: (path: string) => void
  onPreviewAttachment: (ref: WorkAttachmentRef) => void
  onOpen: (path: string) => void
  onReveal: (path: string) => void
  onClose: () => void
}) {
  const language = useLanguage()
  // Relative times re-render once a minute.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(timer))
  const ago = (time: number) => {
    now()
    return getRelativeTime(new Date(time).toISOString(), language.t)
  }
  const row = (item: { name: string; path?: string; folder: string; time: number }, onPreview: () => void) => (
    <WorkFileRow
      name={item.name}
      path={item.path}
      meta={language.t("omni.work.files.meta", {
        folder: item.folder || getFilename(props.directory),
        time: ago(item.time),
      })}
      canOpen={props.canOpen}
      canReveal={props.canReveal}
      revealLabel={props.revealLabel}
      onPreview={onPreview}
      onOpen={props.onOpen}
      onReveal={props.onReveal}
    />
  )

  return (
    <section class="flex h-full min-h-0 flex-col" aria-label={language.t("omni.work.files.title")}>
      <header class="flex shrink-0 items-center gap-2 py-2.5 pl-4 pr-2">
        <div class="min-w-0 flex-1 flex flex-col">
          <h2 class="text-14-medium text-v2-text-text-base">{language.t("omni.work.files.title")}</h2>
          <span class="truncate text-12-regular text-v2-text-text-muted" title={props.directory}>
            {getFilename(props.directory)}
          </span>
        </div>
        <TooltipV2 value={language.t("omni.work.panel.close")} placement="bottom">
          <IconButtonV2
            size="small"
            variant="ghost"
            icon={<Icon name="close" size="small" />}
            aria-label={language.t("omni.work.panel.close")}
            onClick={() => props.onClose()}
          />
        </TooltipV2>
      </header>
      <Show
        when={props.outputs.length > 0 || props.attachments.length > 0}
        fallback={
          <p class="px-4 py-6 text-14-regular text-v2-text-text-muted">{language.t("omni.work.outputs.empty")}</p>
        }
      >
        <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col px-2 pb-3">
          <Show when={props.outputs.length > 0}>
            <ul class="flex flex-col gap-0.5">
              <For each={props.outputs}>{(item) => row(item, () => props.onPreview(item.path))}</For>
            </ul>
          </Show>
          <Show when={props.attachments.length > 0}>
            <h3
              class="px-2 pb-1 text-12-medium text-v2-text-text-muted"
              classList={{ "pt-4": props.outputs.length > 0, "pt-1": props.outputs.length === 0 }}
            >
              {language.t("omni.work.files.attached")}
            </h3>
            <ul class="flex flex-col gap-0.5" aria-label={language.t("omni.work.files.attached")}>
              <For each={props.attachments}>
                {(item) =>
                  row(
                    // Attachments without a known location show their type instead of a folder.
                    { ...item, folder: item.folder || typeLabel(item.name, item.mime, language.t("ui.common.file")) },
                    () => props.onPreviewAttachment({ messageID: item.messageID, partID: item.partID }),
                  )
                }
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </section>
  )
}

function WorkFileRow(props: {
  name: string
  /** Absolute path on disk; the open and reveal actions need it. */
  path?: string
  meta: string
  canOpen: boolean
  canReveal: boolean
  revealLabel: string
  onPreview: () => void
  onOpen: (path: string) => void
  onReveal: (path: string) => void
}) {
  const language = useLanguage()
  const openLabel = () => {
    const app = previewApp(props.name)
    return app ? language.t("omni.work.preview.openIn", { app }) : language.t("omni.work.preview.openDefault")
  }
  return (
    <li class="group flex h-11 items-center gap-1 rounded-lg pr-1 hover:bg-v2-overlay-simple-overlay-hover focus-within:bg-v2-overlay-simple-overlay-hover">
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg pl-2 text-left outline-none"
        title={props.path ?? props.name}
        aria-label={language.t("omni.work.outputs.preview", { name: props.name })}
        onClick={() => props.onPreview()}
      >
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-deep">
          <FileIcon node={{ path: props.name, type: "file" }} class="size-4" />
        </span>
        <span class="min-w-0 flex flex-col">
          <span class="truncate text-14-regular text-v2-text-text-base">{props.name}</span>
          <span class="truncate text-12-regular text-v2-text-text-muted">{props.meta}</span>
        </span>
      </button>
      <Show when={props.canOpen && props.path}>
        {(path) => (
          <TooltipV2 value={openLabel()} placement="left">
            <IconButtonV2
              class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              size="small"
              variant="ghost"
              icon={<Icon name="outline-square-arrow" size="small" />}
              aria-label={openLabel()}
              onClick={() => props.onOpen(path())}
            />
          </TooltipV2>
        )}
      </Show>
      <Show when={props.canReveal && props.path}>
        {(path) => (
          <TooltipV2 value={props.revealLabel} placement="left">
            <IconButtonV2
              class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              size="small"
              variant="ghost"
              icon={<Icon name="folder" size="small" />}
              aria-label={props.revealLabel}
              onClick={() => props.onReveal(path())}
            />
          </TooltipV2>
        )}
      </Show>
    </li>
  )
}
