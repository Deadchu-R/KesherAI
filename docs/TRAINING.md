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

## Step 2: a dataset for a chat model

Choose chats and, if you like, your documents (the Pages page). Then press **Make the dataset**.
- **Chats** become question → answer pairs.
- **Documents** are cut into parts of about 1500 characters, and each part becomes a "write in my style" example.

The dataset is saved as `training/datasets/<name>.jsonl` in the common `messages` chat format, which LoRA trainers such as unsloth and axolotl read. Nothing leaves the computer. It needs at least 20 examples, and hundreds is better.

## Step 3 (experimental): train a chat model

This needs an NVIDIA card with 8 GB or more.

1. Press **Set up the trainer** once. It downloads about 4 GB (Python 3.12, PyTorch for CUDA and unsloth, which is Apache-2.0) into `engines/unsloth`, in a folder of its own.
2. Choose a dataset from step 2, a small base model (Llama 3.2 3B, Qwen 2.5 3B or Gemma 3 4B, each under its own licence) and the number of steps.
3. The training makes a LoRA. It is merged and saved as a q4_k_m GGUF in `models/chat`, so it shows with your chat models. If the GGUF export fails, the LoRA is still saved, and the log says where.
4. **If the card runs out of memory:** choose a smaller base model, fewer steps or a lower rank.
- **Voice:** a voice of your own, made from a few minutes of speech.
