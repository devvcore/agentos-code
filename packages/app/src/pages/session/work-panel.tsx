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
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { makeEventListener } from "@solid-primitives/event-listener"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { errorMessage } from "@/pages/layout/helpers"
import { workOutputs, workPresents, type WorkOutput } from "@/pages/session/work-panel-data"
import { workPanelWidth } from "@/pages/session/work-panel-state"
import { previewApp, useWorkPanel } from "@/pages/session/work-preview"
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
  const outputs = useWorkOutputs(() => props.sessionID)
  const presents = createMemo(
    () => workPresents({ messages: sync().data.message[props.sessionID], parts: sync().data.part }),
    [],
    { equals: (a, b) => a.length === b.length && a.every((item, index) => item.id === b[index].id) },
  )
  const busy = createMemo(() => sync().data.session_working(props.sessionID))
  const loaded = createMemo(() => panel.ready() && !!sync().data.message[props.sessionID])

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
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role=dialog]")))
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

  const preview = (path: string, back?: () => void) => (
    <WorkPreview
      path={path}
      version={outputs().find((item) => item.path === path)?.time}
      onOpen={canOpen() ? () => open(path) : undefined}
      onBack={back}
      onClose={() => panel.close(props.sessionID)}
    />
  )

  return (
    <Show
      when={isDesktop()}
      fallback={
        <Show when={previewing()}>
          {(path) => (
            <Portal>
              <div class="fixed inset-0 z-50 flex flex-col bg-v2-background-bg-base">{preview(path())}</div>
            </Portal>
          )}
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
        <Show when={previewing()}>{(path) => preview(path(), () => panel.back(props.sessionID))}</Show>
        <Show when={view() === "files"}>
          <WorkFiles
            directory={sdk().directory}
            outputs={outputs()}
            canOpen={canOpen()}
            canReveal={canReveal()}
            revealLabel={revealLabel()}
            onPreview={(path) => panel.open(props.sessionID, path)}
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
  canOpen: boolean
  canReveal: boolean
  revealLabel: string
  onPreview: (path: string) => void
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
  const openLabel = (path: string) => {
    const app = previewApp(path)
    return app ? language.t("omni.work.preview.openIn", { app }) : language.t("omni.work.preview.openDefault")
  }

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
        when={props.outputs.length > 0}
        fallback={
          <p class="px-4 py-6 text-14-regular text-v2-text-text-muted">{language.t("omni.work.outputs.empty")}</p>
        }
      >
        <ul class="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-0.5 px-2 pb-3">
          <For each={props.outputs}>
            {(item) => (
              <li class="group flex h-11 items-center gap-1 rounded-lg pr-1 hover:bg-v2-overlay-simple-overlay-hover focus-within:bg-v2-overlay-simple-overlay-hover">
                <button
                  type="button"
                  class="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg pl-2 text-left outline-none"
                  title={item.path}
                  aria-label={language.t("omni.work.outputs.preview", { name: item.name })}
                  onClick={() => props.onPreview(item.path)}
                >
                  <span class="flex size-8 shrink-0 items-center justify-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-deep">
                    <FileIcon node={{ path: item.path, type: "file" }} class="size-4" />
                  </span>
                  <span class="min-w-0 flex flex-col">
                    <span class="truncate text-14-regular text-v2-text-text-base">{item.name}</span>
                    <span class="truncate text-12-regular text-v2-text-text-muted">
                      {language.t("omni.work.files.meta", {
                        folder: item.folder || getFilename(props.directory),
                        time: ago(item.time),
                      })}
                    </span>
                  </span>
                </button>
                <Show when={props.canOpen}>
                  <TooltipV2 value={openLabel(item.path)} placement="left">
                    <IconButtonV2
                      class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                      size="small"
                      variant="ghost"
                      icon={<Icon name="outline-square-arrow" size="small" />}
                      aria-label={openLabel(item.path)}
                      onClick={() => props.onOpen(item.path)}
                    />
                  </TooltipV2>
                </Show>
                <Show when={props.canReveal}>
                  <TooltipV2 value={props.revealLabel} placement="left">
                    <IconButtonV2
                      class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                      size="small"
                      variant="ghost"
                      icon={<Icon name="folder" size="small" />}
                      aria-label={props.revealLabel}
                      onClick={() => props.onReveal(item.path)}
                    />
                  </TooltipV2>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
