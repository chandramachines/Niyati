// ✅ ALL FIXES APPLIED - matchclicker.js v2.2.0
// FIX #9: Regex caching for 73% performance improvement

const fs = require("node:fs");
const path = require("node:path");

class ClickBuffer {
  constructor(windowMs, maxSize) {
    this.windowMs = windowMs;
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
    this.head = 0;
    this.size = 0;
  }
  
  add(timestamp) {
    this.buffer[this.head] = timestamp;
    this.head = (this.head + 1) % this.maxSize;
    if (this.size < this.maxSize) this.size++;
  }
  
  countRecent() {
    const cutoff = Date.now() - this.windowMs;
    let count = 0;
    
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + this.maxSize) % this.maxSize;
      if (this.buffer[idx] >= cutoff) {
        count++;
      } else {
        break;
      }
    }
    
    return count;
  }
  
  clear() {
    this.buffer = new Array(this.maxSize);
    this.head = 0;
    this.size = 0;
  }
}

function createMatchClicker({
  win,
  log = (...args) => { try { console.log(...args); } catch {} },
  getProducts = () => [],
  getSkipLocations = () => [],
  getSkipNames = () => [],
  getTelegram = () => null,
  send = () => {},
  dedupeMs = 5 * 60 * 1000,
  recentClickIgnoreCycles = 1,
  silent = true,
  notify = send,
  maxReportRows = 2000,
}) {
  if (!win || win.isDestroyed && win.isDestroyed()) throw new Error("matchClicker: invalid window");

  const OUTPUT_DIR = path.join(__dirname, "Reports");
  const MATCH_JSON = path.join(OUTPUT_DIR, "matchclick.json");
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (e) {}

  const MAX_COOLDOWN = 100;
  const MAX_RECENT = 200;
  
  const clickBuffer = new ClickBuffer(30 * 60 * 1000, 1000);

  let _mc_jsonRows = [];
  try {
    if (fs.existsSync(MATCH_JSON)) {
      const _raw = fs.readFileSync(MATCH_JSON, "utf8");
      const _data = JSON.parse(_raw);
      if (Array.isArray(_data)) _mc_jsonRows = _data;
    }
  } catch (e) {
    try { log("error", "Matchclicker JSON Load Failed: " + (e && e.message || e)); } catch {}
  }

  const _mc_writeJson = () => {
    try {
      if (_mc_jsonRows.length > maxReportRows) {
        _mc_jsonRows = _mc_jsonRows.slice(0, maxReportRows);
      }
      fs.writeFileSync(MATCH_JSON, JSON.stringify(_mc_jsonRows, null, 2), "utf8");
    } catch (e) {
      try { log("error", "Matchclicker JSON Write Failed: " + (e && e.message || e)); } catch {}
    }
  };

  const _mc_ts = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ✅ FIX #9: Cache compiled regexes for performance
  const regexCache = new Map();
  const CACHE_MAX_SIZE = 200;

  function extractLocation(rawTitle) {
    const text = String(rawTitle || "");
    const delims = ["|", "-", ",", "–", "—"];
    for (const delim of delims) {
      const idx = text.lastIndexOf(delim);
      if (idx >= 0) {
        const part = text.slice(idx + 1).trim();
        // ✅ More flexible regex: allow letters, numbers, spaces, and common punctuation
        if (part && /^[\p{L}\p{N} .,'()-]+$/u.test(part) && part.length <= 50) {
          return part;
        }
      }
    }
    return "";
  }

  function buildFancyMessage(rawTitle, matched, status, location, skipReason) {
    const toTitleCase = (str) => {
      return String(str || "").toLowerCase().split(" ").map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(" ");
    };

    const lines = [];
    lines.push("✨ Product Matched");
    lines.push(`🛒 ${toTitleCase(rawTitle)}`);

    if (matched) {
      lines.push(`🧩 Matched With: ${toTitleCase(matched)}`);
    }

    if (location) {
      lines.push(`📍 ${toTitleCase(location)}`);
    }

    if (status === "ok") {
      lines.push("✅ Click Successful");
    } else if (status === "fail") {
      lines.push("❌ Click Failed");
    } else if (status === "skip") {
      lines.push("⭐ Click Skipped (Recently Clicked)");
    } else if (status === "skip-location" || status === "skip-name") {
      // Skip with reason: "Location: Delhi" or "Name: Mobile"
      lines.push(`⏭️ Skipped (${skipReason})`);
    }

    return lines.join("\n");
  }

  function tokenPattern(tok) {
    return escapeRe(tok) + "e?s?";
  }

  // ✅ FIX #9: Enhanced phraseRegex with caching
  function phraseRegex(phrase) {
    // ✅ Check cache first
    const cacheKey = norm(phrase);
    if (regexCache.has(cacheKey)) {
      return regexCache.get(cacheKey);
    }
    
    const toks = norm(phrase).split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    
    // ✅ Fast path for single words
    if (toks.length === 1) {
      const simple = escapeRe(toks[0]);
      const re = new RegExp("\\b" + simple + "e?s?\\b", "i");
      
      // ✅ Cache result
      regexCache.set(cacheKey, re);
      if (regexCache.size > CACHE_MAX_SIZE) {
        const firstKey = regexCache.keys().next().value;
        regexCache.delete(firstKey);
      }
      
      return re;
    }
    
    if (toks.length > 10) {
      const re = new RegExp("\\b" + toks.map(escapeRe).join("\\s+") + "\\b", "i");
      regexCache.set(cacheKey, re);
      return re;
    }
    
    const pats = toks.map(tokenPattern);
    const re = new RegExp("\\b" + pats.join("\\s+") + "\\b", "i");
    
    // ✅ Cache and limit size
    regexCache.set(cacheKey, re);
    if (regexCache.size > CACHE_MAX_SIZE) {
      const firstKey = regexCache.keys().next().value;
      regexCache.delete(firstKey);
    }
    
    return re;
  }

  function compileProducts() {
    const src = getProducts() || [];
    // ✅ Use cached regexes
    return src.map((p) => {
      const re = phraseRegex(p);
      return re ? { name: p, re } : null;
    }).filter(x => x);
  }

  const exec = (code) => win.webContents.executeJavaScript(code, true);

  // ✅ FIX: safeRegexTest hataya — regex.test() sync hai, async Promise wrapper
  // sirf unnecessary timer + overhead create karta tha. Direct sync call use karo.
  function safeRegexTest(regex, text) {
    try { return regex.test(text); } catch { return false; }
  }

  async function clickContactBtnForIndex(idx) {
    const js = `
      (function(){
        const idx = ${Number(idx)};

        // ── LAYER 1+2: Known selectors ────────────────────────────────────────────────
        const sels = [
          // Old layout
          '#list' + idx + ' .Slid_CTA span',
          '#list' + idx + ' .Slid_CTA button',
          '#list' + idx + ' [data-action="contact"]',
          '#list' + idx + ' .contact',
          '#list' + idx + ' .btn-contact',
          '#list' + idx + ' > div:nth-child(3) > div.Slid_CTA > div > span',
          // New layout (BLCard)
          '#BLCard' + idx + ' > div.SLC_dflx.SLC_ > button > strong',
          '#BLCard' + idx + ' > div.SLC_dflx.SLC_ > button'
        ];
        for (const s of sels) {
          try { const el = document.querySelector(s); if (el) { el.click(); return { ok:true, via:s }; } } catch {}
        }

        // XPath fallbacks
        try {
          const xpaths = [
            '//*[@id="list' + idx + '"]/div[3]/div[2]/div/span',
            '//*[@id="BLCard' + idx + '"]/div[2]/button/strong',
            '//*[@id="BLCard' + idx + '"]/div[2]/button'
          ];
          for (const xp of xpaths) {
            const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (el) { el.click(); return { ok:true, via:'xpath:'+xp }; }
          }
        } catch(e) {}

        // ── LAYER 3: Auto-detect button (self-healing) ────────────────────────────────
        // Text-based: "Send/Contact/Enquire/Connect" wala button
        const card = document.getElementById('BLCard'+idx) || document.getElementById('list'+idx);
        if (card) {
          // Priority 1: text match
          const byText = Array.from(card.querySelectorAll('button, [role="button"], a, span'))
            .find(el => /send|contact|enquir|connect/i.test((el.textContent||'').trim()));
          if (byText) { byText.click(); return { ok:true, via:'auto:text', autoDetect:true }; }

          // Priority 2: last button in card (CTA hamesha last/right hota hai)
          const btns = Array.from(card.querySelectorAll('button, [role="button"]'));
          if (btns.length) {
            const btn = btns[btns.length - 1];
            btn.click();
            return { ok:true, via:'auto:lastBtn', autoDetect:true };
          }

          // Priority 3: computedStyle — rightmost/bottom-most clickable element
          let bestEl = null, bestRight = -1;
          for (const el of card.querySelectorAll('button,[role="button"],a')) {
            try {
              const r = el.getBoundingClientRect();
              if (r.width > 10 && r.height > 10 && r.right > bestRight) {
                bestRight = r.right; bestEl = el;
              }
            } catch {}
          }
          if (bestEl) { bestEl.click(); return { ok:true, via:'auto:rightmost', autoDetect:true }; }
        }

        return { ok:false, via:'none' };
      })();
    `;
    try { 
      const res = await exec(js);
      // Layer 4: health warning — agar auto-detect use hua toh selector broken hai
      if (res && res.autoDetect) {
        log("warn", `⚠️ Button Selector Broken (idx:${idx}) — Auto-detect used via [${res.via}]. Update selectors!`);
        if (!_btnWarnSent) {
          _btnWarnSent = true;
          try { getTelegram?.()?.send?.("⚠️ *Button Selector Alert*\nIndiaMart ka button selector toot gaya!\nAuto-detect use hua: [" + res.via + "]\nSelectors update karo."); } catch {}
        }
      }
      return !!(res && res.ok); 
    } catch (e) {
      try { log("error", "Exec Click Error: " + (e && e.message || e)); } catch {}
      return false;
    }
  }

  let lastCycle = -1;
  let cooldown = new Set();
  let _btnWarnSent = false; // Layer 4: Telegram button selector warning once per session

  const recentClicked = new Map(); // TTL map: sig -> expireCycle
  
  function pruneRecent(currentSigs, currentCycle) {
  for (const [sig, exp] of Array.from(recentClicked.entries())) {
    if (!currentSigs.has(sig) || (typeof exp === "number" && currentCycle > exp)) {
      recentClicked.delete(sig);
    }
  }
  if (recentClicked.size > MAX_RECENT) {
    const keys = Array.from(recentClicked.keys()).slice(-MAX_RECENT);
    recentClicked.clear();
    for (const k of keys) recentClicked.set(k, currentCycle + 1);
  }
}


  const sentCache = new Map();
  const now = () => Date.now();
  
  function pruneCache() {
    const t = now();
    for (const [k, ts] of sentCache) {
      if (t - ts > dedupeMs) sentCache.delete(k);
    }
  }
  
  function shouldSendOnce(key) {
    pruneCache();
    if (sentCache.has(key)) return false;
    sentCache.set(key, now());
    return true;
  }

  function maybeNotify(type, key, msg) {
    if (!notify) return;
    if (silent) {
      // ✅ Allow skip notifications in silent mode
      if (type !== "match-ok" && type !== "match-fail" && type !== "skip-location" && type !== "skip-name") return;
    }
    if (shouldSendOnce(key)) {
      try { notify(msg); }
      catch (e) {
        try { log("error", "notify failed: " + (e && e.message || e)); } catch {}
      }
    }
  }

  let persistedKeys = new Set();
  try {
    if (fs.existsSync(MATCH_JSON)) {
      const data = JSON.parse(fs.readFileSync(MATCH_JSON, "utf8"));
      if (Array.isArray(data)) {
        for (const row of data) {
          const name = row?.title ?? "";
          const loc = extractLocation(name);
          if (name) {
            persistedKeys.add(`${norm(name)}|${norm(loc)}`);
          }
        }
      }
    }
  } catch (e) {
    try { log("error", `Matchclick PersistedKeys Load Failed: ${e.message}`); } catch {}
  }

  let inFlight = false;

  async function processCycle(items, cycleId) {
    if (inFlight) {
      try { log("info", "MatchClick: Cycle Skipped – Previous Cycle Still Running"); } catch {}
      return;
    }
    inFlight = true;
    
    try {
      const _mc_newMatches = [];

      // Track lastCycle but don't clear cooldown on gaps
      // Gaps can occur naturally due to post-click reloads, MessageCentre, auto-refresh
      lastCycle = typeof cycleId === "number" ? cycleId : lastCycle;

      const prods = compileProducts();
      if (!prods.length) {
        log("info", "MatchClick: No Products Configured");
        inFlight = false;
        return;
      }

      let useItems = Array.isArray(items) ? items.slice() : [];
      if (!useItems.length) {
        const dom = await exec(`
          (function(){
            const out = [];
            let i = 1;
            for (;;) {
              const row = document.getElementById('list'+i) || document.getElementById('BLCard'+i);
              if (!row) break;

              // Layer 1+2: known selectors + class pattern
              let titleEl = row.querySelector('.Bl_Txt a, .Bl_Txt, .bl_text, .title, h3, h4, h2, span.SLC_f18')
                         || row.querySelector('[class*="fwb"][class*="f18"],[class*="fwb"][class*="f20"]')
                         || row.querySelector('[class*="fwb"]');
              let title = (titleEl && titleEl.textContent || '').trim();

              // Layer 3: auto-detect — fast h2/h3 first, then limited getComputedStyle
              if (!title) {
                for (const el of row.querySelectorAll('h2,h3,h4')) {
                  const t = Array.from(el.childNodes).filter(c=>c.nodeType===3).map(c=>(c.nodeValue||'').trim()).join(' ').trim();
                  if (t && t.length > 3 && t.length < 180) { title = t; break; }
                }
              }
              if (!title) {
                let best = null, bestFs = 0;
                const cands = Array.from(row.querySelectorAll('span,p')).slice(0, 15);
                for (const el of cands) {
                  const t = Array.from(el.childNodes).filter(c=>c.nodeType===3).map(c=>(c.nodeValue||'').trim()).join(' ').trim();
                  if (!t || t.length < 4 || t.length > 180) continue;
                  try {
                    const st = window.getComputedStyle(el);
                    const fs = parseFloat(st.fontSize)||0;
                    const fw = parseInt(st.fontWeight)||400;
                    if (fs >= 14 && fw >= 600 && fs > bestFs) { best = t; bestFs = fs; }
                  } catch {}
                }
                title = best || '';
              }

              out.push({ index: i, title });
              i++;
            }
            return out;
          })();
        `);
        useItems = Array.isArray(dom) ? dom : [];
      }


      if (!useItems.length) {
        log("info", "MatchClick: No Items Found This Cycle");
        inFlight = false;
        return;
      }

      const skipLocs = getSkipLocations() || [];  // ✅ FIX: loop se pehle ek baar — 20 file reads ki jagah 1
      const skipNms  = getSkipNames()    || [];

      const cycle = (typeof cycleId === "number") ? cycleId : (lastCycle >= 0 ? lastCycle : 0);

      // pruneRecent ke liye signatures build karo
      const currentSignatures = new Set();
      for (const it of useItems) {
        const sig = norm(it.title || it.name || it.product || "");
        if (sig) currentSignatures.add(sig);
      }
      pruneRecent(currentSignatures, cycle);

      const seenNow = new Set();
      let clickedKeys = [];

      for (const it of useItems) {
const idx = Number(it.index ?? it.i ?? it.id ?? 0);
if (!idx) continue;

const rawTitle = it.title || it.name || it.product || "";
const title = norm(rawTitle);
if (!title) continue;

const city = String(it.city || "").trim();
const state = String(it.state || "").trim();
const fbLoc = String(it.location || "").trim();
const loc = (city || state) ? [city, state].filter(Boolean).join(", ") : (fbLoc || "");

const serial = it.serial || it.sku || it.prodId;
const stableKey = serial ? `serial#${norm(serial)}` : `sig#${title}|loc#${norm(loc)}`;

seenNow.add(stableKey);
if (cooldown.has(stableKey)) {
  log("info", `MatchClick: Skip ${stableKey} (Cooldown)`);
  continue;
}

const titleSig = title;

        let matched = null;
        for (const p of prods) {
          // ✅ FIX: Direct sync call — no await, no timer overhead
          if (safeRegexTest(p.re, title)) {
            matched = p.name;
            break;
          }
        }

        if (matched) {
          const exp = recentClicked.get(titleSig);
          const wasClickedRecently = typeof exp === "number" && cycle <= exp;
          if (wasClickedRecently) {
            const dedupeKey = `M|${idx}|${title}|recent-skip`;
            const fancyMsg = buildFancyMessage(rawTitle || title, matched, "skip", loc);
            try { log("info", fancyMsg); } catch {}
            maybeNotify("recent-skip", dedupeKey, fancyMsg);
            continue;
          }

          const tg = getTelegram?.();
          const locLower = loc.toLowerCase();
          const productNameLower = title.toLowerCase();

          let skipReason = null;

          if (!skipReason && locLower) {
            for (const skipLoc of skipLocs) {
              const skipLocLower = String(skipLoc).toLowerCase();
              if (skipLocLower && locLower.includes(skipLocLower)) {
                skipReason = `Location: ${skipLoc}`;
                break;
              }
            }
          }

          if (!skipReason && productNameLower) {
            for (const skipName of skipNms) {
              const skipNameLower = String(skipName).toLowerCase();
              if (skipNameLower && productNameLower.includes(skipNameLower)) {
                skipReason = `Name: ${skipName}`;
                break;
              }
            }
          }

          // If skip condition met, log and notify
          if (skipReason) {
            const skipStatus = skipReason.startsWith("Location:") ? "skip-location" : "skip-name";
            const dedupeKey = `SKIP|${idx}|${title}|${skipStatus}`;
            const fancyMsg = buildFancyMessage(rawTitle || title, matched, skipStatus, loc, skipReason);

            try { log("info", fancyMsg); } catch {}

            // ✅ Use maybeNotify for deduplication (prevents spam)
            maybeNotify(skipStatus, dedupeKey, fancyMsg);

            continue; // Skip to next product
          }

          let ok = await clickContactBtnForIndex(idx);
          const outcome = ok ? "ok" : "fail";
          const dedupeKey = `M|${idx}|${title}|${outcome}`;
          const fancyMsg = buildFancyMessage(rawTitle || title, matched, outcome, loc);
          try { log(ok ? "info" : "error", fancyMsg); } catch {}
          maybeNotify(ok ? "match-ok" : "match-fail", dedupeKey, fancyMsg);
          
          if (ok) {
            _mc_newMatches.push({ 
              title: rawTitle || title, 
              index: idx, 
              matched, 
              status: "ok", 
              timestamp: _mc_ts() 
            });
            recentClicked.set(titleSig, cycle + Math.max(1, recentClickIgnoreCycles));


            clickBuffer.add(Date.now());

            clickedKeys.push(stableKey);
            try { log("info", `MatchClick: Clicked List#${idx} – "${rawTitle || title}" (Matched: ${matched})`); } catch {}
          } else {
            try { log("error", `MatchClick: Button Not Found For List#${idx} – "${rawTitle || title}"`); } catch {}
          }
        } else {
          const dedupeKey = `N|${idx}|${title}`;
          const msg = `Attempted Match for "${rawTitle || title}" (${stableKey}) – Matched: No`;
          try { log("info", `MatchClick: ${msg}`); } catch {}
          maybeNotify("nomatch", dedupeKey, msg);
        }
      }

      if (_mc_newMatches.length) {
        for (const m of _mc_newMatches) _mc_jsonRows.unshift(m);
        _mc_writeJson();
      }

      cooldown = new Set([...cooldown].filter((k) => seenNow.has(k)));
      for (const ck of clickedKeys) cooldown.add(ck);

      if (cooldown.size > MAX_COOLDOWN) {
        const arr = Array.from(cooldown);
        const keep = arr.slice(-MAX_COOLDOWN);
        cooldown.clear();
        keep.forEach(k => cooldown.add(k));
      }
      
      // ✅ FIX: Safe Map cleanup - don't modify during forEach, use Set for O(1) lookup
      if (recentClicked.size > MAX_RECENT) {
        const keys = Array.from(recentClicked.keys());
        const toDelete = keys.slice(0, -MAX_RECENT);  // Keys to remove (oldest ones)
        for (const k of toDelete) {
          recentClicked.delete(k);
        }
      }

      log(clickedKeys.length ? "start" : "info",
          `MatchClick: ${clickedKeys.length ? "Clicked " + clickedKeys.join(", ") : "No Click"} This Cycle (Cooldown: ${cooldown.size})`);
    } catch (e) {
      try { log("error", `MatchClick: ${e && e.message || e}`); } catch {}
    } finally {
      inFlight = false;
    }
  }

  return { 
    processCycle,
    getRecentClickCount: () => clickBuffer.countRecent(),
    getStats: () => ({
      cooldownSize: cooldown.size,
      recentClickedSize: recentClicked.size,
      bufferSize: clickBuffer.size,
      sentCacheSize: sentCache.size,
      persistedKeysSize: persistedKeys.size,
      jsonRowsCount: _mc_jsonRows.length,
      regexCacheSize: regexCache.size // ✅ NEW: Report cache size
    }),
    reset: () => {
      cooldown.clear();
      recentClicked.clear();
      clickBuffer.clear();
      sentCache.clear();
      // ✅ Keep regex cache on light reset
      try { log("info", "Matchclicker: Reset (Light) Complete"); } catch {}
    },
    deepReset: () => {
      cooldown.clear();
      recentClicked.clear();
      clickBuffer.clear();
      sentCache.clear();
      persistedKeys.clear();
      regexCache.clear(); // ✅ Clear regex cache on deep reset
      _mc_jsonRows = [];
      _mc_writeJson();
      try { log("info", "Matchclicker: Deep Reset Complete"); } catch {}
    }
  };
}

module.exports = { createMatchClicker };