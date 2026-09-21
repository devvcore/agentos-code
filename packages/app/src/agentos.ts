export type AgentOSAccount = {
  user: { name: string; email: string }
  workspace: { name: string }
  credits: { balance: number; spent_this_period: number; plan: string }
}

export type AgentOSStartup = {
  state: "starting" | "signing-in" | "ready" | "error"
  signInURL?: string
}
