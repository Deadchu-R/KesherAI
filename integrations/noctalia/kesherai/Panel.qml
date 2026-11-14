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
  property real contentPreferredWidth: 440 * Style.uiScaleRatio
  property real contentPreferredHeight: 520 * Style.uiScaleRatio
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
  }
}
