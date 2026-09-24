import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionAttachment } from "../../src/session/attachment"
import { attachedMessage, pdfDataUrl } from "../fixture/pdf"

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const pdfModel: Provider.Model = {
  ...model,
  capabilities: { ...model.capabilities, input: { ...model.capabilities.input, pdf: true } },
}

const attached = path.join(path.parse(process.cwd()).root, "Users", "someone", "Downloads", "KXCO.pdf")

function userContent(messages: Awaited<ReturnType<typeof MessageV2.toModelMessages>>) {
  const first = messages[0]
  if (first.role !== "user" || !Array.isArray(first.content)) throw new Error("expected user content")
  return first.content
}

function textOf(messages: Awaited<ReturnType<typeof MessageV2.toModelMessages>>) {
  const part = userContent(messages)[0]
  if (part.type !== "text") throw new Error(`expected text, got ${part.type}`)
  return part.text
}

describe("session.attachment pdf fallback", () => {
  test("sends extracted, page-delimited text when the model has no pdf input", async () => {
    const messages = await MessageV2.toModelMessages(
      [attachedMessage(attached, pdfDataUrl(["Revenue grew 12 percent", "Churn fell to 3 percent"]))],
      model,
    )
    const text = textOf(messages)
    expect(text).toStartWith(`Attached PDF "KXCO.pdf" (2 pages, original at ${attached}). Extracted text:`)
    expect(text).toContain("--- Page 1 ---\nRevenue grew 12 percent")
    expect(text).toContain("--- Page 2 ---\nChurn fell to 3 percent")
    expect(text).not.toContain("truncated")

    // The transform no longer sees a PDF, so nothing is turned into an error.
    const final = ProviderTransform.message(messages, model, {})
    expect(JSON.stringify(final)).not.toContain("could not be passed")
  })

  test("keeps the pdf file part unchanged when the model takes pdf input", async () => {
    const url = pdfDataUrl(["Revenue grew 12 percent"])
    const messages = await MessageV2.toModelMessages([attachedMessage(attached, url)], pdfModel)
    expect(userContent(messages)).toStrictEqual([
      { type: "file", mediaType: "application/pdf", filename: attached, data: url },
    ])
  })

  test("points at the original and OCR when the pdf has no text layer", async () => {
    const text = textOf(await MessageV2.toModelMessages([attachedMessage(attached, pdfDataUrl(["", ""]))], model))
    expect(text).toBe(
      `Attached PDF "KXCO.pdf" (2 pages, original at ${attached}) has no text layer; it is probably scanned images. To read it, run OCR on ${attached} (see the pdf skill).`,
    )
  })

  test("truncates past the budget and tells the agent where the full file is", async () => {
    const page = Array.from({ length: 500 }, () => "x".repeat(80)).join("\n")
    const text = textOf(
      await MessageV2.toModelMessages([attachedMessage(attached, pdfDataUrl([page, page, page, page]))], model),
    )
    expect(text).toContain("--- Page 3 ---")
    expect(text).not.toContain("--- Page 4 ---")
    expect(text).toMatch(
      /\[Text truncated at 100,000 of 1\d\d,\d{3} characters, through page 3 of 4\. The full file is at .+KXCO\.pdf; read it with your tools for the remaining content\.\]$/,
    )
    expect(text.length).toBeLessThan(SessionAttachment.PDF_TEXT_BUDGET + 1_000)
  })

  test("reports unreadable pdfs with the original path", async () => {
    const url = `data:application/pdf;base64,${Buffer.from("not a pdf").toString("base64")}`
    const text = textOf(await MessageV2.toModelMessages([attachedMessage(attached, url)], model))
    expect(text).toStartWith(`Attached PDF "KXCO.pdf" could not be opened for text extraction (`)
    expect(text).toEndWith(`The original is at ${attached}; try the pdf skill's tools on it.`)
  })

  test("inlines pdf text into read tool results instead of forwarding media", async () => {
    const user = attachedMessage(attached)
    const messages = await MessageV2.toModelMessages(
      [
        { ...user, parts: [{ ...user.parts[0], type: "text", text: "read it" } as SessionV1.Part] },
        {
          info: {
            id: "msg_assistant",
            sessionID: "ses_test",
            role: "assistant",
            time: { created: 0 },
            parentID: "msg_attached",
            modelID: "test-model",
            providerID: "test",
            mode: "",
            agent: "work",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: "prt_tool",
              sessionID: "ses_test",
              messageID: "msg_assistant",
              type: "tool",
              callID: "call_1",
              tool: "read",
              state: {
                status: "completed",
                input: { filePath: attached },
                output: "PDF read successfully",
                title: "Read",
                metadata: {},
                time: { start: 0, end: 1 },
                attachments: [
                  {
                    id: "prt_att",
                    sessionID: "ses_test",
                    messageID: "msg_assistant",
                    type: "file",
                    mime: "application/pdf",
                    url: pdfDataUrl(["Board deck page"]),
                  },
                ],
              },
            },
          ],
        } as unknown as SessionV1.WithParts,
      ],
      model,
    )
    expect(messages.map((msg) => msg.role)).toEqual(["user", "assistant", "tool"])
    const tool = messages[2]
    if (tool.role !== "tool") throw new Error("expected tool message")
    const result = tool.content[0]
    if (result.type !== "tool-result" || result.output.type !== "text") throw new Error("expected text tool result")
    expect(result.output.value).toBe(
      `PDF read successfully\n\nAttached PDF "KXCO.pdf" (1 page, original at ${attached}). Extracted text:\n\n--- Page 1 ---\nBoard deck page`,
    )
  })
})

describe("session.attachment paths", () => {
  test("collects exactly the local files attached to user messages", () => {
    const mentioned = path.join(path.parse(process.cwd()).root, "work", "notes.txt")
    const user = attachedMessage(attached)
    const paths = SessionAttachment.paths([
      {
        ...user,
        parts: [
          ...user.parts,
          {
            ...user.parts[0],
            id: "prt_url",
            mime: "text/plain",
            filename: "notes.txt",
            url: pathToFileURL(mentioned).href,
          },
          { ...user.parts[0], id: "prt_web", filename: "web.pdf" },
          {
            ...user.parts[0],
            id: "prt_dir",
            mime: "application/x-directory",
            filename: path.dirname(attached),
            url: pathToFileURL(path.dirname(attached)).href,
          },
        ] as SessionV1.Part[],
      },
      { ...user, info: { ...user.info, role: "assistant" } } as unknown as SessionV1.WithParts,
    ])
    expect([...paths].sort()).toEqual([attached, mentioned].map(SessionAttachment.normalize).sort())
  })
})
