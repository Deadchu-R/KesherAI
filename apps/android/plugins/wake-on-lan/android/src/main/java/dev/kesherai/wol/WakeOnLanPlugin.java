package dev.kesherai.wol;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
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

    private static byte[] parseMac(String mac) {
        String[] parts = mac.split("[:-]");
        if (parts.length != 6) throw new IllegalArgumentException("Invalid MAC address: " + mac);
        byte[] bytes = new byte[6];
        for (int i = 0; i < 6; i++) bytes[i] = (byte) Integer.parseInt(parts[i], 16);
        return bytes;
    }
}
