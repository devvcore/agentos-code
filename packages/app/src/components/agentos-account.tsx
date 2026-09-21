import { createResource, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

export function AgentOSAccountDialog() {
  const language = useLanguage()
  return (
    <Dialog title={language.t("agentos.account.title")}>
      <div class="p-6">
        <AgentOSAccountPanel />
      </div>
    </Dialog>
  )
}

export function AgentOSAccountPanel() {
  const platform = usePlatform()
  const language = useLanguage()
  const [state, setState] = createStore({ busy: false, failed: false })
  const [account, { refetch }] = createResource(() => platform.agentos!.account().catch(() => null))
  const signOut = async () => {
    setState({ busy: true, failed: false })
    await platform.agentos!.logout().catch(() => setState({ busy: false, failed: true }))
  }
  return (
    <div class="flex flex-col gap-5 max-w-[720px]" data-component="agentos-account">
      <h2 class="text-16-medium text-text-strong">{language.t("agentos.account.title")}</h2>
      <Show
        when={account()}
        fallback={
          <p role="status" class="text-14-regular text-text-weak">
            {language.t(account.loading ? "agentos.account.loading" : "agentos.account.error")}
          </p>
        }
      >
        {(value) => (
          <>
            <div>
              <div class="text-14-medium text-text-strong">{value().user.name}</div>
              <div class="text-14-regular text-text-weak">{value().user.email}</div>
            </div>
            <dl class="grid grid-cols-2 gap-x-6 gap-y-4 text-14-regular">
              <dt>{language.t("agentos.account.workspace")}</dt>
              <dd>{value().workspace.name}</dd>
              <dt>{language.t("agentos.account.credits")}</dt>
              <dd>{value().credits.balance.toLocaleString()}</dd>
              <dt>{language.t("agentos.account.used")}</dt>
              <dd>{value().credits.spent_this_period.toLocaleString()}</dd>
              <dt>{language.t("agentos.account.plan")}</dt>
              <dd>{value().credits.plan}</dd>
            </dl>
          </>
        )}
      </Show>
      <div class="flex flex-wrap gap-3">
        <Button onClick={() => platform.openExternal("https://tryagentos.net")}>
          {language.t("agentos.account.manage")}
        </Button>
        <Button variant="secondary" disabled={account.loading} onClick={() => void refetch()}>
          {language.t("agentos.account.refresh")}
        </Button>
      </div>
      <div class="border-t border-border-weak-base pt-5 flex flex-col gap-3 items-start">
        <p class="text-12-regular text-text-weak">{language.t("agentos.account.signOutNote")}</p>
        <Button variant="secondary" disabled={state.busy} onClick={() => void signOut()}>
          {language.t("agentos.account.signOut")}
        </Button>
        <Show when={state.failed}>
          <p role="alert" class="text-14-regular text-text-weak">
            {language.t("agentos.account.signOutError")}
          </p>
        </Show>
      </div>
    </div>
  )
}
