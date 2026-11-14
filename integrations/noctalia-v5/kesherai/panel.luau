--!nonstrict
-- KesherAI in a side panel (like Noctalia's Notes): a small chat with your local AI.
--
-- It talks to KesherAI's own API (this computer, or another of yours with its token): a new chat is made on the
-- first question, the question is sent, and the chat is read every second while it works, so the answer appears
-- as it is written. Approvals can be answered here or in KesherAI. The chat stays while Noctalia runs (+ starts a
-- new one); it is a normal KesherAI chat, so it is also in KesherAI's list.

local s = noctalia.state.get("kesher") or {}
local chatId = noctalia.state.get("kesher-chat") or ""
local events = {}
local status = "idle" -- the chat's session: "idle" | "running" | "error"…
local draft = ""
local inputRev = 0 -- a fresh key empties the field after sending
local sending = false
local err = ""
local open = false
local ticks = 0
local closeButton = true
local models = {} -- the chat models: { id, name }
local modelId = noctalia.state.get("kesher-model") or "" -- "" = KesherAI's default
local live = "" -- the answer as it is being written (from the live stream)
local stream = nil -- KesherAI's live events while the chat works
local lastSeq = 0

local render
local load

local function tr(key, subst)
  return noctalia.tr(key, subst)
end

local function base()
  local url = tostring(noctalia.getConfig("url") or "")
  if url == "" then
    url = "http://127.0.0.1:7420"
  end
  return (url:gsub("/+$", ""))
end

local function headers(json)
  local h = { "Accept: application/json" }
  if json then
    table.insert(h, "Content-Type: application/json")
  end
  local token = tostring(noctalia.getConfig("token") or "")
  if token ~= "" and not token:find("[\r\n]") then
    table.insert(h, "Authorization: Bearer " .. token)
  end
  return h
end

-- One request to KesherAI; cb(ok, decodedBody). A refused request (no free slot) counts as a failure.
local function call(method, path, body, cb)
  local req = { url = base() .. path, method = method, headers = headers(body ~= nil) }
  if body ~= nil then
    req.body = noctalia.json.encode(body) or "{}"
  end
  local accepted = noctalia.http(req, function(res)
    local ok = type(res) == "table" and res.ok == true and type(res.status) == "number" and res.status >= 200 and res.status < 300
    local data = nil
    if type(res) == "table" and res.body ~= nil and res.body ~= "" then
      data = noctalia.json.decode(tostring(res.body))
    end
    cb(ok, data)
  end)
  if not accepted then
    cb(false, nil)
  end
end

local function stripThink(text)
  return (tostring(text or ""):gsub("<think>.-</think>%s*", ""):gsub("^%s+", ""))
end

-- The chat as bubbles: questions, answers (the one being written included), and approvals still waiting.
-- An ISO time ("2026-11-14T13:05:02.123Z") as seconds (for how long an answer took).
local function seconds(iso)
  local y, mo, d, h, mi, s = tostring(iso or ""):match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):([%d.]+)")
  if not y then
    return nil
  end
  local days = os.time({ year = tonumber(y), month = tonumber(mo), day = tonumber(d), hour = 0 }) / 86400
  return math.floor(days + 0.5) * 86400 + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(s)
end

-- The web pages a search or a fetch used: { title, url }, http(s) only.
local function sourcesOf(e, call)
  local out = {}
  if e.name == "web_search" then
    for title, url in tostring(e.output or ""):gmatch("%d+%.%s+([^\n]+)\n%s+(https?://[^%s]+)") do
      table.insert(out, { title = title, url = url })
    end
  elseif e.name == "web_fetch" and call ~= nil and type(call.input) == "table" then
    local url = tostring(call.input.url or "")
    if url:match("^https?://") then
      table.insert(out, { title = url:match("^https?://([^/]+)") or url, url = url })
    end
  end
  return out
end

-- The chat as bubbles: questions, answers (with how long they took, their speed and the web pages they used),
-- the answer being written, and approvals still waiting.
local function messages()
  local out = {}
  local answered = {}
  local calls = {}
  for _, e in ipairs(events) do
    if e.type == "approval_result" then
      answered[e.requestId] = true
    elseif e.type == "tool_call" then
      calls[e.callId] = e
    end
  end
  local partial = ""
  local askedAt, stepAt, tokens = nil, nil, 0
  local sources, seen = {}, {}
  for _, e in ipairs(events) do
    if e.type == "user" then
      partial = ""
      askedAt, stepAt, tokens = seconds(e.at), seconds(e.at), 0
      sources, seen = {}, {}
      table.insert(out, { who = "user", text = tostring(e.text or "") })
    elseif e.type == "assistant_delta" then
      partial ..= tostring(e.text or "")
    elseif e.type == "usage" then
      tokens += tonumber(e.output) or 0
    elseif e.type == "tool_result" then
      for _, src in ipairs(sourcesOf(e, calls[e.callId])) do
        if not seen[src.url] and #sources < 8 then
          seen[src.url] = true
          table.insert(sources, src)
        end
      end
      stepAt = seconds(e.at) or stepAt
    elseif e.type == "assistant" then
      partial = ""
      local t = stripThink(e.text)
      local at = seconds(e.at)
      if t ~= "" then
        local m = { who = "ai", text = t, sources = sources }
        if at and askedAt then
          m.took = math.max(0, at - askedAt)
        end
        if at and stepAt and tokens > 0 and at - stepAt > 0.2 then
          m.tps = tokens / (at - stepAt)
        end
        table.insert(out, m)
        sources, seen = {}, {}
      end
      tokens = 0
      stepAt = at or stepAt
    elseif e.type == "approval_request" and not answered[e.requestId] then
      table.insert(out, { who = "approval", id = tostring(e.requestId), text = tostring(e.reason or e.name or "") })
    elseif e.type == "status" and e.status == "error" and e.message ~= nil then
      table.insert(out, { who = "error", text = tostring(e.message) })
    end
  end
  local p = stripThink(partial ~= "" and partial or live)
  if p ~= "" then
    table.insert(out, { who = "ai", text = p, live = true, sources = sources })
  end
  return out
end

local function stopStream()
  if stream ~= nil then
    stream.stop()
    stream = nil
  end
  live = ""
end

-- Follows the chat live (KesherAI's event stream): the answer's words as they come; anything else reloads the chat.
local function startStream()
  if stream ~= nil or chatId == "" or not open then
    return
  end
  stream = noctalia.httpStream({ url = base() .. "/api/conversations/" .. chatId .. "/events?after=" .. tostring(lastSeq), headers = headers(false) }, function(line)
    local json = line:match("^data:%s*(.*)$")
    if json == nil then
      return
    end
    local e = noctalia.json.decode(json)
    if type(e) ~= "table" or e.type == "ping" then
      return
    end
    if e.type == "assistant_delta" then
      live ..= tostring(e.text or "")
      if open then
        render()
      end
    elseif e.type == "info" then
      if e.status ~= nil and e.status ~= "running" and e.status ~= "waiting" then
        load()
      end
    else
      if e.type == "assistant" then
        live = ""
      end
      load()
    end
  end, function(_result)
    stream = nil
  end)
end

local function busy()
  return sending or status == "running" or status == "waiting"
end

load = function()
  if chatId == "" then
    return
  end
  call("GET", "/api/conversations/" .. chatId, nil, function(ok, data)
    if ok and type(data) == "table" then
      events = type(data.events) == "table" and data.events or {}
      status = type(data.session) == "table" and tostring(data.session.status or "idle") or "idle"
      err = ""
      lastSeq = 0
      local lastStep = "user"
      for _, e in ipairs(events) do
        if type(e.seq) == "number" and e.seq > lastSeq then
          lastSeq = e.seq
        end
        if e.type == "user" or e.type == "assistant" or e.type == "tool_call" or e.type == "approval_request" then
          lastStep = e.type
        end
      end
      -- Words already kept as an answer (or followed by a step) are no longer "being written".
      if lastStep ~= "user" then
        live = ""
      end
      if status == "running" or status == "waiting" then
        startStream()
      else
        stopStream()
      end
    elseif not ok and data == nil then
      err = tr("panel.offline")
    else
      -- The chat was deleted in KesherAI: start over.
      chatId = ""
      noctalia.state.set("kesher-chat", "")
      events = {}
      status = "idle"
    end
    if open then
      render()
    end
  end)
end

local attached = {} -- files given to the next question (paths KesherAI opened to this chat)

-- The chat, made when there is none yet; cb(ok).
local function ensureChat(cb)
  if chatId ~= "" then
    cb(true)
    return
  end
  call("POST", "/api/conversations", modelId ~= "" and { kind = "chat", modelId = modelId } or { kind = "chat" }, function(ok, data)
    if ok and type(data) == "table" and type(data.id) == "string" then
      chatId = data.id
      noctalia.state.set("kesher-chat", chatId)
      cb(true)
    else
      cb(false)
    end
  end)
end

local function send(text)
  text = noctalia.string.trim(tostring(text or ""))
  if (text == "" and #attached == 0) or busy() then
    return
  end
  -- Files go first, as KesherAI's own chat box writes them.
  local lines = {}
  for _, f in ipairs(attached) do
    table.insert(lines, "[Attached: " .. f .. "]")
  end
  if #lines > 0 then
    text = table.concat(lines, "\n") .. (text ~= "" and "\n" .. text or "")
  end
  attached = {}
  sending = true
  err = ""
  draft = ""
  inputRev += 1
  table.insert(events, { type = "user", text = text })
  render()
  ensureChat(function(made)
    if not made then
      sending = false
      err = tr("panel.offline")
      render()
      return
    end
    call("POST", "/api/conversations/" .. chatId .. "/messages", { text = text }, function(ok)
      sending = false
      if not ok then
        err = tr("panel.send_failed")
      else
        status = "running"
      end
      load()
    end)
  end)
end

-- Picks files with the desktop's own dialog (zenity, or kdialog on KDE) and opens them to the chat.
local function attachFiles()
  local argv
  if noctalia.commandExists("zenity") then
    argv = { "zenity", "--file-selection", "--multiple", "--separator=\n", "--title=KesherAI" }
  elseif noctalia.commandExists("kdialog") then
    argv = { "kdialog", "--getopenfilename", ".", "--multiple", "--separate-output" }
  else
    err = tr("panel.no_picker")
    render()
    return
  end
  noctalia.runAsync(argv, function(result)
    if type(result) ~= "table" or result.exitCode ~= 0 then
      return
    end
    ensureChat(function(made)
      if not made then
        err = tr("panel.offline")
        render()
        return
      end
      for path in tostring(result.stdout or ""):gmatch("[^\n]+") do
        if #attached < 10 then
          call("POST", "/api/conversations/" .. chatId .. "/access", { path = path }, function(ok, data)
            if ok and type(data) == "table" and type(data.path) == "string" then
              table.insert(attached, data.path)
            else
              err = (type(data) == "table" and type(data.error) == "string") and data.error or tr("panel.attach_failed")
            end
            render()
          end)
        end
      end
    end)
  end, 600000)
end

local function decide(requestId, decision)
  call("POST", "/api/conversations/" .. chatId .. "/approvals/" .. requestId, { decision = decision }, function(_ok)
    load()
  end)
end

local function loadModels()
  call("GET", "/api/models", nil, function(ok, data)
    if not ok or type(data) ~= "table" then
      return
    end
    models = {}
    for _, m in ipairs(type(data.models) == "table" and data.models or data) do
      if type(m) == "table" and m.category == "chat" and type(m.id) == "string" then
        table.insert(models, { id = m.id, name = tostring(m.name or m.id):sub(1, 40) })
      end
    end
    if open then
      render()
    end
  end)
end

local function chooseModel(index)
  local m = models[(tonumber(index) or -1) + 1]
  modelId = m and m.id or ""
  noctalia.state.set("kesher-model", modelId)
  if chatId ~= "" and modelId ~= "" then
    call("PATCH", "/api/conversations/" .. chatId, { modelId = modelId }, function(_ok) end)
  end
  render()
end

local selecting = {}

local function copy(text)
  noctalia.copyToClipboard(text, "text/plain")
  noctalia.notify("KesherAI", tr("panel.copied"))
end

local function toggleSelect(i)
  selecting[i] = not selecting[i]
  render()
end

local function openUrl(url)
  if url:match("^https?://[%w%.%-]+") then
    noctalia.runAsync({ "xdg-open", url })
  end
end

local function bubble(m, i)
  if m.who == "user" then
    return ui.row({ key = "m" .. i, justify = "end" }, {
      ui.column({ padding = 10, radius = 12, fill = "primary/0.18" }, {
        ui.label({ text = m.text, color = "on_surface", maxWidth = 300 }),
      }),
    })
  elseif m.who == "approval" then
    return ui.column({ key = "m" .. i, gap = 8, padding = 10, radius = 12, fill = "secondary/0.15", align = "stretch" }, {
      ui.row({ gap = 6, align = "center" }, {
        ui.glyph({ name = "shield-question", size = 16, color = "secondary" }),
        ui.label({ text = tr("panel.approval"), fontWeight = "bold", color = "on_surface", flexGrow = 1 }),
      }),
      ui.label({ text = m.text, color = "on_surface_variant", maxLines = 6 }),
      ui.row({ gap = 6 }, {
        ui.button({ text = tr("panel.allow"), variant = "primary", onClick = function() decide(m.id, "allow") end }),
        ui.button({ text = tr("panel.deny"), variant = "outline", onClick = function() decide(m.id, "deny") end }),
      }),
    })
  elseif m.who == "error" then
    return ui.label({ key = "m" .. i, text = m.text, color = "error", maxLines = 6 })
  end
  local body = {}
  if selecting[i] and not m.live then
    -- To select part of the answer: the same text in a field (mark it, Ctrl+C).
    table.insert(body, ui.input({ key = "sel" .. i, value = m.text, multiline = true, height = 220 }))
  else
    -- Markdown: headings, lists, tables and code, as the AI wrote them.
    table.insert(body, ui.markdown({ key = "md" .. i .. (m.live and "l" or ""), text = m.text .. (m.live and " ▍" or "") }))
  end
  if not m.live then
    local stats = {}
    if m.took then
      table.insert(stats, string.format("%.1f s", m.took))
    end
    if m.tps then
      table.insert(stats, string.format("%.1f tok/s", m.tps))
    end
    table.insert(body, ui.row({ gap = 4, align = "center" }, {
      ui.label({ text = table.concat(stats, " · "), fontSize = 11, color = "on_surface_variant", flexGrow = 1 }),
      ui.button({ glyph = "copy", variant = "ghost", tooltip = tr("panel.copy"), onClick = function() copy(m.text) end }),
      ui.button({ glyph = selecting[i] and "markdown" or "cursor-text", variant = "ghost", tooltip = selecting[i] and tr("panel.formatted") or tr("panel.select"), onClick = function() toggleSelect(i) end }),
    }))
  end
  if m.sources and #m.sources > 0 then
    local links = { ui.label({ text = tr("panel.sources"), fontSize = 11, fontWeight = "bold", color = "on_surface_variant" }) }
    for n, src in ipairs(m.sources) do
      table.insert(links, ui.button({ key = "src" .. i .. "-" .. n, glyph = "world", text = src.title:sub(1, 60), variant = "ghost", contentAlign = "start", onClick = function() openUrl(src.url) end }))
    end
    table.insert(body, ui.column({ gap = 2, align = "stretch" }, links))
  end
  return ui.column({ key = "m" .. i, gap = 6, padding = 10, radius = 12, fill = "surface_variant/0.55", align = "stretch" }, body)
end

render = function()
  local header = {
    ui.glyph({ name = "sparkles", size = 18, color = "primary" }),
    ui.label({ text = "KesherAI", fontSize = 16, fontWeight = "bold", color = "on_surface", flexGrow = 1 }),
    ui.button({ key = "h-new", glyph = "plus", variant = "ghost", tooltip = tr("panel.new"), enabled = not busy(), onClick = "onNewChat" }),
    ui.button({ key = "h-open", glyph = "external-link", variant = "ghost", tooltip = tr("panel.open"), onClick = "onOpenApp" }),
  }
  if closeButton then
    table.insert(header, ui.button({ key = "h-close", glyph = "close", variant = "ghost", onClick = "onCloseClicked" }))
  end

  local rows = {}
  local list = messages()
  for i, m in ipairs(list) do
    table.insert(rows, bubble(m, i))
  end
  if #list == 0 then
    table.insert(rows, ui.column({ key = "empty", gap = 8, padding = 24, align = "center" }, {
      ui.glyph({ name = "sparkles", size = 36, color = "primary" }),
      ui.label({ text = s.online == false and tr("panel.offline") or tr("panel.empty"), color = "on_surface_variant", textAlign = "center", maxLines = 4 }),
    }))
  end
  if busy() then
    table.insert(rows, ui.label({ key = "working", text = tr("panel.working"), fontSize = 11, color = "on_surface_variant" }))
  end

  local footer = {
    ui.button({ glyph = "paperclip", variant = "ghost", tooltip = tr("panel.attach"), enabled = not busy(), onClick = function() attachFiles() end }),
    ui.input({
      key = "ask-" .. inputRev,
      value = draft,
      placeholder = tr("panel.placeholder"),
      multiline = true,
      submitOnEnter = true,
      focus = true,
      height = 72,
      flexGrow = 1,
      onChange = "onDraft",
      onSubmit = "onSubmit",
    }),
  }
  if busy() and chatId ~= "" then
    table.insert(footer, ui.button({ glyph = "player-stop", variant = "outline", tooltip = tr("panel.stop"), onClick = "onStop" }))
  else
    table.insert(footer, ui.button({ glyph = "send", variant = "primary", tooltip = tr("panel.send"), onClick = "onSend" }))
  end

  local names, selected = {}, -1
  for n, m in ipairs(models) do
    table.insert(names, m.name)
    if m.id == modelId then
      selected = n - 1
    end
  end
  local body = {
    ui.row({ align = "center", gap = 8 }, header),
    ui.select({ key = "model", options = names, selectedIndex = selected, placeholder = tr("panel.model"), controlSize = "sm", enabled = #names > 0 and not busy(), onChange = function(index) chooseModel(index) end }),
    ui.scroll({ key = "chat", flexGrow = 1, gap = 10, align = "stretch", stickToBottom = true, scrollToBottomRev = #list }, rows),
  }
  if err ~= "" then
    table.insert(body, ui.label({ text = err, color = "error", maxLines = 3 }))
  end
  if #attached > 0 then
    local chips = {}
    for n, f in ipairs(attached) do
      table.insert(chips, ui.button({ key = "att" .. n, glyph = "x", text = (f:match("[^/\\]+$") or f):sub(1, 30), variant = "outline", controlSize = "sm", tooltip = f, onClick = function()
        table.remove(attached, n)
        render()
      end }))
    end
    table.insert(body, ui.row({ gap = 6, align = "center" }, chips))
  end
  table.insert(body, ui.row({ gap = 8, align = "end" }, footer))
  panel.render(ui.column({ flexGrow = 1, gap = 10, align = "stretch" }, body))
end

noctalia.state.watch("kesher", function(value)
  s = type(value) == "table" and value or {}
  if open then
    render()
  end
end)

function onOpen(_context)
  open = true
  closeButton = noctalia.getSetting("shell.show_close_buttons") ~= false
  panel.setWantsSecondTicks(true)
  render()
  load()
  loadModels()
end

function onClose()
  open = false
  panel.setWantsSecondTicks(false)
  stopStream()
end

-- Every second while open: read the chat while it works.
function update()
  if not open then
    return
  end
  ticks += 1
  if (status == "running" or status == "waiting") and not sending and (stream == nil or ticks % 5 == 0) then
    load()
  elseif ticks % 10 == 0 then
    load()
  end
end

function onDraft(value)
  draft = tostring(value or "")
end

function onSubmit(value)
  send(value)
end

function onSend()
  send(draft)
end

function onStop()
  call("POST", "/api/conversations/" .. chatId .. "/stop", {}, function(_ok)
    load()
  end)
end

function onNewChat()
  stopStream()
  selecting = {}
  attached = {}
  chatId = ""
  noctalia.state.set("kesher-chat", "")
  events = {}
  status = "idle"
  err = ""
  inputRev += 1
  render()
end

function onOpenApp()
  noctalia.runAsync({ "xdg-open", base() .. "/" .. (chatId ~= "" and ("#/c/" .. chatId) or "") })
  panel.close()
end

function onCloseClicked()
  panel.close()
end
