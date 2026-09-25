import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { apiURL, authenticated, login, saveCredential } from "../../src/agentos/account"
import { applyAccountConfig, configuration } from "../../src/agentos/config"
import { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"

test("PKCE login binds the loopback callback to state and exchanges once", async () => {
  const requests: string[] = []
  const state: Record<string, string> = {}
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    requests.push(url.pathname)
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({
      authorization_endpoint: url.origin + "/api/oauth/authorize", token_endpoint: url.origin + "/api/oauth/token",
      registration_endpoint: url.origin + "/api/oauth/register", code_challenge_methods_supported: ["S256"],
    })
    if (url.pathname === "/api/oauth/register") {
      const body = await request.json()
      expect(body.client_name).toBe("OmniCode")
      expect(new URL(body.redirect_uris[0]).hostname).toBe("127.0.0.1")
      state.redirect = body.redirect_uris[0]
      return Response.json({ client_id: "client-test" })
    }
    if (url.pathname === "/api/oauth/token") {
      const body = new URLSearchParams(await request.text())
      expect(body.get("code")).toBe("one-use-code")
      expect(body.get("redirect_uri")).toBe(state.redirect)
      expect(body.get("client_id")).toBe("client-test")
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(state.challenge)
      return Response.json({ access_token: "agentos_pat_test", token_type: "Bearer" })
    }
    return new Response("not found", { status: 404 })
  } })
  try {
    const credential = await login({ url: server.url.origin, async open(value) {
      const url = new URL(value)
      state.challenge = url.searchParams.get("code_challenge")!
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      const bad = await fetch(state.redirect + "?code=stolen&state=wrong")
      expect(bad.status).toBe(400)
      const good = await fetch(state.redirect + "?code=one-use-code&state=" + url.searchParams.get("state"))
      expect(good.status).toBe(200)
    } })
    expect(credential).toEqual({ url: server.url.origin, token: "agentos_pat_test" })
    expect(requests.filter((path) => path === "/api/oauth/token")).toHaveLength(1)
    await using directory = await tmpdir()
    const file = directory.path + "/private/auth.json"
    await saveCredential(credential, file)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(directory.path + "/private")).mode & 0o777).toBe(0o700)
    expect(await Bun.file(file).json()).toEqual(credential)
  } finally { await server.stop(true) }
})

test("refuses cross-origin OAuth endpoints and insecure credential origins", async () => {
  expect(() => apiURL("http://example.com")).toThrow("HTTPS")
  expect(() => apiURL("https://user:password@example.com")).toThrow("credentials")
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({
    authorization_endpoint: "https://other.example/auth", token_endpoint: "https://other.example/token",
    registration_endpoint: "https://other.example/register", code_challenge_methods_supported: ["S256"],
  }) } })
  try { await expect(login({ url: server.url.origin, async open() { throw new Error("must not open") } })).rejects.toThrow("another server") }
  finally { await server.stop(true) }
})

test("authenticated calls reject redirects without forwarding the token", async () => {
  const calls: string[] = []
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { calls.push(request.url); return Response.json({}) } })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(other.url) } })
  try {
    await expect(authenticated({ url: server.url.origin, token: "agentos_pat_test" }, "/account")).rejects.toThrow()
    expect(calls).toHaveLength(0)
  } finally { await server.stop(true); await other.stop(true) }
})

test("account policy pins all model calls and MCP to AgentOS while retaining project tools", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.headers.get("Authorization")).toBe("Bearer agentos_pat_test")
    return Response.json({ data: [{ id: "test/model", name: "Test coding model", context_length: 200000,
      max_output_tokens: 32000, input_modalities: ["text", "image"], output_modalities: ["text"], supported_parameters: ["tools", "reasoning"] }] })
  } })
  try {
    const config = await configuration({ url: server.url.origin, token: "agentos_pat_test" }, "test/model")
    expect(JSON.stringify(config)).not.toContain("agentos_pat_test")
    expect(config.model).toBe(config.small_model)
    const result = applyAccountConfig({
      model: "openai/unbilled", small_model: "openai/unbilled", enabled_providers: ["openai"], share: "auto",
      provider: { agentos: { options: { baseURL: "https://other.example" }, models: { "test/model": { provider: { api: "https://other.example" } } } } },
      mcp: { agentos: { type: "remote", url: "https://other.example" }, local: { type: "local", command: ["example"] } },
    }, config)
    expect(result.provider).toEqual(config.provider)
    expect(result.enabled_providers).toEqual(["agentos"])
    expect(result.model).toBe("agentos/test/model")
    expect(result.small_model).toBe("agentos/test/model")
    expect(result.share).toBe("disabled")
    expect(result.mcp?.agentos).toEqual(config.mcp.agentos)
    expect(result.mcp?.local).toBeDefined()
    // Chat-run-only AgentOS tools are denied (and so hidden) for every agent; the rest of the server stays available.
    const rules = Permission.fromConfig(result.permission ?? {})
    expect([...Permission.disabled(["agentos_plan", "agentos_ask_user", "agentos_wiki_search"], rules)]).toEqual([
      "agentos_plan",
      "agentos_ask_user",
    ])
  } finally { await server.stop(true) }
})

test("sign-in cancellation stops before registration", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    expect(url.pathname).toBe("/.well-known/oauth-authorization-server")
    return Response.json({ authorization_endpoint: url.origin + "/authorize", token_endpoint: url.origin + "/token",
      registration_endpoint: url.origin + "/register", code_challenge_methods_supported: ["S256"] })
  } })
  try {
    await expect(login({ url: server.url.origin, signal: AbortSignal.abort(), async open() {
      throw new Error("must not open")
    } })).rejects.toThrow()
  } finally { await server.stop(true) }
})

test("loopback and proxy URLs preserve their explicit API prefix", () => {
  expect(apiURL("https://tryagentos.net")).toBe("https://tryagentos.net/api")
  expect(apiURL("https://tryagentos.net/api/")).toBe("https://tryagentos.net/api")
  expect(apiURL("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000")
  expect(apiURL("http://localhost:5173/api/")).toBe("http://localhost:5173/api")
})
