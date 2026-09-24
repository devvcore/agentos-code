import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PresentFilesTool } from "../../src/tool/present_files"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

const it = testEffect(
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node])),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "work",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const put = (file: string, content: string) => Effect.promise(() => Bun.write(file, content))

const init = Effect.fn("PresentFilesToolTest.init")(function* () {
  const info = yield* PresentFilesTool
  return yield* info.init()
})

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return ""
  const err = Cause.squash(exit.cause)
  return err instanceof Error ? err.message : String(err)
}

describe("tool.present_files", () => {
  it.instance("shows project files by absolute and relative path without reading them", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "outputs", "Site Report.xlsx"), "xlsx")
      yield* put(path.join(test.directory, "notes.csv"), "a,b\n1,2\n")
      const tool = yield* init()
      const { items, next } = asks()
      const result = yield* tool.execute(
        { paths: ["outputs/Site Report.xlsx", path.join(test.directory, "notes.csv")] },
        next,
      )
      expect(result.output).toBe("Shown to the user in the app: Site Report.xlsx, notes.csv")
      expect(result.output).not.toContain("a,b")
      expect(result.title).toBe("Site Report.xlsx, notes.csv")
      expect(result.metadata.files).toEqual([
        { path: path.join(test.directory, "outputs", "Site Report.xlsx"), name: "Site Report.xlsx" },
        { path: path.join(test.directory, "notes.csv"), name: "notes.csv" },
      ])
      expect(items.map((item) => item.permission)).toEqual(["present_files"])
    }),
  )

  it.instance("reports missing files and directories to the model", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "outputs", "a.csv"), "x")
      const tool = yield* init()
      const exit = yield* tool
        .execute({ paths: ["outputs/a.csv", "outputs/missing.xlsx", "outputs"] }, ctx)
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const message = failure(exit)
      expect(message).toContain(`File not found: ${path.join(test.directory, "outputs", "missing.xlsx")}`)
      expect(message).toContain(`Not a regular file: ${path.join(test.directory, "outputs")}`)
      expect(message).not.toContain("a.csv")
    }),
  )

  it.instance("asks for external_directory permission for files outside the project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      yield* put(path.join(outer, "Budget.pdf"), "pdf")
      const tool = yield* init()
      const { items, next } = asks()
      const result = yield* tool.execute({ paths: [path.join(outer, "Budget.pdf")] }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext?.patterns).toEqual([path.join(outer, "*").replaceAll("\\", "/")])
      expect(result.metadata.files).toEqual([{ path: path.join(outer, "Budget.pdf"), name: "Budget.pdf" }])
    }),
  )
})
