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
- **Record** (● or R): four clicks to count in, then the microphone.
- **To an instrument…**: the notes of a hum, a whistle or a sung line are found in the page (YIN pitch tracking, no
  model), shown in a piano roll, moved to the key (found by itself) and on the beat if you like, an octave up or down,
  and played by an instrument you pick: piano, acoustic or electric guitar, bass, violin, cello, strings, trumpet,
  saxophone, flute, clarinet, choir, synth; or a beatbox becomes drums (kick, snare and hat, synthesized). Listen first,
  then replace the stretch with it or mix it over the sound.
- **From the video editor:** double-click its sound track; *Back to the video* brings the new sound there.
- **Export / Send to the chat:** a WAV made in the page (16-bit), downloaded or attached to the same chat.

It talks to KesherAI only through `window.kesher` (`ui/kesher.js`): `editor.input` (the chat's sound, as bytes),
`sound.transcript` and `chat.sendFile`. Next: timbre transfer (DDSP) that keeps the hum's expression, chords with Basic
Pitch, a backing track from the music model, voices (a line in another voice), clean-up (noise, echo), loudness for a
target, and stems for music.

**Credits:** the instrument samples (`ui/instruments/`) are from the FluidR3 General MIDI SoundFont by Frank Wen, as
rendered per note by gleitz/midi-js-soundfonts, under the Creative Commons Attribution 3.0 licence; every third note is
kept and the ones between are pitched from it.
