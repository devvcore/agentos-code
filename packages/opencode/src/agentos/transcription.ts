import type { Credential } from "./account"

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024
export const audioTypes = new Map([
  ["audio/webm", "webm"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
])

export async function transcribe(credential: Credential, audio: Uint8Array, type: string, id: string) {
  const mime = type.split(";")[0].trim().toLowerCase()
  const extension = audioTypes.get(mime)
  if (!extension || !audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) {
    return { ok: false as const, reason: "invalid" as const }
  }
  const body = new FormData()
  body.set("audio", new Blob([new Uint8Array(audio)], { type: mime }), `dictation.${extension}`)
  const response = await fetch(credential.url + "/desktop/dictation?reconcile_tasks=false", {
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${credential.token}`, "X-AgentOS-Dictation-ID": id },
  })
  if (!response.ok) {
    const reason =
      response.status === 401
        ? "auth"
        : response.status === 402
          ? "credits"
          : response.status === 422
            ? "empty"
            : "failed"
    return { ok: false as const, reason }
  }
  const result = (await response.json()) as { text?: unknown }
  if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 50_000) {
    return { ok: false as const, reason: "empty" as const }
  }
  return { ok: true as const, text: result.text.trim() }
}
