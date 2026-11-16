package dev.kesherai.notify;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Android's native crash report (a "tombstone", protobuf since Android 12) as readable text: the signal, its cause,
 * the abort message and the backtrace of the thread that crashed. Only what the crash recorder needs, read by hand
 * (no protobuf library in the app). The fields are from AOSP's system/core/debuggerd/proto/tombstone.proto.
 */
final class Tombstone {
    private Tombstone() {}

    /** A small protobuf reader over one message. */
    private static final class Reader {
        final byte[] b;
        int i;
        final int end;

        Reader(byte[] b, int from, int end) {
            this.b = b;
            this.i = from;
            this.end = end;
        }

        boolean more() {
            return i < end;
        }

        long varint() throws IOException {
            long r = 0;
            for (int s = 0; s < 64; s += 7) {
                if (i >= end) throw new IOException("cut");
                int x = b[i++] & 0xff;
                r |= (long) (x & 0x7f) << s;
                if ((x & 0x80) == 0) return r;
            }
            throw new IOException("bad varint");
        }

        /** Skips a field of this wire type; for length-delimited ones, returns [from, to]. */
        int[] field(int wire) throws IOException {
            switch (wire) {
                case 0: varint(); return null;
                case 1: i += 8; return null;
                case 5: i += 4; return null;
                case 2: {
                    int n = (int) varint();
                    if (n < 0 || i + n > end) throw new IOException("cut");
                    int[] r = { i, i + n };
                    i += n;
                    return r;
                }
                default: throw new IOException("wire " + wire);
            }
        }

        String str(int[] r) {
            return new String(b, r[0], r[1] - r[0], StandardCharsets.UTF_8);
        }
    }

    /**
     * Reads a tombstone stream and describes the crash.
     *
     * @param in - ApplicationExitInfo's trace (at most 4 MB is read).
     * @return Text like "SIGSEGV (SEGV_MAPERR) null pointer dereference · thread X\n#0 fn+12 (libfoo.so)…", or
     *     the empty string when it is not a tombstone.
     */
    static String describe(InputStream in) {
        try {
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0 && all.size() < 4 * 1024 * 1024) all.write(buf, 0, n);
            byte[] b = all.toByteArray();
            Reader r = new Reader(b, 0, b.length);
            long tid = -1;
            String signal = "", abort = "";
            StringBuilder causes = new StringBuilder();
            java.util.Map<Long, int[]> threads = new java.util.HashMap<>();
            while (r.more()) {
                long key = r.varint();
                int no = (int) (key >>> 3), wire = (int) (key & 7);
                if (no == 6 && wire == 0) { tid = r.varint(); continue; }
                int[] f = r.field(wire);
                if (f == null) continue;
                if (no == 10) signal = signal(new Reader(b, f[0], f[1]));
                else if (no == 14) abort = r.str(f);
                else if (no == 15) {
                    Reader c = new Reader(b, f[0], f[1]);
                    while (c.more()) {
                        long k = c.varint();
                        int[] g = c.field((int) (k & 7));
                        if ((k >>> 3) == 1 && g != null) causes.append(causes.length() > 0 ? "; " : "").append(c.str(g));
                    }
                } else if (no == 16) {
                    // A map entry: key (1) = thread id, value (2) = the Thread.
                    Reader e = new Reader(b, f[0], f[1]);
                    long id = -1;
                    int[] value = null;
                    while (e.more()) {
                        long k = e.varint();
                        if ((k >>> 3) == 1 && (k & 7) == 0) { id = e.varint(); continue; }
                        int[] g = e.field((int) (k & 7));
                        if ((k >>> 3) == 2) value = g;
                    }
                    if (value != null) threads.put(id, value);
                }
            }
            if (signal.isEmpty() && threads.isEmpty()) return "";
            StringBuilder out = new StringBuilder(signal);
            if (causes.length() > 0) out.append(" · ").append(causes);
            if (!abort.isEmpty()) out.append("\nabort: ").append(abort);
            int[] t = threads.get(tid);
            if (t != null) out.append('\n').append(thread(new Reader(b, t[0], t[1])));
            String s = out.toString();
            return s.length() > 6000 ? s.substring(0, 6000) : s;
        } catch (Throwable e) {
            return "";
        }
    }

    private static String signal(Reader r) throws IOException {
        String name = "", code = "";
        long fault = -1;
        while (r.more()) {
            long k = r.varint();
            int no = (int) (k >>> 3), wire = (int) (k & 7);
            if (no == 9 && wire == 0) { fault = r.varint(); continue; }
            int[] f = r.field(wire);
            if (f == null) continue;
            if (no == 2) name = r.str(f);
            else if (no == 4) code = r.str(f);
        }
        return name + (code.isEmpty() ? "" : " (" + code + ")") + (fault >= 0 ? " at 0x" + Long.toHexString(fault) : "");
    }

    private static String thread(Reader r) throws IOException {
        String name = "";
        StringBuilder frames = new StringBuilder();
        int count = 0;
        while (r.more()) {
            long k = r.varint();
            int no = (int) (k >>> 3);
            int[] f = r.field((int) (k & 7));
            if (f == null) continue;
            if (no == 2) name = r.str(f);
            else if (no == 4 && count < 40) {
                Reader fr = new Reader(r.b, f[0], f[1]);
                String fn = "", file = "";
                long off = 0, rel = 0;
                while (fr.more()) {
                    long fk = fr.varint();
                    int fno = (int) (fk >>> 3), fw = (int) (fk & 7);
                    if (fw == 0) {
                        long v = fr.varint();
                        if (fno == 1) rel = v;
                        else if (fno == 5) off = v;
                        continue;
                    }
                    int[] g = fr.field(fw);
                    if (g == null) continue;
                    if (fno == 4) fn = fr.str(g);
                    else if (fno == 6) file = fr.str(g);
                }
                String lib = file.substring(file.lastIndexOf('/') + 1);
                frames.append("\n#").append(count++).append(' ')
                    .append(fn.isEmpty() ? "pc 0x" + Long.toHexString(rel) : fn + "+" + off)
                    .append(" (").append(lib).append(')');
            }
        }
        return "thread " + name + frames;
    }
}
