import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PlanStep } from "@kesher/shared";

/** Plans and checking the model's steps live in @kesher/shared (study-plan.ts), shared with the phone. */
export { checkPlan, planPrompt, type PlanStep } from "@kesher/shared";
/** A plan for one assignment. */
export interface StudyPlan { id: string; title: string; course: string; due: number; steps: PlanStep[]; createdAt: number; calendar?: boolean }

/** Plans kept in one file in the Study folder. */
export class StudyPlans {
  /** @param file - The plans file. */
  constructor(private readonly file: string) {}

  /** Every plan, soonest due first. */
  async list(): Promise<StudyPlan[]> {
    const raw = await readFile(this.file, "utf8").then((t) => JSON.parse(t) as StudyPlan[], () => [] as StudyPlan[]);
    return (Array.isArray(raw) ? raw : []).sort((a, b) => a.due - b.due);
  }

  private async save(plans: StudyPlan[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(plans));
    await rename(tmp, this.file);
  }

  /** Minutes already planned per day (open steps of other plans). */
  async busy(except?: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const p of await this.list()) if (p.id !== except) for (const s of p.steps) if (!s.done) out[s.date] = (out[s.date] ?? 0) + s.minutes;
    return out;
  }

  /** Adds or replaces a plan. */
  async put(plan: StudyPlan): Promise<StudyPlan> {
    const all = (await this.list()).filter((p) => p.id !== plan.id);
    // Plans long past their due day leave after two weeks.
    await this.save([...all.filter((p) => p.due > Date.now() - 14 * 86_400_000), plan]);
    return plan;
  }

  /** One plan. */
  async get(id: string): Promise<StudyPlan | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Removes a plan. */
  async remove(id: string): Promise<void> {
    await this.save((await this.list()).filter((p) => p.id !== id));
  }
}
