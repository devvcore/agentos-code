import path from "node:path"
import os from "node:os"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

export const Credential = z.object({ url: z.string(), token: z.string().startsWith("agentos_pat_") })
export type Credential = z.infer<typeof Credential>
export class SignInRequired extends Error {}
export const Account = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  workspace: z.object({ id: z.string(), name: z.string() }),
  token: z.object({ id: z.string(), agent_id: z.string().nullable() }),
  default_model: z.string(),
  credits: z.object({ balance: z.number(), spent_this_period: z.number(), included: z.number().nullable(), plan: z.string() }),
})

export function apiURL(input = "https://tryagentos.net") {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash) throw new Error("Use an AgentOS URL without credentials, query, or fragment.")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("AgentOS requires HTTPS, except on localhost.")
  }
  const base = url.href.replace(/\/+$/, "")
  return url.pathname === "/" && url.protocol === "https:" ? base + "/api" : base
}

export function credentialPath() {
  return path.join(process.env.AGENTOS_CODE_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentos-code"), "auth.json")
}

export async function loadCredential(): Promise<Credential> {
  if (process.env.AGENTOS_API_TOKEN) {
    return Credential.parse({ url: apiURL(process.env.AGENTOS_URL), token: process.env.AGENTOS_API_TOKEN })
  }
  const file = Bun.file(credentialPath())
  if (!(await file.exists())) throw new SignInRequired("Sign in with `agentos-code login` first.")
  const result = Credential.safeParse(await file.json().catch(() => null))
  if (!result.success) throw new SignInRequired("AgentOS sign-in is invalid. Run `agentos-code login` again.")
  const url = apiURL(result.data.url)
  if (process.env.AGENTOS_URL && apiURL(process.env.AGENTOS_URL) !== url) {
    throw new Error("This login belongs to another AgentOS server. Run `agentos-code login --url <url>`.")
  }
  return { ...result.data, url }
}

export async function saveCredential(value: Credential, file = credentialPath()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + "." + randomBytes(8).toString("hex")
  try {
    await Bun.write(temporary, JSON.stringify(value) + "\n", { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function jsonRequest(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: "error", signal: init.signal || AbortSignal.timeout(15000) })
  if (!response.ok) {
    // Provider or proxy diagnostics may contain credentials. Only expose a
    // bounded status; a model request is never replayed by this client.
    if (response.status === 401) throw new SignInRequired("AgentOS sign-in expired or was revoked. Run `/login` in the terminal or `agentos-code login`.")
    if (response.status === 402) throw new Error("Your AgentOS workspace is out of credits. Open Usage in AgentOS.")
    if (response.status === 403) throw new Error("Your AgentOS account does not have permission for this action.")
    if (response.status === 404) throw new Error("This AgentOS server needs the AgentOS Code API update.")
    throw new Error(`AgentOS request failed (HTTP ${response.status}).`)
  }
  return response.json()
}

export function authenticated(value: Credential, endpoint: string, method = "GET") {
  return jsonRequest(value.url + endpoint, { method, headers: { Authorization: "Bearer " + value.token } })
}

export async function account(value: Credential) {
  return Account.parse(await authenticated(value, "/inference/v1/account"))
}

const Metadata = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  code_challenge_methods_supported: z.array(z.string()),
})

export async function login(input: {
  url: string
  open: (url: string) => Promise<void>
  signal?: AbortSignal
}) {
  const url = apiURL(input.url)
  const origin = new URL(url).origin
  const metadata = Metadata.parse(await jsonRequest(origin + "/.well-known/oauth-authorization-server"))
  if (!metadata.code_challenge_methods_supported.includes("S256")) throw new Error("AgentOS sign-in requires PKCE S256.")
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
    if (new URL(endpoint).origin !== origin) throw new Error("AgentOS sign-in metadata points to another server.")
  }
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const state = randomBytes(32).toString("hex")
  const signal = input.signal || AbortSignal.timeout(300000)
  const pending = Promise.withResolvers<string>()
  // Attach the rejection handler before a browser or abort can settle it.
  void pending.promise.catch(() => {})
  const abort = () => pending.reject(new Error("AgentOS sign-in timed out or was cancelled."))
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const callback = new URL(request.url)
      if (request.method !== "GET" || callback.pathname !== "/callback") return new Response("Not found", { status: 404 })
      const given = callback.searchParams.get("state") || ""
      if (Buffer.byteLength(given) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(given), Buffer.from(state))) {
        return new Response("Invalid sign-in state", { status: 400 })
      }
      const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
      if (callback.searchParams.has("error")) {
        pending.reject(new Error("AgentOS sign-in was declined."))
        return new Response("Sign-in declined. Return to your terminal.", { headers })
      }
      const code = callback.searchParams.get("code")
      if (!code) return new Response("Missing authorization code", { status: 400, headers })
      pending.resolve(code)
      return new Response("AgentOS sign-in received. You can return to your terminal.", { headers })
    },
  })
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    const redirect = `http://127.0.0.1:${server.port}/callback`
    const registration = z.object({ client_id: z.string() }).parse(await jsonRequest(metadata.registration_endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ client_name: "AgentOS Code", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    }))
    const authorization = new URL(metadata.authorization_endpoint)
    authorization.search = new URLSearchParams({
      client_id: registration.client_id, redirect_uri: redirect, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256", state,
    }).toString()
    await input.open(authorization.href)
    const code = await pending.promise
    const result = z.object({ access_token: z.string().startsWith("agentos_pat_"), token_type: z.literal("Bearer") }).parse(
      await jsonRequest(metadata.token_endpoint, {
        method: "POST", signal,
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id,
          code, code_verifier: verifier, redirect_uri: redirect }),
      }),
    )
    return { url, token: result.access_token }
  } finally {
    signal.removeEventListener("abort", abort)
    await server.stop(true)
  }
}
