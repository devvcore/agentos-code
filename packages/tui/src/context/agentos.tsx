import { createContext, type JSX, useContext } from "solid-js"

export type AgentOSAccount = {
  url: string
  usage(): Promise<string>
  login(input: { url: string; onURL: (url: string) => void; signal: AbortSignal }): Promise<string>
  logout(): Promise<void>
}

const context = createContext<AgentOSAccount>()

export function AgentOSProvider(props: { value?: AgentOSAccount; children: JSX.Element }) {
  return <context.Provider value={props.value}>{props.children}</context.Provider>
}

export function useAgentOS() {
  return useContext(context)
}
