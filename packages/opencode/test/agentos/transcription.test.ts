import { afterEach, expect, test } from "bun:test"
import { transcribe } from "../../src/agentos/transcription"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)))

test("uploads audio with the saved login and disables task reconciliation", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/desktop/dictation")
      expect(new URL(request.url).searchParams.get("reconcile_tasks")).toBe("false")
      expect(request.headers.get("Authorization")).toBe("Bearer agentos_pat_test")
      expect(request.headers.get("X-AgentOS-Dictation-ID")).toBe("test-recording")
      // Bun infers the parsed File type from its extension; verify the transmitted MIME.
      expect(await request.clone().text()).toContain("Content-Type: audio/webm\r\n")
      const audio = (await request.formData()).get("audio") as File
      expect(await audio.text()).toBe("test audio")
      return Response.json({ text: "  Fix the tests.  ", task: null })
    },
  })
  servers.push(server)
  const result = await transcribe(
    { url: server.url.origin, token: "agentos_pat_test" },
    new TextEncoder().encode("test audio"),
    "audio/webm;codecs=opus",
    "test-recording",
  )
  expect(result).toEqual({ ok: true, text: "Fix the tests." })
})

test("keeps provider diagnostics and credentials out of transcription failures", async () => {
  for (const [status, reason] of [
    [401, "auth"],
    [402, "credits"],
    [422, "empty"],
    [500, "failed"],
  ] as const) {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("private provider diagnostics", { status }),
    })
    servers.push(server)
    expect(
      await transcribe(
        { url: server.url.origin, token: "agentos_pat_test" },
        new Uint8Array([1]),
        "audio/wav",
        "test-recording",
      ),
    ).toEqual({ ok: false, reason })
  }
})

test("rejects empty audio, non-audio content, oversize audio and unsafe IDs before upload", async () => {
  const credential = { url: "http://127.0.0.1:1", token: "agentos_pat_test" }
  for (const [audio, type, id] of [
    [new Uint8Array(), "audio/wav", "test"],
    [new Uint8Array([1]), "text/plain", "test"],
    [new Uint8Array(25 * 1024 * 1024 + 1), "audio/wav", "test"],
    [new Uint8Array([1]), "audio/wav", "bad\r\nid"],
  ] as const) {
    expect(await transcribe(credential, audio, type, id)).toEqual({ ok: false, reason: "invalid" })
  }
})
