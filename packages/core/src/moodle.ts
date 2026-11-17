/**
 * The student's Moodle (RESEARCH_LOG "Students, part 19", design MoodleStudy): her courses and what is due, read with
 * her own sign-in through KesherAI's browser pane, and a course's lecture files brought into Study as lectures.
 * Read only: KesherAI never submits, posts or changes anything there.
 */

/** A course she is enrolled in. */
export interface MoodleCourse { id: string; name: string; url?: string }
/** Something due (an assignment, a quiz), with its time in ms. */
export interface MoodleDue { id: string; name: string; course: string; due: number; url?: string }
/** A file on a course page. */
export interface MoodleFile { id: string; name: string; url: string; kind: "resource" | "file" }

/** A Moodle address as KesherAI keeps it: https, no trailing slash, no page; undefined when it is not one. */
export function moodleBase(text: string): string | undefined {
  let u: URL;
  try {
    u = new URL(text.trim().startsWith("http") ? text.trim() : `https://${text.trim()}`);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || !/^[\w.-]+$/.test(u.hostname)) return undefined;
  const path = u.pathname.replace(/\/(my|login|course)(\/.*)?$/, "").replace(/\/[\w-]+\.php$/, "").replace(/\/+$/, "");
  if (!/^(\/[\w.-]+)*$/.test(path)) return undefined;
  return `${u.origin}${path}`;
}

/** The courses from core_course_get_enrolled_courses_by_timeline_classification's answer. */
export function parseCourses(answer: unknown): MoodleCourse[] {
  const list = (answer as { data?: { courses?: unknown[] } })?.data?.courses ?? [];
  return list.flatMap((c) => {
    const o = c as { id?: unknown; fullname?: unknown; viewurl?: unknown };
    const id = String(o.id ?? "");
    const name = String(o.fullname ?? "").replace(/<[^>]*>/g, "").trim();
    return /^\d+$/.test(id) && name ? [{ id, name, ...(typeof o.viewurl === "string" ? { url: o.viewurl } : {}) }] : [];
  });
}

/** What is due, from core_calendar_get_action_events_by_timesort's answer, soonest first. */
export function parseDue(answer: unknown): MoodleDue[] {
  const list = (answer as { data?: { events?: unknown[] } })?.data?.events ?? [];
  return list.flatMap((e) => {
    const o = e as { id?: unknown; name?: unknown; activityname?: unknown; timesort?: unknown; course?: { fullname?: unknown }; url?: unknown };
    const due = Number(o.timesort) * 1000;
    const name = String(o.activityname ?? o.name ?? "").replace(/<[^>]*>/g, "").trim();
    return name && due > 0 ? [{ id: String(o.id ?? ""), name, course: String(o.course?.fullname ?? "").replace(/<[^>]*>/g, "").trim(), due, ...(typeof o.url === "string" ? { url: o.url } : {}) }] : [];
  }).sort((a, b) => a.due - b.due);
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

/**
 * A course page's files: its "File" activities (mod/resource) and files linked straight from it (pluginfile), each once.
 *
 * @param html - The course page.
 * @param base - The Moodle address (links elsewhere are left out).
 */
export function parseCourseFiles(html: string, base: string): MoodleFile[] {
  const out: MoodleFile[] = [];
  const seen = new Set<string>();
  const esc = base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const m of html.matchAll(new RegExp(`<a[^>]+href="(${esc}/mod/resource/view\\.php\\?id=(\\d+))"[^>]*>([\\s\\S]*?)</a>`, "g"))) {
    if (seen.has(m[2]!)) continue;
    seen.add(m[2]!);
    const name = decode((/<span class="instancename">([\s\S]*?)(?:<span class="accesshide|<\/span>)/.exec(m[3]!)?.[1] ?? m[3]!).replace(/<[^>]*>/g, "")).trim();
    out.push({ id: `r${m[2]}`, name: name || `File ${m[2]}`, url: decode(m[1]!), kind: "resource" });
  }
  for (const m of html.matchAll(new RegExp(`href="(${esc}/pluginfile\\.php/[^"]+\\.(?:pdf|pptx?|docx?|xlsx?|txt|md))(?:\\?[^"]*)?"`, "gi"))) {
    const url = decode(m[1]!);
    const id = `p${url.replace(/^.*pluginfile\.php\//, "")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: decodeURIComponent(url.split("/").pop() ?? "file"), url, kind: "file" });
  }
  return out;
}
