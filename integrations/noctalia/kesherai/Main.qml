import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

// KesherAI's state for the bar (how many chats are working), and asking it from the panel. It talks to KesherAI's
// own API on this computer (or another of yours, with its remote-access token in the settings). Only curl is used.
Item {
  id: root
  property var pluginApi: null

  property var cfg: pluginApi?.pluginSettings || ({})
  property var defaults: pluginApi?.manifest?.metadata?.defaultSettings || ({})
  readonly property string baseUrl: String(cfg.url ?? defaults.url ?? "http://127.0.0.1:7420").replace(/\/$/, "")
  readonly property string token: String(cfg.token ?? defaults.token ?? "")

  property bool online: false
  property int working: 0
  property string chatId: ""
  property string answer: ""
  property bool busy: false
  property string error: ""

  function headers() {
    return token ? ["-H", "Authorization: Bearer " + token] : [];
  }
  function curl(method, path, body) {
    var args = ["curl", "-sf", "--connect-timeout", "3", "--max-time", "20", "-X", method].concat(headers());
    if (body !== undefined) args = args.concat(["-H", "Content-Type: application/json", "-d", JSON.stringify(body)]);
    return args.concat([baseUrl + path]);
  }

  // Opens KesherAI (a chat, when given) in the browser or the desktop app's address.
  function openApp(path) {
    Quickshell.execDetached(["xdg-open", baseUrl + "/" + (path || "")]);
  }

  // Asks in a new KesherAI chat; the answer is read as it comes.
  function ask(text) {
    if (!text || busy) return;
    busy = true;
    answer = "";
    error = "";
    createProcess.command = curl("POST", "/api/conversations", { "kind": "chat" });
    createProcess.pending = text;
    createProcess.running = true;
  }

  Process {
    id: statusProcess
    command: root.curl("GET", "/api/conversations/activity")
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          var a = JSON.parse(text);
          root.working = Object.keys(a).length;
          root.online = true;
        } catch (e) {
          root.online = false;
        }
      }
    }
    onExited: function (code) {
      if (code !== 0) root.online = false;
    }
  }

  Process {
    id: createProcess
    property string pending: ""
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.chatId = JSON.parse(text).id;
          sendProcess.command = root.curl("POST", "/api/conversations/" + root.chatId + "/messages", { "text": createProcess.pending });
          sendProcess.running = true;
        } catch (e) {
          root.busy = false;
          root.error = pluginApi?.tr("panel.offline") ?? "KesherAI did not answer.";
        }
      }
    }
  }

  Process {
    id: sendProcess
    onExited: function (code) {
      if (code !== 0) {
        root.busy = false;
        root.error = pluginApi?.tr("panel.offline") ?? "KesherAI did not answer.";
      } else readTimer.start();
    }
  }

  Process {
    id: readProcess
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          var c = JSON.parse(text);
          var ev = c.events || [];
          for (var i = ev.length - 1; i >= 0; i--) {
            if (ev[i].type === "assistant") {
              root.answer = String(ev[i].text || "").replace(/<think>[\s\S]*?<\/think>\s*/g, "");
              break;
            }
          }
          var st = c.session && c.session.status;
          if (st === "idle" || st === "error") {
            root.busy = false;
            readTimer.stop();
          }
        } catch (e) {}
      }
    }
  }

  Timer {
    id: readTimer
    interval: 1500
    repeat: true
    onTriggered: {
      readProcess.command = root.curl("GET", "/api/conversations/" + root.chatId);
      readProcess.running = true;
    }
  }

  Timer {
    interval: 10000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: statusProcess.running = true
  }

  IpcHandler {
    target: "plugin:kesherai"
    function toggle() {
      if (pluginApi) pluginApi.withCurrentScreen(screen => pluginApi.togglePanel(screen));
    }
  }
}
