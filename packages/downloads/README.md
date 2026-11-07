# @kesher/downloads

The in-app model downloader, in the spirit of LM Studio's — but for every category, not only LLMs.

| File | What it does |
| --- | --- |
| `huggingface.ts` | Searches the Hugging Face Hub and lists a repo's files with their sizes and SHA-256 hashes |
| `downloader.ts` | `DownloadManager`: a queue that resumes interrupted downloads (HTTP `Range`) and verifies SHA-256 when it finishes |
| `hardware.ts` | Reads RAM and, when `nvidia-smi` exists, GPU name and VRAM; `estimateFit` turns that into a green / yellow / red badge |

The manager writes to `<file>.part` and renames on success, so a half-downloaded file is never mistaken for a model. Where files land is decided by the caller (the core server puts image models in ComfyUI's folders when one is configured).
