import { For, Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, columnName, delimitedModel } from "@/pages/session/work-preview-sheet"

/** Read-only CSV/TSV grid: column letters, row numbers, pinned header row. */
export function WorkPreviewGrid(props: { text: string; delimiter: string }) {
  const language = useLanguage()
  const model = createMemo(() => delimitedModel(props.text, props.delimiter))
  // With more than one row, the first is treated as the header and pinned under the column letters.
  const header = createMemo(() => (model().rows.length > 1 ? model().rows[0] : undefined))
  const body = createMemo(() => (header() ? model().rows.slice(1) : model().rows))

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show when={model().truncated}>
        <p class="shrink-0 border-b border-v2-border-border-muted px-3 py-1.5 text-12-regular text-v2-text-text-muted">
          {language.t("omni.work.preview.truncated", { rows: SHEET_MAX_ROWS, columns: SHEET_MAX_COLUMNS })}
        </p>
      </Show>
      <div class="min-h-0 flex-1 overflow-auto">
        <table
          class="table-fixed border-separate border-spacing-0 text-12-regular text-v2-text-text-base tabular-nums"
          style={{ width: `${model().widths.reduce((sum, width) => sum + width, 44)}px` }}
        >
          <colgroup>
            <col style={{ width: "44px" }} />
            <For each={model().widths}>{(width) => <col style={{ width: `${width}px` }} />}</For>
          </colgroup>
          <thead class="sticky top-0 z-10">
            <tr>
              <th class="sticky left-0 z-10 border-b border-r border-v2-border-border-muted bg-v2-background-bg-layer-01" />
              <For each={model().widths}>
                {(_, index) => (
                  <th class="border-b border-r border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1 text-12-regular text-v2-text-text-muted">
                    {columnName(index())}
                  </th>
                )}
              </For>
            </tr>
            <Show when={header()}>
              {(row) => <Row row={row()} number={1} widths={model().widths} class="bg-v2-background-bg-base font-medium" />}
            </Show>
          </thead>
          <tbody>
            <For each={body()}>
              {(row, index) => (
                <Row
                  row={row}
                  number={index() + (header() ? 2 : 1)}
                  widths={model().widths}
                  numeric={model().numeric}
                />
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Row(props: { row: string[]; number: number; widths: number[]; numeric?: boolean[]; class?: string }) {
  return (
    <tr>
      <th class="sticky left-0 border-b border-r border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1 text-right text-12-regular text-v2-text-text-muted">
        {props.number}
      </th>
      <For each={props.widths}>
        {(_, column) => (
          <td
            class={`max-w-0 truncate border-b border-r border-v2-border-border-muted px-2 py-1 ${props.class ?? ""}`}
            classList={{ "text-right": !!props.numeric?.[column()] }}
            title={props.row[column()]}
          >
            {props.row[column()]}
          </td>
        )}
      </For>
    </tr>
  )
}
