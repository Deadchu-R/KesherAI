# ComfyUI and the PBR texture flow

**עברית בקצרה:** KesherAI מתחבר ל-ComfyUI (מזהה אוטומטית או מתקין מנוהל) ומריץ בו תמונות, וידאו, צליל ו-3D. הכלי `make_pbr_texture` יוצר טקסטורה חוזרת (seamless) ממילים: אלבדו ב-ComfyUI, בדיקת תפר ותיקון, ואז נורמל, חספוס, AO וגובה מחושבים במחשב. כדאי להתקין את הצומת `ComfyUI-seamless-tiling` למשבצת מושלמת.

## What it does
Runs graphs in ComfyUI from chat and the editors. For materials, one request makes a tileable albedo plus normal, roughness, AO and height maps, shown as a grid and a lit sphere.

## Prerequisites
ComfyUI installed (or let KesherAI manage it), a checkpoint in its `checkpoints` folder, a GPU with enough memory. Some features need a recent ComfyUI (sound 0.22+, 3D 0.34+, painting a model 0.46+).

## Steps
1. **Install/connect:** open the Nodes (ComfyUI) page. A running ComfyUI is detected; otherwise use the install button (it asks before downloading).
2. **Models:** put checkpoints in ComfyUI's folders or download from the Models page; KesherAI asks before big downloads and shows the size.
3. **Seamless nodes:** in ComfyUI install `ComfyUI-seamless-tiling` (nodes `SeamlessTile`, `CircularVAEDecode`) through ComfyUI-Manager, then restart ComfyUI. The model and VAE then pad circularly and the picture tiles as it is made.
4. Without them (or with models such as FLUX that do not pad), the flow still works: a seam check finds the seam and a fix pass offsets the picture by half and inpaints the cross, using core nodes only.
5. Ask in chat: "tileable rusty metal texture". The maps tile exactly because every filter wraps around the edges.

## Verify
The result shows five maps; tile the albedo 3x3 in the viewer and look for a seam.

## Troubleshooting
- "ComfyUI not found": start it, or press install; business mode can block it.
- Missing node errors: install the named custom node and restart.
- Out of memory: use a smaller checkpoint or lower the size.

## Safety
Custom nodes are code that runs on your computer; install only ones you trust. KesherAI uses only ComfyUI's own nodes plus the one seamless pack, and sends nothing outside the computer.
