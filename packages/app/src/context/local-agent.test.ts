import { describe, expect, test } from "bun:test"
import { hasCustomAgent, hasWorkAgent, resolveAgent, selectAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})

describe("selectAgent", () => {
  const agents = [{ name: "build" }, { name: "plan" }, { name: "work" }, { name: "custom" }]

  test("keeps the work agent when custom agents are hidden", () => {
    expect(selectAgent(agents, "work", false)?.name).toBe("work")
  })

  test("falls back to build for other agents when custom agents are hidden", () => {
    expect(selectAgent(agents, "plan", false)?.name).toBe("build")
    expect(selectAgent(agents, "custom", false)?.name).toBe("build")
    expect(selectAgent(agents, undefined, false)?.name).toBe("build")
  })

  test("uses the requested agent when custom agents are visible", () => {
    expect(selectAgent(agents, "plan", true)?.name).toBe("plan")
    expect(selectAgent(agents, "work", true)?.name).toBe("work")
  })

  test("falls back to build when the server has no work agent", () => {
    expect(selectAgent([{ name: "build" }, { name: "plan" }], "work", false)?.name).toBe("build")
  })
})

describe("hasWorkAgent", () => {
  test("detects the work agent", () => {
    expect(hasWorkAgent([{ name: "build" }, { name: "work" }])).toBe(true)
  })

  test("hides Work when the server has no work agent", () => {
    expect(hasWorkAgent([{ name: "build" }, { name: "plan" }])).toBe(false)
  })
})
