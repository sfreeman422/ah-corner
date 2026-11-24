-- Original companion. No protected calls, scans, purchases, postings, or network access.
local function say(s) print("|cff76d2b4AH Corner:|r " .. tostring(s)) end
local function coins(c) return string.format("%dg %02ds %02dc", math.floor(c/10000), math.floor(c/100)%100, c%100) end
local function valid(n) return n and n > 0 and n == math.floor(n) and n < 1000000000000 end
local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, _, name)
 if name ~= "AHCorner" then return end
 if type(AHCornerJournal) ~= "table" then AHCornerJournal = {} end
 AHCornerJournal.records = AHCornerJournal.records or {}
 AHCornerJournal.counter = AHCornerJournal.counter or 0
end)
SLASH_AHCORNER1 = "/ahc"
SlashCmdList.AHCORNER = function(msg)
 local cmd, rest = msg:match("^(%S*)%s*(.-)$")
 cmd = string.lower(cmd or "")
 if cmd == "plan" then
  local plan = AHCornerPlan or {}; local age = time() - (plan.timestamp or 0)
  if age > 7200 or age < -300 then say("Plan is stale or unconfigured. Export a fresh live plan from the dashboard."); return end
  say("Market " .. tostring(plan.market) .. "; age " .. math.floor(age/60) .. " minutes. Verify faction, prices, quantities, and deposits manually.")
  for i, row in ipairs(plan.rows or {}) do
   say(string.format("%d. %s [ID %d] | %d units | buyout %s | max buy %s/unit | target %s/unit", i, row.name, row.id, row.quantity, coins(row.cost), coins(row.buyMax or 0), coins(row.target)))
  end
  if #(plan.rows or {}) == 0 then say("No qualifying plan rows.") end
 elseif cmd == "buy" or cmd == "sell" then
  local id, q, total, fee = rest:match("^(%d+)%s+(%d+)%s+(%d+)%s*(%d*)$")
  id, q, total, fee = tonumber(id), tonumber(q), tonumber(total), tonumber(fee) or 0
  if not (valid(id) and valid(q) and valid(total)) or fee < 0 or fee ~= math.floor(fee) or (cmd == "sell" and fee > total) then say("Usage: /ahc " .. cmd .. " ITEM_ID QUANTITY GROSS_COPPER [FEE_COPPER]"); return end
  local journal = AHCornerJournal
  if not journal then say("Journal not initialized; reload UI."); return end
  journal.counter = journal.counter + 1
  local guid = (UnitGUID("player") or "player"):gsub("[^%w_-]", "")
  local stamp = time()
  local key = guid .. "-" .. stamp .. "-" .. journal.counter
  local record = string.format("AHC1|%s|%s|%d|%d|%d|%d|%d", key, cmd, id, q, total, fee, stamp)
  table.insert(journal.records, record)
  say("Recorded " .. cmd .. " of " .. q .. " units for " .. coins(total) .. ". Log out or /reload to write SavedVariables.")
 elseif cmd == "count" then say(tostring(#((AHCornerJournal or {}).records or {})) .. " manual records.")
 else
  say("/ahc plan — show fresh advisory plan; search the auction house yourself.")
  say("/ahc buy ITEM_ID QTY GROSS_COPPER [FEE_COPPER] — record a completed purchase.")
  say("/ahc sell ITEM_ID QTY GROSS_COPPER [FEE_COPPER] — record a confirmed sale.")
  say("/ahc count — journal record count. /reload or log out before importing.")
 end
end
