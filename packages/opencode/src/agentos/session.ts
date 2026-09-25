import path from "node:path"
import { createHash } from "node:crypto"
import { chmod, rm, stat } from "node:fs/promises"
import { z } from "zod"
import {
  Account,
  account,
  apiURL,
  authenticated,
  credentialPath,
  loadCredential,
  login,
  saveCredential,
  SignInRequired,
  Unavailable,
  type Credential,
} from "./account"
import { catalog, configuration, Models } from "./config"

export type PreparedAccount = Awaited<ReturnType<typeof prepare>>

// Each startup check gets this long; together they stay well inside a run's budget.
export const STARTUP_TIMEOUT = 8000

// The last account and model list AgentOS verified for this login. When AgentOS is slow or down at startup,
// the session starts from it instead of failing; model calls still go to AgentOS and are still billed there.
const Saved = z.object({ fingerprint: z.string(), url: z.string(), details: Account, catalog: Models })

export function savedAccountPath() {
  return path.join(path.dirname(credentialPath()), "account-cache.json")
}

function fingerprint(credential: Credential) {
  return createHash("sha256").update(credential.url + "\n" + credential.token).digest("hex")
}

async function prepare(credential: Credential) {
  const model = (details: z.infer<typeof Account>) => process.env.AGENTOS_MODEL || details.default_model
  try {
    const details = await account(credential, STARTUP_TIMEOUT)
    const models = await catalog(credential, STARTUP_TIMEOUT)
    const config = JSON.stringify(await configuration(credential, model(details), models))
    const file = savedAccountPath()
    const saved = { fingerprint: fingerprint(credential), url: credential.url, details, catalog: models }
    await Bun.write(file, JSON.stringify(saved) + "\n", { mode: 0o600 })
      .then(() => chmod(file, 0o600))
      .catch(() => {})
    return { credential, details, config }
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error
    const saved = Saved.safeParse(await Bun.file(savedAccountPath()).json().catch(() => undefined))
    if (!saved.success || saved.data.fingerprint !== fingerprint(credential)) throw error
    console.error(`${error.message} Starting with the account and models AgentOS last confirmed.`)
    const config = JSON.stringify(await configuration(credential, model(saved.data.details), saved.data.catalog))
    return { credential, details: saved.data.details, config }
  }
}

export async function signIn(input: Parameters<typeof login>[0]) {
  const result = await prepare(await login(input))
  input.signal?.throwIfAborted()
  // An OAuth token is not a usable coding account until its account and model
  // catalog have both been verified. Keep the previous login on failure.
  await saveCredential(result.credential)
  return result
}

export async function requireAccount(input: { interactive: boolean; open: (url: string) => Promise<void> }) {
  const credential = await loadCredential().catch((error) => {
    if (!(error instanceof SignInRequired) || !input.interactive) throw error
  })
  if (credential) {
    try {
      return await prepare(credential)
    } catch (error) {
      if (!(error instanceof SignInRequired) || !input.interactive || process.env.AGENTOS_API_TOKEN) throw error
    }
  }
  return signIn({ url: credential?.url || process.env.AGENTOS_URL || "https://tryagentos.net", open: input.open })
}

export function applySession(result: PreparedAccount) {
  process.env.AGENTOS_API_TOKEN = result.credential.token
  process.env.AGENTOS_URL = apiURL(result.credential.url)
  process.env.AGENTOS_CODE_CONFIG = result.config
  process.env.OPENCODE_CONFIG_CONTENT = result.config
  process.env.OPENCODE_DISABLE_CLAUDE_CODE = "true"
  process.env.OPENCODE_PURE = "1"
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "true"
  process.env.OPENCODE_DISABLE_SHARE = "true"
}

export async function isInteractive(args: string[]) {
  if (!process.stdin.isTTY) return false
  if (!args[0] || args[0].startsWith("-")) return true
  return (await stat(args[0]).catch(() => undefined))?.isDirectory() ?? false
}

export function terminalAccount(reload: (result: PreparedAccount) => Promise<void>) {
  return {
    get url() {
      return process.env.AGENTOS_URL || "https://tryagentos.net"
    },
    async usage() {
      const result = await account(await loadCredential())
      return `${result.user.email}\nWorkspace: ${result.workspace.name}\nPlan: ${result.credits.plan}\nCredits remaining: ${result.credits.balance}\nCredits used this period: ${result.credits.spent_this_period}`
    },
    async login(input: { url: string; onURL: (url: string) => void; signal: AbortSignal }) {
      if (process.env.AGENTOS_CODE_EXTERNAL_TOKEN)
        throw new Error(
          "This session uses AGENTOS_API_TOKEN. Unset it and restart OmniCode to use browser sign-in.",
        )
      const result = await signIn({
        ...input,
        async open(url) {
          input.onURL(url)
          const { default: open } = await import("open")
          await open(url).catch(() => {})
        },
      })
      await reload(result)
      applySession(result)
      return `Signed in as ${result.details.user.email}\nWorkspace: ${result.details.workspace.name}\nCredits remaining: ${result.details.credits.balance}`
    },
    async logout() {
      if (process.env.AGENTOS_CODE_EXTERNAL_TOKEN)
        throw new Error("This session uses AGENTOS_API_TOKEN. Unset it and revoke it in AgentOS Settings.")
      const credential = await loadCredential()
      try {
        const result = await account(credential)
        await authenticated(credential, "/access-tokens/" + encodeURIComponent(result.token.id), "DELETE")
      } catch (error) {
        if (!(error instanceof SignInRequired)) throw error
      }
      await rm(credentialPath(), { force: true })
      await rm(savedAccountPath(), { force: true })
    },
  }
}
