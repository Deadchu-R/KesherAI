# Training models

The **Train models** page (Create → Train models) shows what this computer can train and what it still needs.

## Step 1: a picture LoRA

A LoRA is a small add-on to a picture model. It teaches the model a style, a character or an object from 10 to 30 of your own pictures.

**What you need:**
- An NVIDIA graphics card. 8 GB is enough for SD 1.5; SDXL needs 12 GB or more.
- ComfyUI, installed and running from the Nodes page.
- An SD 1.5 or SDXL checkpoint in ComfyUI's `models/checkpoints` folder.

**How to train one:** give it a name, a trigger word (for example `mycat`), a base model and the pictures, then press **Start training**. With the default 600 steps it takes about 15 to 60 minutes, depending on the card.

**How it works:** the training uses ComfyUI's own training nodes (`TrainLoraNode`, the dataset loader and `SaveLoRA`; their names differ between ComfyUI versions, and KesherAI uses whichever ones the installed ComfyUI has).
- The pictures are made smaller (at most 1024 px) and copied into `ComfyUI/input/kesher-train-<name>`. That folder is removed when the training ends.
- The LoRA file is copied to the picture engine's LoRA folder, so it shows on the **Images** page. It is also copied to ComfyUI's `models/loras`.
- To use it, write the trigger word in your prompt.
- **If the card runs out of memory:** choose SD 1.5, fewer steps or a lower rank.

## Next steps

- **Chat:** a LoRA on your own texts (your writing or your notes), with this computer's limits shown first.
- **Voice:** a voice of your own, made from a few minutes of speech.
