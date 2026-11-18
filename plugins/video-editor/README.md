# Video editor (official KesherAI plugin)

A video editor that runs inside KesherAI as an app plugin, laid out after CapCut, Premiere and DaVinci Resolve
(docs/RESEARCH_LOG.md → "The video editor's screen"; design VideoEditorWorkspace).

- **Open it from a chat:** "Edit in the video editor" on a chat's video opens it here as a tab.
- **The screen:** the viewer on top, the timeline across the bottom (the whole video as a thin strip over it), the chosen
  clip's settings on the side. On a phone: the viewer on top, the timeline under it, and the tools at the bottom (as CapCut).
- **Editing:** split at the playhead, delete a clip (the main track is magnetic: the gap closes), trim the start or end to
  the playhead, move a clip left or right, undo and redo.
- **Keys:** Space play/pause, J/K/L back/stop/forward, ←/→ a frame, Shift+←/→ a second, S split, Q/W trim the start/end
  to the playhead, Delete removes the clip, Ctrl+Z / Ctrl+Y, `+`/`−` zoom the timeline, `?` shows them all.
- **Transcript:** *Transcribe* runs whisper on your computer; each line shows its time, a tap goes there, and ✂ cuts what
  it says out of the video. *Remove long silences* cuts the pauses over a second (before, between and after the speech).
- **Export:** the kept stretches are cut and joined on your computer by FFmpeg (exact frames, H.264 + AAC) into a new file
  in the chat's folder; *Send to the chat* attaches it with an optional message.

How it is built: plain HTML, CSS and JavaScript (`ui/`), no build step. It talks to KesherAI only through `window.kesher`
(`ui/kesher.js`): `editor.input` (the chat's video, as bytes), `video.transcript` and `video.cut` (the export). Next: captions from
speech burned in or as a file, and the AI task bar under a marked stretch.
