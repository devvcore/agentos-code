import { type JSX, Match, Show, Switch, createMemo, createResource, onCleanup } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ReactIsland } from "@/components/extend/react-island"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { WorkPreviewGrid } from "@/pages/session/work-preview-grid"
import { PREVIEW_MAX_BYTES, previewApp, previewMime } from "@/pages/session/work-preview"
import {
  loadPreview,
  previewName,
  previewPath,
  previewSourceKind,
  type WorkPreviewSource,
} from "@/pages/session/work-preview-source"

/**
 * In-panel preview of one Omniwork file. Project files come from the server's file read endpoint
 * (base64 for binary files); message attachments decode from the data URL they carry, so files
 * from outside the project (e.g. ~/Downloads) preview too. PDF/Office renderers load lazily as
 * React islands.
 */
export function WorkPreview(props: {
  source: WorkPreviewSource
  /** Changes when the agent rewrites the file, so the preview reloads. */
  version?: number
  /** Desktop-only "open in default app"; omitted where it can't work. */
  onOpen?: () => void
  /** Back to the files list; omitted where there is no list (phones). */
  onBack?: () => void
  /** Closes the whole panel. */
  onClose: () => void
}) {
  const sdk = useSDK()
  const theme = useTheme()
  const language = useLanguage()
  const kind = createMemo(() => previewSourceKind(props.source))
  const name = createMemo(() => previewName(props.source) || language.t("ui.message.attachment.alt"))
  const path = createMemo(() => previewPath(props.source))
  const app = createMemo(() => previewApp(name()))
  const openLabel = createMemo(() => {
    const value = app()
    return value ? language.t("omni.work.preview.openIn", { app: value }) : language.t("omni.work.preview.openDefault")
  })

  const [file] = createResource(
    () => ({ source: props.source, version: props.version, directory: sdk().directory }),
    (input) =>
      loadPreview(input.source, {
        directory: input.directory,
        read: (relative) =>
          sdk()
            .client.file.read({ path: relative })
            .then((result) => result.data!),
      }),
  )
  // Gate on state so reading the resource never suspends an enclosing Suspense boundary.
  const loaded = createMemo(() => (file.state === "ready" ? file() : undefined))
  const bytes = createMemo(() => {
    const value = loaded()
    return value?.type === "bytes" ? value.bytes : undefined
  })
  const text = createMemo(() => {
    const value = bytes()
    return value ? new TextDecoder().decode(value) : ""
  })
  const image = createMemo(() => {
    const value = bytes()
    if (!value || kind() !== "image") return
    const source = props.source
    const mime = source.type === "inline" && source.mime.startsWith("image/") ? source.mime : previewMime(name())
    const url = URL.createObjectURL(new Blob([value], { type: mime }))
    onCleanup(() => URL.revokeObjectURL(url))
    return url
  })
  const labels = createMemo(() => ({
    loading: language.t("omni.work.preview.loading"),
    error: language.t("omni.work.preview.renderFailed"),
  }))

  const loading = () => (
    <div class="flex h-full items-center justify-center gap-2 text-14-regular text-v2-text-text-muted" role="status">
      <LoaderV2 />
      {language.t("omni.work.preview.loading")}
    </div>
  )
  const failed = () => (
    <Notice icon="status" title={language.t("omni.work.preview.renderFailed")}>
      <OpenButton label={openLabel()} onOpen={props.onOpen} />
    </Notice>
  )

  return (
    <section class="flex h-full min-h-0 flex-col" aria-label={language.t("omni.work.preview.label")}>
      <header
        class="flex shrink-0 items-center gap-2 border-b border-v2-border-border-muted py-2 pr-2"
        classList={{ "pl-4": !props.onBack, "pl-2": !!props.onBack }}
      >
        <Show when={props.onBack}>
          {(back) => (
            <TooltipV2 value={language.t("omni.work.preview.back")} placement="bottom">
              <IconButtonV2
                size="small"
                variant="ghost"
                icon={<Icon name="chevron-down" size="small" class="rotate-90" />}
                aria-label={language.t("omni.work.preview.back")}
                onClick={() => back()()}
              />
            </TooltipV2>
          )}
        </Show>
        <FileIcon node={{ path: name(), type: "file" }} class="size-5 shrink-0" />
        <h2 class="min-w-0 flex-1 truncate text-14-medium text-v2-text-text-base" title={path() ?? name()}>
          {name()}
        </h2>
        <Show when={props.onOpen}>
          {(open) => (
            <TooltipV2 value={openLabel()} placement="bottom">
              <IconButtonV2
                size="small"
                variant="ghost"
                icon={<Icon name="outline-square-arrow" size="small" />}
                aria-label={openLabel()}
                onClick={() => open()()}
              />
            </TooltipV2>
          )}
        </Show>
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

      <div class="relative min-h-0 flex-1 overflow-hidden">
        <Switch fallback={loading()}>
          <Match when={file.state === "errored"}>
            <Notice icon="status" title={language.t("omni.work.preview.failed")}>
              <OpenButton label={openLabel()} onOpen={props.onOpen} />
            </Notice>
          </Match>
          <Match when={loaded()?.type === "outside"}>
            <Notice icon="folder" title={language.t("omni.work.preview.outside")}>
              <OpenButton label={openLabel()} onOpen={props.onOpen} />
            </Notice>
          </Match>
          <Match when={loaded()?.type === "too-large"}>
            <Notice
              icon="status"
              title={language.t("omni.work.preview.tooLarge.title")}
              description={language.t("omni.work.preview.tooLarge.description", {
                size: PREVIEW_MAX_BYTES / 1024 / 1024,
              })}
            >
              <OpenButton label={openLabel()} onOpen={props.onOpen} />
            </Notice>
          </Match>
          <Match when={loaded()?.type === "unsupported" || loaded()?.type === "unavailable"}>
            <Notice
              icon="review"
              title={language.t("omni.work.preview.unsupported.title")}
              description={
                !props.onOpen
                  ? language.t("omni.work.preview.unsupported.descriptionWeb")
                  : app()
                    ? language.t("omni.work.preview.unsupported.description", { app: app()! })
                    : language.t("omni.work.preview.unsupported.descriptionDefault")
              }
            >
              <OpenButton label={openLabel()} onOpen={props.onOpen} />
            </Notice>
          </Match>
          <Match when={bytes()}>
            {(value) => (
              <Switch>
                <Match when={kind() === "image"}>
                  <div class="flex h-full items-center justify-center overflow-auto bg-v2-background-bg-deep p-4">
                    <img src={image()} alt={name()} class="max-h-full max-w-full object-contain" />
                  </div>
                </Match>
                <Match when={kind() === "text"}>
                  <pre class="h-full overflow-auto whitespace-pre-wrap break-words p-4 text-12-regular text-v2-text-text-base font-mono">
                    {text()}
                  </pre>
                </Match>
                <Match when={kind() === "csv" || kind() === "tsv"}>
                  <WorkPreviewGrid text={text()} delimiter={kind() === "tsv" ? "\t" : ","} />
                </Match>
                <Match when={kind() === "pdf"}>
                  <ReactIsland
                    class="h-full"
                    fallback={loading()}
                    error={failed}
                    load={async () => {
                      const { default: PdfViewer } = await import("@/components/extend/pdf-viewer")
                      return PdfViewer
                    }}
                    props={{
                      bytes: value(),
                      name: name(),
                      labels: {
                        ...labels(),
                        page: (current: number, total: number) =>
                          language.t("omni.work.preview.page", { current, total }),
                      },
                    }}
                  />
                </Match>
                <Match when={kind() === "xlsx"}>
                  <ReactIsland
                    class="h-full"
                    fallback={loading()}
                    error={failed}
                    load={async () => {
                      const { default: XlsxPreview } = await import("@/components/extend/xlsx-viewer")
                      return XlsxPreview
                    }}
                    props={{
                      bytes: value(),
                      name: name(),
                      dark: theme.mode() === "dark",
                      labels: { ...labels(), sheets: language.t("omni.work.preview.sheets") },
                    }}
                  />
                </Match>
                <Match when={kind() === "docx"}>
                  <ReactIsland
                    class="h-full"
                    fallback={loading()}
                    error={failed}
                    load={async () => {
                      const { default: DocxPreview } = await import("@/components/extend/docx-viewer")
                      return DocxPreview
                    }}
                    props={{ bytes: value() }}
                  />
                </Match>
                <Match when={kind() === "pptx"}>
                  <ReactIsland
                    class="h-full"
                    fallback={loading()}
                    error={failed}
                    load={async () => {
                      const { default: PptxPreview } = await import("@/components/extend/pptx-viewer")
                      return PptxPreview
                    }}
                    props={{ bytes: value(), labels: labels() }}
                  />
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      </div>
    </section>
  )
}

function Notice(props: {
  icon: "status" | "folder" | "review"
  title: string
  description?: string
  children?: JSX.Element
}) {
  return (
    <div class="flex h-full items-center justify-center p-6">
      <div class="flex max-w-80 flex-col items-center gap-3 text-center">
        <Icon name={props.icon} size="large" class="text-v2-icon-icon-muted" />
        <div class="flex flex-col gap-1">
          <p class="text-14-medium text-v2-text-text-base">{props.title}</p>
          <Show when={props.description}>
            <p class="text-14-regular text-v2-text-text-muted">{props.description}</p>
          </Show>
        </div>
        {props.children}
      </div>
    </div>
  )
}

function OpenButton(props: { label: string; onOpen?: () => void }) {
  return (
    <Show when={props.onOpen}>
      {(open) => (
        <ButtonV2 size="small" variant="outline" icon="outline-square-arrow" onClick={() => open()()}>
          {props.label}
        </ButtonV2>
      )}
    </Show>
  )
}
