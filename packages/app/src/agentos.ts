export type AgentOSAccount = {
  user: { name: string; email: string }
  workspace: { name: string }
  credits: { balance: number; spent_this_period: number; plan: string }
}

export type AgentOSStartup = {
  state: "starting" | "signing-in" | "ready" | "error"
  signInURL?: string
}

export type AgentOSDictation = { audio: ArrayBuffer; type: string; id: string }
export type AgentOSDictationResult =
  | { ok: true; text: string }
  | { ok: false; reason: "auth" | "credits" | "empty" | "invalid" | "failed" }
