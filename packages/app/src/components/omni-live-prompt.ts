export type LiveCaption = {
  role: "user" | "assistant"
  text: string
  start: number
  end: number
  sealed: boolean
}

export function liveDelegationPrompt(input: { captions: LiveCaption[]; offset: number }) {
  const cutoff = Number.isFinite(input.offset) ? input.offset + 750 : Number.POSITIVE_INFINITY
  const captions = input.captions.filter((caption) => caption.text.trim() && caption.start <= cutoff)
  const pending = captions.filter((caption) => caption.role === "user" && !caption.sealed)
  if (!pending.length) return

  const turns = captions.slice(-24).reduce<{ role: LiveCaption["role"]; text: string }[]>((result, caption) => {
    const text = caption.text.replace(/\s+/g, " ").trim().slice(0, 1600)
    const previous = result.at(-1)
    if (previous?.role === caption.role) previous.text += " " + text
    else result.push({ role: caption.role, text })
    return result
  }, [])
  const transcript = turns
    .map((turn) => `${turn.role === "user" ? "You" : "OmniCode"}: ${turn.text}`)
    .join("\n")
    .slice(-8000)

  return {
    captions: pending,
    text:
      "Continue from our live conversation. Apply my latest direction in context instead of treating transcript " +
      "fragments as separate prompts. Ignore filler, abandoned phrases, and anything I explicitly said was not " +
      "addressed to you. If I corrected an earlier instruction, follow the correction.\n\n" +
      "Recent live conversation:\n" +
      transcript,
  }
}
