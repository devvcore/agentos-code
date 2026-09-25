// Piped stdin for `run` and the terminal. Without a message, stdin is the prompt, so it is read to EOF.
// With a message, stdin is optional extra context: agent harnesses and CI runners often hand the CLI a pipe
// that is never written to or closed, and waiting for its EOF hangs the command before a session exists.
// Only wait `wait` ms for the first chunk; once data arrives, read the rest to EOF.
export const PIPED_STDIN_WAIT_MS = 1000

export async function readPipedStdin(input: {
  required: boolean
  wait?: number
  stdin?: { isTTY?: boolean }
  stream?: () => ReadableStream<Uint8Array>
}) {
  if ((input.stdin ?? process.stdin).isTTY) return
  const reader = (input.stream ?? (() => Bun.stdin.stream()))().getReader()
  const timer = Promise.withResolvers<undefined>()
  const timeout = input.required
    ? undefined
    : setTimeout(() => timer.resolve(undefined), input.wait ?? PIPED_STDIN_WAIT_MS)
  const first = await Promise.race([reader.read(), timer.promise])
  clearTimeout(timeout)
  if (!first) {
    // Stop polling stdin so the unclosed pipe cannot keep the process alive.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    return
  }
  const chunks: Uint8Array[] = []
  for (let next = first; !next.done; next = await reader.read()) chunks.push(next.value)
  reader.releaseLock()
  return Buffer.concat(chunks).toString()
}
