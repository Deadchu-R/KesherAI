# Work list (Roee and Claude)

The running list of what is being worked on, what is next and what waits on Roee. Claude keeps it up to date after
every task (and tells Roee in the chat what changed). Status: ✅ done · 🔨 in progress · ⬜ next · 👤 waits on Roee.
Longer-term plans are in [FUTURE_FEATURES.md](FUTURE_FEATURES.md); research in [RESEARCH_LOG.md](RESEARCH_LOG.md).

## Now (2026-11-19): research and code only, no new builds (Roee, 10:13)
- ✅ **Mark it and let the model work** (FUTURE_FEATURES), in all four editors:
  - ✅ Pictures: repaint the selection (earlier).
  - ✅ 3D: the "what to do with this part" box (earlier).
  - ✅ Video: ✦ With AI on the chosen clip: a picture from words, this shot in another look, or a video clip from words
    (through the chat; it goes in by itself at the clip's place and length). On main, not in a build yet.
  - ✅ Sound: ✦ With AI on the selection: music for it (through the chat; goes in by itself, cut and faded to the
    selection, under it or instead of it), or other words in a voice. On main, not in a build yet.
- ✅ The design doc: boards for ✦ With AI (video and sound) and the 3D picture / turntable buttons.
- ✅ Video: transitions between clips (Send to the chat → Between clips: dissolve, slide, wipe, circle, zoom, pixels,
  through white, fade to black; 0.3–1.2 s). Without overlap, so every time in the edit stays.
- ✅ Video: the transition shows in the player at each cut; "Between clips" is in the inspector (phone: ⚙ Clip).
- ✅ 3D turntable: its length (6, 12, 20 s) and size (the view's, or 1920×1080) from the 🎞 button's menu.
- ✅ Pictures: type text on the picture (a box by the words, the typing shows at once; Esc puts it back).
- ✅ Security scan 164: nothing to fix.
- ✅ The design doc: boards for transitions and typing text on the picture.
- ✅ Sound effects from words: Stable Audio 3 Small-SFX (ready flow, the chat's make_sound, and "A sound effect for
  it" in the sound editor). Not tried in ComfyUI on the PC yet (needs ComfyUI 0.22+ and a 3.5 GB download, with a yes).
- ✅ Fixed: ✦ With AI now finds the new song or video in the bank too (the chat keeps them there, not in its folder).
- ✅ Video: "continue this shot" (✦ With AI → Continue): the clip's last frame is set in motion through the chat's new
  animate_picture (Wan 2.2 5B), and goes in after it. Not run in ComfyUI on the PC yet.
- ✅ Video: a different transition at each cut (the clip's "Comes in with"; plain cut or any kind; seen in the player).
- ✅ Security scan 165: nothing to fix.

- ✅ 3D models with colours: TRELLIS.2 (MIT, native in ComfyUI 0.34+): the 3D editor's "A model from words, with
  colours" and "A model from a picture, with colours", and the chat's make_3d paints by default. The flow passed a real
  ComfyUI 0.46's validation in the workspace; not run with the real model (that needs the PC and a ~7.7 GB download).
- ✅ Paint an existing model (🖌 in the 3D editor): four views drawn by words (SD 1.5 + ControlNet depth) and baked onto
  it, with ComfyUI's own nodes; its geometry half ran in a real ComfyUI in the workspace.
- ✅ Security scan 166: nothing to fix.

- ✅ A study guide for a student friend (Roee, 11:50): a doc from installing to every study tool, only the study
  parts, with 17 real screenshots (desktop and phone) from 0.6.400 on a demo course.

- ✅ Helper agents (Roee, 12:39): docs/AGENT_BRIEF.md and .claude/agents (research, build); Claude leads,
  helpers research or build one task each and report back in 15 lines.
- 🔨 A scene together for guests through share links: ✅ research → 🔨 build (helper agent, Opus).
- ✅ Research: helper agents inside KesherAI (lead + research/build/lookup helpers, a model per helper, GPU-aware).
- ✅ Research: a task inbox (Claude → git → KesherAI on the PC → Antigravity / local model → agy/* branch → Claude
  reviews). Roee (12:5x): Antigravity runs only when he presses Run, one at a time, for now; KesherAI may push
  only agy/* and the inbox branch. Defaults until he says otherwise: 10 Antigravity tasks a day, Gemini's default model.
- ⬜ Research Google's terms for unattended Antigravity in depth (Roee: "remember to check it in depth").
- ⬜ Design doc: guests in a scene, helpers in chat, the task inbox; then build helpers + inbox (Opus helper).

## Builds
- ✅ 0.6.397 and 0.6.398 are available in the app.
- ✅ 0.6.399 is available too.
- ✅ 0.6.400 is available (Roee, 11:16: "add the 2 things, then a build and stop"). Stopped after it.

## Waiting on Roee 👤
- 👤 When convenient: 🖌 paint a model (ComfyUI 0.46+; asks before downloading SD 1.5 + ControlNet depth, ~2.8 GB).
- 👤 When convenient: a 3D model with colours (update ComfyUI to 0.34+; it asks before downloading TRELLIS.2, ~7.7 GB).
- 👤 When convenient: try the 3D editor's "A model from words" (ComfyUI; asks before downloading Hunyuan3D 2, ~4.9 GB).
- 👤 When convenient: try "continue this shot" (needs the Wan 2.2 5B flow in ComfyUI; it asks before downloading).
- 👤 When convenient: try sound effects (needs ComfyUI 0.22+; it asks before downloading 3.5 GB).
- 👤 Install 0.6.400 from the app and check (what to check is in the chat's "available" messages).
- 👤 The guest test from the phone (shared projects).
- 👤 A stronger model for writing chat reports.
- 👤 Unreal AutoShooter has no levels: noted only, not fixed (Roee's call).

## Next, from FUTURE_FEATURES (code only)
- ✅ Say on screen what loaded a model ("Loaded because: …" on the Models page and in the computer's details).
- ✅ A scene together (Unity Studio style): each person's colour chip, camera (a cone with the name) and selection,
  and follow their view; for this computer, the phone and paired devices. ⬜ Later: guests through share links.
- 👤 Open items that need Roee: Magic Tab (testing at the keyboard), the npm SDK (an npm account), Google sign-in for
  email invites, the Unreal levels bug (Roee: later).

## Later (agreed)
- ✅ A 3D model from words without the chat (＋ Add → A model from words: a picture, then Hunyuan3D 2 on the computer;
  the first time it asks before downloading the 3D model). Not run in ComfyUI on the PC yet.
