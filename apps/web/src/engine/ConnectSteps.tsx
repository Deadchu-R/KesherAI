import { getLocale } from "../i18n";
import { AddUnityPackage } from "./AddUnityPackage";
import { InstallIntoProject } from "./InstallIntoProject";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * How to connect the editor: Unity (the package through Unity's CLI) or
 * Unreal (the KesherAI Bridge plugin: install into a project, or by hand).
 *
 * @param p.unity - Unity's steps instead of Unreal's.
 * @param p.download - The plugin's download link (Unreal).
 */
export function ConnectSteps(p: { unity: boolean; download: string }) {
  const unity = p.unity;
  const app = unity ? "Unity" : "Unreal";
  const st = { download: p.download };
  return (
    <section className="card stack">
      <h2>{L(`חיבור ${app}`, `Connect ${app}`)}</h2>
      {unity ? (
        <>
          <AddUnityPackage />
          <ol className="ue-steps">
            <li>{L("Unity 6 ומעלה, עם Visual Scripting.", "Unity 6 or newer, with Visual Scripting.")}</li>
            <li>{L("\"הוסף לפרויקט\" מעתיק את חבילת KesherAI Bridge לפרויקט ומוסיף את חבילת ה-Pipeline של Unity דרך ה-CLI. Unity מקמפל לבד — בלי Visual Studio.", "“Add to a project” copies the KesherAI Bridge package into the project and adds Unity's Pipeline package through the CLI. Unity compiles it by itself — no Visual Studio.")}</li>
            <li>{L("כש-Unity פתוח, השינויים קורים בו מיד (Ctrl+Z מבטל). כשהוא סגור, KesherAI מריץ את Unity ברקע, משנה ושומר — לוקח קצת יותר זמן.", "With Unity open, changes happen in it at once (Ctrl+Z undoes them). With it closed, KesherAI runs Unity in the background, changes and saves — a little slower.")}</li>
          </ol>
        </>
      ) : (
        <>
      <InstallIntoProject />
      <p className="muted small">{L("או ידנית:", "Or by hand:")}</p>
      <ol className="ue-steps">
        <li>{L("הורד את הפלאגין:", "Download the plugin:")} <a className="button primary" href={st.download}>⬇ KesherAIBridge.zip</a></li>
        <li>{L("חלץ אותו לתיקייה Plugins בתוך הפרויקט (YourProject/Plugins/KesherAIBridge).", "Unzip it into your project's Plugins folder (YourProject/Plugins/KesherAIBridge).")}</li>
        <li>{L("פתח את הפרויקט. בפרויקט C++, Unreal יבנה את הפלאגין בפעם הראשונה (צריך Visual Studio). לפרויקט Blueprint בלבד — השתמש ב\"התקן לתוך פרויקט\" למעלה.", "Open the project. In a C++ project Unreal builds the plugin the first time (needs Visual Studio). For a Blueprint-only project, use “Install into a project” above.")}</li>
        <li>{L("זהו: כש-KesherAI פתוח, Unreal מתחבר לבד ויופיע כאן 🟢.", "That's it: while KesherAI runs, Unreal connects by itself and shows 🟢 here.")}</li>
      </ol>
        </>
      )}
      <p className="muted small">{L(`החיבור הוא רק בתוך המחשב הזה. כל גרף שנפתח כאן נשמר כעותק, כדי שתוכל לראות אותו ולבקש שינויים גם כש-${app} סגור.`, `The connection stays on this computer. Every graph opened here is kept as a copy, so you can see it and ask for changes with ${app} closed too.`)} <a href={`https://github.com/Deadchu-R/KesherAI/blob/main/docs/${unity ? "UNITY" : "UNREAL"}.md`} target="_blank" rel="noreferrer">{`docs/${unity ? "UNITY" : "UNREAL"}.md`}</a></p>
    </section>
  );
}
