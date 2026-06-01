// ✅ ALL FIXES APPLIED - productScraper.js v2.2.0
// FIX #5: Atomic scraper lock with promise chaining

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
  const MIN_MS = 3000, DEF_MS = 7000, RETRY_MS = 800, BLANKS_BREAK = 5; // RETRY_MS: 1500→800ms
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
  
  // ⚡ OPT: Debounced persistState — har cycle pe sync disk write nahi, 5s baad ek baar
  let _persistDebounce = null;
  const persistState = () => {
    clearTimeout(_persistDebounce);
    _persistDebounce = setTimeout(() => writeJSON(F_STATE, refresh), 5000);
  };
  // Turant flush karna ho toh (shutdown/stop pe)
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
  // Cycle-based reload: setInterval ki jagah har cycle ke end pe turant reload
  let _beforeReload = () => {};
  let cycleReloadTimer = null;

  const clearCycleReload = () => {
    if (cycleReloadTimer) { clearTimeout(cycleReloadTimer); cycleReloadTimer = null; }
  };

  function enableAutoReload(ms = refresh.intervalMs, beforeReload = () => {}) {
    disableAutoReload("switching");
    // ✅ ms is now ignored — reload happens automatically after each scrape+match+click cycle
    _beforeReload = typeof beforeReload === 'function' ? beforeReload : () => {};
    refresh.userWantedAutoRefresh = true;
    refresh.enabled = true;
    refresh.lastStartAt = now();
    persistState();
    // ✅ FIX: Pehla cycle kickoff — page already loaded ho toh did-finish-load nahi aata
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
      // Page load ho rahi hai? → did-finish-load → onDidFinishLoad → scheduleAfterDelay auto-trigger karega
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
      persistStateNow(); // ⚡ Stop pe turant flush
      log("stop", `Auto-Refresh Stopped${reason ? ` – ${reason}` : ""}`);

      // ✅ Don't send Telegram notification on quit or internal switching
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

    // Parse legacy UTC ISO ("...Z") and new IST "YYYY-MM-DD HH:mm:ss"
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
    // ✅ FIX: persistJSON yahan se hataya — items loop ke baad batch mein ek baar call hoga
    keys.add(key);
    log("info", `Persist: + "${title}"${location ? ` [${location}]` : ""}`);
    serial += 1;
    return true;
  }

  let active = false, scheduled = null, cycleId = 0, paused = false;
  let _scrapePromise = null; // ✅ FIX #5: Use promise instead of boolean flag
  let _selectorWarnSent = false; // Layer 4: send Telegram warning only once per session
  let lastCycleDurationMs = null;
  let _cycleStartAt = 0;
  let consecutiveForceReloads = 0; // ✅ FIX: Track repeated force reloads — navigateToDefault after 3 fails
  
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

  // ✅ FIX #5: Atomic scraper lock with promise chaining
  async function scrapeOnce(currentCycleId) {
    // ✅ Atomic lock with promise joining
    if (_scrapePromise) {
      log("debug", "Scrape: Already Running, Joining Existing Scrape");
      try {
        return await _scrapePromise;
      } catch (e) {
        log("error", `Scrape: Previous Scrape Failed: ${e.message}`);
        return { ran: false, reason: 'previous-failed' };
      }
    }
    
    // ✅ Create new scrape promise
    _scrapePromise = (async () => {
      try {
        _cycleStartAt = now();
        if (paused) { 
          log("info","Scrape: Paused – Skip"); 
          return { ran: false, reason: 'paused' }; 
        }
        if (!win || win.isDestroyed()) return { ran: false };
        
        // ✅ Add timeout protection
        const SCRAPE_TIMEOUT = 30000;
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Scrape timeout')), SCRAPE_TIMEOUT)
        );

        const scrapePromise = (async () => {
          const js = `(function(max, loginSel){
            if (document.readyState !== 'interactive' && document.readyState !== 'complete')
              return { ready:false, items:[] };
            if (!document.querySelector(loginSel)) return { ready:true, loggedIn:false, items:[] };

            // ── Card detection: old #list{i} | new #BLCard{i} ──────────────────────────
            const firstCard = document.querySelector('#list1') || document.querySelector('#BLCard1');
            if (!firstCard) {
              const noData = document.querySelector([
                // ✅ Exact selector from IndiaMart — "As per your current selection" warning
                '#root > div:nth-child(8) > div > div.RelventLeads.BuyLdC_wrap > div.BuyLdC_wrapCont.SLC_dflxG > div > div > strong',
                // XPath fallback (as CSS): same element via class
                'div.RelventLeads strong',
                'div.BuyLdC_wrap strong',
                // Old selectors
                '#bl_listing .alertmsg',
                '#bl_listing h2.alertmsg',
                '#new_buy_leads_msg',
                '#grid22msg11',
              ].join(','));
              if (noData) return { ready:true, loggedIn:true, items:[] };
              return { ready:false, items:[] };
            }

            // ── Helpers ──────────────────────────────────────────────────────────────────
            const txt   = n => (n ? (n.textContent||'').trim() : '');
            // qs: full textContent (title use)
            const qs    = sel => { try { const n=document.querySelector(sel); return txt(n); } catch { return ''; } };
            // qtxt: ONLY direct text nodes — skip child links/spans (city/state use)
            const qtxt  = sel => { try { const n=document.querySelector(sel); if(!n) return ''; return Array.from(n.childNodes).filter(c=>c.nodeType===3).map(c=>(c.nodeValue||'').trim()).filter(Boolean).join(' ').trim(); } catch { return ''; } };
            const xpS   = xp  => { try { return String(document.evaluate(xp,document,null,XPathResult.STRING_TYPE,null).stringValue||'').trim(); } catch { return ''; } };
            const xpN   = xp  => { try { return document.evaluate(xp,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue; } catch { return null; } };
            const xpTxt = xp  => { const n=xpN(xp); return txt(n); };

            // ── LAYER 3: Auto-detect via computedStyle (self-healing) ────────────────────
            // Selector/class change ho tab bhi kaam karta hai — font-size+weight se title dhundho
            // ── LAYER 3: Auto-detect — getComputedStyle ONLY called as last resort ────────
            // Optimization: scan sirf h2/h3/span (not div/a) — max 15 elements per card
            function autoTitle(card) {
              if (!card) return '';
              // Fast pass: pehle class-agnostic bold candidates dhundho (no getComputedStyle)
              for (const el of card.querySelectorAll('h2,h3,h4')) {
                const t = Array.from(el.childNodes).filter(c=>c.nodeType===3).map(c=>(c.nodeValue||'').trim()).join(' ').trim();
                if (t && t.length > 3 && t.length < 180) return t;
              }
              // Slow pass: getComputedStyle — max 15 span/p elements only
              const candidates = Array.from(card.querySelectorAll('span,p')).slice(0, 15);
              let best = null, bestFs = 0;
              for (const el of candidates) {
                const t = Array.from(el.childNodes).filter(c=>c.nodeType===3).map(c=>(c.nodeValue||'').trim()).join(' ').trim();
                if (!t || t.length < 4 || t.length > 180 || /^\d[\d\s,.]*$/.test(t)) continue;
                try {
                  const st = window.getComputedStyle(el);
                  const fs = parseFloat(st.fontSize) || 0;
                  const fw = parseInt(st.fontWeight) || 400;
                  if (fs >= 14 && fw >= 600 && fs > bestFs) { best = t; bestFs = fs; }
                } catch {}
              }
              return best || '';
            }

            // Location auto-detect: NO getComputedStyle — pure text pattern matching
            function autoLocation(card) {
              if (!card) return { city:'', state:'', location:'' };
              const results = [];
              // Scan max 20 spans — stop as soon as 2 location-like texts found
              const els = Array.from(card.querySelectorAll('span,strong')).slice(0, 20);
              for (const el of els) {
                const t = Array.from(el.childNodes).filter(c=>c.nodeType===3).map(c=>(c.nodeValue||'').trim()).join(' ').trim();
                if (!t || t.length < 2 || t.length > 60) continue;
                // Only letters (city/state pattern) — no numbers, no punctuation
                if (!/^[A-Za-zऀ-ॿ][A-Za-zऀ-ॿ ]{1,}$/.test(t)) continue;
                // Skip if parent has bold class (likely title)
                if ((el.className||'').includes('fwb') || (el.className||'').includes('bold')) continue;
                results.push(t);
                if (results.length >= 2) break;
              }
              return { city: results[0]||'', state: results[1]||'', location: '' };
            }

            // ── LAYER 4: Selector health monitor ─────────────────────────────────────────
            const _broken = [];

            // ── LAYER 1+2: Known selectors + class pattern fallbacks ──────────────────────
            const titleBySelectors = i => {
              const card = document.getElementById('BLCard'+i) || document.getElementById('list'+i);
              return (
                // Old layout
                qs('#list'+i+' div.lstNwLft > div.lstNwLftImg.lstNwDflx.lstNwPr > div > h2') ||
                qs('#list'+i+' h2') ||
                xpTxt('//*[@id="list'+i+'"]//h2') ||
                // New layout — known selectors
                qs('#BLCard'+i+' > div.SLC_dflxG.BuyLdC_Gtc1.SLC_ais.BuyLdC_gap.SLC_f12 > div.SLC_dflx.SLC_flxdc.BuyLdC_brd > span') ||
                xpTxt('//*[@id="BLCard'+i+'"]/div[1]/div[1]/span') ||
                // Layer 2: class pattern — bold+large (stable even if class names change)
                (card ? (()=>{ const n=card.querySelector('[class*="fwb"][class*="f18"],[class*="fwb"][class*="f20"],[class*="f18"][class*="fwb"]'); return n ? Array.from(n.childNodes).filter(c=>c.nodeType===3).map(c=>(c.nodeValue||'').trim()).join(' ').trim() : ''; })() : '')
              );
            };

            const cityBySelectors = i =>
              xpS('//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[1]/text()') ||
              qtxt('#BLCard'+i+' > div.SLC_dflxG.BuyLdC_Gtc1.SLC_ais.BuyLdC_gap.SLC_f12 > div.SLC_dflx.SLC_flxdc.BuyLdC_brd > div > div > div.BuyLdC_time_loc > div.SLC_dflx.SLC_aic.SLC_gap5 > strong:nth-child(2)') ||
              xpS('//*[@id="BLCard'+i+'"]/div[1]/div[1]/div/div/div[1]/div[1]/strong[1]/text()');

            const stateBySelectors = i =>
              xpS('//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[2]/text()') ||
              qtxt('#BLCard'+i+' > div.SLC_dflxG.BuyLdC_Gtc1.SLC_ais.BuyLdC_gap.SLC_f12 > div.SLC_dflx.SLC_flxdc.BuyLdC_brd > div > div > div.BuyLdC_time_loc > div.SLC_dflx.SLC_aic.SLC_gap5 > strong:nth-child(4)') ||
              xpS('//*[@id="BLCard'+i+'"]/div[1]/div[1]/div/div/div[1]/div[1]/strong[3]/text()');

            const fbXp = i => xpS('//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span/span/text()');

            // ── Main scrape loop ──────────────────────────────────────────────────────────
            const items = [];
            let blanks = 0;
            for (let i=1; i<=max; i++){
              const card = document.getElementById('BLCard'+i) || document.getElementById('list'+i);
              if (!card && i > 1 && ++blanks >= 5) break;
              if (!card) { blanks++; continue; }

              // Title: selectors first, auto-detect as final fallback
              let title = titleBySelectors(i);
              let usedAutoTitle = false;
              if (!title) {
                title = autoTitle(card);
                usedAutoTitle = !!title;
                if (usedAutoTitle) _broken.push('title#'+i);
              }

              if (title) {
                // Location: selectors first, auto-detect as final fallback
                let city  = cityBySelectors(i);
                let state = stateBySelectors(i);
                let location = '';
                let usedAutoLoc = false;
                if (!city && !state) {
                  location = fbXp(i);
                  if (!location) {
                    const auto = autoLocation(card);
                    city = auto.city; state = auto.state;
                    usedAutoLoc = !!(city || state);
                    if (usedAutoLoc) _broken.push('loc#'+i);
                  }
                }
                items.push({ index:i, title, city: city||'', state: state||'', location: location||'' });
                blanks = 0;
              } else {
                if (++blanks >= ${BLANKS_BREAK} && items.length) break;
              }
            }

            // Layer 4: health report — agar koi auto-detect use hua toh warn karo
            const selectorsBroken = _broken.length > 0;
            return { ready:true, loggedIn:true, items, selectorsBroken, brokenAt: _broken };
          })(${Number(maxItems)}, ${JSON.stringify(loginSelector)})`;

          return await exec(js);
        })();
        
        // ✅ Race against timeout
        const res = await Promise.race([scrapePromise, timeoutPromise]);
        
        if (!res || res.ready === false) { 
          log("info", "Scrape: Not Ready (Will Retry)"); 
          return { ran: false, retry: true }; 
        }
        if (res.loggedIn === false) { 
          log("info", "Scrape: Not Logged In"); 
          if (onItems) { try { await onItems([], currentCycleId); } catch {} }
          return { ran: true }; 
        }

        // Layer 4: Selector health warning — log + Telegram (once per session)
        if (res.selectorsBroken) {
          const brokenMsg = "⚠️ Selector Health: Auto-detect used for [" + (res.brokenAt||[]).join(', ') + "] — IndiaMart layout changed! Update selectors.";
          log("warn", brokenMsg);
          if (!_selectorWarnSent) {
            _selectorWarnSent = true;
            try { getTelegram?.()?.send?.("⚠️ *Selector Alert*\nIndiaMart ka layout change ho gaya!\nAuto-detect use hua: [" + (res.brokenAt||[]).join(', ') + "]\nSelectors update karo."); } catch {}
          }
        }

        const items = Array.isArray(res.items) ? res.items : [];
        if (!items.length) {
          log("info", "Scrape: No Products Found");
        } else {
          let newCount = 0;
          for (const it of items) {
            const loc = composeLoc(it);
            log("scrape", `#List${it.index}: ${it.title}${loc ? ` [${loc}]` : ""}`);
            if (it.title && recordIfNew(it.title, loc)) newCount++;
          }
          // ✅ FIX: Ek baar batch write — 20 items = 20 writes ki jagah sirf 1
          if (newCount > 0) persistJSON();
          log("info", `Scrape: ${items.length} Product(s)${newCount ? ` (${newCount} new)` : ""}`);
        }
        // ✅ Await onItems — processCycle (click) complete hone do pehle reload karo
        if (onItems) {
          try { await onItems(items, currentCycleId); } catch(e) {
            log("error", `onItems Error: ${e?.message || e}`);
          }
        }
        // ✅ Cycle complete → turant next page reload (instant cycle mode)
        if (active && refresh.enabled && !paused) {
          cycleReloadTimer = setTimeout(() => {
            cycleReloadTimer = null;
            if (!win || win.isDestroyed() || !active || !refresh.enabled || paused) return;
            if (_cycleStartAt) lastCycleDurationMs = now() - _cycleStartAt;
            try { _beforeReload(); } catch {}
            win.webContents.reload();
          }, 50); // ⚡ OPT: 150→50ms — scrape+click already done, minimal settle needed
        }
        return { ran: true };
        
      } catch (e) {
        if (e.message === 'Scrape timeout') {
          log("error", "⏱️ Scrape Timed Out - Page May Be Frozen");
        } else {
          log("error", `Scrape Error: ${e.message}`);
        }
        return { ran: false };
      } finally {
        // ✅ Clear promise reference when done
        _scrapePromise = null;
      }
    })();
    
    // ✅ Return the promise (first caller gets this directly)
    return await _scrapePromise;
  }

  const onDidFinishLoad = () => { 
    if (active && refresh.enabled && !paused) scheduleAfterDelay(bumpCycle()); 
  };
  
  function scheduleAfterDelay(cId) {
    clearScheduled();
    const wait = Math.max(0, Number(delayMs) || DEF_MS);
    const MAX_DOM_RETRIES = 5; // 5 × 800ms = 4s max DOM wait

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
            log("warning", `Scrape: DOM not ready after ${MAX_DOM_RETRIES} retries — force reload #${consecutiveForceReloads}`);
            if (!win || win.isDestroyed()) return;
            // ✅ FIX: 3 baar force reload ke baad bhi ready nahi → navigateToDefault
            // (window minimize se page stale/navigate away ho jaata hai — hard reload se wapas laao)
            if (consecutiveForceReloads >= 3) {
              consecutiveForceReloads = 0;
              log("warning", "Scrape: Page stale detected — navigating to default URL");
              try { await navigateToDefault({ hard: true }); } catch { win.webContents.reload(); }
            } else {
              win.webContents.reload();
            }
          }
        } else if (r && r.ran) {
          consecutiveForceReloads = 0; // ✅ FIX: Success pe counter reset
        }
        // r.ran === true → cycleReloadTimer already scheduled inside scrapeOnce ✅
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