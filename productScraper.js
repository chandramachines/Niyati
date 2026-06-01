// ✅ ALL FIXES APPLIED - productScraper.js v3.0.0
// ✅ XHR INTERCEPTION IMPLEMENTATION
// FIX: DOM Scraping → XHR API Interception (getBLDisplayData)
// Now captures leads directly from IndiaMart JSON API response

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function createProductScraper({
  win,
  log = () => {},
  delayMs = 1000,
  maxItems = 50,
  loginSelector = "#selsout",
  onItems = null,
  getTelegram = null,
}) {
  if (!win || win.isDestroyed()) throw new Error("productScraper: invalid window");

  const DIR_APP = __dirname;
  const DIR_USER = path.join(app.getPath("userData"), "Niyati");
  const DIR_LOG = path.join(DIR_APP, "Reports");
  const F_STATE = path.join(DIR_USER, "refresh_state.json");

  const LIST_DIR = path.join(DIR_APP, "List");
  const F_PRODUCTS = path.join(LIST_DIR, "products.json");
  const F_KEYWORDS = path.join(LIST_DIR, "keywords.json");

  const F_LOG_JSON = path.join(DIR_LOG, "products_log.json");
  try { fs.mkdirSync(DIR_LOG, { recursive: true }); } catch {}
  try { fs.mkdirSync(LIST_DIR, { recursive: true }); } catch {}

  const URL_DEFAULT = "https://seller.indiamart.com/bltxn/?pref=recent";
  const MIN_MS = 3000, DEF_MS = 7000, RETRY_MS = 800, BLANKS_BREAK = 5;
  const MAX_LOG_ROWS = 5000;

  const now = () => Date.now();
  // IST timestamp: "YYYY-MM-DD HH:mm:ss" (Asia/Kolkata)
  const ts = () => {
    const d = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(d).reduce((o,p)=> (o[p.type]=p.value, o), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };

  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const ensureDir = (p) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} };

  const normStr = (s) => String(s || "")
    .toLowerCase()
    .replace(/[,|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const makeKey = (title, location) => `${normStr(title)}|${normStr(location) || "-"}`;

  const writeJSON = (file, data) => {
    try {
      ensureDir(file);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (e) {
      log("error", `JSON Write Failed (${path.basename(file)}): ${e.message}`);
    }
  };
  
  const readJSON = (file, fb) => safe(() => JSON.parse(fs.readFileSync(file, "utf8")), fb);

  let refresh = readJSON(F_STATE, {
    enabled: false, 
    intervalMs: DEF_MS, 
    userWantedAutoRefresh: false,
    lastStartAt: 0, 
    lastStopAt: 0, 
    lastCycleAt: 0, 
    cycles: 0,
  });
  
  // ⚡ OPT: Debounced persistState
  let _persistDebounce = null;
  const persistState = () => {
    clearTimeout(_persistDebounce);
    _persistDebounce = setTimeout(() => writeJSON(F_STATE, refresh), 5000);
  };
  const persistStateNow = () => {
    clearTimeout(_persistDebounce);
    _persistDebounce = null;
    writeJSON(F_STATE, refresh);
  };

  // ✅ Page Keepalive Mechanism
  let keepAliveTimer = null;

  function startKeepAlive(win) {
    if (keepAliveTimer) return;
    
    log("info", "✅ Page Keepalive Started (15s Interval)");
    
    keepAliveTimer = setInterval(() => {
      if (!win || win.isDestroyed()) { stopKeepAlive(); return; }
      (async () => {
        try {
          if (!win || win.isDestroyed()) {
            stopKeepAlive();
            return;
          }
          
          await Promise.race([
            win.webContents.executeJavaScript(`
              (function() {
                const now = Date.now();
                const marker = document.getElementById('niyati-keepalive') || 
                              document.createElement('div');
                marker.id = 'niyati-keepalive';
                marker.setAttribute('data-last-ping', now);
                marker.style.display = 'none';
                if (!marker.parentNode) document.body.appendChild(marker);
                return now;
              })();
            `, true),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
          ]);
        } catch (e) {
          // Silent fail - page might be navigating
        }
      })();
    }, 15000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      log("info", "Page Keepalive Stopped");
    }
  }

  let tReload = null;
  let _beforeReload = () => {};
  let cycleReloadTimer = null;

  const clearCycleReload = () => {
    if (cycleReloadTimer) { clearTimeout(cycleReloadTimer); cycleReloadTimer = null; }
  };

  function enableAutoReload(ms = refresh.intervalMs, beforeReload = () => {}) {
    disableAutoReload("switching");
    _beforeReload = typeof beforeReload === 'function' ? beforeReload : () => {};
    refresh.userWantedAutoRefresh = true;
    refresh.enabled = true;
    refresh.lastStartAt = now();
    persistState();
    if (active && !paused) {
      const isLoading = safe(() =>
        typeof win.webContents.isLoadingMainFrame === 'function'
          ? win.webContents.isLoadingMainFrame()
          : win.webContents.isLoading()
      , false);
      if (!isLoading) {
        scheduleAfterDelay(bumpCycle());
        log("info", "Cycle: First kickoff (page already loaded)");
      }
    }

    log("start", "Auto-Refresh Started (Instant Cycle Mode)");
    try {
      const tg = getTelegram?.();
      tg?.send?.("▶️ Auto-Refresh Started (Instant Cycle Mode)");
    } catch {}
  }
  
  function disableAutoReload(reason) {
    if (tReload) clearInterval(tReload);
    tReload = null;
    clearCycleReload();
    if (refresh.enabled) {
      refresh.enabled = false;
      refresh.lastStopAt = now();
      persistStateNow();
      log("stop", `Auto-Refresh Stopped${reason ? ` – ${reason}` : ""}`);

      if (reason !== "quit" && reason !== "switching") {
        try {
          const tg = getTelegram?.();
          tg?.send?.(`⏹️ Auto-Refresh Stopped${reason ? ` – ${reason}` : ""}`);
        } catch {}
      }
    }
  }
  
  const getReloadState = () => ({ ...refresh, active, paused, lastCycleDurationMs });

  let productSet = new Set();
  safe(() => {
    if (fs.existsSync(F_PRODUCTS)) {
      const arr = readJSON(F_PRODUCTS, []);
      if (Array.isArray(arr)) productSet = new Set(arr.map(normStr));
      return;
    }
    const legacyTxt = path.join(DIR_APP, "products.txt");
    if (fs.existsSync(legacyTxt)) {
      const txt = fs.readFileSync(legacyTxt, "utf8");
      const arr = (txt || "").split(",").map(s => s.trim()).filter(Boolean);
      writeJSON(F_PRODUCTS, arr);
      productSet = new Set(arr.map(normStr));
      log("info", "Migrated Products.txt -> List/products.json");
    }
  });
  
  const getProducts = () => Array.from(productSet);
  const writeListJSON = (file, items = []) => { 
    ensureDir(file); 
    writeJSON(file, Array.isArray(items) ? items : []); 
    log("info", `${path.basename(file)} Updated (${(items||[]).length} Items)`); 
  };
  
  function setProducts(items = []) {
    try {
      writeListJSON(F_PRODUCTS, Array.isArray(items) ? items : []);
      productSet = new Set((items || []).map(normStr));
      log("info", `Products.json Updated (${productSet.size}) [SetProducts]`);
      return true;
    } catch (e) { 
      log("error", "SetProducts Failed: " + e.message); 
      return false; 
    }
  }
  
  function wireListsIPC(ipcMain) {
    try { ipcMain.removeHandler('lists:saveProducts'); } catch {}
    try { ipcMain.removeHandler('lists:saveKeywords'); } catch {}
    ipcMain.handle("lists:saveProducts", (_e, items = []) => { 
      safe(() => { 
        writeListJSON(F_PRODUCTS, items); 
        productSet = new Set((items || []).map(normStr)); 
      }); 
      return { ok: true }; 
    });
    ipcMain.handle("lists:saveKeywords", (_e, items = []) => { 
      try { 
        writeListJSON(F_KEYWORDS, items); 
        return { ok: true }; 
      } catch (e) { 
        return { ok: false, error: e.message }; 
      } 
    });
  }

  safe(() => {
    if (!fs.existsSync(F_KEYWORDS)) {
      const legacy = path.join(DIR_APP, "keywords.txt");
      if (fs.existsSync(legacy)) {
        const txt = fs.readFileSync(legacy, "utf8");
        const arr = (txt||"").split(/[, \n]+/).map(s=>s.trim().toLowerCase()).filter(Boolean);
        writeJSON(F_KEYWORDS, arr);
        log("info","Migrated Keywords.txt -> List/keywords.json");
      }
    }
  });

  const composeLoc = (it) => {
    const city = String(it.city || "").trim();
    const state = String(it.state || "").trim();
    const fb = String(it.location || "").trim();
    return (city || state) ? [city, state].filter(Boolean).join(", ") : (fb || "");
  };

  let keys = new Set(), serial = 1, rows = [];
  
  safe(() => {
    if (!fs.existsSync(F_LOG_JSON)) return;
    const data = readJSON(F_LOG_JSON, []);
    if (!Array.isArray(data)) return;

    const parseTs = (s) => {
      if (!s) return Infinity;
      const t = Date.parse(s);
      if (Number.isFinite(t)) return t;
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(String(s));
      if (m) {
        const t2 = Date.parse(`${m[1]}T${m[2]}+05:30`);
        if (Number.isFinite(t2)) return t2;
      }
      return Infinity;
    };

    data.sort((a,b) => parseTs(a?.timestamp) - parseTs(b?.timestamp));
    
    const seen = new Set();
    const dedupRows = [];
    for (const r of data) {
      const k = makeKey(r?.name, r?.location);
      if (seen.has(k)) continue;
      seen.add(k);
      dedupRows.push(r);
    }
    
    rows = dedupRows;
    
    for (const r of rows) {
      keys.add(makeKey(r?.name, r?.location));
      const s = parseInt(r?.serial, 10);
      if (!Number.isNaN(s)) serial = Math.max(serial, s + 1);
    }
    
    if (rows.length !== data.length) { 
      writeJSON(F_LOG_JSON, rows); 
    }
  });

  const persistJSON = () => writeJSON(F_LOG_JSON, rows);

  function recordIfNew(title, location) {
    const key = makeKey(title, location);
    if (keys.has(key)) return false;
    rows.unshift({ serial, timestamp: ts(), name: title, location });
    if (rows.length > MAX_LOG_ROWS) {
      const removed = rows.splice(MAX_LOG_ROWS);
      for (const r of removed) keys.delete(makeKey(r?.name, r?.location));
    }
    keys.add(key);
    log("info", `Persist: + "${title}"${location ? ` [${location}]` : ""}`);
    serial += 1;
    return true;
  }

  let active = false, scheduled = null, cycleId = 0, paused = false;
  let _scrapePromise = null;
  let _selectorWarnSent = false;
  let lastCycleDurationMs = null;
  let _cycleStartAt = 0;
  let consecutiveForceReloads = 0;
  
  const clearScheduled = () => { 
    if (scheduled) { 
      clearTimeout(scheduled); 
      scheduled = null; 
    } 
  };
  
  const bumpCycle = () => { 
    cycleId += 1; 
    refresh.cycles = (refresh.cycles|0) + 1; 
    refresh.lastCycleAt = now(); 
    persistState(); 
    return cycleId; 
  };

  // ============================================
  // ✅ XHR INTERCEPTION SETUP
  // ============================================
  
  let _xhrInterceptorActive = false;

  function setupXhrInterceptor(win) {
    const interceptorCode = `
      (function() {
        console.log("🔍 XHR Interceptor शुरू हुआ - getBLDisplayData");
        
        // Step 1: Global array जहाँ leads store होंगे
        window.__niyatiCapturedLeads = [];
        
        // Step 2: Original XMLHttpRequest save करो
        const OriginalXHR = window.XMLHttpRequest;
        const originalOpen = OriginalXHR.prototype.open;
        const originalSend = OriginalXHR.prototype.send;
        
        // Step 3: open() को override करो - URL track करने के लिए
        OriginalXHR.prototype.open = function(method, url, ...args) {
          this._niyatiUrl = url;
          this._niyatiMethod = method;
          return originalOpen.apply(this, [method, url, ...args]);
        };
        
        // Step 4: send() को override करो - response intercept करने के लिए
        OriginalXHR.prototype.send = function(body) {
          const xhr = this;
          const originalOnreadystatechange = this.onreadystatechange;
          
          this.onreadystatechange = function() {
            // जब response complete हो
            if (xhr.readyState === 4 && xhr.status === 200) {
              try {
                // Check: क्या यह getBLDisplayData request है?
                if (xhr._niyatiUrl && /getBLDisplayData/i.test(xhr._niyatiUrl)) {
                  
                  const responseText = xhr.responseText;
                  const responseData = JSON.parse(responseText);
                  
                  console.log("✅ getBLDisplayData Response मिला!");
                  console.log("📦 DisplayList items:", responseData.DisplayList?.length || 0);
                  
                  // DisplayList से leads निकालो
                  if (responseData.DisplayList && Array.isArray(responseData.DisplayList)) {
                    window.__niyatiCapturedLeads = responseData.DisplayList;
                    console.log("💾 Stored " + window.__niyatiCapturedLeads.length + " leads");
                  }
                }
              } catch(e) {
                console.error("❌ Parse Error:", e.message);
              }
            }
            
            // Original callback को भी call करो - ताकि page normal चले
            if (originalOnreadystatechange) {
              originalOnreadystatechange.call(this);
            }
          };
          
          return originalSend.apply(this, [body]);
        };
        
        console.log("✅ Interceptor Ready - Waiting for getBLDisplayData");
        return { ok: true };
      })();
    `;
    
    return win.webContents.executeJavaScript(interceptorCode, true);
  }

  // Step 5: Captured leads को extract करो
  async function getInterceptedLeads(win) {
    const extractCode = `
      (function() {
        const leads = window.__niyatiCapturedLeads || [];
        
        if (leads.length === 0) {
          console.log("❌ कोई leads नहीं मिले");
          return [];
        }
        
        console.log("📊 Total Leads:", leads.length);
        
        // हर lead को format करो
        return leads.map((lead, idx) => ({
          index: idx + 1,
          title: lead.ETO_OFR_TITLE || lead.BLCARDDATA?.[0]?.FK_PC_ITEM_DISPLAY_NAME || '',
          city: lead.GLUSR_CITY || '',
          state: lead.GLUSR_STATE || '',
          location: (lead.GLUSR_CITY || '') + (lead.GLUSR_STATE ? ', ' + lead.GLUSR_STATE : ''),
          date: lead.ETO_OFR_DATE || lead.OFFER_DATE || '',
          company: lead.GLUSR_COMPANY || '',
          businessType: lead.GL_BIZ_TYPE || '',
          price: lead.BLCARDDATA?.[0]?.PRODUCT_PRICE || '',
          productName: lead.BLCARDDATA?.[0]?.FK_PC_ITEM_DISPLAY_NAME || '',
          raw: lead
        }));
      })();
    `;
    
    try {
      const extractedLeads = await win.webContents.executeJavaScript(extractCode, true);
      return extractedLeads || [];
    } catch(e) {
      log("error", "Failed to extract leads: " + e.message);
      return [];
    }
  }

  // ✅ Main scrapeOnce() function - XHR based
  async function scrapeOnce(currentCycleId) {
    if (_scrapePromise) {
      log("debug", "Scrape: Already Running, Joining");
      try {
        return await _scrapePromise;
      } catch (e) {
        log("error", `Scrape: Previous Failed: ${e.message}`);
        return { ran: false, reason: 'previous-failed' };
      }
    }
    
    _scrapePromise = (async () => {
      try {
        _cycleStartAt = now();
        
        if (paused) {
          log("info", "Scrape: Paused");
          return { ran: false, reason: 'paused' };
        }
        
        if (!win || win.isDestroyed()) return { ran: false };
        
        // ⭐ STEP 1: पहली बार page load हो तो XHR Interceptor लगाओ
        if (!_xhrInterceptorActive) {
          log("info", "🔍 XHR Interceptor Setup करते हैं...");
          try {
            await setupXhrInterceptor(win);
            _xhrInterceptorActive = true;
            
            // Interceptor को work करने का समय दो
            await new Promise(r => setTimeout(r, 2000));
            log("info", "✅ XHR Interceptor Active");
          } catch(e) {
            log("error", "Interceptor Setup Failed: " + e.message);
            _xhrInterceptorActive = false;
          }
        }
        
        // ⭐ STEP 2: Captured leads निकालो
        log("info", "📥 Extracting intercepted leads...");
        const items = await getInterceptedLeads(win);
        
        if (!items || items.length === 0) {
          log("info", "Scrape: No leads captured");
          return { ran: true };
        }
        
        // ⭐ STEP 3: Process leads
        log("info", `✅ ${items.length} leads captured via XHR (getBLDisplayData API)`);
        
        let newCount = 0;
        for (const it of items) {
          const loc = composeLoc(it);
          log("scrape", `#${it.index}: ${it.title} [${loc}]`);
          
          if (it.title && recordIfNew(it.title, loc)) {
            newCount++;
          }
        }
        
        if (newCount > 0) persistJSON();
        log("info", `Scrape: ${items.length} Products (${newCount} new)`);
        
        // onItems callback को भेजो
        if (onItems) {
          try {
            await onItems(items, currentCycleId);
          } catch(e) {
            log("error", `onItems Error: ${e?.message || e}`);
          }
        }
        
        // Cycle complete - reload करो
        if (active && refresh.enabled && !paused) {
          cycleReloadTimer = setTimeout(() => {
            cycleReloadTimer = null;
            if (!win || win.isDestroyed() || !active || !refresh.enabled || paused) return;
            if (_cycleStartAt) lastCycleDurationMs = now() - _cycleStartAt;
            try { _beforeReload(); } catch {}
            win.webContents.reload();
          }, 50);
        }
        
        return { ran: true };
        
      } catch (e) {
        log("error", `Scrape Error: ${e.message}`);
        return { ran: false };
      } finally {
        _scrapePromise = null;
      }
    })();
    
    return await _scrapePromise;
  }

  const onDidFinishLoad = () => { 
    if (active && refresh.enabled && !paused) scheduleAfterDelay(bumpCycle()); 
  };
  
  function scheduleAfterDelay(cId) {
    clearScheduled();
    const wait = Math.max(0, Number(delayMs) || DEF_MS);
    const MAX_DOM_RETRIES = 5;

    scheduled = setTimeout(async () => {
      scheduled = null;
      if (!active || !refresh.enabled || paused) return;

      let attempt = 0;

      const tryOnce = async () => {
        if (!active || !refresh.enabled || paused) return;

        const r = await scrapeOnce(cId);

        if (!active || !refresh.enabled || paused) return;

        if (r && r.retry) {
          if (attempt < MAX_DOM_RETRIES) {
            attempt++;
            scheduled = setTimeout(tryOnce, RETRY_MS);
          } else {
            consecutiveForceReloads++;
            log("warning", `Scrape: Not ready after ${MAX_DOM_RETRIES} retries — force reload #${consecutiveForceReloads}`);
            if (!win || win.isDestroyed()) return;
            if (consecutiveForceReloads >= 3) {
              consecutiveForceReloads = 0;
              log("warning", "Scrape: Page stale detected — navigating to default URL");
              try { await navigateToDefault({ hard: true }); } catch { win.webContents.reload(); }
            } else {
              win.webContents.reload();
            }
          }
        } else if (r && r.ran) {
          consecutiveForceReloads = 0;
        }
      };

      await tryOnce();
    }, wait);
  }

  function enable() {
    if (active) return;
    active = true;
    startKeepAlive(win);
    safe(() => win.webContents.on("did-finish-load", onDidFinishLoad));
    const isLoading = safe(() => (typeof win.webContents.isLoadingMainFrame === "function")
      ? win.webContents.isLoadingMainFrame()
      : win.webContents.isLoading(), false);
    if (refresh.enabled && !isLoading && !paused) scheduleAfterDelay(bumpCycle());
    log("info", "Scrape: Enabled");
  }
  
  function disable() {
    if (!active) return;
    active = false;
    stopKeepAlive();
    clearScheduled();
    clearCycleReload();
    safe(() => win.webContents.removeListener("did-finish-load", onDidFinishLoad));
    log("info", "Scrape: Disabled");
  }
  
  async function navigateToDefault({ hard = false } = {}) {
    if (!win || win.isDestroyed()) return;
    try {
      const href = await exec("location.href");
      const onDefault = typeof href === "string" && href.startsWith(URL_DEFAULT);
      if (hard || !onDefault) win.loadURL(URL_DEFAULT);
      else win.webContents.reloadIgnoringCache();
    } catch { 
      win.loadURL(URL_DEFAULT); 
    }
  }

  return {
    enable, 
    disable, 
    scrapeOnce,
    enableAutoReload, 
    disableAutoReload, 
    getReloadState,
    wireListsIPC, 
    getProducts, 
    setProducts, 
    navigateToDefault,
    setPaused(flag = true) {
      paused = !!flag;
      if (paused) { 
        clearScheduled();
        clearCycleReload();
        stopKeepAlive(); 
      }
      else if (active) { 
        scheduleAfterDelay(bumpCycle()); 
        startKeepAlive(win); 
      }
    },
    isPaused() { return !!paused; },
    resetLog() {
      rows = [];
      keys.clear();
      serial = 1;
      persistJSON();
      log("info", "Products Log Reset");
    }
  };
}

module.exports = { createProductScraper };
