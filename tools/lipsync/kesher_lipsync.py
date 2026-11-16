"""
KesherAI's lip sync for the avatar camera (strong NVIDIA computers, optional).

Listens to the microphone; while the student speaks, MuseTalk moves the lips of her own recorded clip to her voice
and the frames go, as JPEG over a websocket, to the avatar page (#/avatar-feed), which draws them over its idle loop.
When she is silent nothing is sent and the page shows the recorded loop. Optionally (--cable) her voice is played,
held back by the frames' delay, into a virtual audio cable that Zoom or Teams uses as its microphone, so lips and
voice arrive together.

Runs from MuseTalk's folder (its models are under ./models). Listens on 127.0.0.1 only and needs KesherAI's token.
"""
import argparse
import asyncio
import collections
import copy
import glob
import hashlib
import json
import math
import os
import pickle
import sys
import threading
import time

import cv2
import numpy as np
import torch

SR = 16000
FPS = 25
STEP = 5  # frames made per step (0.2 s)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--clip", required=True, help="the student's recorded avatar clip")
    p.add_argument("--work", required=True, help="where the prepared avatar is kept")
    p.add_argument("--port", type=int, default=28790)
    p.add_argument("--token", default="")
    p.add_argument("--mic", default=None, help="input device (name or index); default: Windows' default microphone")
    p.add_argument("--cable", default=None, help="output device for the held-back voice (e.g. 'CABLE Input')")
    p.add_argument("--threshold", type=float, default=0.012, help="speech level (RMS) that counts as talking")
    p.add_argument("--prepare-only", action="store_true")
    return p.parse_args()


class Models:
    """MuseTalk 1.5's models in half precision on the graphics card."""

    def __init__(self):
        from transformers import WhisperModel
        from musetalk.utils.utils import load_all_model
        from musetalk.utils.audio_processor import AudioProcessor
        from musetalk.utils.face_parsing import FaceParsing

        self.device = torch.device("cuda:0")
        self.vae, self.unet, self.pe = load_all_model(unet_model_path="models/musetalkV15/unet.pth", vae_type="sd-vae", unet_config="models/musetalkV15/musetalk.json", device=self.device)
        self.pe = self.pe.half().to(self.device)
        self.vae.vae = self.vae.vae.half().to(self.device)
        self.unet.model = self.unet.model.half().to(self.device)
        self.dtype = self.unet.model.dtype
        self.timesteps = torch.tensor([0], device=self.device)
        self.audio = AudioProcessor(feature_extractor_path="models/whisper")
        self.whisper = WhisperModel.from_pretrained("models/whisper").to(device=self.device, dtype=self.dtype).eval()
        self.whisper.requires_grad_(False)
        self.fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)


class Avatar:
    """The clip prepared once (faces, latents, masks), kept in --work and redone when the clip changes."""

    def __init__(self, m, clip, work):
        st = os.stat(clip)
        key = hashlib.sha1(f"{clip}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:12]
        self.dir = os.path.join(work, key)
        if not os.path.exists(os.path.join(self.dir, "done")):
            self.prepare(m, clip)
        self.load()

    def prepare(self, m, clip):
        from musetalk.utils.preprocessing import get_landmark_and_bbox
        from musetalk.utils.blending import get_image_prepare_material

        log("preparing the avatar from", clip)
        os.makedirs(os.path.join(self.dir, "full"), exist_ok=True)
        os.makedirs(os.path.join(self.dir, "mask"), exist_ok=True)
        cap = cv2.VideoCapture(clip)
        frames = []
        # At most 20 s of the clip at 25 fps (the cycle plays forward then back).
        while len(frames) < 500:
            ok, f = cap.read()
            if not ok:
                break
            frames.append(f)
        if not frames:
            raise SystemExit("The clip could not be read.")
        paths = []
        for i, f in enumerate(frames):
            pth = os.path.join(self.dir, "full", f"{i:08d}.png")
            cv2.imwrite(pth, f)
            paths.append(pth)
        coords, frame_list = get_landmark_and_bbox(paths, 0)
        latents = []
        keep = []
        for (bbox, frame) in zip(coords, frame_list):
            if bbox == (0.0, 0.0, 0.0, 0.0):
                continue
            x1, y1, x2, y2 = bbox
            y2 = min(y2 + 10, frame.shape[0])
            crop = cv2.resize(frame[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
            latents.append(m.vae.get_latents_for_unet(crop))
            keep.append(((x1, y1, x2, y2), frame))
        if not keep:
            raise SystemExit("No face was found in the clip.")
        keep = keep + keep[::-1]
        latents = latents + latents[::-1]
        masks, mask_boxes = [], []
        for i, (bbox, frame) in enumerate(keep):
            mask, box = get_image_prepare_material(frame, list(bbox), fp=m.fp, mode="jaw")
            cv2.imwrite(os.path.join(self.dir, "mask", f"{i:08d}.png"), mask)
            masks.append(mask)
            mask_boxes.append(box)
        with open(os.path.join(self.dir, "meta.pkl"), "wb") as f:
            pickle.dump({"coords": [b for b, _ in keep], "mask_boxes": mask_boxes}, f)
        torch.save(latents, os.path.join(self.dir, "latents.pt"))
        for i, (_, frame) in enumerate(keep):
            cv2.imwrite(os.path.join(self.dir, "full", f"c{i:08d}.jpg"), frame)
        open(os.path.join(self.dir, "done"), "w").close()
        log("avatar ready:", len(keep), "frames")

    def load(self):
        with open(os.path.join(self.dir, "meta.pkl"), "rb") as f:
            meta = pickle.load(f)
        self.coords = meta["coords"]
        self.mask_boxes = meta["mask_boxes"]
        self.latents = torch.load(os.path.join(self.dir, "latents.pt"))
        self.frames = [cv2.imread(p) for p in sorted(glob.glob(os.path.join(self.dir, "full", "c*.jpg")))]
        self.masks = [cv2.imread(p) for p in sorted(glob.glob(os.path.join(self.dir, "mask", "*.png")))]
        self.n = len(self.frames)


class Mic:
    """The microphone into a 4-second ring, and (with --cable) the voice held back by `delay` into the cable."""

    def __init__(self, device, cable):
        import sounddevice as sd

        self.ring = collections.deque(maxlen=SR * 4)
        self.lock = threading.Lock()
        self.delay = 0.3
        self.out = collections.deque()
        self.stream = sd.InputStream(samplerate=SR, channels=1, dtype="float32", device=device, blocksize=320, callback=self.on_audio)
        self.cable = None
        if cable:
            self.cable = sd.OutputStream(samplerate=SR, channels=1, dtype="float32", device=cable, blocksize=320, callback=self.on_play)
        self.stream.start()
        if self.cable:
            self.cable.start()

    def on_audio(self, data, frames, t, status):
        x = data[:, 0].copy()
        with self.lock:
            self.ring.extend(x)
            if self.cable:
                self.out.append(x)

    def on_play(self, data, frames, t, status):
        data.fill(0)
        with self.lock:
            # Wait until `delay` seconds of voice are queued, then play in order (the frames' delay).
            if sum(len(b) for b in self.out) < self.delay * SR:
                return
            got = 0
            while self.out and got < frames:
                b = self.out[0]
                take = min(len(b), frames - got)
                data[got:got + take, 0] = b[:take]
                got += take
                if take == len(b):
                    self.out.popleft()
                else:
                    self.out[0] = b[take:]

    def last(self, seconds):
        with self.lock:
            a = np.array(self.ring, dtype=np.float32)
        return a[-int(seconds * SR):]


class Clients:
    def __init__(self):
        self.all = set()

    async def send(self, msg):
        for ws in list(self.all):
            try:
                await ws.send(msg)
            except Exception:
                self.all.discard(ws)


@torch.no_grad()
def make_frames(m, av, audio, idx):
    """The last STEP frames of `audio` (1.2 s window), lip-synced onto the avatar's frames from `idx`."""
    feats, length = features(m, audio)
    chunks = m.audio.get_whisper_chunk(feats, m.device, m.dtype, m.whisper, length, fps=FPS, audio_padding_length_left=2, audio_padding_length_right=2)
    # The newest frames lack their right context (the next 0.08 s): take the ones just before them.
    end = chunks.shape[0] - 2
    chunks = chunks[end - STEP:end]
    lat = torch.cat([av.latents[(idx + i) % av.n] for i in range(STEP)]).to(device=m.device, dtype=m.dtype)
    pred = m.unet.model(lat, m.timesteps, encoder_hidden_states=m.pe(chunks.to(m.device))).sample
    recon = m.vae.decode_latents(pred.to(dtype=m.vae.vae.dtype))
    from musetalk.utils.blending import get_image_blending

    out = []
    for i, face in enumerate(recon):
        k = (idx + i) % av.n
        x1, y1, x2, y2 = av.coords[k]
        face = cv2.resize(face.astype(np.uint8), (x2 - x1, y2 - y1))
        frame = get_image_blending(copy.deepcopy(av.frames[k]), face, [x1, y1, x2, y2], av.masks[k], av.mask_boxes[k])
        out.append(frame)
    return out


def features(m, audio):
    f = m.audio.feature_extractor(audio, return_tensors="pt", sampling_rate=SR).input_features.to(dtype=m.dtype)
    return [f], len(audio)


async def main():
    a = parse()
    import websockets

    m = Models()
    av = Avatar(m, a.clip, a.work)
    if a.prepare_only:
        return
    mic = Mic(int(a.mic) if a.mic and a.mic.isdigit() else a.mic, a.cable)
    clients = Clients()

    async def handler(ws):
        path = getattr(getattr(ws, "request", None), "path", "") or getattr(ws, "path", "")
        if a.token and f"token={a.token}" not in path:
            await ws.close(4001, "token")
            return
        clients.all.add(ws)
        try:
            await ws.wait_closed()
        finally:
            clients.all.discard(ws)

    async with websockets.serve(handler, "127.0.0.1", a.port, max_size=2**20):
        log(json.dumps({"ready": True, "port": a.port, "frames": av.n}))
        idx = 0
        talking_until = 0.0
        was = False
        loop = asyncio.get_running_loop()
        tick = time.perf_counter()
        while True:
            tick += STEP / FPS
            await asyncio.sleep(max(0, tick - time.perf_counter()))
            recent = mic.last(0.2)
            level = float(np.sqrt(np.mean(recent ** 2))) if len(recent) else 0.0
            now = time.perf_counter()
            if level > a.threshold:
                talking_until = now + 0.5  # a short pause between words keeps the lips going
            talking = now < talking_until
            if talking != was:
                was = talking
                await clients.send(json.dumps({"talking": talking}))
            if not talking or not clients.all:
                idx = (idx + STEP) % av.n
                continue
            t0 = time.perf_counter()
            frames = await loop.run_in_executor(None, make_frames, m, av, mic.last(1.2), idx)
            idx = (idx + STEP) % av.n
            spent = time.perf_counter() - t0
            # The voice is held back by what the frames take (window lag + making them), for the cable.
            mic.delay = 0.08 + spent + 0.1
            for f in frames:
                ok, jpg = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 85])
                if ok:
                    await clients.send(jpg.tobytes())
            if spent > STEP / FPS:
                tick = time.perf_counter()  # behind: skip ahead rather than pile up


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
