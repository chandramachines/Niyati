const DEFAULT_TIMEOUT = 25;

// ✅ Input sanitization patterns
const SHELL_INJECTION = /(\$\(|\$\{|`)/g;
const PATH_TRAVERSAL = /\.\.[\/\\]/g;

// ✅ Sanitize user input
function sanitizeInput(str, maxLength = 500) {
  return String(str || "")
    .replace(SHELL_INJECTION, '') // Remove shell injection attempts
    .replace(PATH_TRAVERSAL, '')  // Remove path traversal
    .replace(/[^\p{L}\p{N}\s.,_@+()-]/gu, '') // Allow only safe chars
    .slice(0, maxLength)
    .trim();
}

const HELP_TEXT_HTML = `<b>🤖 NiyatiBrowser – Help</b>

⏱ Refresh
- /startref – ✅ Auto-Refresh ON (Instant Cycle Mode)
- /stopref – 🛑 Auto-Refresh OFF

🧩 Products
- /addprod &lt;name&gt; – ➕ Add Product
- /delprod &lt;name&gt; – ➖ Remove Product
- /prodlist – 🗂️ List Products

🧠 Keywords
- /addkey &lt;word&gt; – ➕ Add Keyword
- /delkey &lt;word&gt; – ➖ Remove Keyword
- /keylist – 🧾 List Keywords

⏭️ Skip Lists
- /addskiploc &lt;location&gt; – ➕ Add Skip Location
- /delskiploc &lt;location&gt; – ➖ Remove Skip Location
- /skiploclist – 📍 List Skip Locations
- /addskipname &lt;name&gt; – ➕ Add Skip Name
- /delskipname &lt;name&gt; – ➖ Remove Skip Name
- /skipnamelist – 🏷️ List Skip Names

📸 Screenshots
- /ss – Both Windows (Album)
- /sswin1 – Leads Window (Photo)
- /sswin2 – Manager Window (Photo)

📊 Status &amp; Maintenance
- /status – Send Status
- /clean – 🧹 Clean Up
- /cleanall – 🧨 Deep Clean (Careful)
- /networkfix – 🔧 Force Network Recovery (Stuck Offline Fix)
- /reset – ♻️ Full Reset (Scraper + Matcher + MC)
- /restart – 🔄 Restart App
- /quit – 🔴 Quit App

🪟 Windows / UI
- /manager – Focus Manager
- /leads – Focus Leads
- /togglemax – Toggle Maximize
- /reload – Reload Manager UI

🔐 Login / OTP
- /autologin – Start Auto-Login
- /otp &lt;1234&gt; – Submit OTP
- /resend – Request New OTP

🔒 Lock
- /lock – Hide All Windows
- /unlock &lt;user,pass&gt; – Unlock (if Creds Enabled)

🧰 Utilities
- /ping – 🏓 Pong
- /sync – 🔧 Re-Sync Slash Commands

📦 Reports
- /runreports – Trigger Daily Report Now`;

function createTelegramClient({
  token,
  chatId,
  commands = {},
  onUnknown,
  dropPendingOnStart = false,
  onCommand,
  onCommandResult,
  incomingFileSaveDir
}) {
  if (!token) {
    console.warn("[Telegram] TELEGRAM_BOT_TOKEN Not Set; Skipping Integration.");
    return {
      start() {},
      stop() {},
      send() {},
      syncCommands() {},
      sendFile() {}
    };
  }

  const API = `https://api.telegram.org/bot${token}`;
  const JSON_HDR = { "Content-Type": "application/json" };
  let lastUpdateId = 0, abortCtrl = null;
  const startTs = Math.floor(Date.now() / 1000);

  const call = async (method, payload = {}) => {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: JSON_HDR,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`${method} failed: ${res.status} ${JSON.stringify(data)}`);
      return data.result;
    } catch (e) {
      // Log but don't throw - prevents unhandled rejections
      console.error(`[Telegram] ${method} Failed:`, e.message);
      throw e; // Re-throw for caller to handle
    }
  };

  const sendRaw = async (text, extra = {}) => {
    if (!chatId) return false;
    try {
      await call("sendMessage", { chat_id: chatId, text: String(text ?? ""), ...extra });
      return true;
    } catch (e) {
      console.error("[Telegram] Send Failed:", e.message);
      return false;
    }
  };

  async function sendPhotoBuffer(buf, { caption = "", filename = "photo.jpg", mime = "image/jpeg" } = {}) {
    if (!chatId) return;
    try {
      const fd = new FormData();
      fd.append("chat_id", String(chatId));
      if (caption) fd.append("caption", caption);
      const blob = new Blob([buf], { type: mime });
      fd.append("photo", blob, filename);
      const res = await fetch(`${API}/sendPhoto`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(`sendPhoto failed: ${JSON.stringify(data)}`);
      return data.result;
    } catch (e) {
      console.error("[Telegram] SendPhoto Failed:", e.message);
      return null;
    }
  }

  async function sendMediaGroupPhotos(photos) {
    if (!chatId) return;
    try {
      const fd = new FormData();
      fd.append("chat_id", String(chatId));
      const media = [];
      for (const p of photos) {
        const key = p.name || ("photo" + media.length);
        const blob = new Blob([p.buf], { type: "image/jpeg" });
        fd.append(key, blob, `${key}.jpg`);
        media.push({
          type: "photo",
          media: `attach://${key}`,
          caption: p.caption || undefined
        });
      }
      fd.append("media", JSON.stringify(media));
      const res = await fetch(`${API}/sendMediaGroup`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(`sendMediaGroup failed: ${JSON.stringify(data)}`);
      return data.result;
    } catch (e) {
      console.error("[Telegram] SendMediaGroup Failed:", e.message);
      return null;
    }
  }

  const wrapSendForCmd = (ctx) => async (text, extra = {}) => {
    await sendRaw(String(text ?? ""), extra);
    try { 
      onCommandResult && onCommandResult({ ...ctx, reply: text }); 
    } catch {}
    return;
  };

  async function downloadFileById(fileId) {
    const info = await call("getFile", { file_id: fileId });
    if (!info?.file_path) throw new Error("No file_path");
    
    if (info.file_size > 50 * 1024 * 1024) {
      throw new Error("File too large (max 50MB)");
    }
    
    const base = API.startsWith("https://api.telegram.org/bot")
      ? "https://api.telegram.org"
      : API.replace(/\/bot$/, '');
    const url = `${base}/file/bot${token}/${info.file_path}`;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed ${res.status}`);
    
    const buf = new Uint8Array(await res.arrayBuffer());
    return { buf, file_path: info.file_path };
  }

  async function saveBufferToDir(buf, saveDir, filename) {
    const fs = require("node:fs/promises");
    const path = require("node:path");
    
    const safeName = String(filename)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 255);
    
    if (!safeName || safeName.startsWith('.')) {
      throw new Error("Invalid filename");
    }
    
    const p = path.join(saveDir, safeName);
    
    const resolved = path.resolve(p);
    const safeDir = path.resolve(saveDir);
    if (!resolved.startsWith(safeDir)) {
      throw new Error("Invalid path");
    }
    
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
    return p;
  }

  const ensurePollingMode = () =>
    call("deleteWebhook", { drop_pending_updates: !!dropPendingOnStart }).catch(() => {});

  const drainBacklogToLatest = async () => {
    try {
      for (;;) {
        const batch = await call("getUpdates", { 
          offset: lastUpdateId + 1, 
          timeout: 0, 
          limit: 100 
        });
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const u of batch) {
          if (typeof u.update_id === "number") {
            lastUpdateId = Math.max(lastUpdateId, u.update_id);
          }
        }
      }
    } catch (e) {
      console.warn("[Telegram] Warm-Up Drain Failed:", e.message);
    }
  };

  const cleanCmd = (name) =>
    String(name || "")
      .replace(/^\/+/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 32);

  const cleanDesc = (d, fallback) => {
    let s = String(d ?? "").replace(/\s+/g, " ").trim();
    if (s.length < 3) s = String(fallback || "command");
    if (s.length > 256) s = s.slice(0, 256);
    return s;
  };

  function makeInvoker(v) {
    if (typeof v === "function") {
      return async (ctx) => {
        const { args, send } = ctx;
        try {
          const out = (v.length <= 1) ? v(args) : v(ctx);
          const val = (out && typeof out.then === "function") ? await out : out;
          if (typeof val !== "undefined") await send(String(val));
        } catch (e) {
          await send("Error: " + (e?.message || e));
        }
      };
    }
    if (v && typeof v.handler === "function") {
      return async (ctx) => {
        try {
          const out = v.handler(ctx);
          if (out && typeof out.then === "function") {
            await out;
          } else if (out !== undefined && out !== null) {
            // ✅ FIX: Don't send null/undefined as message (was sending "null" string)
            await ctx.send(String(out));
          }
        } catch (e) {
          await ctx.send("Error: " + (e?.message || e));
        }
      };
    }
    return null;
  }

  const normalize = (spec) => {
    const list = [], map = {};
    const seen = new Set();

    for (const [rawCmd, v] of Object.entries(spec || {})) {
      const inv = makeInvoker(v);
      if (!inv) continue;

      const hidden = (typeof v === "object" && v && !!v.hidden);
      const cleaned = cleanCmd(rawCmd);
      if (!cleaned) continue;

      map[cleaned] = inv;
      map[rawCmd] = inv;

      if (hidden) continue;

      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        const desc = (typeof v === "object" && v && (v.desc || v.description)) || cleaned;
        list.push({ 
          command: cleaned, 
          description: cleanDesc(desc, cleaned) 
        });
      }
    }
    return { list, map };
  };

  const { list: commandList, map: handlerMap } = normalize(commands);

  const __helpText = () => {
    const lines = ["🤖 Niyati Bot – Command Menu"];
    const seen = new Set();
    for (const { command, description } of commandList) {
      if (seen.has(command)) continue;
      lines.push(`/${command} – ${description}`);
      seen.add(command);
    }
    return lines.join("\n");
  };
  
  if (!handlerMap["help"] && !handlerMap["/help"]) { 
    handlerMap["help"] = ({ send }) => send(__helpText()); 
    handlerMap["/help"] = handlerMap["help"]; 
  }

  async function syncCommands(notify = false) {
    if (!commandList.length) return;

    const valid = commandList
      .map(c => ({
        command: cleanCmd(c.command),
        description: cleanDesc(c.description, c.command)
      }))
      .filter(c => /^[a-z0-9_]{1,32}$/.test(c.command));

    if (!valid.length) throw new Error("No valid commands to set.");

    const scopes = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" }
    ];

    try {
      for (const scope of scopes) {
        await call("deleteMyCommands", { scope }).catch(()=>{});
      }
      for (const scope of scopes) {
        await call("setMyCommands", { commands: valid, scope });
      }
      if (chatId) {
        await call("sendChatAction", { 
          chat_id: chatId, 
          action: "typing" 
        }).catch(()=>{});
        if (notify) await sendRaw("🔧 Commands Re-Synced ✅");
      }
    } catch (e) {
      throw new Error("Command Sync Failed: " + e.message);
    }
  }

  const dispatch = (upd) => {
    const msg = upd.message || upd.edited_message;
    if (!msg) return;
    if (chatId && String(msg.chat.id) !== String(chatId)) return;
    if (typeof msg.date === "number" && msg.date < startTs) return;

    if (incomingFileSaveDir && (msg.document || (msg.photo && msg.photo.length) || msg.video || msg.audio || msg.voice)) {
      (async () => {
        try {
          const kind = msg.document ? 'document' : msg.photo ? 'photo' : msg.video ? 'video' : msg.audio ? 'audio' : 'voice';
          const meta = msg.document || (msg.photo && msg.photo[msg.photo.length - 1]) || msg.video || msg.audio || msg.voice;
          const preferName = meta.file_name || (kind + '-' + (meta.file_unique_id || ''));
          const { buf, file_path } = await downloadFileById(meta.file_id);
          const path = require('node:path');
          const filename = preferName || path.basename(file_path);
          const saved = await saveBufferToDir(buf, incomingFileSaveDir, filename);
          await sendRaw(`📥 Saved <b>${filename}</b> (${(buf.length/1024).toFixed(1)} KB) to <code>${saved}</code>`, { parse_mode: 'HTML' });
        } catch (e) {
          await sendRaw('❌ File Save Failed: ' + e.message);
        }
      })();
    }

    if (!msg.text) return; 
    const text = msg.text.trim();
    if (!text.startsWith("/")) return;

    const [raw, ...rest] = text.split(/\s+/);
    const cmd = cleanCmd(raw.replace(/^\/|@.*$/g, ""));
    
    // ✅ Sanitize arguments
    const rawArgs = rest.join(" ");
    const args = sanitizeInput(rawArgs, 1000);
    
    if (rawArgs !== args && rawArgs.length > 0) {
      console.warn(`[Telegram] Sanitized Command Args: "${rawArgs}" -> "${args}"`);
      wrapSendForCmd({ cmd, args })("⚠️ Input Was Sanitized for Security");
    }

    const ctx = { 
      cmd, 
      args, // Sanitized version
      raw: text, 
      msg, 
      send: wrapSendForCmd({ cmd, args }), 
      sendPhoto: sendPhotoBuffer, 
      sendMediaGroup: sendMediaGroupPhotos, 
      syncCommands,
      downloadFile: downloadFileById,
      incomingFileSaveDir,
      message: msg
    };

    try { onCommand && onCommand({ cmd, args, raw: text }); } catch {}

    const handler = handlerMap[cmd] || handlerMap[raw] || handlerMap[`/${cmd}`];
    if (typeof handler === "function") {
      // ✅ FIX: Await async handler and catch errors to prevent unhandled rejections
      Promise.resolve(handler(ctx)).catch(e => {
        console.error(`[Telegram] Command handler error for /${cmd}:`, e?.message || e);
        try { ctx.send(`❌ Command Error: ${e?.message || 'Unknown error'}`); } catch {}
      });
    } else if (typeof onUnknown === "function") {
      Promise.resolve(onUnknown(ctx)).catch(e => {
        console.error(`[Telegram] Unknown handler error:`, e?.message || e);
      });
    } else {
      ctx.send("❓ Unknown Command. Try /sync Then /help");
    }
  };

  async function start() {
    // ✅ FIX #11: Prevent duplicate polling loops
    if (abortCtrl) {
      console.warn("[Telegram] Polling Already Running, Stopping First");
      stop();
      // Wait for cleanup
      await new Promise(r => setTimeout(r, 500));
    }

    try {
      await ensurePollingMode();
      await drainBacklogToLatest();
      await syncCommands(false);
      await sendRaw("🔗 Niyati Browser Connected.");
    } catch (e) {
      console.error("[Telegram] Init Error:", e.message);
    }

    abortCtrl = new AbortController();
    const { signal } = abortCtrl;

    while (!signal.aborted) {
      try {
        const res = await fetch(`${API}/getUpdates`, {
          method: "POST",
          headers: JSON_HDR,
          body: JSON.stringify({ 
            offset: lastUpdateId + 1, 
            timeout: DEFAULT_TIMEOUT, 
            limit: 100 
          }),
          signal
        });
        const data = await res.json();
        if (!data.ok) throw new Error("getUpdates not ok: " + JSON.stringify(data));
        for (const upd of data.result) {
          if (typeof upd.update_id === "number") {
            lastUpdateId = Math.max(lastUpdateId, upd.update_id);
          }
          try { dispatch(upd); }
          catch (e) { console.error("[Telegram] Dispatch Error:", e.message); }
        }
      } catch (err) {
        if (signal.aborted) break;
        console.error("[Telegram] Poll Error:", err.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  const stop = () => { 
    if (abortCtrl) { 
      try { abortCtrl.abort(); } catch {} 
    } 
    abortCtrl = null; 
  };

  const sendDocument = async (filePath, caption = "") => {
    if (!chatId) return;
    try {
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const fd = new FormData();
      fd.append("chat_id", String(chatId));
      if (caption) fd.append("caption", caption);
      const blob = new Blob([await fs.readFile(filePath)]);
      fd.append("document", blob, path.basename(filePath));
      const res = await fetch(`${API}/sendDocument`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(`sendDocument failed: ${JSON.stringify(data)}`);
      return data.result;
    } catch (e) {
      console.error("[Telegram] SendDocument Failed:", e.message);
      return null;
    }
  };

  const sendFile = (filePath, caption = "") => sendDocument(filePath, caption);

  // Buffer se seedha document bhejo — vCard ke liye use hota hai
  const sendBufferAsDocument = async (buf, { filename = "file", mime = "application/octet-stream", caption = "" } = {}) => {
    if (!chatId) return;
    try {
      const fd = new FormData();
      fd.append("chat_id", String(chatId));
      if (caption) fd.append("caption", caption);
      const blob = new Blob([buf], { type: mime });
      fd.append("document", blob, filename);
      const res = await fetch(`${API}/sendDocument`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(`sendBufferAsDocument failed: ${JSON.stringify(data)}`);
      return data.result;
    } catch (e) {
      console.error("[Telegram] SendBufferAsDocument Failed:", e.message);
      return null;
    }
  };

  return {
    start, 
    stop,
    send: sendRaw,
    syncCommands,
    sendFile,
    sendBufferAsDocument
  };
}

// Replace this section in your telegram.js file

function buildDefaultCommands(deps = {}) {
  const ok = (b) => (b ? "OK" : "Failed");

  const cmds = {
    help: {
      desc: "Show Commands",
      handler: ({ send }) => send(HELP_TEXT_HTML, {
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    },

    startref: {
      desc: "Start Auto-Refresh",
      // ✅ FIX: Don't send duplicate message - productScraper.enableAutoReload() already sends Telegram notification
      handler: ({ send }) => {
        const result = deps.enableAuto?.(deps.getIntervalSec?.() || 7);
        return ok(result) ? null : send("❌ Start Failed – Retry.");  // Only send on failure
      }
    },

    stopref: {
      desc: "Stop Auto-Refresh",
      // ✅ FIX: Don't send duplicate message - productScraper.disableAutoReload() already sends Telegram notification
      handler: ({ send }) => {
        const result = deps.disableAuto?.();
        return ok(result) ? null : send("❌ Stop Failed – Retry.");  // Only send on failure
      }
    },
    
    setref: {
      desc: "Set Refresh Interval (not used in cycle mode)",
      handler: ({ send }) => {
        return send("ℹ️ /setref is not applicable — instant cycle mode active.\nRefresh happens automatically after each scrape+click cycle.");
      }
    },

    addprod: {
      desc: "Add Product",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Product Name");
        return send(ok(deps.addProduct?.(safe)) ? `✅ Product Saved: ${safe}` : "❌ Add Failed – Try Again.");
      }
    },

    delprod: {
      desc: "Delete Product",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Product Name");
        return send(ok(deps.deleteProduct?.(safe)) ? `✅ Removed Product: ${safe}` : "❌ Delete Failed – Check the Name & Retry.");
      }
    },
    
    prodlist: {
      desc: "List Products",
      handler: ({ send }) => {
        try {
          const arr = deps.listProducts ? deps.listProducts() : [];
          send(arr.length ? `📦 Products (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "🔭 No Products Yet.");
        } catch { send("❌ Failed to load products."); }
      }
    },

    addkey: {
      desc: "Add Keyword",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Keyword");
        return send(ok(deps.addKeyword?.(safe)) ? `✅ Added Keyword: ${safe}` : "❌ Couldn't Add – Retry.");
      }
    },

    delkey: {
      desc: "Delete Keyword",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Keyword");
        return send(ok(deps.deleteKeyword?.(safe)) ? `✅ Removed: ${safe}` : "❌ Delete Failed – Retry.");
      }
    },
    
    keylist: {
      desc: "List Keywords",
      handler: ({ send }) => {
        try {
          const arr = deps.listKeywords ? deps.listKeywords() : [];
          send(arr.length ? `🏷️ Keywords (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "🙈 No Keywords Yet.");
        } catch { send("❌ Failed to load keywords."); }
      }
    },

    addskiploc: {
      desc: "Add Skip Location",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Location");
        return send(ok(deps.addSkipLocation?.(safe)) ? `✅ Added Skip Location: ${safe}` : "❌ Add Failed – Retry.");
      }
    },

    delskiploc: {
      desc: "Delete Skip Location",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Location");
        return send(ok(deps.deleteSkipLocation?.(safe)) ? `✅ Removed Skip Location: ${safe}` : "❌ Delete Failed – Check the Location & Retry.");
      }
    },

    skiploclist: {
      desc: "List Skip Locations",
      handler: ({ send }) => {
        try {
          const arr = deps.listSkipLocations ? deps.listSkipLocations() : [];
          send(arr.length ? `📍 Skip Locations (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "🗺️ No Skip Locations Yet.");
        } catch { send("❌ Failed to load skip locations."); }
      }
    },

    addskipname: {
      desc: "Add Skip Name",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Name");
        return send(ok(deps.addSkipName?.(safe)) ? `✅ Added Skip Name: ${safe}` : "❌ Add Failed – Retry.");
      }
    },

    delskipname: {
      desc: "Delete Skip Name",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Name");
        return send(ok(deps.deleteSkipName?.(safe)) ? `✅ Removed Skip Name: ${safe}` : "❌ Delete Failed – Check the Name & Retry.");
      }
    },

    skipnamelist: {
      desc: "List Skip Names",
      handler: ({ send }) => {
        try {
          const arr = deps.listSkipNames ? deps.listSkipNames() : [];
          send(arr.length ? `🏷️ Skip Names (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "📝 No Skip Names Yet.");
        } catch { send("❌ Failed to load skip names."); }
      }
    },

    ss: {
      desc: "Both Windows (Album)",
      handler: async ({ send, sendMediaGroup }) => {
        try {
          await send("📸 Taking Screenshots of Both Windows…");
          const out = await deps.screenshotBothAsJpegs?.({ stayHidden: true, quality: 88 });
          if (out && out.managerBuf && out.leadsBuf) {
            await sendMediaGroup([
              { name: "manager", buf: out.managerBuf, caption: "Manager" },
              { name: "leads", buf: out.leadsBuf, caption: "Leads" }
            ]);
          } else {
            await send("❌ Screenshot Failed – Ensure main.js Has screenshotBothAsJpegs.");
          }
        } catch (e) {
          await send("⚠️ Screenshot Failed: " + (e?.message || e));
        }
      }
    },
    
    sswin1: {
      desc: "Screenshot Leads (Photo)",
      handler: async ({ send, sendPhoto }) => {
        try {
          await send("📸 Capturing Leads…");
          const buf = await deps.screenshotLeadsAsJpeg?.({ stayHidden: true, quality: 88 });
          if (buf) {
            await sendPhoto(buf, { caption: "Leads", filename: "leads.jpg" });
          } else {
            await send("❌ Screenshot Failed – Ensure main.js Has screenshotLeadsAsJpeg.");
          }
        } catch (e) {
          await send("⚠️ Screenshot Failed: " + (e?.message || e));
        }
      }
    },

    sswin2: {
      desc: "Screenshot Manager (Photo)",
      handler: async ({ send, sendPhoto }) => {
        try {
          await send("📸 Capturing Manager…");
          const buf = await deps.screenshotManagerAsJpeg?.({ stayHidden: true, quality: 88 });
          if (buf) {
            await sendPhoto(buf, { caption: "Manager", filename: "manager.jpg" });
          } else {
            await send("❌ Screenshot Failed – Ensure main.js Has screenshotManagerAsJpeg.");
          }
        } catch (e) {
          await send("⚠️ Screenshot Failed: " + (e?.message || e));
        }
      }
    },

    status: {
      desc: "Send Status Report",
      handler: ({ send }) => send((deps.sendStatus && deps.sendStatus()) ? "🧾 Status Shared." : "❌ Status Send Failed – Retry.")
    },

    webhookstatus: {
      desc: "Webhook Server Status Check",
      handler: ({ send }) => {
        const status = deps.webhookStatus ? deps.webhookStatus() : "❓ Unknown";
        return send(`🔗 Webhook: ${status}`);
      }
    },

    clean: {
      desc: "Memory Clean",
      handler: ({ send }) => send((deps.cleanNow && deps.cleanNow()) ? "🧹 Cleanup Complete." : "❌ Cleanup Failed – Retry.")
    },

    cleanall: {
      desc: "Archive+Truncate+Clean",
      handler: ({ send }) => send((deps.cleanAll && deps.cleanAll()) ? "🧼 Deep Clean Done."  : "❌ Deep Clean Failed – Retry.")
    },

    networkfix: {
      desc: "Force recover from stuck offline",
      handler: async ({ send }) => {
        await send("🔧 Network Fix: Forcing recovery...");
        const ok = deps.forceNetworkRecovery?.();
        return send(ok
          ? "✅ Recovery triggered — leads window restarting. Give it 15s."
          : "❌ Network Fix Failed — try /restart");
      }
    },

    reset: {
      desc: "Full reset: scraper, matcher, MC, state",
      handler: async ({ send }) => {
        await send("♻️ Full Reset in progress...");
        const ok = deps.fullReset?.();
        return send(ok
          ? "✅ Reset Done — scraper will resume in 2s if auto-refresh was on."
          : "❌ Reset Failed — try /restart");
      }
    },

    restart: {
      desc: "Relaunch App",
      handler: async ({ send }) => {
        await send("🔄 Restarting…");
        deps.restartApp && deps.restartApp();
      }
    },

    quit: {
      desc: "Quit the App",
      handler: ({ send }) => {
        // ✅ Don't send message here - before-quit handler will send it
        deps.quitApp?.();
      }
    },

    lock: {
      desc: "Lock: Hide ALL Windows (Incl. Login)",
      handler: ({ send }) => {
        try { deps.lockAll && deps.lockAll(); } catch {}
        return send("🔒 Locked – All Windows Hidden.");
      }
    },

    unlock: {
      desc: "Unlock (With or Without Creds)",
      handler: ({ send, args }) => {
        const maybe = deps.unlockNoCreds ? deps.unlockNoCreds() : (deps.unlockWithCreds ? deps.unlockWithCreds(args) : "🚫 Unlock Not Available");
        return send(maybe);
      }
    },

    manager: {
      desc: "Focus Manager Window",
      handler: ({ send }) => send((deps.focusManager && deps.focusManager()) ? "🗂️ Manager Focused" : "❌ Failed to focus Manager window.")
    },

    leads: {
      desc: "Focus Leads Window",
      handler: ({ send }) => send((deps.focusLeads && deps.focusLeads()) ? "👀 Leads Focused" : "❌ Failed to focus Leads window.")
    },

    togglemax: {
      desc: "Toggle Maximize Manager",
      handler: ({ send }) => {
        try { deps.toggleMax && deps.toggleMax(); return send("🪄 Toggled"); }
        catch { return send("❌ Failed to toggle maximize."); }
      }
    },

    autologin: {
      desc: "Start Auto-Login",
      handler: ({ send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already Logged In.");
        if (!deps.startAutoLogin?.()) return send("⚠️ Auto-Login Not Ready.");
        return send("⏳ Auto-Login Started.");
      }
    },

    otp: {
      desc: "Submit OTP",
      handler: ({ args, send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already Logged In.");
        const okk = deps.injectOtp && deps.injectOtp(String(args || "").trim());
        return send(okk ? "🔐 OTP Submitted." : "❌ Invalid OTP / No Active Attempt.");
      }
    },

    resend: {
      desc: "Request OTP Again",
      handler: ({ send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already Logged In.");
        return send(deps.requestResend?.() ? "🔁 Will Click Request OTP." : "⛔ No Auto-Login Attempt Is Active.");
      }
    },

    ping: {
      desc: "Health Check",
      handler: ({ send }) => send("🏓 Pong")
    },

    sync: {
      desc: "Re-Sync Slash Commands",
      handler: ({ send, syncCommands }) => (async () => {
        try {
          await syncCommands(true);
        } catch (e) {
          await send("❌ Sync Failed: " + (e?.message || e));
        }
      })()
    },

    reload: {
      desc: "Reload Manager UI",
      handler: ({ send }) => send(deps.reloadManager?.() ? "🔄 Manager Reloaded" : "❌ Reload Failed")
    },

    // ✅ FIX: These need async handlers with proper send context
    runreports: {
      desc: "Run Daily Reports",
      handler: async ({ send }) => {
        try {
          // Call the actual function that sends reports
          const result = await new Promise((resolve) => {
            try {
              // This will be wired from main.js
              if (deps.sendDailyReports) {
                deps.sendDailyReports("manual").then(() => resolve(true)).catch(() => resolve(false));
              } else {
                resolve(false);
              }
            } catch {
              resolve(false);
            }
          });

          return send(result ? "📊 Reports Sent Successfully" : "❌ Reports Failed - Check Logs");
        } catch (e) {
          return send("❌ Failed: " + e.message);
        }
      }
    },

    getfile: {
      desc: "Get a File from Server",
      handler: async ({ args, send }) => {
        if (!args) return await send("Usage: /getfile <filename>\nExample: /getfile products.json");

        const fname = String(args).trim();
        const safe = fname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
        if (!safe) return await send("❌ Invalid Filename");

        try {
          if (deps.sendFile) {
            await deps.sendFile(safe);
            return await send(`✅ Sent: ${safe}`);
          } else {
            return await send("❌ Sendfile Not Available");
          }
        } catch (e) {
          return await send(`❌ Failed: ${e.message}`);
        }
      }
    }
  };

  // Create aliases
  const aliases = {
    startrefresh:  { hidden: true, handler: cmds.startref.handler },
    stoprefresh:   { hidden: true, handler: cmds.stopref.handler },
    setrefresh:    { hidden: true, handler: cmds.setref.handler },
    addproduct:    { hidden: true, handler: cmds.addprod.handler },
    deleteproduct: { hidden: true, handler: cmds.delprod.handler },
    productlist:   { hidden: true, handler: cmds.prodlist.handler },
    addkeyword:    { hidden: true, handler: cmds.addkey.handler },
    deletekeyword: { hidden: true, handler: cmds.delkey.handler },
    keywordlist:   { hidden: true, handler: cmds.keylist.handler },
    "/lock":       { hidden: true, handler: cmds.lock.handler },
    "/unlock":     { hidden: true, handler: cmds.unlock.handler },
    "/manager":    { hidden: true, handler: cmds.manager.handler },
    "/leads":      { hidden: true, handler: cmds.leads.handler },
    "/togglemax":  { hidden: true, handler: cmds.togglemax.handler },
    webhookstatus: { hidden: true, handler: cmds.webhookstatus.handler },
  };

  return { ...cmds, ...aliases };
}

module.exports = { 
  createTelegramClient, 
  buildDefaultCommands,
  saveBufferToDir: async (buf, saveDir, filename) => {
    const fs = require("node:fs/promises");
    const path = require("node:path");
    
    const safeName = String(filename)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 255);
    
    if (!safeName || safeName.startsWith('.')) {
      throw new Error("Invalid filename");
    }
    
    const p = path.join(saveDir, safeName);
    
    const resolved = path.resolve(p);
    const safeDir = path.resolve(saveDir);
    if (!resolved.startsWith(safeDir)) {
      throw new Error("Invalid path");
    }
    
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
    return p;
  }
};