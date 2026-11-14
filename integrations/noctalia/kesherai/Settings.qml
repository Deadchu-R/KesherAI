import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Widgets

// Where KesherAI is: this computer by default; another of yours with its address and remote-access token.
ColumnLayout {
  id: root
  property var pluginApi: null
  property var cfg: pluginApi?.pluginSettings || ({})
  property var defaults: pluginApi?.manifest?.metadata?.defaultSettings || ({})
  property string editUrl: cfg.url ?? defaults.url ?? "http://127.0.0.1:7420"
  property string editToken: cfg.token ?? defaults.token ?? ""
  spacing: Style.marginL

  NTextInput {
    Layout.fillWidth: true
    label: pluginApi?.tr("settings.url.label") ?? "KesherAI's address"
    description: pluginApi?.tr("settings.url.desc") ?? "This computer: http://127.0.0.1:7420"
    text: root.editUrl
    onTextChanged: root.editUrl = text
  }

  NTextInput {
    Layout.fillWidth: true
    label: pluginApi?.tr("settings.token.label") ?? "Remote-access token (another computer only)"
    description: pluginApi?.tr("settings.token.desc") ?? "Empty for this computer."
    text: root.editToken
    onTextChanged: root.editToken = text
  }

  function saveSettings() {
    pluginApi.pluginSettings.url = root.editUrl.trim();
    pluginApi.pluginSettings.token = root.editToken.trim();
    pluginApi.saveSettings();
  }
}
