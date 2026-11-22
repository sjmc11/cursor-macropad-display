-- Macropad keystroke bridge for the Cursor "macropad" extension.
--
-- Cursor extensions can't press keys, so the extension POSTs a key combo
-- (e.g. "cmd+shift+l") to this tiny localhost server, which presses it.
--
-- Safety:
--   * listens on 127.0.0.1 only
--   * every request must carry the secret from ~/.macropad/token
--     (a custom header, so browsers can't forge it without a CORS preflight)
--   * keys are only sent while Cursor is the frontmost app
--
-- Install: see README.md (symlink into ~/.hammerspoon and add `require("macropad")`).

local M = {}

M.port = 47615
M.allowedApps = { ["Cursor"] = true }
M.tokenPath = os.getenv("HOME") .. "/.macropad/token"

local aliases = {
  enter = "return", ["return"] = "return",
  backspace = "delete", delete = "delete", del = "forwarddelete",
  esc = "escape", escape = "escape",
  space = "space", tab = "tab",
  up = "up", down = "down", left = "left", right = "right",
}
local modNames = { cmd = "cmd", command = "cmd", ctrl = "ctrl", control = "ctrl",
                   alt = "alt", opt = "alt", option = "alt", shift = "shift", fn = "fn" }

local function readOrCreateToken()
  local f = io.open(M.tokenPath, "r")
  if f then
    local t = f:read("*l")
    f:close()
    if t and #t >= 16 then return t end
  end
  os.execute("mkdir -p '" .. os.getenv("HOME") .. "/.macropad' && chmod 700 '" .. os.getenv("HOME") .. "/.macropad'")
  local token = hs.host.uuid():gsub("-", "") .. hs.host.uuid():gsub("-", "")
  f = assert(io.open(M.tokenPath, "w"))
  f:write(token, "\n")
  f:close()
  os.execute("chmod 600 '" .. M.tokenPath .. "'")
  return token
end

-- "cmd+shift+l" -> {"cmd","shift"}, "l"
local function parseCombo(combo)
  local parts = {}
  for p in combo:lower():gmatch("[^+]+") do table.insert(parts, (p:gsub("^%s+", ""):gsub("%s+$", ""))) end
  if #parts == 0 then return nil, "empty combo" end
  local key = table.remove(parts)
  local mods = {}
  for _, m in ipairs(parts) do
    if not modNames[m] then return nil, "unknown modifier '" .. m .. "'" end
    table.insert(mods, modNames[m])
  end
  key = aliases[key] or key
  if not hs.keycodes.map[key] then return nil, "unknown key '" .. key .. "'" end
  return mods, key
end

local function header(headers, name)
  for k, v in pairs(headers or {}) do
    if k:lower() == name:lower() then return v end
  end
end

function M.start()
  M.token = readOrCreateToken()
  if M.server then M.server:stop() end
  M.server = hs.httpserver.new(false, false)
  M.server:setInterface("localhost")
  M.server:setPort(M.port)
  M.server:setCallback(function(method, path, headers, body)
    if method ~= "POST" then return "method not allowed", 405, {} end
    if header(headers, "X-Macropad-Token") ~= M.token then return "bad token", 403, {} end

    if path == "/ping" then return "pong", 200, {} end

    if path == "/keys" then
      local app = hs.application.frontmostApplication()
      local appName = app and app:name() or "?"
      if not M.allowedApps[appName] then return "frontmost app is " .. appName .. ", not Cursor", 409, {} end
      local mods, key = parseCombo(body or "")
      if not mods then return key, 400, {} end
      hs.eventtap.keyStroke(mods, key, 20000)
      return "ok", 200, {}
    end

    return "not found", 404, {}
  end)
  M.server:start()
  hs.printf("macropad bridge listening on 127.0.0.1:%d", M.port)
end

M.start()
return M
