# Local models: engine, quants and vision

**עברית בקצרה:** KesherAI מוריד ומריץ בעצמו את llama.cpp (CUDA ל-NVIDIA, Vulkan לשאר, Metal ב-Mac). כל מודל מקבל סימון התאמה למחשב שלך (טוב / בסדר / איטי / גדול מדי) ותחזית מהירות. בוחרים קוונטיזציה (Q4_K_M היא ברירת מחדל טובה) לפי הזיכרון. למודלי ראייה נדרש גם קובץ mmproj; הם משמשים לשליטה במחשב ובדפדפן לפי צילום מסך.

## What it does
Runs GGUF chat models in the built-in llama.cpp engine, with no LM Studio or Ollama needed (you can still connect them). Before loading, `llama-fit-params` shows how many layers go on each graphics card and how much memory is left.

## Prerequisites
A computer with a GPU is best; CPU works but slowly. Disk space for models; a Hugging Face connection to download.

## Steps
1. **Engine:** the first start downloads the llama.cpp build for your hardware. Nothing to install by hand.
2. **Pick a model:** "Set it up for me" (conservative / balanced / extreme) or the Models page: one-click models and Hugging Face search.
3. **Read the fit mark** on each model: good, OK, slow or too big, with the expected speed. Choose the quant that fits: smaller quant (Q4) means less memory and a little less quality; larger (Q6, Q8) the reverse. Keep some memory free for the context.
4. **Safetensors** models are for ComfyUI; **GGUF** loads in the built-in engine.
5. **Vision models for computer control:** Settings > "Computer & browser vision" lists Qwen3-VL 8B (default, about 5 GB plus a 1.2 GB projector) and UI-TARS-1.5 7B. Install adds both the model and its `mmproj` file. They run in their own llama.cpp server and unload after 10 idle minutes.

## Verify
Load a model and send "hello"; the speed shows under the answer. For vision, ask the chat to find a button in a window (`computer_find`).

## Troubleshooting
- Too big: pick a smaller quant or fewer context tokens. A second loaded model reduces free memory.
- Slow: check that the GPU build was chosen (on Linux Vulkan needs `libvulkan.so.1`).
- Vision tool says no model: press the Install button the chat shows.

## Safety
Downloads are checked with SHA-256. Models run on your computer; nothing is sent out unless you connect a cloud provider.
