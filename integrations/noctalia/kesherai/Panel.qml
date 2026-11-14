import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Services.UI
import qs.Widgets

// A small KesherAI panel: ask, read the answer as it comes, open the chat in KesherAI.
Item {
  id: root
  property var pluginApi: null
  readonly property var main: pluginApi?.mainInstance
  readonly property var geometryPlaceholder: panelContainer
  // The size the user dragged it to (saved), or the default. Noctalia's panel follows these as they change.
  readonly property real minW: 320 * Style.uiScaleRatio
  readonly property real minH: 300 * Style.uiScaleRatio
  property real contentPreferredWidth: Math.max(minW, (pluginApi?.pluginSettings?.panelWidth ?? 440) * Style.uiScaleRatio)
  property real contentPreferredHeight: Math.max(minH, (pluginApi?.pluginSettings?.panelHeight ?? 520) * Style.uiScaleRatio)
  // A bar at the bottom opens the panel upward: dragging up makes it taller there.
  readonly property bool opensUp: (Settings.data?.bar?.position ?? "top") === "bottom"
  readonly property bool allowAttach: true
  property string question: ""

  anchors.fill: parent

  Rectangle {
    id: panelContainer
    anchors.fill: parent
    color: "transparent"

    ColumnLayout {
      anchors.fill: parent
      anchors.margins: Style.marginL
      spacing: Style.marginM

      NText {
        text: "KesherAI"
        pointSize: Style.fontSizeL
        font.weight: Font.Medium
        color: Color.mOnSurface
      }

      NText {
        visible: !root.main || !root.main.online
        Layout.fillWidth: true
        wrapMode: Text.Wrap
        text: pluginApi?.tr("panel.offline") ?? "KesherAI is not running on this computer (or the address in the settings is wrong)."
        color: Color.mOnSurfaceVariant
      }

      NTextInput {
        Layout.fillWidth: true
        placeholderText: pluginApi?.tr("panel.placeholder") ?? "Ask your local AI…"
        text: root.question
        onTextChanged: root.question = text
      }

      RowLayout {
        spacing: Style.marginS
        NButton {
          text: root.main && root.main.busy ? (pluginApi?.tr("panel.working") ?? "Working…") : (pluginApi?.tr("panel.ask") ?? "Ask")
          enabled: root.main && !root.main.busy && root.question.trim().length > 0
          onClicked: {
            root.main.ask(root.question.trim());
            root.question = "";
          }
        }
        NButton {
          visible: root.main && root.main.chatId !== ""
          text: pluginApi?.tr("panel.open-chat") ?? "Open in KesherAI"
          onClicked: root.main.openApp("#/c/" + root.main.chatId)
        }
      }

      NBox {
        Layout.fillWidth: true
        Layout.fillHeight: true
        NScrollView {
          anchors.fill: parent
          anchors.margins: Style.marginM
          NText {
            width: parent.width
            wrapMode: Text.Wrap
            text: root.main ? (root.main.error || root.main.answer) : ""
            color: root.main && root.main.error ? Color.mError : Color.mOnSurface
          }
        }
      }
    }

    // Resize by dragging a bottom corner (or the top corners when the panel opens upward), as a window's corner.
    Repeater {
      model: [-1, 1]
      delegate: MouseArea {
        required property int modelData
        readonly property int side: modelData
        width: 18 * Style.uiScaleRatio
        height: 18 * Style.uiScaleRatio
        anchors.left: side < 0 ? parent.left : undefined
        anchors.right: side > 0 ? parent.right : undefined
        anchors.bottom: root.opensUp ? undefined : parent.bottom
        anchors.top: root.opensUp ? parent.top : undefined
        hoverEnabled: true
        preventStealing: true
        cursorShape: (side > 0) !== root.opensUp ? Qt.SizeFDiagCursor : Qt.SizeBDiagCursor
        property point start
        property real startW
        property real startH
        onPressed: (mouse) => {
          start = mapToGlobal(mouse.x, mouse.y);
          startW = root.contentPreferredWidth;
          startH = root.contentPreferredHeight;
        }
        onPositionChanged: (mouse) => {
          if (!pressed) return;
          const p = mapToGlobal(mouse.x, mouse.y);
          root.contentPreferredWidth = Math.max(root.minW, startW + side * (p.x - start.x));
          root.contentPreferredHeight = Math.max(root.minH, startH + (root.opensUp ? start.y - p.y : p.y - start.y));
        }
        onReleased: {
          if (!pluginApi) return;
          pluginApi.pluginSettings.panelWidth = Math.round(root.contentPreferredWidth / Style.uiScaleRatio);
          pluginApi.pluginSettings.panelHeight = Math.round(root.contentPreferredHeight / Style.uiScaleRatio);
          pluginApi.saveSettings();
        }
        onDoubleClicked: {
          // Back to the default size.
          root.contentPreferredWidth = 440 * Style.uiScaleRatio;
          root.contentPreferredHeight = 520 * Style.uiScaleRatio;
          if (!pluginApi) return;
          pluginApi.pluginSettings.panelWidth = 440;
          pluginApi.pluginSettings.panelHeight = 520;
          pluginApi.saveSettings();
        }
        // A small grip so the corner is found.
        Canvas {
          anchors.fill: parent
          opacity: parent.containsMouse || parent.pressed ? 0.9 : 0.35
          onPaint: {
            const c = getContext("2d");
            c.reset();
            c.strokeStyle = Color.mOnSurfaceVariant;
            c.lineWidth = 1.5;
            const w = width, h = height;
            for (let k = 1; k <= 2; k++) {
              const d = k * w / 3;
              c.beginPath();
              const x0 = side > 0 ? w - d : d, x1 = side > 0 ? w : 0;
              const yA = root.opensUp ? 0 : h, yB = root.opensUp ? d : h - d;
              c.moveTo(x0, yA);
              c.lineTo(x1, yB);
              c.stroke();
            }
          }
        }
      }
    }
  }
}
