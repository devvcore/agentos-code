import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { SessionID, MessageID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { Truncate } from "@/tool/truncate"
import { WorkPython } from "../../src/work/python"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ready = {
  state: "ready",
  python: "/rt/envs/abc/bin/python",
  bin: "/rt/envs/abc/bin",
  version: "3.12.14",
  current: true,
} as const

describe("WorkPython.stamp", () => {
  const base = {
    python: "3.12.14",
    requirements: ["pandas==3.0.6", "numpy==2.5.3"],
    excludeNewer: "2026-09-24T00:00:00Z",
  }

  test("is stable and ignores requirement order", () => {
    expect(WorkPython.stamp(base)).toBe(WorkPython.stamp({ ...base, requirements: ["numpy==2.5.3", "pandas==3.0.6"] }))
    expect(WorkPython.stamp()).toMatch(/^[0-9a-f]{16}$/)
    expect(WorkPython.stamp()).toBe(WorkPython.stamp())
  })

  test("changes when requirements, Python, or the resolution date change", () => {
    const id = WorkPython.stamp(base)
    expect(WorkPython.stamp({ ...base, requirements: ["pandas==3.0.7", "numpy==2.5.3"] })).not.toBe(id)
    expect(WorkPython.stamp({ ...base, requirements: [...base.requirements, "pillow==12.3.0"] })).not.toBe(id)
    expect(WorkPython.stamp({ ...base, python: "3.12.15" })).not.toBe(id)
    expect(WorkPython.stamp({ ...base, excludeNewer: "2026-10-01T00:00:00Z" })).not.toBe(id)
  })
})

describe("WorkPython.env", () => {
  test("puts the managed venv first on PATH for work", () => {
    const env = WorkPython.env({ PATH: "/usr/bin:/bin", PYTHONHOME: "/elsewhere", HOME: "/h" }, true, ready)
    expect(env.PATH).toBe(["/rt/envs/abc/bin", "/usr/bin:/bin"].join(path.delimiter))
    expect(env.VIRTUAL_ENV).toBe("/rt/envs/abc")
    expect(env.MPLBACKEND).toBe("Agg")
    expect(env.PYTHONHOME).toBeUndefined()
    expect(env.HOME).toBe("/h")
  })

  test("leaves other agents and unready runtimes unchanged", () => {
    const base = { PATH: "/usr/bin:/bin" }
    expect(WorkPython.env(base, false, ready)).toBe(base)
    expect(WorkPython.env(base, true, { state: "installing" })).toBe(base)
    expect(WorkPython.env(base, true, { state: "unavailable" })).toBe(base)
    expect(WorkPython.env(base, true, { state: "failed", log: "/x.log" })).toBe(base)
  })
})

describe("WorkPython.describe", () => {
  test("ready names the interpreter and preinstalled libraries", () => {
    const text = WorkPython.describe(ready)!
    expect(text).toContain("/rt/envs/abc/bin/python (Python 3.12.14)")
    for (const name of ["pandas", "openpyxl", "python-docx", "python-pptx", "markitdown", "pillow"])
      expect(text).toContain(name)
    expect(text).toContain("Do not pip install these")
  })

  test("installing, failed, and unavailable", () => {
    expect(WorkPython.describe({ state: "installing" })).toContain("still installing")
    expect(WorkPython.describe({ state: "installing" })).toContain("system python3")
    expect(WorkPython.describe({ state: "failed", log: "/rt/install.log" })).toContain("/rt/install.log")
    expect(WorkPython.describe({ state: "unavailable" })).toBeUndefined()
  })

  test("packages strips extras and pins", () => {
    expect(WorkPython.packages()).toContain("markitdown")
    expect(WorkPython.packages()).toContain("python-docx")
    expect(WorkPython.packages().every((name) => /^[a-z-]+$/.test(name))).toBe(true)
  })
})

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

describe("WorkPython shell integration", () => {
  it.live("only work shells get the managed Python on PATH", () =>
    Effect.gen(function* () {
      const root = WorkPython.root()
      const bin = path.join(root, "envs", "test", "bin")
      yield* Effect.promise(async () => {
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(path.join(bin, "python"), "")
        await Bun.write(
          path.join(root, "current.json"),
          JSON.stringify({ stamp: "old", python: path.join(bin, "python"), bin, version: "3.12.14" }),
        )
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))

      expect((yield* Effect.promise(() => WorkPython.status())).state).toBe("ready")
      expect(yield* Effect.promise(() => WorkPython.prompt())).toContain(path.join(bin, "python"))

      const tool = yield* ShellTool
      const shell = yield* tool.init()
      const ctx = {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        callID: "",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const work = yield* shell.execute({ command: "echo $PATH" }, { ...ctx, agent: "work" })
      const build = yield* shell.execute({ command: "echo $PATH" }, { ...ctx, agent: "build" })
      expect(work.output.trim().startsWith(bin + path.delimiter)).toBe(true)
      expect(build.output).not.toContain(bin)
    }).pipe(provideInstance(path.join(import.meta.dir, "../.."))),
  )
})
