# Waking the computer from the phone

KesherAI runs on your computer, so the computer has to be awake for the phone to reach it. There are two ways to handle sleep.

## Keep it awake

Settings → Phone → **Keep this computer awake while remote access is on**. The desktop app then stops Windows and macOS from sleeping while remote access is enabled. The screen can still turn off.

## Wake it from sleep (Wake-on-LAN)

A sleeping computer cannot wake itself. Another device on the **same network** sends it a small "magic packet", and the network card turns the computer on.

The Android app does this: when it cannot reach KesherAI, it shows **Wake the computer**. It sends the packet, then tries to connect for about a minute. The pairing link from Settings → Phone carries the network card's address (`wake=` and `bcast=`), so scan or copy the link again after updating KesherAI.

### One-time setup on Windows

1. **Device Manager → Network adapters →** your network card **→ Properties**.
   - **Power Management:** tick *Allow this device to wake the computer* and *Only allow a magic packet to wake the computer*.
   - **Advanced:** set *Wake on Magic Packet* to **Enabled**. Some cards also have *Wake on pattern match* and *Shutdown Wake-On-Lan*; enable them too.
2. **Control Panel → Power Options → Choose what the power buttons do →** *Change settings that are currently unavailable* → untick **Turn on fast startup** (fast startup often blocks waking from "shut down").
3. In the **BIOS/UEFI** (usually Del or F2 at start-up), turn on *Wake on LAN*, *Power On By PCI-E* or similar, and turn off *ErP / EuP* (deep power saving).

### What works

- **Wired Ethernet** works almost always. **Wi-Fi** wake is supported only by some laptops and cards.
- **Sleep** works best. **Hibernate** and **shut down** work only if the BIOS allows it.
- The phone must be on the **same home network**. Routers drop magic packets that come from the internet.

### From outside the home

Use an always-on device at home to send the packet: a router with a Wake-on-LAN page, a Raspberry Pi, or a Home Assistant box, reached through Tailscale. KesherAI never asks you to open a port on your router.
