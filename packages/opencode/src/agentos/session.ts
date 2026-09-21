import { rm, stat } from "node:fs/promises"
import {
  account,
  apiURL,
  authenticated,
  credentialPath,
  loadCredential,
  login,
  saveCredential,
  SignInRequired,
} from "./account"
import { configuration } from "./config"

export type PreparedAccount = Awaited<ReturnType<typeof prepare>>

async function prepare(credential: Awaited<ReturnType<typeof loadCredential>>) {
  const details = await account(credential)
  const config = JSON.stringify(await configuration(credential, process.env.AGENTOS_MODEL || details.default_model))
  return { credential, details, config }
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
    },
  }
}
