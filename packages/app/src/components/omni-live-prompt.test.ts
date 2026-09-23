import { expect, test } from "bun:test"
import { liveDelegationPrompt, type LiveCaption } from "./omni-live-prompt"

const caption = (input: Partial<LiveCaption> & Pick<LiveCaption, "role" | "text">): LiveCaption => ({
  start: 0,
  end: 100,
  sealed: false,
  ...input,
})

test("turns fragmented speech into one contextual coding prompt", () => {
  const first = caption({ role: "user", text: "Build a mental load app" })
  const second = caption({ role: "user", text: "for couples and families", start: 110, end: 240 })
  const correction = caption({ role: "user", text: "Make it React Native, not an AgentOS app.", start: 360, end: 500 })
  const result = liveDelegationPrompt({
    captions: [
      first,
      second,
      caption({ role: "assistant", text: "I will get started.", start: 250, end: 350 }),
      correction,
    ],
    offset: 500,
  })

  expect(result?.captions).toEqual([first, second, correction])
  expect(result?.text).toContain("You: Build a mental load app for couples and families")
  expect(result?.text).toContain("OmniCode: I will get started.")
  expect(result?.text).toContain("Make it React Native, not an AgentOS app.")
  expect(result?.text).toContain("instead of treating transcript fragments as separate prompts")
})

test("uses the delegation offset and does not resend accepted speech", () => {
  const accepted = caption({ role: "user", text: "Start the app", sealed: true })
  const correction = caption({ role: "user", text: "Use React Native", start: 900, end: 1000 })
  const future = caption({ role: "user", text: "This belongs to the next request", start: 1900, end: 2000 })
  const result = liveDelegationPrompt({ captions: [accepted, correction, future], offset: 1000 })

  expect(result?.captions).toEqual([correction])
  expect(result?.text).toContain("Start the app Use React Native")
  expect(result?.text).not.toContain("next request")
})

test("waits when a delegation has no new user transcript", () => {
  expect(
    liveDelegationPrompt({
      captions: [caption({ role: "assistant", text: "What would you like me to change?" })],
      offset: 100,
    }),
  ).toBeUndefined()
})
