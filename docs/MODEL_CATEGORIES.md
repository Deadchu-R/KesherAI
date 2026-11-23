# Models per job

Every place in KesherAI where a model is chosen for a job, how to set it through the local API, its default, and the
pick for Roee's PC (RTX 3090 24 GB, Ryzen 9 9950X3D, about 64 GB RAM, Windows) from the models already installed.
The lead applies this on the PC (through KesherAI itself). Settings › "Models per job" shows the same list in the app.

Rules behind the picks: one big model on the graphics card at a time (about 18 GB leaves room for context and a small
model beside it); Hebrew quality first where the job writes Hebrew; small and fast for small jobs; a model that does not
fit in 24 GB (Qwen3-Coder-Next, Qwen3.8-Flash-Next, the abliterated coder) only by hand, never as a default.

Ids: a built-in engine chat model is `llamacpp/<file name without .gguf>` (spaces and slashes become `-`); an image
model `sdcpp/<repo>/<file>`; a video model is the file's path (or a ComfyUI model id). `PUT /api/settings` with
`activeModels` replaces the whole map, so send the current map with the one change (as Settings › Active models does).

## The categories (activeModels)

| Category | What it does | Recommended (installed) | Why | API call (default) |
|---|---|---|---|---|
| `chat` | Every chat, voice mode, text actions, the Text Helper, Study fallback | Qwen3.6-27B (bartowski Q, ~18 GB) | Fully on the card with room for context; strong at tools and code, good Hebrew; already his main and self-work model, so nothing swaps | `PUT /api/settings {activeModels:{…,chat:"llamacpp/<Qwen3.6-27B file>"}}`, then `POST /api/engines/llamacpp/load {modelPath}` (default: none until the welcome or a load) |
| `code` | Code page's default model | Qwen3.6-27B (same) | Same model as chat: no second 18 GB load; Coder-Next (38 GB) spills into RAM | `activeModels.code` (default: falls back to `chat`) |
| `codeInline` | Grey suggestions while typing code | Qwen3.5-2B Q4 (~1.3 GB) | The only small model installed; fast beside the big one. A small coder (Qwen2.5-Coder 1.5B) would be better, not installed | `activeModels.codeInline` (default: off) |
| `image` | Pictures (chat's generate_image, Images page) | Qwen-Image-2512 GGUF (+ Qwen2.5-VL-7B, umt5 extras) | Best quality and text inside images; 12 GB+ is comfortable on 24 GB | `activeModels.image="sdcpp/unsloth/Qwen-Image-2512-GGUF/<file>"`, or `POST /api/models/setup/media/image` (default: Qwen-Image at 12 GB+, else FLUX schnell) |
| `video` | Short clips (generate_video) | Wan 2.2 (~10 GB) | Better motion and quality than 2.1 and fits the card; Wan 2.1 1.3B stays for quick drafts | `activeModels.video="<path of the Wan 2.2 file>"` (default: Wan 2.1 1.3B via `POST /api/models/setup/media/video`) |
| `music` | Songs and sound effects (generate_audio) | ACE-Step 1.5 turbo (ComfyUI) | Fast, sings in Hebrew too; the only music model installed | `activeModels.music="comfyui/<ACE-Step file>"` (default: none; ComfyUI flow) |
| `3d` | 3D models (generate_3d) | TRELLIS.2-4B; Hunyuan3D-DiT v2 as fallback | TRELLIS.2 gives better meshes and textures; unload the chat model first (both together do not fit 24 GB) | `activeModels["3d"]="comfyui/<file>"` (default: none) |
| `embedding` | Search by meaning (knowledge bases, chat search) | Qwen3-Embedding-0.6B Q8 | Multilingual (Hebrew), tiny, runs beside the chat model | `POST /api/knowledge/semantic/setup` (computer only; finds the installed file and sets `activeModels.embedding="llamacpp-embed/<file>"`) |
| `speech-to-text` | Microphone, voice mode, lectures and meetings | ivrit-ai large-v3 turbo (active) | Trained further on Hebrew; f16 runs on the card | `PUT /api/speech/stt {stt:"local", language:"auto"}`; `POST /api/speech/stt/setup {hebrew:true}` (default: `auto`, general large-v3 turbo) |
| `text-to-speech` | Reading answers aloud | Kokoro (active) | The only local voice wired into the server; Hebrew is read by the system voice. Zonos-Hebrew and F5-TTS Hebrew are installed but not wired in yet (open task) | `POST /api/speech/tts/local/setup` (default: Kokoro) |

## Other jobs that pick a model

| Job | What it does | Recommended (installed) | Why | API call (default) |
|---|---|---|---|---|
| Small model beside (Auto's router, small turns) | Routes each message; simple messages answered by a small model | Qwen3.5-2B Q4 (~1.3 GB) | Exactly the recommended router (ROUTER_MODEL); fits beside 18 GB | `POST /api/model-router/router/setup` (finds the file, loads it beside); `PUT /api/model-team {smallTurns:true}` (default: on, router not loaded) |
| Auto (model per message) | New chats on Auto; strengths per model | DictaLM-3.0-24B-Thinking: hebrew · Qwen3.6-27B: tools, code · gemma-4-31B: vision, research · Qwen3.5-2B: fast | Sends Hebrew writing to Dicta, tools and code to Qwen, photos to Gemma | `PUT /api/model-router {defaultAuto:true}`, `{strengths:{modelId,list}}` per model (default: off, strengths by family) |
| Model team translator | Translates an answer that came out in the wrong language | translategemma-4b (~2.8 GB) | Made for translation, Hebrew included; fits beside the chat model | `PUT /api/model-team {translator:"llamacpp/<translategemma file>"}` (default: `main`, the chat's own model). **Found anywhere:** any `translategemma*.gguf` under the models folder (any folder or quant; Q4_K_M first) counts as downloaded; the Translate page uses a chosen, present file first, then the loaded chat model, then any such file, and Gemini only after those. `/api/translate/download` stays for when none exists |
| Photos in chats and Study | Reads boards, schedules, screenshots | gemma-4-12b-it (+ mmproj, ~7.4 GB) | Picked by itself: the smallest local model over 4 GB with a vision file. Nothing to set | none (automatic) |
| Computer and browser control vision | computer_find / browser_find_visual | `auto`; install Qwen3-VL 8B (6.2 GB) when control is used | No VL model for control is installed; Qwen3-VL 8B is the tested one | `PUT /api/vision/choice {model:"auto"\|"qwen3-vl-8b"\|"ui-tars-1.5-7b"}`; install: Install button `vision-model` (default: `auto`). **Found on the computer:** "auto" also uses any GGUF with an `mmproj*.gguf` beside it (prefers gemma-4-12b, then Qwen3-VL, Qwen2.5-VL, UI-TARS, others; non-Qwen families get the Qwen3 point format, best effort). `/api/models/jobs` shows `vision` as `ready` with that model, or `none` with a download offer (tap only, left out of "set up everything") |
| Helpers in the chat | lookup / research / build sub-agents | lookup `small`, research `auto`, build `inherit` | Lookups are quick; a build helper reuses the loaded Qwen3.6-27B instead of loading a second big model | `PUT /api/helpers/settings {models:{lookup,research,build}}` (default: `auto` for all) |
| Self-work | Long local coding runs | Qwen3.6-27B | His self-work model; the automatic pick (code-model.ts) can choose Coder-Next, which does not fit the card | `POST /api/self-work/start {modelId:"llamacpp/<Qwen3.6-27B file>"}` per run (default: pickCodeModel, else chat) |
| Task inbox | Antigravity / OpenCode Go tasks | Gemini default; OpenCode small `opencode-go/mimo-v2.6-flash`, strong `opencode-go/mimo-v2.6-pro` | Defaults are his (2026-11-19); local tasks go through self-work | `PUT /api/task-inbox/settings {model, opencode:{small,strong}}` |
| Study courses | Course chat, quizzes, summaries | DictaLM-3.0-24B-Thinking (default) | Best Hebrew model installed; picked by itself as the biggest DictaLM | per course (course settings); default: biggest DictaLM on disk |
| Coach | Prompt and usage advice | unset (the conversation's model) | No extra load on the card | `PUT /api/coach/settings {modelId:null}` |
| Free cloud helpers | Fallback when the local model is busy | each service's free default | Background only (his setting) | `PUT` free-cloud settings, `freeCloud.models` |

Not to use by default here: Qwen3-Coder-Next (~38 GB), huihui Coder-Next abliterated (~48 GB), Qwen3.8-Flash-Next
(~84 GB): all spill far past 24 GB into RAM. Qwen3.8-27B UD-Q4 and gemma-4-31B are good alternatives to Qwen3.6-27B
for chat (gemma-4-31B sees pictures, but at 18.8 GB leaves less room for context).

## Headless smoke run of a ComfyUI flow

`POST /api/comfy-ui/flows/:id/smoke` (computer only) checks that a ready-made flow (music, 3D, video, ...) works without
opening ComfyUI's page: it starts ComfyUI if needed, runs the flow with the smallest settings (music 5 s; video 5 frames
at 256 x 256; 3D a short latent and a coarse mesh; 2 sampler steps; a generated test picture for the loaders), waits up to
10 minutes and answers `{ok, seconds, outputs:[{kind,file}], error}`. Video and 3D unload the chat model first. The
"Test" button beside each ready flow (Nodes page, Ready-made menu) shows the same: a check with the seconds, or the error.

## Sweep 23.11 (PC on 0.6.461, one tiny real job per category through KesherAI's API)

| Category | Model | Result |
|---|---|---|
| Chat | Qwen3.6-27B Q4_K_M | works (10 s, with /no_think) |
| Hebrew chat | DictaLM-3.0-Nemotron-12B | fails: empty answer, all tokens spent thinking, reasoning not shown (fix in progress) |
| Router / inline code | Qwen3.5-2B | fails: same empty answer (fix in progress) |
| Image | Qwen-Image-2512 Q4_K_M, 512 px, 8 steps | works (35 s) |
| Text to speech | Kokoro | works (3 s) |
| Speech to text | ivrit-ai large-v3-turbo | works: Kokoro's sentence came back word for word (1 s) |
| Embedding search | Qwen3-Embedding-0.6B | works (7 s) |
| Translator | translategemma-4b | failed: file not found, ran through Gemini (fixed in 3a4bbee3) |
| Vision | auto | failed: nothing detected though gemma-4 + mmproj is on disk (fixed in 3a4bbee3) |
| Video / music / 3D | Wan 2.2 5B / ACE-Step 1.5 / Hunyuan3D 2 | flows ready and models present; not run: KesherAI has no API to run a ComfyUI flow headless yet |
| Hebrew voice | F5-TTS | not installed (3.6 GB, waits for Roee's tap) |
