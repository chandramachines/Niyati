// ================================================================
// Niyati Browser - Renderer.js
// Version: 3.0.0
// ================================================================

const CONST = Object.freeze({
  LS_REFRESH:  "niyati:leadsRefresh",
  LS_PRODUCTS: "niyati:products",
  LS_KEYWORDS: "niyati:keywords",
  LS_SKIP_LOCATIONS: "niyati:skipLocations",
  LS_SKIP_NAMES: "niyati:skipNames",
  LOG_CARD_LIMIT: 3000,
  BATCH_SIZE_LIMIT: 500,
  MIN_SEC: 3,
  MAX_SEC: 3600,
  DEFAULT_SEC: 7
});

const $ = (s, r=document)=>r.querySelector(s);
const on = (el, ev, fn, opts)=> el.addEventListener(ev, fn, opts);

// ✅ FIX #5: SAFE HTML BUILDER - Whitelist approach
const h = (tag, cls, content) => { 
  const n = document.createElement(tag); 
  if (cls) n.className = cls;
  
  if (content != null) {
    // ✅ Always use textContent by default (safe)
    n.textContent = String(content);
  }
  
  return n;
};

const pad2 = n=> String(n).padStart(2,"0");
const fmtTime = (t=Date.now())=>{ const d=new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

// ✅ FIX #18: LOCALSTORAGE QUOTA HANDLING
const jsonGet = (k, fb=null)=>{ 
  try{ 
    const val=JSON.parse(localStorage.getItem(k)||"null"); 
    return val!==null?val:fb; 
  }catch{ return fb; } 
};

const MAX_STORAGE_ITEMS = 100;
const MAX_STORAGE_SIZE = 1000000; // 1MB

const jsonSet = (k, v)=> {
  try {
    // ✅ Truncate arrays
    if (Array.isArray(v) && v.length > MAX_STORAGE_ITEMS) {
      console.warn(`${k} truncated from ${v.length} to ${MAX_STORAGE_ITEMS}`);
      v = v.slice(0, MAX_STORAGE_ITEMS);
    }
    
    const serialized = JSON.stringify(v);
    
    // ✅ Check size
    if (serialized.length > MAX_STORAGE_SIZE) {
      console.error(`${k} Too Large (${serialized.length} Bytes)`);
      return false;
    }

    localStorage.setItem(k, serialized);
    return true;
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      console.error("localStorage Quota Exceeded");
      try {
        // Clear refresh state and retry
        localStorage.removeItem(CONST.LS_REFRESH);
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch {
        console.error("Still Can't Store After Clearing");
        return false;
      }
    }
    console.error(`jsonSet Error: ${e.message}`);
    return false;
  }
};

// ================================================================
// DOM Elements
// ================================================================

const BTN_MIN=$("#min"), BTN_MAX=$("#max"), BTN_CLOSE=$("#close"), MAX_ICON=$("#maxIcon");
const NET_CHIP=$("#netStatus"), NET_LABEL=$(".label", NET_CHIP);
const REF_FORM=$("#refreshForm"), BTN_START=$("#refreshStart"), BTN_STOP=$("#refreshStop");
const PROD_FORM=$("#prodForm"), PROD_INPUT=$("#prodInput"), PROD_LIST=$("#prodList"), PROD_COUNT=$("#prodCount");
const KEY_FORM=$("#keyForm"), KEY_INPUT=$("#keyInput"), KEY_INLINE=$("#keyInline"), KEY_COUNT=$("#keyCount");
const SKIP_LOC_FORM=$("#skipLocForm"), SKIP_LOC_INPUT=$("#skipLocInput"), SKIP_LOC_INLINE=$("#skipLocInline"), SKIP_LOC_COUNT=$("#skipLocCount");
const SKIP_NAME_FORM=$("#skipNameForm"), SKIP_NAME_INPUT=$("#skipNameInput"), SKIP_NAME_INLINE=$("#skipNameInline"), SKIP_NAME_COUNT=$("#skipNameCount");
const LOG_LIST=$("#logList"), LOG_COUNT=$("#logCount");

// ================================================================
// Window Controls
// ================================================================

let offWin = null;
try {
  if (BTN_MIN && window.NiyatiWindow?.minimize) {
    on(BTN_MIN, "click", ()=> window.NiyatiWindow.minimize());
  }
  if (BTN_CLOSE && window.NiyatiWindow?.close) {
    on(BTN_CLOSE, "click", ()=> window.NiyatiWindow.close());
  }
  if (BTN_MAX && window.NiyatiWindow?.maximize) {
    on(BTN_MAX, "click", ()=> window.NiyatiWindow.maximize());
  }

  if (window.NiyatiWindow?.onState) {
    offWin = window.NiyatiWindow.onState((state)=>{
      const isMax = state === "max";
      if (BTN_MAX) {
        BTN_MAX.dataset.state = isMax ? "max" : "restored";
        BTN_MAX.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
        BTN_MAX.title = isMax ? "Restore" : "Maximize";
      }
      if (MAX_ICON) {
        MAX_ICON.innerHTML = isMax
          ? `<path d="M8 9.5h7.5v7.5H8z" fill="none" stroke="currentColor" stroke-width="2"></path><path d="M8.5 8.5h7v1" stroke="currentColor" stroke-width="2"></path>`
          : `<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"></rect>`;
      }
    });
  }
} catch(e) {
  console.error("Window controls error:", e);
}

// ================================================================
// Theme Picker
// ================================================================

const THEME_BTN = $("#titleThemeTrigger"); // Title text is now the theme trigger
const THEME_PANEL = $("#themePanel");
const COLOR_BTNS = document.querySelectorAll(".color-btn");
const CUSTOM_COLOR_PICKER = $("#customColorPicker");
const APPLY_CUSTOM_COLOR = $("#applyCustomColor");
const LS_THEME_BG = "niyati:themeBg";

function applyBackgroundColor(color) {
  if (!color) return;

  // Set CSS variable and direct style for compatibility
  document.documentElement.style.setProperty('--theme-bg', color);
  document.body.style.backgroundColor = color;

  // Update active state on buttons
  COLOR_BTNS.forEach(btn => {
    const isActive = btn.dataset.bg === color;
    btn.classList.toggle("active", isActive);
  });

  if (CUSTOM_COLOR_PICKER) {
    CUSTOM_COLOR_PICKER.value = color;
  }
}

// Load saved theme on startup
const savedBg = jsonGet(LS_THEME_BG, "#0b0c0e");
applyBackgroundColor(savedBg);

// Toggle theme panel
if (THEME_BTN && THEME_PANEL) {

  // Function to show/hide panel with direct styles
  function toggleThemePanel(show) {
    if (show) {
      THEME_PANEL.classList.add("open");
      // Direct style as fallback
      THEME_PANEL.style.opacity = "1";
      THEME_PANEL.style.visibility = "visible";
      THEME_PANEL.style.transform = "translateX(-50%) translateY(0)";
      THEME_BTN.setAttribute("aria-expanded", "true");
    } else {
      THEME_PANEL.classList.remove("open");
      // Direct style as fallback
      THEME_PANEL.style.opacity = "0";
      THEME_PANEL.style.visibility = "hidden";
      THEME_PANEL.style.transform = "translateX(-50%) translateY(-10px)";
      THEME_BTN.setAttribute("aria-expanded", "false");
    }
  }

  // Start hidden
  toggleThemePanel(false);

  // Click handler
  THEME_BTN.addEventListener("click", function(e) {
    e.stopPropagation();
    e.preventDefault();
    const isCurrentlyOpen = THEME_PANEL.classList.contains("open");
    toggleThemePanel(!isCurrentlyOpen);
  });

  // Close panel when clicking outside
  document.addEventListener("click", function(e) {
    if (!THEME_PANEL.contains(e.target) && !THEME_BTN.contains(e.target)) {
      toggleThemePanel(false);
    }
  });
}

// Preset color buttons - Set background colors via JS (CSP blocks inline styles)
COLOR_BTNS.forEach((btn) => {
  const bgColor = btn.dataset.bg;
  if (bgColor) {
    btn.style.backgroundColor = bgColor;
  }

  on(btn, "click", (e) => {
    e.stopPropagation();
    const color = btn.dataset.bg;
    applyBackgroundColor(color);
    jsonSet(LS_THEME_BG, color);
  });
});

// Custom color picker
if (APPLY_CUSTOM_COLOR && CUSTOM_COLOR_PICKER) {
  on(APPLY_CUSTOM_COLOR, "click", (e) => {
    e.stopPropagation();
    const color = CUSTOM_COLOR_PICKER.value;
    applyBackgroundColor(color);
    jsonSet(LS_THEME_BG, color);
    COLOR_BTNS.forEach(btn => btn.classList.remove("active"));
  });

  on(CUSTOM_COLOR_PICKER, "change", () => {
    const color = CUSTOM_COLOR_PICKER.value;
    applyBackgroundColor(color);
    jsonSet(LS_THEME_BG, color);
    COLOR_BTNS.forEach(btn => btn.classList.remove("active"));
  });
}

// ================================================================
// Network Status
// ================================================================

function setNetState(online){
  NET_CHIP.classList.toggle("online", !!online);
  NET_CHIP.classList.toggle("offline", !online);
  NET_LABEL.textContent = online ? "Online" : "Offline";
  window.NetBridge?.report?.(!!online);
}
setNetState(false);
on(window, "online",  ()=> window.NetBridge?.report?.(true));
on(window, "offline", ()=> window.NetBridge?.report?.(false));

// ================================================================
// Refresh Controls
// ================================================================

const setRunningUI = (running)=>{ BTN_START.disabled=running; BTN_STOP.disabled=!running; };

function applyRefreshState(s){
  try { setNetState(!!s.isNetworkOnline); } catch {};
  if (s.enabled) {
    setRunningUI(true);
    BTN_START.textContent="⟳ Running";
    BTN_START.title="Instant cycle mode active";
  } else {
    setRunningUI(false);
    if (!s.isNetworkOnline) { BTN_START.textContent="Paused (offline)"; BTN_START.title="Network offline"; }
    else if (s.suspendedByAuth || s.isLoggedIn===false) { BTN_START.textContent="Paused (login)"; BTN_START.title="Login required"; }
    else { BTN_START.textContent="Start"; BTN_START.title="Start auto-refresh"; }
  }
}
let offRefresh = null;
try {
  if (window.LeadsRefresh?.onState) {
    offRefresh = window.LeadsRefresh.onState(applyRefreshState);
  }
} catch(e) {
  console.error("LeadsRefresh.onState error:", e);
}

if (REF_FORM) {
  on(REF_FORM, "submit", async (e)=>{
    e.preventDefault();
    try {
      if (window.LeadsRefresh?.start) {
        await window.LeadsRefresh.start(7000); // ms ignored in cycle mode
      }
      if (window.LeadsRefresh?.getState) {
        applyRefreshState(await window.LeadsRefresh.getState());
      }
    } catch (e) {
      console.error("Failed to Start Refresh:", e);
    }
  });
}

if (BTN_STOP) {
  on(BTN_STOP, "click", async ()=>{
    try {
      if (window.LeadsRefresh?.stop) {
        await window.LeadsRefresh.stop();
      }
      jsonSet(CONST.LS_REFRESH, { ...(jsonGet(CONST.LS_REFRESH, {})), enabled:false });
      if (window.LeadsRefresh?.getState) {
        applyRefreshState(await window.LeadsRefresh.getState());
      }
    } catch (e) {
      console.error("Failed to Stop Refresh:", e);
    }
  });
}

(async ()=>{
  try {
    window.NetBridge?.report?.(navigator.onLine);
    const pref = jsonGet(CONST.LS_REFRESH);
    if (pref?.enabled) {
      try {
        await window.LeadsRefresh.start(7000); // ms ignored in cycle mode
      } catch (e) {
        console.error("Failed to Auto-Start Refresh:", e);
      }
    }
    if (window.LeadsRefresh?.getState) {
      applyRefreshState(await window.LeadsRefresh.getState());
    }
  } catch(e) {
    console.error("Refresh initialization error:", e);
  }
})();

// ================================================================
// Products & Keywords Management
// ================================================================

const normSpace = s=> String(s||"").trim().replace(/\s+/g," ");
const toTitle = s=> normSpace(s).toLowerCase().split(" ").map(w=> w? (w[0].toUpperCase()+w.slice(1)):"").join(" ");
const uniqPush = (arr, val, key=(x)=>x.toLowerCase())=>{ if(!val) return; const k=key(val); if(!arr.some(v=>key(v)===k)) arr.push(val); };

const persist = async (type, arr)=>{
  let storageKey;
  if (type==="products") storageKey = CONST.LS_PRODUCTS;
  else if (type==="keywords") storageKey = CONST.LS_KEYWORDS;
  else if (type==="skipLocations") storageKey = CONST.LS_SKIP_LOCATIONS;
  else if (type==="skipNames") storageKey = CONST.LS_SKIP_NAMES;

  jsonSet(storageKey, arr);

  try {
    if (type==="products") {
      await window.Lists.saveProducts(arr);
    } else if (type==="keywords") {
      await window.Lists.saveKeywords(arr);
    } else if (type==="skipLocations") {
      await window.Lists.saveSkipLocations(arr); // ✅ FIX Bug3: return hataya — neeche return true hoga
    } else if (type==="skipNames") {
      await window.Lists.saveSkipNames(arr);     // ✅ FIX Bug3: return hataya — neeche return true hoga
    }
    return true; // ✅ Sab types ke liye consistent true return
  } catch (e) {
    console.error(`Failed To Persist ${type}:`, e);
    return false;
  }
};

let products = jsonGet(CONST.LS_PRODUCTS, []);
let keywords = jsonGet(CONST.LS_KEYWORDS, []);
let skipLocations = jsonGet(CONST.LS_SKIP_LOCATIONS, []);
let skipNames = jsonGet(CONST.LS_SKIP_NAMES, []);

function renderProducts(arr){
  PROD_LIST.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((item, idx)=>{
    const li = h("li","pill");
    
    const left = h("div", "left");
    const serial = h("span", "serial", String(idx+1));
    const title = h("span", "title", item);
    left.appendChild(serial);
    left.appendChild(title);
    
    const btn = h("button", "del");
    btn.textContent = "Delete";
    btn.dataset.index = String(idx);
    btn.setAttribute("aria-label", "Delete");
    
    li.appendChild(left);
    li.appendChild(btn);
    frag.appendChild(li);
  });
  PROD_LIST.append(frag); 
  PROD_COUNT.textContent = arr.length;
}

function renderKeywords(arr){
  KEY_INLINE.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((kw, idx)=>{
    const span = h("span","kw");
    const text = h("span","", kw);
    const btn = h("button","rm");
    btn.textContent="×";
    btn.dataset.index=String(idx);
    btn.setAttribute("aria-label",`Remove ${kw}`);
    span.appendChild(text);
    span.appendChild(btn);
    frag.appendChild(span);
  });
  KEY_INLINE.append(frag);
  KEY_COUNT.textContent = arr.length;
}

function renderSkipLocations(arr){
  SKIP_LOC_INLINE.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((loc, idx)=>{
    const span = h("span","kw");
    const text = h("span","", loc);
    const btn = h("button","rm");
    btn.textContent="×";
    btn.dataset.index=String(idx);
    btn.setAttribute("aria-label",`Remove ${loc}`);
    span.appendChild(text);
    span.appendChild(btn);
    frag.appendChild(span);
  });
  SKIP_LOC_INLINE.append(frag);
  SKIP_LOC_COUNT.textContent = arr.length;
}

function renderSkipNames(arr){
  SKIP_NAME_INLINE.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((name, idx)=>{
    const span = h("span","kw");
    const text = h("span","", name);
    const btn = h("button","rm");
    btn.textContent="×";
    btn.dataset.index=String(idx);
    btn.setAttribute("aria-label",`Remove ${name}`);
    span.appendChild(text);
    span.appendChild(btn);
    frag.appendChild(span);
  });
  SKIP_NAME_INLINE.append(frag);
  SKIP_NAME_COUNT.textContent = arr.length;
}

on(PROD_FORM, "submit", async (e)=>{
  e.preventDefault();
  const raw = PROD_INPUT.value.trim();
  if (!raw) return;
  const items = raw.split(",").map(toTitle).filter(Boolean);
  for (const it of items) uniqPush(products, it);
  renderProducts(products);
  await persist("products", products);
  PROD_INPUT.value=""; PROD_INPUT.focus();
});

on(PROD_LIST, "click", async (e)=>{
  if (e.target.matches(".del")) {
    const idx = Number(e.target.dataset.index);
    if (!isNaN(idx)) {
      products.splice(idx, 1);
      renderProducts(products);
      await persist("products", products);
    }
  }
});

on(KEY_FORM, "submit", async (e)=>{
  e.preventDefault();
  const raw = KEY_INPUT.value.trim();
  if (!raw) return;
  const items = raw.split(",").map(normSpace).filter(Boolean);
  for (const it of items) uniqPush(keywords, it);
  renderKeywords(keywords);
  await persist("keywords", keywords);
  KEY_INPUT.value=""; KEY_INPUT.focus();
});

on(KEY_INLINE, "click", async (e)=>{
  if (e.target.matches(".rm")) {
    const idx = Number(e.target.dataset.index);
    if (!isNaN(idx)) {
      keywords.splice(idx, 1);
      renderKeywords(keywords);
      await persist("keywords", keywords);
    }
  }
});

on(SKIP_LOC_FORM, "submit", async (e)=>{
  e.preventDefault();
  const raw = SKIP_LOC_INPUT.value.trim();
  if (!raw) return;
  const items = raw.split(",").map(normSpace).filter(Boolean);
  for (const it of items) uniqPush(skipLocations, it);
  renderSkipLocations(skipLocations);
  await persist("skipLocations", skipLocations);
  SKIP_LOC_INPUT.value=""; SKIP_LOC_INPUT.focus();
});

on(SKIP_LOC_INLINE, "click", async (e)=>{
  if (e.target.matches(".rm")) {
    const idx = Number(e.target.dataset.index);
    if (!isNaN(idx)) {
      skipLocations.splice(idx, 1);
      renderSkipLocations(skipLocations);
      await persist("skipLocations", skipLocations);
    }
  }
});

on(SKIP_NAME_FORM, "submit", async (e)=>{
  e.preventDefault();
  const raw = SKIP_NAME_INPUT.value.trim();
  if (!raw) return;
  const items = raw.split(",").map(normSpace).filter(Boolean);
  for (const it of items) uniqPush(skipNames, it);
  renderSkipNames(skipNames);
  await persist("skipNames", skipNames);
  SKIP_NAME_INPUT.value=""; SKIP_NAME_INPUT.focus();
});

on(SKIP_NAME_INLINE, "click", async (e)=>{
  if (e.target.matches(".rm")) {
    const idx = Number(e.target.dataset.index);
    if (!isNaN(idx)) {
      skipNames.splice(idx, 1);
      renderSkipNames(skipNames);
      await persist("skipNames", skipNames);
    }
  }
});

// Collapse buttons removed - cards always expanded

renderProducts(products);
renderKeywords(keywords);
renderSkipLocations(skipLocations);
renderSkipNames(skipNames);
// ✅ ADD THIS BLOCK HERE:
window.RendererLists = Object.freeze({
  refresh: () => {
    try {
      products = jsonGet(CONST.LS_PRODUCTS, []);
      keywords = jsonGet(CONST.LS_KEYWORDS, []);
      skipLocations = jsonGet(CONST.LS_SKIP_LOCATIONS, []);
      skipNames = jsonGet(CONST.LS_SKIP_NAMES, []);
      renderProducts(products);
      renderKeywords(keywords);
      renderSkipLocations(skipLocations);
      renderSkipNames(skipNames);
      return true;
    } catch (e) {
      console.error('RendererLists.refresh error:', e);
      return false;
    }
  }
});

// ================================================================
// Log System
// ================================================================

const LOG_CATEGORIES = {
  auth: { emoji:"🔐", module:"Auth" }, start: { emoji:"▶️", module:"Start" }, stop: { emoji:"⏹️", module:"Stop" },
  refresh: { emoji:"🔄", module:"Refresh" }, scrape: { emoji:"🔍", module:"Scrape" },
  telegram: { emoji:"✈️", module:"Telegram" }, error: { emoji:"❌", module:"Error" },
  info: { emoji:"ℹ️", module:"Info" }, warning: { emoji:"⚠️", module:"Warning" },
  debug: { emoji:"🐛", module:"Debug" }
};

function classify(msg){
  const lc = String(msg).toLowerCase();
  
  if (/keyword matched|keywordmatch/i.test(msg)) return { emoji:"✨", module:"Keyword", msg };
  if (/^mc:/i.test(msg) || /messagecentre|block#/i.test(msg)) return { emoji:"📨", module:"MessageCentre", msg };
  
  for (const [key, cat] of Object.entries(LOG_CATEGORIES)) {
    if (lc.includes(key) || lc.startsWith(key+":")) return { ...cat, msg };
  }
  
  return { emoji:"📋", module:"General", msg };
}

const LogFns = (() => {
  const onlyDataMC = (html) => {
    const s = String(html||"").replace(/<\/?b[^>]*>/gi,"").replace(/^MC:\s*/i,"").trim();
    const m = s.match(/^block#\s*\d+\s*→\s*(.+)$/i);
    return m ? m[1].trim() : s;
  };

  const mcParse = (html) => {
    const out = {};
    let s = onlyDataMC(html);
    s = String(s||"").replace(/<\/?b[^>]*>/gi,"").replace(/^MC:\s*/i,"").replace(/^block#\s*\d+\s*→\s*/i,"").trim();
    for (const p of s.split("|").map(x=>x.trim()).filter(Boolean)) {
      const m = p.match(/^(\w+)\s*:\s*(.+)$/); if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k.startsWith("buyer")) out.buyer=v;
      else if (k.startsWith("product")) out.product=v;
      else if (k.startsWith("company")) out.company=v;
      else if (k.startsWith("email")) out.email=v;
      else if (k.startsWith("gstin")) out.gstin=v;
      else if (k.startsWith("mobile")||k==="phone") out.mobile=v;
      else if (k.startsWith("address")) out.address=v.replace(/\s*\n\s*/g,", ");
      else if (k.startsWith("time")) out.time=v;
    }
    return out;
  };

  const extractKeywordTitle = (raw)=>{
    const s=String(raw);
    let m = s.match(/"([^"]+)"/); if (m) return m[1].trim();
    m = s.match(/🛒\s*([^|]+)$/); if (m) return m[1].trim();
    m = s.match(/Keyword matched\s*(?:–|-)?\s*(?:\|\s*)?(?:🛒\s*)?(.+)$/i);
    if (m) { const t=m[1].trim(); if (!/^keyword matched$/i.test(t)) return t; }
    const plain = s.replace(/<\/?[^>]+>/g,"").trim();
    return plain && plain.length<=80 && !/^keyword matched$/i.test(plain) ? plain : null;
  };

  const extractKeywordMeta = (raw)=>{
    const s = String(raw||"").trim();
    let m = s.match(/keywordmatch:\s*"([^"]+)"(?:\s*\[([^\]]+)\])?/i);
    if (m) return { title: m[1].trim(), location: (m[2]||"").trim() };
    m = s.match(/"([^"]+)"(?:\s*\[([^\]]+)\])?/);
    if (m) return { title: m[1].trim(), location: (m[2]||"").trim() };
    m = s.match(/🛒\s*([^|]+?)(?:\s*\|\s*📍\s*([^\|]+))?$/);
    if (m) return { title: m[1].trim(), location: (m[2]||"").trim() };
    const t = extractKeywordTitle(s);
    return t ? { title: t, location: "" } : null;
  };

  const normalizeKey = html => String(html).replace(/<\/?[^>]+>/g,"").replace(/\s+/g," ").trim().toLowerCase();
  const extractTitle = html => String(html).match(/class="h-title">([^<]+)</i)?.[1]?.trim().toLowerCase() || null;

  return { mcParse, extractKeywordTitle, extractKeywordMeta, normalizeKey, extractTitle, onlyDataMC };
})();

// ✅ FIX #17: BATCH FLUSH RACE CONDITION FIXED
let batch = [];
let isFlushScheduled = false;
let isFlushInProgress = false;

function scheduleFlush(){
  if (isFlushScheduled || isFlushInProgress) return;
  
  // ✅ Limit batch size
  if (batch.length > CONST.BATCH_SIZE_LIMIT) {
    batch.splice(0, batch.length - CONST.BATCH_SIZE_LIMIT);
  }
  
  isFlushScheduled = true;
  
  requestAnimationFrame(() => {
    isFlushScheduled = false;
    flushBatch();
  });
}

function flushBatch(){
  if (isFlushInProgress) return;
  if (!batch.length) return;

  isFlushInProgress = true;
  
  // ✅ Take snapshot to prevent race
  const toFlush = batch.slice();
  batch = [];
  
  try {
    const groups = [];
    let last = null;
    
    for (const it of toFlush) {
      if (!last || last.module !== it.module) {
        groups.push(last = { module: it.module, t: it.t, rows: [it] });
      } else {
        last.rows.push(it);
      }
    }

    const frag = document.createDocumentFragment();

    for (const g of groups) {
      const card = h("li", "logbox");
      // Add data-module attribute for CSS color styling
      card.dataset.module = g.module;

      const hdr = h("div", "loghdr");
      const time = h("span", "time", fmtTime(g.t));
      const mod = h("span", "module", g.module);
      hdr.appendChild(time);
      hdr.appendChild(mod);
      
      const lines = h("ul", "lines");

      if (g.module === "Keyword") {
        const keyLine = h("li");
        const emo = h("span", "emo", "✨");
        const txt = h("span", "txt", "Keyword Matched");
        txt.style.color = "#38bdf8";
        txt.style.fontWeight = "600";
        keyLine.appendChild(emo);
        keyLine.appendChild(txt);
        lines.appendChild(keyLine);

        const seen = new Set();
        for (const it of g.rows) {
          const meta = LogFns.extractKeywordMeta(it.msg);
          if (!meta || !meta.title) continue;

          const key = (meta.title + "|" + (meta.location||"")).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          const prodLine = h("li");
          const prodEmo = h("span", "emo", "🛒");
          const prodTxt = h("span", "txt");
          const titleB = h("b", "h-title", meta.title);
          prodTxt.appendChild(titleB);
          prodLine.appendChild(prodEmo);
          prodLine.appendChild(prodTxt);
          lines.appendChild(prodLine);
          
          if (meta.location) {
            const locLine = h("li");
            const locEmo = h("span", "emo", "📍");
            const locTxt = h("span", "txt", meta.location);
            locLine.appendChild(locEmo);
            locLine.appendChild(locTxt);
            lines.appendChild(locLine);
          }
        }

        card.appendChild(hdr);
        card.appendChild(lines);
        frag.prepend(card);
        continue;
      }

      if (g.module === "MessageCentre") {
        let added = 0;
        for (const it of g.rows) {
          const f = LogFns.mcParse(it.msg);
          if (!Object.keys(f).length) continue;

          if (f.product) {
            const line = h("li");
            const emo = h("span", "emo", "🛒");
            const txt = h("span", "txt");
            const titleB = h("b", "h-title", f.product);
            txt.appendChild(titleB);
            line.appendChild(emo);
            line.appendChild(txt);
            lines.appendChild(line);
            added++;
          }
          if (f.buyer) { const line = h("li"); line.appendChild(h("span","emo","👤")); line.appendChild(h("span","txt",f.buyer)); lines.appendChild(line); added++; }
          if (f.mobile) { const line = h("li"); line.appendChild(h("span","emo","📞")); line.appendChild(h("span","txt",f.mobile)); lines.appendChild(line); added++; }
          if (f.email) { const line = h("li"); line.appendChild(h("span","emo","✉️")); line.appendChild(h("span","txt",f.email)); lines.appendChild(line); added++; }
          if (f.company) { const line = h("li"); line.appendChild(h("span","emo","🏢")); line.appendChild(h("span","txt",f.company)); lines.appendChild(line); added++; }
          if (f.gstin) { const line = h("li"); line.appendChild(h("span","emo","🧾")); line.appendChild(h("span","txt",f.gstin)); lines.appendChild(line); added++; }
          if (f.address) { const line = h("li"); line.appendChild(h("span","emo","📍")); line.appendChild(h("span","txt",f.address)); lines.appendChild(line); added++; }
          if (f.time) { const line = h("li"); line.appendChild(h("span","emo","⏰")); line.appendChild(h("span","txt",f.time)); lines.appendChild(line); added++; }

          if (added) {
            const sp = h("li");
            sp.appendChild(h("span","emo",""));
            sp.appendChild(h("span","txt"," "));
            sp.style.opacity = "0.15";
            lines.appendChild(sp);
          }
        }
        if (!added) continue;
        card.appendChild(hdr);
        card.appendChild(lines);
        frag.prepend(card);
        continue;
      }

      const seen = new Set();
      const titleSeen = new Set();
      for (const it of g.rows) {
        const line = h("li");
        
        // ✅ Safe text handling
        let txt = it.msg;
        const titleMatch = txt.match(/"([^"]+)"/);
        if (titleMatch) {
          const before = txt.substring(0, titleMatch.index);
          const title = titleMatch[1];
          const after = txt.substring(titleMatch.index + titleMatch[0].length);
          
          const t = title.trim().toLowerCase();
          if (t) {
            if (titleSeen.has(t)) continue;
            titleSeen.add(t);
          }
          
          const txtSpan = h("span", "txt");
          txtSpan.textContent = before;
          const titleB = h("b", "h-title", title);
          txtSpan.appendChild(titleB);
          const afterText = document.createTextNode(after);
          txtSpan.appendChild(afterText);
          
          const k = LogFns.normalizeKey(it.msg);
          if (seen.has(k)) continue;
          seen.add(k);
          
          line.appendChild(h("span", "emo", it.emoji));
          line.appendChild(txtSpan);
        } else {
          const k = LogFns.normalizeKey(txt);
          if (seen.has(k)) continue;
          seen.add(k);

          line.appendChild(h("span", "emo", it.emoji));

          // Check if message has a heading prefix
          const headingMatch = txt.match(/^(MatchClick|Scrape|#List\d+):\s*/);
          if (headingMatch) {
            const txtSpan = h("span", "txt");
            const heading = h("span", "", headingMatch[0]);
            heading.style.color = "#38bdf8";
            heading.style.fontWeight = "600";
            const rest = txt.substring(headingMatch[0].length);
            txtSpan.appendChild(heading);
            txtSpan.appendChild(document.createTextNode(rest));
            line.appendChild(txtSpan);
          } else {
            line.appendChild(h("span", "txt", txt));
          }
        }
        
        lines.appendChild(line);
      }
      
      card.appendChild(hdr);
      card.appendChild(lines);
      frag.prepend(card);
    }

    LOG_LIST.prepend(frag);
    
    // ✅ Limit log list size
    while (LOG_LIST.children.length > CONST.LOG_CARD_LIMIT) {
      LOG_LIST.removeChild(LOG_LIST.lastChild);
    }
    
    if (LOG_COUNT) LOG_COUNT.textContent = String(LOG_LIST.children.length);
    
  } finally {
    isFlushInProgress = false;
    
    // ✅ If new items added during flush, schedule again
    if (batch.length > 0) {
      scheduleFlush();
    }
  }
}

function addLog({ t, level, msg }){
  const clean = String(msg ?? "").replace(/^LM:\s*/,'').trim();
  const { module, emoji, msg:renderMsg } = classify(clean);
  batch.push({ t: t||Date.now(), module, emoji, msg: renderMsg });
  
  // ✅ Limit batch size
  if (batch.length > CONST.BATCH_SIZE_LIMIT) {
    batch.splice(0, batch.length - CONST.BATCH_SIZE_LIMIT);
  }
  
  scheduleFlush();
}

let offLogs = null;
try {
  if (window.Logs?.onAppend) {
    offLogs = window.Logs.onAppend(addLog);
  }
} catch(e) {
  console.error("❌ Logs.onAppend error:", e);
}

// ================================================================
// Cleanup on Window Close
// ================================================================

on(window, "beforeunload", ()=>{
  offWin?.();
  offLogs?.();
  offRefresh?.();

  // ✅ Clean up any remaining scheduled tasks
  isFlushScheduled = false;
  isFlushInProgress = false;
  batch = [];

  if (tCountdown) {
    clearInterval(tCountdown);
    tCountdown = null;
  }

  // ✅ FIX: Remove visibilitychange listener to prevent memory leak
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});

// ================================================================
// Page Visibility - Pause Animations When Hidden
// ================================================================

function handleVisibilityChange() {
  if (document.hidden) {
    document.body.classList.add('page-hidden');
  } else {
    document.body.classList.remove('page-hidden');
  }
}

document.addEventListener('visibilitychange', handleVisibilityChange);

// Initial check
handleVisibilityChange();

// ================================================================
// Ready Message
// ================================================================

// Debug logs removed for production
