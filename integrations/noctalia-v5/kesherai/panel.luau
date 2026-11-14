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
local function messages()
  local out = {}
  local answered = {}
  for _, e in ipairs(events) do
    if e.type == "approval_result" then
      answered[e.requestId] = true
    end
  end
  local partial = ""
  for _, e in ipairs(events) do
    if e.type == "user" then
      partial = ""
      table.insert(out, { who = "user", text = tostring(e.text or "") })
    elseif e.type == "assistant_delta" then
      partial ..= tostring(e.text or "")
    elseif e.type == "assistant" then
      partial = ""
      local t = stripThink(e.text)
      if t ~= "" then
        table.insert(out, { who = "ai", text = t })
      end
    elseif e.type == "approval_request" and not answered[e.requestId] then
      table.insert(out, { who = "approval", id = tostring(e.requestId), text = tostring(e.reason or e.name or "") })
    elseif e.type == "status" and e.status == "error" and e.message ~= nil then
      table.insert(out, { who = "error", text = tostring(e.message) })
    end
  end
  local p = stripThink(partial ~= "" and partial or live)
  if p ~= "" then
    table.insert(out, { who = "ai", text = p, live = true })
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

local function send(text)
  text = noctalia.string.trim(tostring(text or ""))
  if text == "" or busy() then
    return
  end
  sending = true
  err = ""
  draft = ""
  inputRev += 1
  table.insert(events, { type = "user", text = text })
  render()
  local function post()
    call("POST", "/api/conversations/" .. chatId .. "/messages", { text = text }, function(ok)
      sending = false
      if not ok then
        err = tr("panel.send_failed")
      else
        status = "running"
      end
      load()
    end)
  end
  if chatId ~= "" then
    post()
    return
  end
  call("POST", "/api/conversations", { kind = "chat" }, function(ok, data)
    if ok and type(data) == "table" and type(data.id) == "string" then
      chatId = data.id
      noctalia.state.set("kesher-chat", chatId)
      post()
    else
      sending = false
      err = tr("panel.offline")
      render()
    end
  end)
end

local function decide(requestId, decision)
  call("POST", "/api/conversations/" .. chatId .. "/approvals/" .. requestId, { decision = decision }, function(_ok)
    load()
  end)
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
  return ui.column({ key = "m" .. i, padding = 10, radius = 12, fill = "surface_variant/0.55", align = "stretch" }, {
    ui.label({ text = m.text .. (m.live and " ▍" or ""), color = "on_surface" }),
  })
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

  local body = {
    ui.row({ align = "center", gap = 8 }, header),
    ui.scroll({ key = "chat", flexGrow = 1, gap = 10, align = "stretch", stickToBottom = true, scrollToBottomRev = #list }, rows),
  }
  if err ~= "" then
    table.insert(body, ui.label({ text = err, color = "error", maxLines = 3 }))
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
