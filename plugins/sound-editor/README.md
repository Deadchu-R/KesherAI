# Sound editor (official KesherAI plugin)

A sound editor that runs inside KesherAI as an app plugin, laid out after Audition, iZotope RX, Descript and Ferrite
(docs/RESEARCH_LOG.md → "The sound editor's screen"; design SoundEditorWorkspace).

- **Open it from a chat:** "Edit in the sound editor" on a chat's sound or recording opens it here as a tab.
- **The screen:** the waveform with a thin overview strip over it, the selection's tools in a bar, the transcript on the
  side. On a phone: the waveform large, the tools at the bottom.
- **Editing:** drag to select a stretch; Delete cuts it (the rest closes up), Keep keeps only it, Silence, Fade in, Fade
  out, louder or quieter by 3 dB, Normalize (to −1 dB peak, all or the selection); undo and redo (20 steps).
- **Keys:** Space play/pause (the selection when there is one), Delete cuts, Ctrl+A selects all, Esc lets go, Ctrl+Z /
  Ctrl+Y, `+`/`−` zoom, ←/→ move the playhead a second, `?` shows them all.
- **Transcript:** *Transcribe* runs whisper on your computer; each line shows its time, a tap selects it, ✂ cuts it, and
  *Remove long silences* cuts the pauses over a second.
- **Export / Send to the chat:** a WAV made in the page (16-bit), downloaded or attached to the same chat.

It talks to KesherAI only through `window.kesher` (`ui/kesher.js`): `editor.input` (the chat's sound, as bytes),
`sound.transcript` and `chat.sendFile`. Next: clean-up (noise, echo) with a strength and A/B, loudness for a target,
stems for music, and "fix this line in my voice".
