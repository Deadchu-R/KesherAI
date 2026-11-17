/** A screen's size: a page that says it is for a phone (viewport width ≤ 480, or kesher-frame "phone") is 390×844. */
export function frameSize(code: string): { w: number; h: number; phone: boolean } {
  const tag = /<meta[^>]+name=["']kesher-frame["'][^>]+content=["'](phone|desktop|tablet)["']/i.exec(code)?.[1];
  const vw = Number(/<meta[^>]+name=["']viewport["'][^>]+width=(\d+)/i.exec(code)?.[1] ?? 0);
  if (tag === "phone" || (vw > 0 && vw <= 480)) return { w: 390, h: 844, phone: true };
  if (tag === "tablet") return { w: 834, h: 1112, phone: false };
  return { w: 1280, h: 800, phone: false };
}

