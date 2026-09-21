import { z } from "zod"
import { authenticated, type Credential } from "./account"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

export function applyAccountConfig(config: ConfigV1.Info, account: ConfigV1.Info): ConfigV1.Info {
  // Replace the provider, including per-model endpoints. Deep-merging lets a
  // repository config redirect the workspace credential to another server.
  return {
    ...config, provider: account.provider, enabled_providers: ["agentos"], disabled_providers: [],
    model: config.model?.startsWith("agentos/") ? config.model : account.model,
    small_model: account.small_model, share: "disabled", autoshare: false, autoupdate: false,
    mcp: { ...config.mcp, agentos: account.mcp!.agentos },
  }
}

export const Models = z.object({ data: z.array(z.object({
  id: z.string(), name: z.string(), context_length: z.number().positive(), max_output_tokens: z.number().positive(),
  input_modalities: z.array(z.string()), output_modalities: z.array(z.string()), supported_parameters: z.array(z.string()),
})) })

export async function configuration(credential: Credential, model: string) {
  const catalog = Models.parse(await authenticated(credential, "/inference/v1/models"))
  const models = catalog.data.filter((entry) => entry.supported_parameters.includes("tools") && entry.output_modalities.includes("text"))
  if (!models.some((entry) => entry.id === model)) {
    throw new Error(`The AgentOS model '${model}' is not available for coding. Choose one with AGENTOS_MODEL.`)
  }
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["agentos"],
    model: "agentos/" + model,
    small_model: "agentos/" + model,
    autoupdate: false,
    share: "disabled" as const,
    provider: {
      agentos: {
        name: "AgentOS", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: credential.url + "/inference/v1", apiKey: "{env:AGENTOS_API_TOKEN}", includeUsage: true },
        models: Object.fromEntries(models.map((entry) => [entry.id, {
          id: entry.id, name: entry.name, tool_call: true,
          reasoning: entry.supported_parameters.includes("reasoning"),
          attachment: entry.input_modalities.includes("image"),
          limit: { context: entry.context_length, output: entry.max_output_tokens },
          modalities: { input: entry.input_modalities.filter((x): x is "text" | "image" | "audio" | "video" | "pdf" => ["text", "image", "audio", "video", "pdf"].includes(x)), output: ["text" as const] },
        }])),
      },
    },
    mcp: { agentos: { type: "remote" as const, url: credential.url + "/mcp", oauth: false as const,
      headers: { Authorization: "Bearer {env:AGENTOS_API_TOKEN}" } } },
  }
}
