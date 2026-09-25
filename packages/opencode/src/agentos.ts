import { rm } from "node:fs/promises"
import { parseArgs } from "node:util"
import { account, authenticated, credentialPath, loadCredential, SignInRequired } from "./agentos/account"
import { applySession, isInteractive, requireAccount, savedAccountPath, signIn } from "./agentos/session"

process.env.AGENTOS_CODE = "1"
const args = process.argv.slice(2)
const browserLogin = args[0] === "serve" && args.includes("--login")
if (browserLogin) {
  const index = args.indexOf("--login")
  args.splice(index, 1)
  process.argv.splice(index + 2, 1)
}
if (process.env.AGENTOS_API_TOKEN) process.env.AGENTOS_CODE_EXTERNAL_TOKEN = "1"
else delete process.env.AGENTOS_CODE_EXTERNAL_TOKEN

async function openSignIn(url: string, noBrowser = false) {
  console.log("Sign in to AgentOS to start coding:\n" + url)
  if (noBrowser) return
  const { default: open } = await import("open")
  await open(url).catch(() => console.log("Open the link above in your browser to finish signing in."))
}

try {
  if (args[0] === "login") {
    const options = parseArgs({
      args: args.slice(1),
      options: { url: { type: "string" }, "no-browser": { type: "boolean" } },
    })
    const session = await signIn({
      url: options.values.url || process.env.AGENTOS_URL || "https://tryagentos.net",
      async open(url) {
        await openSignIn(url, options.values["no-browser"])
      },
    })
    const result = session.details
    console.log(
      `Signed in as ${result.user.email}\nWorkspace: ${result.workspace.name}\nCredits: ${result.credits.balance}`,
    )
  } else if (args[0] === "logout") {
    const options = parseArgs({ args: args.slice(1), options: { local: { type: "boolean" } } })
    if (process.env.AGENTOS_API_TOKEN)
      throw new Error("This session uses AGENTOS_API_TOKEN. Unset it to sign out; revoke it in AgentOS Settings.")
    if (!options.values.local) {
      const credential = await loadCredential()
      const result = await account(credential)
      await authenticated(credential, "/access-tokens/" + encodeURIComponent(result.token.id), "DELETE")
    }
    await rm(credentialPath(), { force: true })
    await rm(savedAccountPath(), { force: true })
    console.log(
      options.values.local
        ? "Local login removed. The token can still be revoked in AgentOS Settings."
        : "Signed out. The AgentOS token was revoked.",
    )
  } else if (args[0] === "live-bridge") {
    const { liveBridge } = await import("./agentos/live")
    await liveBridge()
  } else if (args[0] === "transcribe") {
    const { transcribe, MAX_AUDIO_BYTES } = await import("./agentos/transcription")
    const options = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        stdin: { type: "boolean" },
        type: { type: "string", default: "audio/webm" },
        id: { type: "string" },
      },
    })
    const file = options.values.stdin ? Bun.stdin : Bun.file(options.positionals[0] || "")
    if (!options.values.stdin && file.size > MAX_AUDIO_BYTES) throw new Error("The recording is too large.")
    const data = await file.bytes()
    const result = await loadCredential()
      .then((credential) =>
        transcribe(credential, data, options.values.type!, options.values.id || crypto.randomUUID()),
      )
      .catch((error) => ({ ok: false, reason: error instanceof SignInRequired ? "auth" : "failed" }))
    console.log(JSON.stringify(result))
  } else if (args[0] === "usage" || args[0] === "whoami") {
    const options = parseArgs({ args: args.slice(1), options: { json: { type: "boolean" } } })
    const result = await account(await loadCredential())
    if (options.values.json) console.log(JSON.stringify(result, null, 2))
    else
      console.log(
        `${result.user.email}\nWorkspace: ${result.workspace.name}\nPlan: ${result.credits.plan}\nCredits remaining: ${result.credits.balance}\nCredits used this period: ${result.credits.spent_this_period}`,
      )
  } else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(`OmniCode — coding with your AgentOS account

  omnicode login [--url URL] [--no-browser]
  omnicode whoami [--json]
  omnicode usage [--json]
  omnicode logout [--local]
  omnicode [directory]               Open the coding terminal
  omnicode run "your task"           Run a coding task
  omnicode run --format json "task"  Stream events for AgentOS
  omnicode serve [--login]          Start the API; --login opens browser sign-in if needed
  omnicode transcribe FILE --type audio/wav  Transcribe audio into text
  omnicode models                   List AgentOS coding models

Use AGENTOS_MODEL to choose a model. AgentOS handles usage and credits.
Opening the terminal starts browser sign-in if needed. Inside it, use /login, /usage, or /logout.
Hosted runs can use AGENTOS_API_TOKEN and AGENTOS_URL without browser login.
Append --help to a command for its options.`)
  } else if (["upgrade", "uninstall", "providers", "debug", "auth"].includes(args[0])) {
    throw new Error("Use `omnicode login` for authentication. Install and update OmniCode from devvcore/agentos-code.")
  } else {
    if (["serve", "web"].includes(args[0]) && !process.env.OPENCODE_SERVER_PASSWORD) {
      throw new Error("Set OPENCODE_SERVER_PASSWORD before starting the OmniCode server.")
    }
    // Set the account before importing any runtime module: global paths and
    // worker environment are captured during OpenCode module initialization.
    if (!args.includes("--help") && !args.includes("-h") && !args.includes("--version") && !args.includes("-v")) {
      applySession(await requireAccount({ interactive: browserLogin || (await isInteractive(args)), open: openSignIn }))
    }
    await import("./index")
  }
} catch (error) {
  // Validation errors can echo the offending value, including an auth token.
  console.error(
    error instanceof Error && error.name !== "ZodError" ? error.message : "AgentOS returned an invalid response.",
  )
  process.exitCode = 1
}
