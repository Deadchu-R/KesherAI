/** The Text Helper's quick actions as questions to the model (no React here, so tests can read them). */

/** Text with Hebrew letters is translated to English; any other text to Hebrew when the app is in Hebrew, else to English. */
export function translateTarget(text: string, locale: string): "English" | "Hebrew" {
  if (/[\u0590-\u05FF]/.test(text)) return "English";
  return locale === "he" ? "Hebrew" : "English";
}

/** The question sent for a quick action, with the selected text quoted. */
export function actionPrompt(kind: "summarize" | "explain" | "translate" | "fix" | "simpler" | "reply", text: string, locale: string): string {
  const asks: Record<typeof kind, string> = {
    summarize: "Summarize this text in a few short points, in the text's own language.",
    explain: "Explain this text simply: what it means and any terms in it.",
    translate: `Translate this text to ${translateTarget(text, locale)}. Answer with the translation only.`,
    fix: "Fix the spelling, grammar and punctuation of this text, keeping its language, meaning and tone. Answer with the corrected text only.",
    simpler: "Rewrite this text so it is shorter and simpler, keeping its language and meaning. Answer with the new text only.",
    reply: "Write a short, friendly reply to this message, in its language. Answer with the reply only.",
  };
  return `${asks[kind]}\n\n"""\n${text}\n"""`;
}
