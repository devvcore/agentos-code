import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { credentialPath, saveCredential } from "../../src/agentos/account"
import { applySession, requireAccount, signIn, terminalAccount } from "../../src/agentos/session"

const keys = [
  "AGENTOS_CODE_HOME",
  "AGENTOS_URL",
  "AGENTOS_API_TOKEN",
  "AGENTOS_MODEL",
  "AGENTOS_CODE_EXTERNAL_TOKEN",
  "AGENTOS_CODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_PURE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_SHARE",
]
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
let directory: string
beforeEach(async () => {
  for (const key of keys) delete process.env[key]
  directory = await mkdtemp(join(tmpdir(), "agentos-signin-"))
  process.env.AGENTOS_CODE_HOME = directory
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

function server(options: { failAccount?: number; badCatalog?: boolean } = {}) {
  const calls: string[] = []
  const instance = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push(url.pathname)
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          authorization_endpoint: url.origin + "/authorize",
          token_endpoint: url.origin + "/token",
          registration_endpoint: url.origin + "/register",
          code_challenge_methods_supported: ["S256"],
        })
      if (url.pathname === "/register") return Response.json({ client_id: "test" })
      if (url.pathname === "/token") return Response.json({ access_token: "agentos_pat_fresh", token_type: "Bearer" })
      if (url.pathname === "/inference/v1/account") {
        if (request.headers.get("authorization") === "Bearer agentos_pat_expired")
          return new Response(null, { status: 401 })
        if (options.failAccount) return new Response(null, { status: options.failAccount })
        return Response.json({
          user: { id: "user", name: "Test", email: "coder@example.test" },
          workspace: { id: "workspace", name: "Coding workspace" },
          token: { id: "token", agent_id: null },
          default_model: "test/model",
          credits: { balance: 17, spent_this_period: 3, included: 20, plan: "team" },
        })
      }
      if (url.pathname === "/inference/v1/models")
        return Response.json({
          data: options.badCatalog
            ? []
            : [
                {
                  id: "test/model",
                  name: "Coding model",
                  context_length: 100000,
                  max_output_tokens: 4000,
                  input_modalities: ["text"],
                  output_modalities: ["text"],
                  supported_parameters: ["tools"],
                },
              ],
        })
      if (url.pathname === "/access-tokens/token" && request.method === "DELETE") return Response.json({ ok: true })
      return new Response("Unexpected request", { status: 500 })
    },
  })
  process.env.AGENTOS_URL = instance.url.origin
  return {
    calls,
    instance,
    async open(value: string) {
      const url = new URL(value)
      const callback = new URL(url.searchParams.get("redirect_uri")!)
      callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "approved" }).toString()
      expect((await fetch(callback)).status).toBe(200)
    },
  }
}

test("a fresh interactive launch requires browser consent before loading coding configuration", async () => {
  const fixture = server()
  try {
    const result = await requireAccount({
      interactive: true,
      async open(url) {
        expect(fixture.calls).toEqual(["/.well-known/oauth-authorization-server", "/register"])
        expect(await Bun.file(credentialPath()).exists()).toBe(false)
        await fixture.open(url)
      },
    })
    expect(result.details.workspace.name).toBe("Coding workspace")
    expect(await Bun.file(credentialPath()).json()).toEqual(result.credential)
    expect(fixture.calls).toEqual([
      "/.well-known/oauth-authorization-server",
      "/register",
      "/token",
      "/inference/v1/account",
      "/inference/v1/models",
    ])
  } finally {
    await fixture.instance.stop(true)
  }
})

test("expired saved login starts browser sign-in; a valid saved login does not", async () => {
  const fixture = server()
  try {
    await saveCredential({ url: fixture.instance.url.origin, token: "agentos_pat_expired" })
    await requireAccount({ interactive: true, open: fixture.open })
    fixture.calls.length = 0
    await requireAccount({
      interactive: true,
      async open() {
        throw new Error("Already signed in")
      },
    })
    expect(fixture.calls).toEqual(["/inference/v1/account", "/inference/v1/models"])
  } finally {
    await fixture.instance.stop(true)
  }
})

test("headless signed-out runs fail without opening a browser or sending a model request", async () => {
  const fixture = server()
  try {
    await expect(requireAccount({ interactive: false, open: fixture.open })).rejects.toThrow("omnicode login")
    expect(fixture.calls).toEqual([])
  } finally {
    await fixture.instance.stop(true)
  }
})

test("invalid external tokens and server outages do not silently switch accounts", async () => {
  const fixture = server({ failAccount: 503 })
  try {
    process.env.AGENTOS_API_TOKEN = "agentos_pat_expired"
    await expect(requireAccount({ interactive: true, open: fixture.open })).rejects.toThrow("expired")
    delete process.env.AGENTOS_API_TOKEN
    await saveCredential({ url: fixture.instance.url.origin, token: "agentos_pat_saved" })
    await expect(requireAccount({ interactive: true, open: fixture.open })).rejects.toThrow("503")
    expect(fixture.calls).toEqual(["/inference/v1/account", "/inference/v1/account"])
  } finally {
    await fixture.instance.stop(true)
  }
})

test("failed catalog verification preserves the previous account", async () => {
  const fixture = server({ badCatalog: true })
  try {
    const previous = { url: fixture.instance.url.origin, token: "agentos_pat_previous" }
    await saveCredential(previous)
    await expect(signIn({ url: fixture.instance.url.origin, open: fixture.open })).rejects.toThrow(
      "not available for coding",
    )
    expect(await Bun.file(credentialPath()).json()).toEqual(previous)
  } finally {
    await fixture.instance.stop(true)
  }
})

test("declined browser consent leaves the CLI signed out", async () => {
  const fixture = server()
  try {
    await expect(
      requireAccount({
        interactive: true,
        async open(value) {
          const url = new URL(value)
          await fetch(
            url.searchParams.get("redirect_uri") + "?error=access_denied&state=" + url.searchParams.get("state"),
          )
        },
      }),
    ).rejects.toThrow("declined")
    expect(await Bun.file(credentialPath()).exists()).toBe(false)
    expect(fixture.calls).not.toContain("/token")
    expect(fixture.calls).not.toContain("/inference/v1/account")
  } finally {
    await fixture.instance.stop(true)
  }
})

test("terminal usage uses the authenticated workspace and logout revokes and removes login", async () => {
  const fixture = server()
  try {
    applySession(await requireAccount({ interactive: true, open: fixture.open }))
    const controller = terminalAccount(async () => {})
    expect(await controller.usage()).toContain("Workspace: Coding workspace\nPlan: team\nCredits remaining: 17")
    await controller.logout()
    expect(fixture.calls.at(-1)).toBe("/access-tokens/token")
    expect(await Bun.file(credentialPath()).exists()).toBe(false)
  } finally {
    await fixture.instance.stop(true)
  }
})
