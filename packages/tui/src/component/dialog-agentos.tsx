import { createSignal, onCleanup, Show } from "solid-js"
import { useAgentOS } from "../context/agentos"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useClipboard } from "../context/clipboard"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogAlert } from "../ui/dialog-alert"
import { useDialog } from "../ui/dialog"
import { Link } from "../ui/link"
import { useBindings } from "../keymap"

export function agentosError(error: unknown) {
  return error instanceof Error && error.name !== "ZodError" ? error.message : "AgentOS returned an invalid response."
}

export function DialogAgentOSLogin() {
  const account = useAgentOS()!
  const dialog = useDialog()
  const sync = useSync()
  const clipboard = useClipboard()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)
  const [url, setURL] = createSignal("")
  const [error, setError] = createSignal("")
  const [copied, setCopied] = createSignal(false)
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  async function copy() {
    try {
      if (!clipboard.write) throw new Error("Clipboard unavailable")
      await clipboard.write(url())
      setCopied(true)
    } catch {
      setError("Could not copy the link.")
    }
  }
  useBindings(() => ({
    enabled: busy() && Boolean(url()),
    bindings: [{ key: "c", desc: "Copy sign-in link", group: "Dialog", cmd: copy }],
  }))

  return (
    <DialogPrompt
      title="Sign in to AgentOS"
      value={account.url}
      busy={busy()}
      busyText="Waiting for browser sign-in…"
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>Press Enter to sign in with your AgentOS account.</text>
          <Show when={url()}>
            <Link href={url()}>Open sign-in in your browser</Link>
            <text fg={theme.primary} onMouseUp={copy}>
              {copied() ? "Sign-in link copied" : "c Copy sign-in link"}
            </text>
          </Show>
          <Show when={error()}>
            <text fg={theme.error}>{error()}</text>
          </Show>
        </box>
      )}
      onConfirm={async (value) => {
        if (Object.values(sync.data.session_status).some((status) => status.type !== "idle")) {
          setError("Stop the running task before switching accounts.")
          return
        }
        setBusy(true)
        setError("")
        setCopied(false)
        try {
          const message = await account.login({ url: value.trim(), onURL: setURL, signal: controller.signal })
          if (controller.signal.aborted) return
          dialog.replace(() => <DialogAlert title="Signed in to AgentOS" message={message} />)
        } catch (error) {
          if (controller.signal.aborted) return
          setError(agentosError(error))
        } finally {
          setBusy(false)
          setURL("")
        }
      }}
    />
  )
}
