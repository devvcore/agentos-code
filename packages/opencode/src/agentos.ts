import { rm } from "node:fs/promises"
import { parseArgs } from "node:util"
import { account, apiURL, authenticated, credentialPath, loadCredential, login, saveCredential } from "./agentos/account"
import { configuration } from "./agentos/config"

process.env.AGENTOS_CODE = "1"
const args = process.argv.slice(2)

try {
  if (args[0] === "login") {
    const options = parseArgs({ args: args.slice(1), options: { url: { type: "string" }, "no-browser": { type: "boolean" } } })
    const credential = await login({
      url: options.values.url || process.env.AGENTOS_URL || "https://tryagentos.net",
      async open(url) {
        console.log("Sign in to AgentOS:\n" + url)
        if (options.values["no-browser"]) return
        const { default: open } = await import("open")
        await open(url).catch(() => console.log("Open the link above in your browser to finish signing in."))
      },
    })
    await saveCredential(credential)
    const result = await account(credential)
    console.log(`Signed in as ${result.user.email}\nWorkspace: ${result.workspace.name}\nCredits: ${result.credits.balance}`)
  } else if (args[0] === "logout") {
    const options = parseArgs({ args: args.slice(1), options: { local: { type: "boolean" } } })
    if (process.env.AGENTOS_API_TOKEN) throw new Error("This session uses AGENTOS_API_TOKEN. Unset it to sign out; revoke it in AgentOS Settings.")
    if (!options.values.local) {
      const credential = await loadCredential()
      const result = await account(credential)
      await authenticated(credential, "/access-tokens/" + encodeURIComponent(result.token.id), "DELETE")
    }
    await rm(credentialPath(), { force: true })
    console.log(options.values.local ? "Local login removed. The token can still be revoked in AgentOS Settings." : "Signed out. The AgentOS token was revoked.")
  } else if (args[0] === "usage" || args[0] === "whoami") {
    const options = parseArgs({ args: args.slice(1), options: { json: { type: "boolean" } } })
    const result = await account(await loadCredential())
    if (options.values.json) console.log(JSON.stringify(result, null, 2))
    else console.log(`${result.user.email}\nWorkspace: ${result.workspace.name}\nPlan: ${result.credits.plan}\nCredits remaining: ${result.credits.balance}\nCredits used this period: ${result.credits.spent_this_period}`)
  } else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(`AgentOS Code — coding with your AgentOS account

  agentos-code login [--url URL] [--no-browser]
  agentos-code whoami [--json]
  agentos-code usage [--json]
  agentos-code logout [--local]
  agentos-code [directory]               Open the coding terminal
  agentos-code run "your task"           Run a coding task
  agentos-code run --format json "task"  Stream events for AgentOS
  agentos-code serve                    Start the headless API
  agentos-code models                   List AgentOS coding models

Use AGENTOS_MODEL to choose a model. AgentOS handles usage and credits.
Hosted runs can use AGENTOS_API_TOKEN and AGENTOS_URL without browser login.
Append --help to an OpenCode command for its options.`)
  } else if (["upgrade", "uninstall", "providers", "debug", "auth"].includes(args[0])) {
    throw new Error("Use `agentos-code login` for authentication. Install and update AgentOS Code from devvcore/agentos-code.")
  } else {
    if (["serve", "web"].includes(args[0]) && !process.env.OPENCODE_SERVER_PASSWORD) {
      throw new Error("Set OPENCODE_SERVER_PASSWORD before starting the AgentOS Code server.")
    }
    // Set the account before importing any runtime module: global paths and
    // worker environment are captured during OpenCode module initialization.
    if (!args.includes("--help") && !args.includes("-h") && !args.includes("--version") && !args.includes("-v")) {
      const credential = await loadCredential()
      const result = await account(credential)
      process.env.AGENTOS_API_TOKEN = credential.token
      process.env.AGENTOS_URL = apiURL(credential.url)
      process.env.AGENTOS_CODE_CONFIG = JSON.stringify(await configuration(credential, process.env.AGENTOS_MODEL || result.default_model))
      process.env.OPENCODE_CONFIG_CONTENT = process.env.AGENTOS_CODE_CONFIG
      process.env.OPENCODE_DISABLE_CLAUDE_CODE = "true"
      process.env.OPENCODE_PURE = "1"
      process.env.OPENCODE_DISABLE_AUTOUPDATE = "true"
      process.env.OPENCODE_DISABLE_SHARE = "true"
    }
    await import("./index")
  }
} catch (error) {
  // Validation errors can echo the offending value, including an auth token.
  console.error(error instanceof Error && error.name !== "ZodError" ? error.message : "AgentOS returned an invalid response.")
  process.exitCode = 1
}
