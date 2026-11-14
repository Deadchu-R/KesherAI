--!nonstrict
-- KesherAI on the bar: a mark, and how many chats are working. Click opens the panel; right-click opens KesherAI.

local PANEL = "kesherai/kesherai:panel"
local s = noctalia.state.get("kesher") or {}

local function render()
  barWidget.setVisible(true)
  if s.online == true then
    barWidget.setGlyph(s.working and s.working > 0 and "loader-2" or "sparkles")
    barWidget.setText(s.working and s.working > 0 and tostring(s.working) or "")
    barWidget.setTooltip(s.working and s.working > 0 and noctalia.tr("bar.working", { count = tostring(s.working) }) or noctalia.tr("bar.idle"))
  else
    barWidget.setGlyph("sparkles")
    barWidget.setText("")
    barWidget.setTooltip(noctalia.tr("bar.offline"))
  end
end

noctalia.state.watch("kesher", function(value)
  s = type(value) == "table" and value or {}
  render()
end)

function update()
  noctalia.setUpdateInterval(60000)
  render()
end

function onClick()
  noctalia.togglePanel(PANEL)
end

function onRightClick()
  local url = s.url or "http://127.0.0.1:7420"
  noctalia.runAsync({ "xdg-open", url .. "/" })
end

function onIpc(event, _payload)
  if event == "toggle" then
    noctalia.togglePanel(PANEL)
  end
end

render()
