import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { InstanceState } from "../../src/effect/instance-state"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  test("working folder listing shows files with sizes, one level of subfolders, and skips hidden and dependency folders", async () => {
    await using tmp = await tmpdir()
    const write = async (file: string, bytes = 10) => {
      await fs.mkdir(path.dirname(path.join(tmp.path, file)), { recursive: true })
      await fs.writeFile(path.join(tmp.path, file), "x".repeat(bytes))
    }
    await write("sales_2026.csv", 2048)
    await write("outputs/Summary.xlsx")
    await write("data/raw/deep.csv")
    await write(".git/HEAD")
    await write("node_modules/pkg/index.js")
    await write(".env")

    const listing = await SystemPrompt.folder(tmp.path)
    expect(listing).toContain("  sales_2026.csv (2.0 KB, modified ")
    expect(listing).toContain("  outputs/ (folder, 1 item)")
    expect(listing).toContain(`    ${path.join("outputs", "Summary.xlsx")} (10 B, modified `)
    expect(listing).toContain(`    ${path.join("data", "raw")}/ (folder)`)
    // One level into subfolders only; hidden and dependency folders never appear.
    expect(listing).not.toContain("deep.csv")
    expect(listing).not.toContain(".git")
    expect(listing).not.toContain(".env")
    expect(listing).not.toContain("node_modules")
    expect(listing).not.toContain("more")

    await using empty = await tmpdir()
    expect(await SystemPrompt.folder(empty.path)).toBe("  (empty)")
  })

  test("working folder listing is capped, keeps every top-level entry, and gives outputs/ first claim on the rest", async () => {
    await using tmp = await tmpdir()
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => fs.writeFile(path.join(tmp.path, `file-${i}.txt`), "x")),
      fs.mkdir(path.join(tmp.path, "archive")).then(() =>
        Promise.all(Array.from({ length: 20 }, (_, i) => fs.writeFile(path.join(tmp.path, "archive", `old-${i}.txt`), "x"))),
      ),
      fs.mkdir(path.join(tmp.path, "outputs")).then(() =>
        Promise.all(Array.from({ length: 3 }, (_, i) => fs.writeFile(path.join(tmp.path, "outputs", `Report ${i}.docx`), "x"))),
      ),
    ])

    const lines = (await SystemPrompt.folder(tmp.path, 10)).split("\n")
    // 7 top-level entries + 3 from outputs/ fill the cap; archive/ contents are summarized.
    expect(lines).toHaveLength(11)
    expect(lines.filter((line) => line.startsWith("  file-"))).toHaveLength(5)
    expect(lines).toContain("  archive/ (folder, 20 items)")
    expect(lines.filter((line) => line.includes("Report "))).toHaveLength(3)
    expect(lines.some((line) => line.includes("old-"))).toBe(false)
    expect(lines.at(-1)).toBe("  …and 20 more")
  })

  it.instance("environment lists the working folder only for work sessions", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.promise(() => fs.writeFile(path.join(ctx.directory, "sales_2026.csv"), "region,total"))
      const sys = yield* SystemPrompt.Service
      const model = { providerID: "test", api: { id: "test-model" } } as Provider.Model

      const work = (yield* sys.environment(model, { scratch: "/scratch", folder: true })).join("\n")
      expect(work).toContain(`Working folder: ${ctx.directory}\nThe user's files are here; use paths relative to it.`)
      expect(work).toContain("  sales_2026.csv (12 B, modified ")

      const code = (yield* sys.environment(model)).join("\n")
      expect(code).not.toContain("Working folder:")
      expect(code).not.toContain("sales_2026.csv")
    }),
  )

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
