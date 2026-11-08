package dev.kesherai.wol;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.net.DatagramSocket;
import java.net.InetAddress;

/**
 * Wakes a sleeping computer with a Wake-on-LAN "magic packet": six 0xFF bytes
 * followed by the network card's MAC address sixteen times, sent as a UDP
 * broadcast on ports 9 and 7. The computer's network card must have
 * Wake-on-LAN turned on, and the phone must be on the same network.
 */
@CapacitorPlugin(name = "WakeOnLan")
public class WakeOnLanPlugin extends Plugin {

    @PluginMethod
    public void wake(PluginCall call) {
        final String mac = call.getString("mac");
        final String broadcast = call.getString("broadcast", "255.255.255.255");
        if (mac == null) {
            call.reject("mac is required");
            return;
        }
        new Thread(() -> {
            try {
                byte[] macBytes = parseMac(mac);
                byte[] packet = new byte[6 + 16 * macBytes.length];
                for (int i = 0; i < 6; i++) packet[i] = (byte) 0xFF;
                for (int i = 6; i < packet.length; i += macBytes.length) {
                    System.arraycopy(macBytes, 0, packet, i, macBytes.length);
                }
                try (DatagramSocket socket = new DatagramSocket()) {
                    socket.setBroadcast(true);
                    for (String host : new String[] { broadcast, "255.255.255.255" }) {
                        InetAddress address = InetAddress.getByName(host);
                        for (int port : new int[] { 9, 7 }) {
                            socket.send(new DatagramPacket(packet, packet.length, address, port));
                        }
                    }
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not send the wake packet: " + e.getMessage());
            }
        }).start();
    }

    /**
     * Finds computers on this phone's network with a port open (KesherAI's 7420):
     * tries every address of each home network the phone is on (a /24), quickly and in parallel.
     */
    @PluginMethod
    public void scan(PluginCall call) {
        final int port = call.getInt("port", 7420);
        final int timeout = call.getInt("timeout", 350);
        new Thread(() -> {
            try {
                List<String> prefixes = new ArrayList<>();
                for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (java.net.InetAddress a : Collections.list(ni.getInetAddresses())) {
                        if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                        String ip = a.getHostAddress();
                        String prefix = ip.substring(0, ip.lastIndexOf('.') + 1);
                        if (!prefixes.contains(prefix)) prefixes.add(prefix);
                    }
                }
                final List<String> found = Collections.synchronizedList(new ArrayList<>());
                ExecutorService pool = Executors.newFixedThreadPool(64);
                for (String prefix : prefixes) {
                    for (int i = 1; i < 255; i++) {
                        final String host = prefix + i;
                        pool.execute(() -> {
                            try (Socket s = new Socket()) {
                                s.connect(new InetSocketAddress(host, port), timeout);
                                found.add(host);
                            } catch (Exception ignored) {
                                // nothing there
                            }
                        });
                    }
                }
                pool.shutdown();
                pool.awaitTermination(30, TimeUnit.SECONDS);
                JSArray hosts = new JSArray();
                for (String h : found) hosts.put(h);
                JSArray nets = new JSArray();
                for (String p : prefixes) nets.put(p + "0/24");
                JSObject out = new JSObject();
                out.put("hosts", hosts);
                out.put("networks", nets);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Could not scan the network: " + e.getMessage());
            }
        }).start();
    }

    private static byte[] parseMac(String mac) {
        String[] parts = mac.split("[:-]");
        if (parts.length != 6) throw new IllegalArgumentException("Invalid MAC address: " + mac);
        byte[] bytes = new byte[6];
        for (int i = 0; i < 6; i++) bytes[i] = (byte) Integer.parseInt(parts[i], 16);
        return bytes;
    }
}
