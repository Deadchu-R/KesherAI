--!nonstrict
-- KesherAI status: asks KesherAI's own API on this computer (or another of yours, with its token) every
-- 10 seconds whether it runs and how many chats are working, and shares that with the bar and the panel.

local busy = false

local function base()
  local url = tostring(noctalia.getConfig("url") or "")
  if url == "" then
    url = "http://127.0.0.1:7420"
  end
  return (url:gsub("/+$", ""))
end

local function headers()
  local h = { "Accept: application/json" }
  local token = tostring(noctalia.getConfig("token") or "")
  if token ~= "" and not token:find("[\r\n]") then
    table.insert(h, "Authorization: Bearer " .. token)
  end
  return h
end

local function publish(online, working)
  noctalia.state.set("kesher", { online = online, working = working, url = base(), at = os.time() })
end

local function check()
  if busy then
    return
  end
  busy = true
  local accepted = noctalia.http({ url = base() .. "/api/conversations/activity", method = "GET", headers = headers() }, function(res)
    busy = false
    if type(res) ~= "table" or res.ok ~= true or type(res.status) ~= "number" or res.status < 200 or res.status >= 300 then
      publish(false, 0)
      return
    end
    local data = noctalia.json.decode(tostring(res.body or ""))
    local n = 0
    if type(data) == "table" then
      for _ in pairs(data) do
        n += 1
      end
    end
    publish(true, n)
  end)
  if not accepted then
    busy = false
    publish(false, 0)
  end
end

noctalia.state.watch("kesher-command", function(_value)
  check()
end)

function update()
  noctalia.setUpdateInterval(10000)
  check()
end

function onConfigChanged()
  check()
end

function onEnable()
  check()
end
