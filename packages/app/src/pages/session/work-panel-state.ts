/**
 * Omniwork side panel state, per session. The panel behaves like Claude.ai artifacts: closed by
 * default, opened to a files list from the header, or to a single file preview from chat cards,
 * `present_files`, or the end of a turn that produced a new deliverable.
 *
 * `seen` holds deliverable paths already known when a turn ended, and `presented` holds the
 * `present_files` part IDs already handled, so reloads and paginated history never re-open files.
 * `dismissed` records that the user closed the panel during the current turn.
 */
export type WorkPanelView = "closed" | "files" | "preview"

export type WorkPanelState = {
  view: WorkPanelView
  path?: string
  seen?: string[]
  presented?: string[]
  dismissed?: boolean
}

/** A completed `present_files` tool part: the agent showing files to the user in-app. */
export type WorkPresent = { id: string; paths: string[] }

export type WorkPanelAction =
  | { type: "files" }
  | { type: "open"; path: string }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "back" }
  /** First observation of a session's history: remember everything without opening anything. */
  | { type: "seed"; outputs: string[]; presents: WorkPresent[] }
  /** New `present_files` parts: open the newest one now, or only remember them when `quiet`. */
  | { type: "present"; presents: WorkPresent[]; quiet?: boolean }
  | { type: "turnStart" }
  /** The session went idle; `outputs` are deliverable paths, newest first. `quiet` only remembers. */
  | { type: "turnEnd"; outputs: string[]; quiet?: boolean }

export const WORK_PANEL_CLOSED: WorkPanelState = { view: "closed" }

export function workPanelReduce(state: WorkPanelState, action: WorkPanelAction): WorkPanelState {
  if (action.type === "files") return { ...state, view: "files", path: undefined }
  if (action.type === "open") return { ...state, view: "preview", path: action.path }
  if (action.type === "close") return { ...state, view: "closed", path: undefined, dismissed: true }
  if (action.type === "toggle") return workPanelReduce(state, { type: state.view === "closed" ? "files" : "close" })
  if (action.type === "back") return state.view === "preview" ? { ...state, view: "files", path: undefined } : state
  if (action.type === "seed") {
    if (state.seen) return state
    return { ...state, seen: action.outputs, presented: action.presents.map((item) => item.id) }
  }
  if (action.type === "present") return present(state, action.presents, action.quiet)
  if (action.type === "turnStart") return state.dismissed ? { ...state, dismissed: false } : state
  if (!state.seen) return { ...state, seen: action.outputs }
  const target = action.quiet ? undefined : workAutoOpen(state, action.outputs)
  const seen = [...state.seen, ...action.outputs.filter((path) => !state.seen?.includes(path))]
  if (!target) return { ...state, seen }
  return { ...state, seen, view: "preview", path: target }
}

/**
 * Which deliverable to open when a turn ends: the newest one not seen before, but only while
 * the panel is closed or listing files, and never after the user closed the panel this turn.
 */
export function workAutoOpen(state: WorkPanelState, outputs: string[]) {
  if (state.view === "preview" || state.dismissed || !state.seen) return
  return outputs.find((path) => !state.seen?.includes(path))
}

function present(state: WorkPanelState, presents: WorkPresent[], quiet?: boolean): WorkPanelState {
  const fresh = presents.filter((item) => !state.presented?.includes(item.id))
  if (fresh.length === 0) return state
  const paths = fresh.flatMap((item) => item.paths)
  const next = {
    ...state,
    presented: [...(state.presented ?? []), ...fresh.map((item) => item.id)],
    // Presented files are already in front of the user, so the turn end must not re-open them.
    seen: state.seen ? [...state.seen, ...paths.filter((path) => !state.seen?.includes(path))] : state.seen,
  }
  const target = fresh.findLast((item) => item.paths.length > 0)?.paths[0]
  if (quiet || !target) return next
  return { ...next, view: "preview", path: target }
}

/** CSS width of the WorkPanel for its view. Closed collapses to nothing. */
export function workPanelWidth(view: WorkPanelView) {
  if (view === "preview") return "clamp(480px, 50%, 900px)"
  if (view === "files") return "340px"
  return "0px"
}

/** CSS width of the session column beside the WorkPanel (8px row gap), so both fill the row. */
export function workSessionWidth(view: WorkPanelView) {
  if (view === "closed") return "100%"
  return `calc(100% - ${workPanelWidth(view)} - 8px)`
}
