import Quickshell
import qs.Commons
import qs.Services.UI
import qs.Widgets

// The bar's KesherAI button: lit while chats are working, the count in the tooltip; click for the panel,
// right-click to open KesherAI.
NIconButton {
  id: root

  property var pluginApi: null
  property ShellScreen screen
  property string widgetId: ""
  property string section: ""
  property int sectionWidgetIndex: -1
  property int sectionWidgetsCount: 0

  readonly property var main: pluginApi?.mainInstance

  icon: "sparkles"
  tooltipText: !main || !main.online ? (pluginApi?.tr("widget.offline") ?? "KesherAI is not running") : main.working > 0 ? (pluginApi?.tr("widget.working", { "count": main.working }) ?? (main.working + " chats working")) : (pluginApi?.tr("widget.idle") ?? "KesherAI: ask something")
  tooltipDirection: BarService.getTooltipDirection(screen?.name)
  baseSize: Style.getCapsuleHeightForScreen(screen?.name)
  applyUiScale: false
  customRadius: Style.radiusL
  colorBg: Style.capsuleColor
  colorFg: main && main.working > 0 ? Color.mPrimary : main && main.online ? Color.mOnSurface : Color.mOnSurfaceVariant
  border.color: Style.capsuleBorderColor
  border.width: Style.capsuleBorderWidth

  onClicked: {
    if (pluginApi) pluginApi.togglePanel(root.screen, this);
  }

  NPopupContextMenu {
    id: contextMenu
    model: [
      { "label": pluginApi?.tr("menu.open") ?? "Open KesherAI", "action": "open", "icon": "external-link" },
      { "label": pluginApi?.tr("menu.settings") ?? "Settings", "action": "settings", "icon": "settings" }
    ]
    onTriggered: function (action) {
      contextMenu.close();
      PanelService.closeContextMenu(screen);
      if (action === "open" && root.main) root.main.openApp("");
      else if (action === "settings") BarService.openPluginSettings(root.screen, pluginApi.manifest);
    }
  }

  onRightClicked: PanelService.showContextMenu(contextMenu, root, screen)
}
