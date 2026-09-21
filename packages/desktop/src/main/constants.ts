import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const AGENTOS_CODE = import.meta.env.AGENTOS_CODE === "1"
export const UPDATER_ENABLED = !AGENTOS_CODE && app.isPackaged && CHANNEL !== "dev"
