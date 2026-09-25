import { createMemo, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useWorkAttachments, useWorkOutputs } from "@/pages/session/work-panel"
import { useWorkPanel } from "@/pages/session/work-preview"

/**
 * Work mode's entry point to the Files panel, in the session title row. Always shown so people
 * learn where files live; with nothing yet it opens the panel's empty state.
 */
export function WorkFilesButton(props: { sessionID: string }) {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const panel = useWorkPanel()
  const outputs = useWorkOutputs(() => props.sessionID)
  const attachments = useWorkAttachments(() => props.sessionID, outputs)
  const count = createMemo(() => outputs().length + attachments().length)
  const opened = createMemo(() => panel.view(props.sessionID) !== "closed")
  const label = () => language.t("omni.work.files.title")
  const toggle = () => panel.toggleFiles(props.sessionID)

  const badge = () => (
    <Show when={count() > 0}>
      <span
        data-slot="work-files-count"
        aria-hidden="true"
        class="pointer-events-none absolute -top-1 -right-1 min-w-3.5 h-3.5 rounded-full px-1 text-[10px] font-medium leading-[14px] text-center tabular-nums"
        classList={{
          "bg-v2-background-bg-layer-03 text-v2-text-text-base": settings.general.newLayoutDesigns(),
          "bg-surface-base-active text-text-strong": !settings.general.newLayoutDesigns(),
        }}
      >
        {count()}
      </span>
    </Show>
  )

  return (
    <Show
      when={settings.general.newLayoutDesigns()}
      fallback={
        <TooltipKeybind title={label()} keybind={command.keybind("work.files.toggle")}>
          <span class="relative flex">
            <IconButton
              icon="folder"
              variant="ghost"
              class="size-6 rounded-md"
              classList={{ "bg-surface-base-active": opened() }}
              onClick={toggle}
              aria-label={label()}
              aria-expanded={opened()}
              aria-controls="work-panel"
            />
            {badge()}
          </span>
        </TooltipKeybind>
      }
    >
      <TooltipV2
        class="shrink-0"
        placement="bottom"
        value={
          <>
            {label()}
            <Show when={command.keybindParts("work.files.toggle").length > 0}>
              <KeybindV2 keys={command.keybindParts("work.files.toggle")} variant="neutral" />
            </Show>
          </>
        }
      >
        <span class="relative flex">
          <IconButtonV2
            type="button"
            icon={<IconV2 name="folder" />}
            variant="ghost-muted"
            size="large"
            state={opened() ? "pressed" : undefined}
            onClick={toggle}
            aria-label={label()}
            aria-expanded={opened()}
            aria-controls="work-panel"
          />
          {badge()}
        </span>
      </TooltipV2>
    </Show>
  )
}
