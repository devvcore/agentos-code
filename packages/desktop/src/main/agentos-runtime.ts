import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import type { AgentOSAccount, AgentOSStartup } from "@opencode-ai/app/agentos"

const execute = promisify(execFile)

export async function readAgentOSAccount(binary: string) {
  const { stdout } = await execute(binary, ["whoami", "--json"], { timeout: 20_000, maxBuffer: 64 * 1024 })
  // The CLI validates the server response before emitting JSON. Never expose
  // its credential file or grant identifier to the renderer.
  const value = JSON.parse(stdout) as AgentOSAccount
  return { user: value.user, workspace: value.workspace, credits: value.credits }
}

export async function revokeAgentOSAccount(binary: string) {
  await execute(binary, ["logout"], { timeout: 20_000, maxBuffer: 64 * 1024 })
}

export function startAgentOSRuntime(input: {
  binary: string
  port: number
  password: string
  onState: (state: AgentOSStartup) => void
  checkHealth: (url: string, password: string) => Promise<boolean>
}) {
  const child = spawn(
    input.binary,
    ["serve", "--login", "--hostname", "127.0.0.1", "--port", String(input.port), "--cors", "oc://renderer"],
    {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: input.password, OPENCODE_SERVER_USERNAME: "opencode" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const ready = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  // Startup failure can precede the caller attaching its health waiter.
  void ready.promise.catch(() => undefined)
  let stopped = false
  let settled = false
  let pending = ""
  const deadline = Date.now() + 360_000
  let timer: NodeJS.Timeout | undefined
  input.onState({ state: "starting" })

  const fail = () => {
    if (stopped) return
    settled = true
    clearTimeout(timer)
    input.onState({ state: "error" })
    ready.reject(new Error("AgentOS runtime could not start"))
  }
  child.on("error", fail)
  child.once("close", () => {
    clearTimeout(timer)
    exited.resolve()
    fail()
  })
  child.stdout.on("data", (chunk: Buffer) => {
    if (settled || stopped) return
    pending += chunk.toString("utf8")
    const lines = pending.split("\n")
    pending = lines.pop()?.slice(-8192) ?? ""
    for (const line of lines) {
      // This URL comes from the bundled CLI's validated OAuth metadata. The
      // browser opens there automatically; retain it only for manual retry.
      if (!line.startsWith("https://")) continue
      try {
        const url = new URL(line.trim())
        if (url.protocol !== "https:" || url.username || url.password) continue
        input.onState({ state: "signing-in", signInURL: url.href })
      } catch {}
    }
  })
  // Drain stderr without persisting login links or server diagnostics that
  // may contain private repository data. The UI reports a bounded failure.
  child.stderr.resume()

  const poll = async () => {
    if (settled || stopped) return
    if (Date.now() >= deadline) {
      fail()
      child.kill()
      return
    }
    if (await input.checkHealth(`http://127.0.0.1:${input.port}`, input.password)) {
      if (stopped || settled) return
      settled = true
      input.onState({ state: "ready" })
      ready.resolve()
      return
    }
    if (!settled && !stopped) timer = setTimeout(poll, 250)
  }
  void poll().catch(() => {
    fail()
    child.kill()
  })

  return {
    listener: {
      async stop() {
        if (stopped) return
        stopped = true
        clearTimeout(timer)
        if (!settled) ready.reject(new Error("AgentOS runtime stopped"))
        child.kill("SIGTERM")
        const force = setTimeout(() => child.kill("SIGKILL"), 6000)
        await exited.promise
        clearTimeout(force)
      },
    },
    health: { wait: ready.promise },
  }
}
