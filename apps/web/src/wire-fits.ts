const NUMBER = /^(int|int64|byte|real|float|double)$/;
/**
 * Whether a wire from one pin type fits another, as Unreal tells it while dragging: the same type, numbers (a
 * conversion node is added), objects (the class is checked on connecting); else why not.
 */
export function wireFits(from: string, to: string): { ok: boolean; why: string } {
  const base = (t: string) => t.replace(/\[\]$/, "").split(":")[0]!;
  const [a, b] = [base(from), base(to)];
  const list = (t: string) => t.endsWith("[]");
  if ((a === "exec") !== (b === "exec")) return { ok: false, why: "Exec ≠ value" };
  if (list(from) !== list(to)) return { ok: false, why: `${from} ≠ ${to}` };
  if (from === to || a === "exec") return { ok: true, why: "" };
  if (NUMBER.test(a) && NUMBER.test(b)) return { ok: true, why: a === b ? "" : `${a} → ${b}` };
  if (a === b && (a === "object" || a === "class" || a === "struct" || a === "interface")) return { ok: true, why: "" };
  if (a === b && !from.includes(":")) return { ok: true, why: "" };
  return { ok: false, why: `${from} ≠ ${to}` };
}
