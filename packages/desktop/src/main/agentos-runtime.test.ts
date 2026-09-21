import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readAgentOSAccount, startAgentOSRuntime } from "./agentos-runtime"
import type { AgentOSStartup } from "@opencode-ai/app/agentos"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "agentos-desktop-"))
  directories.push(dir)
  const binary = join(dir, "agentos-code")
  await writeFile(binary, `#!/usr/bin/env node\n${source}\n`)
  await chmod(binary, 0o700)
  return { dir, binary }
}

test("starts the bundled CLI with browser login and authenticated loopback, then stops its child", async () => {
  const file = await fixture(`
    require("fs").writeFileSync(__filename + ".started", JSON.stringify({ pid: process.pid, args: process.argv.slice(2), password: process.env.OPENCODE_SERVER_PASSWORD }))
    console.log("Sign in to AgentOS to start coding:")
    process.stdout.write("https://tryagentos.net/authorize?")
    setTimeout(() => process.stdout.write("state=test\\n"), 10)
    setInterval(() => {}, 1000)
  `)
  const states: AgentOSStartup[] = []
  const runtime = startAgentOSRuntime({
    binary: file.binary,
    port: 49123,
    password: "local-test-password",
    onState: (state) => states.push(state),
    checkHealth: async (url, password) => {
      expect(url).toBe("http://127.0.0.1:49123")
      expect(password).toBe("local-test-password")
      return states.some((state) => state.state === "signing-in")
    },
  })
  try {
    await runtime.health.wait
    expect(states.map((state) => state.state)).toEqual(["starting", "signing-in", "ready"])
    expect(states[1].signInURL).toBe("https://tryagentos.net/authorize?state=test")
    const started = JSON.parse(await readFile(file.binary + ".started", "utf8"))
    expect(started.args).toEqual([
      "serve",
      "--login",
      "--hostname",
      "127.0.0.1",
      "--port",
      "49123",
      "--cors",
      "oc://renderer",
    ])
    expect(started.password).toBe("local-test-password")
    await runtime.listener.stop()
    expect(() => process.kill(started.pid, 0)).toThrow()
  } finally {
    await runtime.listener.stop()
  }
})

test("a missing runtime fails promptly and cleanup completes", async () => {
  const states: AgentOSStartup[] = []
  const runtime = startAgentOSRuntime({
    binary: "/missing/agentos-code",
    port: 49123,
    password: "test",
    onState: (state) => states.push(state),
    checkHealth: async () => false,
  })
  await expect(runtime.health.wait).rejects.toThrow("could not start")
  await runtime.listener.stop()
  expect(states.at(-1)?.state).toBe("error")
})

test("a runtime crash fails startup without waiting for the login deadline", async () => {
  const file = await fixture("process.exit(1)")
  const runtime = startAgentOSRuntime({
    binary: file.binary,
    port: 49123,
    password: "test",
    onState: () => {},
    checkHealth: async () => false,
  })
  await expect(runtime.health.wait).rejects.toThrow("could not start")
  await runtime.listener.stop()
})

test("account IPC data excludes the grant identifier and credentials", async () => {
  const value = {
    user: { name: "Test", email: "test@example.com" },
    workspace: { name: "Test workspace" },
    credits: { balance: 42, spent_this_period: 3, plan: "test" },
  }
  const file = await fixture(
    `console.log(${JSON.stringify(JSON.stringify({ ...value, token: { id: "private-id" }, credential: "private-token" }))})`,
  )
  expect(await readAgentOSAccount(file.binary)).toEqual(value)
})
