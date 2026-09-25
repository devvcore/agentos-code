import { expect, test } from "bun:test"
import { readPipedStdin } from "../../src/cli/stdin"

const piped = { isTTY: false }
// A pipe the parent never writes to or closes, as agent harnesses and CI runners hand out.
const open = () => new ReadableStream<Uint8Array>({ start() {} })
const text = (value: string, delay = 0) => () =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      await Bun.sleep(delay)
      controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })

test("a message with a silent, unclosed stdin pipe does not wait for EOF", async () => {
  const started = Date.now()
  expect(await readPipedStdin({ required: false, wait: 50, stdin: piped, stream: open })).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(1000)
})

test("piped context that starts in time is read to EOF", async () => {
  expect(await readPipedStdin({ required: false, wait: 200, stdin: piped, stream: text("context", 20) })).toBe(
    "context",
  )
})

test("without a message, stdin is the prompt and is always read", async () => {
  expect(await readPipedStdin({ required: true, wait: 10, stdin: piped, stream: text("prompt", 100) })).toBe("prompt")
})

test("a terminal is never read", async () => {
  expect(await readPipedStdin({ required: true, stdin: { isTTY: true }, stream: open })).toBeUndefined()
})
