import { createInterface } from "node:readline"
import { z } from "zod"
import { loadCredential, SignInRequired } from "./account"

const Request = z.object({
  sequence: z.number().int().nonnegative(),
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("start"), sdp: z.string().min(1).max(64000), context: z.string().max(12000) }),
    z.object({ action: z.enum(["status", "end"]), id: z.string().min(1).max(160) }),
  ]),
})
const Reply = z.object({
  id: z.string(),
  sdp: z.string().optional(),
  machineId: z.string().optional(),
  phase: z.string().optional(),
  error: z.string().nullable().optional(),
})

export async function liveBridge() {
  // A single private process owns credentials and instance affinity throughout
  // the call. The renderer can only start/read/end calls it created here.
  const calls = new Map<string, string>()
  const credential = await loadCredential().catch(() => undefined)
  const request = async (id: string | undefined, method: string, body?: unknown) => {
    if (!credential) throw new SignInRequired()
    const machine = id ? calls.get(id) : undefined
    const response = await fetch(credential.url + "/code/live" + (id ? "/" + encodeURIComponent(id) : ""), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(method === "POST" ? 50000 : 15000),
      headers: {
        Authorization: "Bearer " + credential.token,
        "Content-Type": "application/json",
        ...(machine ? { "fly-force-instance-id": machine } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok)
      return {
        ok: false as const,
        reason:
          response.status === 401
            ? ("auth" as const)
            : response.status === 402
              ? ("credits" as const)
              : response.status === 409
                ? ("conflict" as const)
                : ("failed" as const),
      }
    const data = Reply.parse(await response.json())
    if (method === "POST") calls.set(data.id, data.machineId || "")
    if (method === "DELETE" || data.phase === "ended" || data.phase === "failed") calls.delete(data.id)
    return { ok: true as const, id: data.id, sdp: data.sdp, phase: data.phase, error: data.error }
  }
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.length > 100000) break
      const parsed = Request.safeParse(JSON.parse(line))
      if (!parsed.success) break
      const { sequence, input } = parsed.data
      const result = await (async () => {
        if (input.action === "start") {
          if (calls.size) return { ok: false, reason: "conflict" }
          return request(undefined, "POST", { sdp: input.sdp, context: input.context })
        }
        if (!calls.has(input.id)) return { ok: false, reason: "failed" }
        return request(input.id, input.action === "end" ? "DELETE" : "GET")
      })().catch((error) => ({ ok: false, reason: error instanceof SignInRequired ? "auth" : "failed" }))
      console.log(JSON.stringify({ sequence, result }))
    }
  } finally {
    await Promise.allSettled([...calls.keys()].map((id) => request(id, "DELETE")))
  }
}
