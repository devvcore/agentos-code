import type { SessionV1 } from "@opencode-ai/core/v1/session"

/** A minimal valid PDF with Helvetica text per page (one text line per `\n`); an empty string makes a page with no text layer. */
export function pdfBytes(pages: string[]) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    ...pages.flatMap((text, i) => {
      // 1pt type so long test pages stay inside the MediaBox; extractors drop off-page text.
      const lines = text ? text.split("\n").map((line) => `(${line}) Tj 0 -1.2 Td`) : []
      const stream = lines.length ? `BT /F1 1 Tf 10 780 Td ${lines.join(" ")} ET` : ""
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ]
    }),
  ]
  const body = objects.reduce(
    (acc, object, i) => ({
      text: acc.text + `${i + 1} 0 obj\n${object}\nendobj\n`,
      offsets: [...acc.offsets, acc.text.length],
    }),
    { text: "%PDF-1.4\n", offsets: [] as number[] },
  )
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...body.offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.text.length}\n%%EOF\n`,
  ].join("")
  return Buffer.from(body.text + xref, "latin1")
}

export function pdfDataUrl(pages: string[]) {
  return `data:application/pdf;base64,${pdfBytes(pages).toString("base64")}`
}

/** A user message that attaches `filepath` the way the desktop app does: a data URL named by its source path. */
export function attachedMessage(filepath: string, url = pdfDataUrl(["attached"])) {
  return {
    info: {
      id: "msg_attached",
      sessionID: "ses_test",
      role: "user",
      time: { created: 0 },
      agent: "work",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [
      {
        id: "prt_attached",
        sessionID: "ses_test",
        messageID: "msg_attached",
        type: "file",
        mime: "application/pdf",
        filename: filepath,
        url,
      },
    ],
  } as unknown as SessionV1.WithParts
}
