export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}

// With custom agents hidden the app only exposes the Code (build) and Work (work) modes.
export function selectAgent<T extends { name: string }>(items: T[], name: string | undefined, visible: boolean) {
  return resolveAgent(items, visible || name === "work" ? name : "build")
}

export function hasWorkAgent(items: Array<{ name: string }>) {
  return items.some((item) => item.name === "work")
}

// The AgentOS build pins Omniwork's model (GLM 5.3 Flash) and the server enforces it, so Work mode shows no model or variant picker.
export function pinnedModel<T>(agent: { name: string; model?: T } | undefined) {
  return agent?.name === "work" ? agent.model : undefined
}
