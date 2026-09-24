import { describe, expect, test } from "bun:test"
import {
  WORK_PANEL_CLOSED,
  workAutoOpen,
  workPanelReduce,
  workPanelWidth,
  workSessionWidth,
  type WorkPanelAction,
  type WorkPanelState,
} from "./work-panel-state"

const run = (state: WorkPanelState, ...actions: WorkPanelAction[]) => actions.reduce(workPanelReduce, state)
const seeded = (seen: string[] = []): WorkPanelState => ({ view: "closed", seen, presented: [] })

describe("work panel widths", () => {
  test("closed takes no room; files is compact; preview is wide", () => {
    expect(workPanelWidth("closed")).toBe("0px")
    expect(workPanelWidth("files")).toBe("340px")
    expect(workPanelWidth("preview")).toBe("clamp(480px, 50%, 900px)")
  })

  test("session column fills the row when closed, else leaves the panel plus the gap", () => {
    expect(workSessionWidth("closed")).toBe("100%")
    expect(workSessionWidth("files")).toBe("calc(100% - 340px - 8px)")
    expect(workSessionWidth("preview")).toBe("calc(100% - clamp(480px, 50%, 900px) - 8px)")
  })
})

describe("workPanelReduce navigation", () => {
  test("starts closed", () => {
    expect(WORK_PANEL_CLOSED.view).toBe("closed")
  })

  test("files, preview, back, close", () => {
    const files = run(WORK_PANEL_CLOSED, { type: "files" })
    expect(files.view).toBe("files")
    const preview = run(files, { type: "open", path: "/w/outputs/a.pdf" })
    expect(preview).toMatchObject({ view: "preview", path: "/w/outputs/a.pdf" })
    const back = run(preview, { type: "back" })
    expect(back.view).toBe("files")
    expect(back.path).toBeUndefined()
    expect(run(back, { type: "close" })).toMatchObject({ view: "closed", dismissed: true })
  })

  test("close from a preview closes the whole panel", () => {
    const state = run(WORK_PANEL_CLOSED, { type: "open", path: "/a.pdf" }, { type: "close" })
    expect(state.view).toBe("closed")
    expect(state.path).toBeUndefined()
  })

  test("back is a no-op outside a preview", () => {
    const files = run(WORK_PANEL_CLOSED, { type: "files" })
    expect(run(files, { type: "back" })).toBe(files)
    expect(run(WORK_PANEL_CLOSED, { type: "back" })).toBe(WORK_PANEL_CLOSED)
  })

  test("toggle opens the files list when closed and closes any open view", () => {
    expect(run(WORK_PANEL_CLOSED, { type: "toggle" }).view).toBe("files")
    expect(run(WORK_PANEL_CLOSED, { type: "files" }, { type: "toggle" }).view).toBe("closed")
    expect(run(WORK_PANEL_CLOSED, { type: "open", path: "/a.pdf" }, { type: "toggle" }).view).toBe("closed")
  })
})

describe("workPanelReduce seed", () => {
  test("remembers existing history once without opening anything", () => {
    const state = run(WORK_PANEL_CLOSED, {
      type: "seed",
      outputs: ["/w/a.pdf"],
      presents: [{ id: "p1", paths: ["/w/b.xlsx"] }],
    })
    expect(state).toEqual({ view: "closed", seen: ["/w/a.pdf"], presented: ["p1"] })
    expect(run(state, { type: "seed", outputs: ["/w/c.pdf"], presents: [] })).toBe(state)
  })
})

describe("turn end auto-open", () => {
  test("opens the newest deliverable not seen before", () => {
    const state = run(seeded(["/w/old.pdf"]), {
      type: "turnEnd",
      outputs: ["/w/new2.pdf", "/w/new1.pdf", "/w/old.pdf"],
    })
    expect(state).toMatchObject({ view: "preview", path: "/w/new2.pdf" })
    expect(state.seen).toEqual(["/w/old.pdf", "/w/new2.pdf", "/w/new1.pdf"])
  })

  test("opens from the files list too", () => {
    const state = run({ ...seeded(), view: "files" }, { type: "turnEnd", outputs: ["/w/a.pdf"] })
    expect(state).toMatchObject({ view: "preview", path: "/w/a.pdf" })
  })

  test("never replaces a preview the user is looking at", () => {
    const state = run(seeded(), { type: "open", path: "/w/mine.pdf" }, { type: "turnEnd", outputs: ["/w/a.pdf"] })
    expect(state).toMatchObject({ view: "preview", path: "/w/mine.pdf", seen: ["/w/a.pdf"] })
  })

  test("does nothing when nothing is new", () => {
    const state = run(seeded(["/w/a.pdf"]), { type: "turnEnd", outputs: ["/w/a.pdf"] })
    expect(state.view).toBe("closed")
  })

  test("respects a close during the same turn, and forgets it next turn", () => {
    const closed = run(seeded(), { type: "turnStart" }, { type: "files" }, { type: "close" })
    const first = run(closed, { type: "turnEnd", outputs: ["/w/a.pdf"] })
    expect(first.view).toBe("closed")
    expect(first.seen).toEqual(["/w/a.pdf"])
    const second = run(first, { type: "turnStart" }, { type: "turnEnd", outputs: ["/w/b.pdf", "/w/a.pdf"] })
    expect(second).toMatchObject({ view: "preview", path: "/w/b.pdf" })
  })

  test("an unseeded session only seeds", () => {
    const state = run(WORK_PANEL_CLOSED, { type: "turnEnd", outputs: ["/w/a.pdf"] })
    expect(state).toEqual({ view: "closed", seen: ["/w/a.pdf"] })
  })

  test("quiet only remembers", () => {
    const state = run(seeded(), { type: "turnEnd", outputs: ["/w/a.pdf"], quiet: true })
    expect(state).toEqual({ view: "closed", seen: ["/w/a.pdf"], presented: [] })
  })

  test("workAutoOpen picks the first unseen output", () => {
    expect(workAutoOpen(seeded(["/b"]), ["/c", "/b", "/a"])).toBe("/c")
    expect(workAutoOpen(seeded(["/c"]), ["/c"])).toBeUndefined()
    expect(workAutoOpen(WORK_PANEL_CLOSED, ["/c"])).toBeUndefined()
  })
})

describe("present_files auto-open", () => {
  test("opens the first file of the newest new part immediately, even over a preview", () => {
    const state = run(
      seeded(),
      { type: "open", path: "/w/mine.pdf" },
      {
        type: "present",
        presents: [
          { id: "p1", paths: ["/w/a.xlsx"] },
          { id: "p2", paths: ["/w/b.docx", "/w/c.pdf"] },
        ],
      },
    )
    expect(state).toMatchObject({ view: "preview", path: "/w/b.docx", presented: ["p1", "p2"] })
    expect(state.seen).toEqual(["/w/a.xlsx", "/w/b.docx", "/w/c.pdf"])
  })

  test("each part opens at most once, so closing it sticks", () => {
    const presents = [{ id: "p1", paths: ["/w/a.xlsx"] }]
    const opened = run(seeded(), { type: "present", presents })
    const closed = run(opened, { type: "close" })
    expect(run(closed, { type: "present", presents })).toBe(closed)
  })

  test("parts present at seed time never open", () => {
    const presents = [{ id: "p1", paths: ["/w/a.xlsx"] }]
    const state = run(WORK_PANEL_CLOSED, { type: "seed", outputs: [], presents }, { type: "present", presents })
    expect(state.view).toBe("closed")
  })

  test("quiet parts are remembered without opening", () => {
    const presents = [{ id: "p1", paths: ["/w/a.xlsx"] }]
    const state = run(seeded(), { type: "present", presents, quiet: true })
    expect(state).toMatchObject({ view: "closed", presented: ["p1"] })
    expect(run(state, { type: "present", presents })).toBe(state)
  })

  test("presented files do not re-open when the turn ends", () => {
    const state = run(
      seeded(),
      { type: "present", presents: [{ id: "p1", paths: ["/w/a.xlsx"] }] },
      { type: "back" },
      { type: "turnEnd", outputs: ["/w/a.xlsx"] },
    )
    expect(state.view).toBe("files")
  })

  test("a part without files only records itself", () => {
    const state = run(seeded(), { type: "present", presents: [{ id: "p1", paths: [] }] })
    expect(state).toMatchObject({ view: "closed", presented: ["p1"] })
  })
})

describe("workPanelReduce attachments", () => {
  const ref = { messageID: "msg_user", partID: "prt_file" }

  test("opening an attachment previews it by reference only", () => {
    const next = run(WORK_PANEL_CLOSED, { type: "attachment", ref })
    expect(next.view).toBe("preview")
    expect(next.attachment).toEqual(ref)
    expect(next.path).toBeUndefined()
    // Persisted state never carries the attachment bytes.
    expect(JSON.stringify(next)).not.toContain("data:")
  })

  test("path and attachment previews replace each other", () => {
    const withPath = run(WORK_PANEL_CLOSED, { type: "open", path: "/w/outputs/a.pdf" }, { type: "attachment", ref })
    expect(withPath.path).toBeUndefined()
    expect(withPath.attachment).toEqual(ref)
    const back = run(withPath, { type: "open", path: "/w/outputs/a.pdf" })
    expect(back.attachment).toBeUndefined()
    expect(back.path).toBe("/w/outputs/a.pdf")
  })

  test("back, files, and close clear the attachment", () => {
    const open = run(WORK_PANEL_CLOSED, { type: "attachment", ref })
    expect(run(open, { type: "back" })).toMatchObject({ view: "files", attachment: undefined })
    expect(run(open, { type: "files" })).toMatchObject({ view: "files", attachment: undefined })
    expect(run(open, { type: "close" })).toMatchObject({ view: "closed", attachment: undefined })
  })

  test("auto-open never replaces an attachment preview", () => {
    const open = run(seeded(), { type: "attachment", ref })
    const next = run(open, { type: "turnEnd", outputs: ["/w/outputs/new.pdf"] })
    expect(next.attachment).toEqual(ref)
    expect(next.view).toBe("preview")
  })
})
