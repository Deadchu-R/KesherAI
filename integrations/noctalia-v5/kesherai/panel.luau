--!nonstrict
-- KesherAI's panel: whether it runs, how many chats are working, and buttons to open it.

local s = noctalia.state.get("kesher") or {}
local open = false

local function url(path)
  return (s.url or "http://127.0.0.1:7420") .. "/" .. (path or "")
end

local function render()
  local status
  if s.online == true then
    status = (s.working or 0) > 0 and noctalia.tr("bar.working", { count = tostring(s.working) }) or noctalia.tr("bar.idle")
  else
    status = noctalia.tr("panel.offline")
  end
  panel.render(ui.column({ flexGrow = 1, gap = 12, padding = 4, align = "stretch" }, {
    ui.row({ align = "center", gap = 8 }, {
      ui.glyph({ name = "sparkles", size = 20, color = "primary" }),
      ui.label({ text = "KesherAI", fontSize = 17, fontWeight = "bold", color = "on_surface", flexGrow = 1 }),
      ui.button({ glyph = "refresh", variant = "ghost", tooltip = noctalia.tr("panel.refresh"), onClick = "onRefresh" }),
      ui.button({ glyph = "close", variant = "ghost", tooltip = noctalia.tr("panel.close"), onClick = "onCloseClicked" }),
    }),
    ui.label({ text = status, color = s.online == true and "on_surface" or "error", maxLines = 4 }),
    ui.button({ glyph = "external-link", text = noctalia.tr("panel.open"), enabled = s.online == true, onClick = "onOpenApp" }),
    ui.button({ glyph = "calendar", text = noctalia.tr("panel.day"), enabled = s.online == true, onClick = "onDay" }),
  }))
end

noctalia.state.watch("kesher", function(value)
  s = type(value) == "table" and value or {}
  if open then
    render()
  end
end)

function onOpen(_context)
  open = true
  render()
end

function onOpenApp()
  noctalia.runAsync({ "xdg-open", url("") })
  panel.close()
end

function onClose()
  open = false
end

function onCloseClicked()
  panel.close()
end

function onRefresh()
  noctalia.state.set("kesher-command", { op = "refresh", token = tostring(os.time()) })
end

function onDay()
  noctalia.runAsync({ "xdg-open", url("#/day") })
  panel.close()
end
