// KesherAI's avatar camera: a "KesherAI Camera" that Zoom, Teams and other DirectShow apps can choose.
// The desktop app writes raw frames to this program's stdin: 1280 x 720, 3 bytes per pixel (BGR, as softcam
// expects), top row first. Each full frame is sent to the camera at once (the app paces them). The program ends
// when stdin closes. Built in the release workflow against softcam (MIT, https://github.com/tshino/softcam).
#include <cstdio>
#include <vector>
#include <fcntl.h>
#include <io.h>
#include "softcam.h"

int main() {
  const int width = 1280, height = 720;
  const size_t frame = static_cast<size_t>(width) * height * 3;
  _setmode(_fileno(stdin), _O_BINARY);
  scCamera cam = scCreateCamera(width, height, 0.0f);
  if (!cam) {
    std::fprintf(stderr, "kesher-cam: the camera could not be made (is another one running?)\n");
    return 2;
  }
  std::vector<unsigned char> buf(frame);
  for (;;) {
    size_t got = 0;
    while (got < frame) {
      size_t n = std::fread(buf.data() + got, 1, frame - got, stdin);
      if (n == 0) {
        scDeleteCamera(cam);
        return 0;
      }
      got += n;
    }
    scSendFrame(cam, buf.data());
  }
}
