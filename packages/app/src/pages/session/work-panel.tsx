/**
 * Omniwork right-side panel (Cowork style): plan progress, deliverable outputs, working folder.
 *
 * Mount it in session.tsx in place of `<SessionSidePanel ... />` while the session is in Work mode:
 *
 *   <Show when={params.id}>{(id) => <WorkPanel sessionID={id()} />}</Show>
 *
 * It reads everything else from context (useSync, useSDK, usePlatform, useServer), fetches the
 * session todo list on mount, and hides itself below the desktop breakpoint like SessionSidePanel.
 * While `workPreview` holds a file for the session, the panel widens and shows that file instead.
 */
import { For, Show, createEffect, createMemo, on } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { TextStrikethrough } from "@opencode-ai/ui/text-strikethrough"
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
import { workOutputs } from "@/pages/session/work-panel-data"
import { previewApp, workPanelWidth, workPreview } from "@/pages/session/work-preview"
import { WorkPreview } from "@/pages/session/work-preview-view"
import { fileManagerApp } from "@/utils/file-manager"
import { showToast } from "@/utils/toast"

export function WorkPanel(props: { sessionID: string }) {
  const sync = useSync()
  const sdk = useSDK()
  const platform = usePlatform()
  const server = useServer()
  const settings = useSettings()
  const language = useLanguage()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const local = createMemo(() => platform.platform === "desktop" && server.isLocal())
  const canOpen = createMemo(() => local() && !!platform.openPath)
  const canReveal = createMemo(() => local() && !!platform.revealPath)
  const revealLabel = createMemo(() =>
    language.t(fileManagerApp(platform.platform === "desktop" && platform.os ? platform.os : "unknown").actionLabel),
  )

  createEffect(
    on(
      () => [sdk().directory, props.sessionID] as const,
      ([, id]) => void sync().session.todo(id),
    ),
  )

  const todos = createMemo(() => sync().data.todo[props.sessionID] ?? [])
  const done = createMemo(() => todos().filter((todo) => todo.status === "completed").length)
  const outputs = createMemo(() =>
    workOutputs({
      directory: sdk().directory,
      messages: sync().data.message[props.sessionID],
      parts: sync().data.part,
    }),
  )

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

  const previewing = createMemo(() => workPreview.path(props.sessionID))
  const openLabel = (path: string) => {
    const app = previewApp(path)
    return app ? language.t("omni.work.preview.openIn", { app }) : language.t("omni.work.preview.openDefault")
  }

  const reveal = (path: string) => {
    if (!canReveal() || !platform.revealPath) return
    platform.revealPath(path).then((revealed) => {
      if (!revealed) showToast({ variant: "error", title: language.t("omni.work.outputs.missing") })
    }, failed)
  }

  return (
    <Show when={isDesktop()}>
      <aside
        id="work-panel"
        aria-label={language.t("omni.work.panel")}
        class="relative min-w-0 h-full shrink-0 flex flex-col overflow-hidden transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ width: workPanelWidth(!!previewing()) }}
        classList={{
          "bg-v2-background-bg-base rounded-[10px] shadow-[var(--v2-elevation-raised)]":
            settings.general.newLayoutDesigns(),
          "bg-background-base border-l border-border-weaker-base": !settings.general.newLayoutDesigns(),
        }}
      >
        <Show when={previewing()}>
          {(path) => (
            <WorkPreview
              path={path()}
              version={outputs().find((item) => item.path === path())?.time}
              onOpen={canOpen() ? () => open(path()) : undefined}
              onClose={() => workPreview.close(props.sessionID)}
            />
          )}
        </Show>
        <div
          class="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col gap-6 px-4 py-4"
          classList={{ hidden: !!previewing() }}
        >
          <section class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-14-medium text-v2-text-text-base">{language.t("omni.work.progress.title")}</h2>
              <Show when={todos().length > 0}>
                <span class="text-12-regular text-v2-text-text-muted tabular-nums">
                  {language.t("omni.work.progress.count", { done: done(), total: todos().length })}
                </span>
              </Show>
            </div>
            <Show
              when={todos().length > 0}
              fallback={<p class="text-13-regular text-v2-text-text-muted">{language.t("omni.work.progress.empty")}</p>}
            >
              <div class="flex flex-col gap-1.5">
                <For each={todos()}>
                  {(todo) => (
                    <Checkbox
                      readOnly
                      checked={todo.status === "completed"}
                      indeterminate={todo.status === "in_progress"}
                      data-in-progress={todo.status === "in_progress" ? "" : undefined}
                      data-state={todo.status}
                      style={{ "--checkbox-align": "flex-start", "--checkbox-offset": "1px" }}
                    >
                      <TextStrikethrough
                        active={todo.status === "completed" || todo.status === "cancelled"}
                        text={todo.content}
                        class="text-13-regular min-w-0 break-words"
                        style={{
                          "line-height": "var(--line-height-normal)",
                          color:
                            todo.status === "completed" || todo.status === "cancelled"
                              ? "var(--text-weak)"
                              : "var(--text-strong)",
                        }}
                      />
                    </Checkbox>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <section class="flex flex-col gap-2">
            <h2 class="text-14-medium text-v2-text-text-base">{language.t("omni.work.outputs.title")}</h2>
            <Show
              when={outputs().length > 0}
              fallback={<p class="text-13-regular text-v2-text-text-muted">{language.t("omni.work.outputs.empty")}</p>}
            >
              <ul class="flex flex-col -mx-2">
                <For each={outputs()}>
                  {(item) => {
                    const label = () => (
                      <>
                        <FileIcon node={{ path: item.path, type: "file" }} class="size-5 shrink-0" />
                        <span class="min-w-0 flex flex-col">
                          <span class="text-13-regular text-v2-text-text-base truncate">{item.name}</span>
                          <span class="text-11-regular text-v2-text-text-faint truncate">{item.folder}</span>
                        </span>
                      </>
                    )
                    return (
                      <li class="group flex items-center gap-1 rounded-md hover:bg-v2-overlay-simple-overlay-hover">
                        <button
                          type="button"
                          class="flex-1 min-w-0 flex items-center gap-2.5 px-2 py-1.5 text-left"
                          title={item.path}
                          aria-label={language.t("omni.work.outputs.preview", { name: item.name })}
                          onClick={() => workPreview.open(props.sessionID, item.path)}
                        >
                          {label()}
                        </button>
                        <Show when={canOpen()}>
                          <TooltipV2 value={openLabel(item.path)} placement="left">
                            <IconButtonV2
                              class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              size="small"
                              variant="ghost"
                              icon={<Icon name="outline-square-arrow" size="small" />}
                              aria-label={openLabel(item.path)}
                              onClick={() => open(item.path)}
                            />
                          </TooltipV2>
                        </Show>
                        <Show when={canReveal()}>
                          <TooltipV2 value={revealLabel()} placement="left">
                            <IconButtonV2
                              class="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              size="small"
                              variant="ghost"
                              icon={<Icon name="folder" size="small" />}
                              aria-label={revealLabel()}
                              onClick={() => reveal(item.path)}
                            />
                          </TooltipV2>
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </Show>
          </section>
        </div>

        <section
          class="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-v2-border-border-muted"
          classList={{ hidden: !!previewing() }}
        >
          <Icon name="folder" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <div class="flex-1 min-w-0 flex flex-col">
            <span class="text-11-regular text-v2-text-text-faint">{language.t("omni.work.folder.title")}</span>
            <span class="text-13-regular text-v2-text-text-base truncate" title={sdk().directory}>
              {getFilename(sdk().directory)}
            </span>
          </div>
          <Show when={canOpen()}>
            <TooltipV2 value={language.t("omni.work.folder.open")} placement="left">
              <IconButtonV2
                size="small"
                variant="ghost"
                icon={<Icon name="outline-square-arrow" size="small" />}
                aria-label={language.t("omni.work.folder.open")}
                onClick={() => open(sdk().directory)}
              />
            </TooltipV2>
          </Show>
        </section>
      </aside>
    </Show>
  )
}
