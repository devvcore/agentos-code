import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Session } from "./session"

/**
 * Per-session scratch folders for the Omniwork `work` agent: throwaway scripts, renders, and intermediate files live
 * here instead of in the user's folder. One folder per session tree, so subagents share their root session's folder.
 */
export const root = path.join(Global.Path.data, "work-scratch")

const MAX_AGE = 7 * 24 * 60 * 60 * 1000

/**
 * The session tree a session belongs to: the root session's ID, and the agent acting for it. Subagents spawned from a
 * work session act on the work agent's behalf, so they inherit its instruction scope and scratch folder.
 */
export const owner = Effect.fn("Scratch.owner")(function* (session: Session.Info, agent: string) {
  const sessions = yield* Session.Service
  let current = session
  while (current.parentID) current = yield* sessions.get(current.parentID)
  return { sessionID: current.id, agent: session.parentID ? (current.agent ?? agent) : agent }
})

/** Create (or touch) the scratch folder for a root session. Creating a new one also sweeps folders idle for a week. */
export async function ensure(sessionID: string) {
  const dir = path.join(root, sessionID)
  const created = await fs.mkdir(dir, { recursive: true })
  // Folder mtime tracks the session's last activity, so active sessions are never swept.
  if (!created) await fs.utimes(dir, new Date(), new Date()).catch(() => {})
  if (created) await sweep(sessionID)
  return dir
}

async function sweep(keep: string) {
  const cutoff = Date.now() - MAX_AGE
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== keep)
      .map(async (entry) => {
        const dir = path.join(root, entry.name)
        const stat = await fs.stat(dir).catch(() => undefined)
        if (stat && stat.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      }),
  )
}

export * as Scratch from "./scratch"
