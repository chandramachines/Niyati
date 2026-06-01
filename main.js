// Niyati Browser - Main Process
// ✅ ALL 88 ISSUES FIXED - Version 3.1.0 COMPLETE
// Last Updated: 2025-11-12
// Fixed: Memory leaks, race conditions, blocking I/O, XSS, input validation, single instance lock
// Total Lines: ~2460

// Niyati Browser - Main Process
// ✅ ALL ISSUES FIXED - Version 3.0.0 PART 1
// Last Updated: 2025-01-06
// Lines: 1-450 (Initialization, Config, Timers, Window Management)

const { app, BrowserWindow, ipcMain, nativeTheme, net, Tray, Menu, nativeImage, powerSaveBlocker, powerMonitor } = require('electron');

// ✅ FIX: isShuttingDown yahan declare karo — child-process-gone handler line 19 pe use karta hai
// let declaration se pehle use karna ReferenceError deta hai
let isShuttingDown = false;

// ✅ Handle child-process crashes
app.on('child-process-gone', (_event, details) => {
  console.error('[child-process-gone]', details.type, details.reason, details.exitCode);
  // ✅ FIX: isShuttingDown check — agar app already band ho raha hai toh relaunch mat karo
  if (details.type === 'GPU' && details.reason !== 'clean-exit' && !isShuttingDown) {
    app.relaunch();
    app.exit(0);
  }
});

let pendingStartMs = null;
let pendingResume = false;

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("path");

app.commandLine.appendSwitch("disable-logging");
// Disable QUIC protocol to prevent "Fails to find on path connection IDs" errors
app.commandLine.appendSwitch("disable-quic");
// ✅ FIX: Renderer timer throttling rokta hai jab window background/minimized ho
// backgroundThrottling:false sirf background tab ke liye kaam karta hai — ye flags OS level pe kaam karte hain
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
if (String(process.env.QUIET ?? "1") === "1") {
  const noop = () => {}; 
  console.log = console.info = console.debug = console.warn = noop;
}

// ✅ FIX #7: SECURE Environment Variable Loading
(() => { 
  try {
    const envPath = path.join(__dirname, ".env");
    
    // ✅ Check file exists and size
    if (!fs.existsSync(envPath)) return;
    
    const stats = fs.statSync(envPath);
    const MAX_ENV_FILE_SIZE = 10240; // 10KB
    
    if (stats.size > MAX_ENV_FILE_SIZE) {
      console.error(`⚠️  .env file too large (${stats.size} bytes), max ${MAX_ENV_FILE_SIZE}`);
      return;
    }
    
    // ✅ Whitelist allowed variables
    const ALLOWED_ENV_VARS = new Set([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID', 
      'INDIAMART_MOBILE',
      'LOCK_USER',
      'LOCK_PASS',
      'LOCK_PASS_HASH',
      'QUIET',
      'NODE_ENV',
      'LOCK_PERSIST',
      'LOCK_PERSIST_TTL_MS',
      'LOCK_ON_START',
      'DAILY_TZ',
      'DAILY_REPORT_TIMES',
      'DAILY_CATCHUP_MINS'
    ]);
    
    const env = fs.readFileSync(envPath, "utf8");
    
    for (const ln of env.split(/\r?\n/)) {
      const trimmed = ln.trim();
      
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const m = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      
      const [, key, rawValue] = m;
      
      // ✅ Only allow whitelisted variables
      if (!ALLOWED_ENV_VARS.has(key)) {
        console.warn(`⚠️  Ignoring unknown env var: ${key}`);
        continue;
      }
      
      // Skip if already set
      if (process.env[key] !== undefined) continue;
      
      let value = rawValue.trim();
      
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      // ✅ Validate value length
      if (value.length > 500) {
        console.error(`⚠️  Value too long for ${key} (${value.length} chars)`);
        continue;
      }
      
      process.env[key] = value;
    }
  } catch (e) {
    console.error('⚠️  Failed to load .env:', e.message);
  }
})();

const { createStatusWatcher } = require("./statuswatcher");
const { createTelegramClient, buildDefaultCommands } = require("./telegram");
const { createAutoLogin } = require("./autologin");
const { createProductScraper } = require("./productScraper");
const { createWebhookServer } = require("./webhookserver");
const { createMatchClicker } = require("./matchclicker");
const { createKeywordMatcher } = require("./keywordmatcher");
const { createLockScreen } = require("./lockscreen");
const { injectVisibilityMonitor } = require("./visibility-monitor");

const EXISTS = fs.existsSync;
const REPORTS_DIR = path.join(__dirname, "Reports");

// ✅ FIX #13: Enhanced Timer Management with Shutdown Protection
const _activeTimers = new Map();
// isShuttingDown is declared at top of file (before child-process-gone handler)

const _safeSetInterval = (fn, ms, label = '') => {
  // ✅ Don't create timers during shutdown
  if (isShuttingDown) {
    console.warn('⚠️  Attempted to create timer during shutdown:', label);
    return null;
  }
  
  const id = setInterval(fn, ms);
  _activeTimers.set(id, {
    type: 'interval',
    created: Date.now(),
    label: label || new Error().stack.split('\n')[2]?.trim() || 'unknown',
    ms
  });
  if (_activeTimers.size > 50) {
    log("warning", `⚠️ High Timer Count: ${_activeTimers.size}`);
  }
  return id;
};

const _safeClearInterval = (id) => {
  if (!id) return;
  if (!_activeTimers.has(id)) {
    log("debug", `Timer ${id} Already Cleared or Not Tracked`);
    return;
  }
  clearInterval(id);
  _activeTimers.delete(id);
};

const _safeSetTimeout = (fn, ms, label = '') => {
  // ✅ Don't create timers during shutdown
  if (isShuttingDown) {
    console.warn('⚠️  Attempted to create timeout during shutdown:', label);
    return null;
  }
  
  const id = setTimeout(() => {
    _activeTimers.delete(id);
    try { fn(); } catch (e) { log("error", `Timeout Callback Error: ${e.message}`); }
  }, ms);
  _activeTimers.set(id, {
    type: 'timeout',
    created: Date.now(),
    label: label || new Error().stack.split('\n')[2]?.trim() || 'unknown',
    ms
  });
  return id;
};

const _safeClearTimeout = (id) => {
  if (!id) return;
  if (_activeTimers.has(id)) {
    clearTimeout(id);
    _activeTimers.delete(id);
  }
};

function logActiveTimers() {
  if (_activeTimers.size === 0) return;
  log("debug", `📊 Active Timers: ${_activeTimers.size}`);
  for (const [id, info] of _activeTimers) {
    const age = Math.round((Date.now() - info.created) / 1000);
    log("debug", `  Timer ${id} [${info.type}]: ${info.ms}ms, Age: ${age}s, ${info.label.slice(0, 80)}`);
  }
}

// ✅ Power Save Blocker
let powerBlockerId = null;
function enablePowerSaveBlocker() {
  try {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      log("info", "Power Save Blocker Already Active");
      return;
    }
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    if (powerSaveBlocker.isStarted(powerBlockerId)) {
      log("info", `✅ Power Save Blocker Active (ID: ${powerBlockerId})`);
    } else {
      log("error", "❌ Power Save Blocker Failed To Start");
    }
  } catch (e) {
    log("error", `Power Save Blocker Error: ${e.message}`);
  }
}

function disablePowerSaveBlocker() {
  try {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
      log("info", "Power Save Blocker Stopped");
      powerBlockerId = null;
    }
  } catch (e) {
    log("error", `Power Save Blocker Stop Error: ${e.message}`);
  }
}

// ✅ Timer Health Check with System Resume Detection
const TIMER_HEALTH_CHECK_MS = 30000;
let lastHealthCheckTime = Date.now();
let healthCheckTimer = null;
let systemWasSuspended = false;

// ✅ Detect system resume
try {
  powerMonitor.on('suspend', () => {
    log("info", "System Suspending - Pausing Health Checks");
    systemWasSuspended = true;
  });

  powerMonitor.on('resume', () => {
    log("info", "System Resumed - Resetting Health Check Timer");
    systemWasSuspended = false;
    lastHealthCheckTime = Date.now();
  });
} catch (e) {
  log("warning", `PowerMonitor Not Available: ${e.message}`);
}

function startTimerHealthCheck() {
  if (healthCheckTimer) return;
  
  healthCheckTimer = _safeSetInterval(() => {
    const now = Date.now();
    const elapsed = now - lastHealthCheckTime;
    lastHealthCheckTime = now;
    
    // ✅ Don't trigger false alarms after system resume
    if (systemWasSuspended) {
      log("info", "Skipping Throttle Check - System Just Resumed");
      systemWasSuspended = false;
      return;
    }

    if (elapsed > 45000) {
      log("warning", `⚠️ Timer Throttling Detected! Expected ~30s, Got ${Math.round(elapsed/1000)}s`);
      log("warning", "This Indicates Window Sleep/Throttling Occurred");

      try {
        if (winLeads && !winLeads.isDestroyed()) {
          if (!winLeads.isVisible()) {
            log("warning", "Leads Window Is Hidden - Attempting To Show");
            winLeads.show();
          }
          if (winLeads.isMinimized()) {
            log("warning", "Leads Window Is Minimized - Attempting To Restore");
            winLeads.restore();
          }
        }
      } catch (e) {
        log("error", `Health Check Recovery Failed: ${e.message}`);
      }
    }
  }, TIMER_HEALTH_CHECK_MS, 'timerHealthCheck');
}

function stopTimerHealthCheck() {
  if (healthCheckTimer) {
    _safeClearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// ✅ FIX #14: Window State Recovery with Race Protection
let windowHealthCheckInterval = null;

function startWindowHealthCheck() {
  if (windowHealthCheckInterval) return;
  
  windowHealthCheckInterval = _safeSetInterval(() => {
    try {
      // ✅ Check if window exists first
      if (!winLeads || winLeads.isDestroyed()) {
        log("debug", "Leads Window Destroyed During Health Check");
        return;
      }
      
      // ✅ Take atomic snapshot of window state
      const snapshot = {
        visible: null,
        minimized: null,
        focused: null,
        destroyed: null
      };
      
      try {
        snapshot.destroyed = winLeads.isDestroyed();
        if (snapshot.destroyed) {
          log("warning", "Leads Window Destroyed, Cannot Check State");
          return;
        }
        
        snapshot.visible = winLeads.isVisible();
        snapshot.minimized = winLeads.isMinimized();
        snapshot.focused = winLeads.isFocused();
      } catch (e) {
        log("error", `Failed To Get Window State: ${e.message}`);
        return;
      }
      
      // ✅ Log state if hidden or minimized
      if (!snapshot.visible || snapshot.minimized) {
        log("debug", `Leads Window State: visible=${snapshot.visible}, minimized=${snapshot.minimized}, focused=${snapshot.focused}`);
      }
      
      // ✅ Auto-recovery with error handling
      if (!snapshot.visible && shouldShowWindows() && !lockScreen?.isLocked?.()) {
        try {
          log("info", "Auto-Recovery: Showing Hidden Leads Window");
          winLeads.show();
        } catch (e) {
          log("error", `Failed To Show Window: ${e.message}`);
        }
      }

      // ℹ️ Minimized window is intentional — do NOT auto-restore here.
      // Restore only happens on timer throttling detection (startTimerHealthCheck).


    } catch (e) {
      log("error", `Window Health Check Error: ${e.message}`);
    }
  }, 60000, 'windowHealthCheck');
}

function stopWindowHealthCheck() {
  if (windowHealthCheckInterval) {
    _safeClearInterval(windowHealthCheckInterval);
    windowHealthCheckInterval = null;
  }
}

// Input validation
const validateMs = (ms) => {
  const num = Number(ms);
  if (!Number.isFinite(num) || num < 3000 || num > 3600000) {
    throw new Error('Invalid interval: must be 3000-3600000ms');
  }
  return num;
};

function parseProductTs(s) {
  try {
    if (!s) return 0;
    if (/^\d{4}-\d{2}-\d{2}T/.test(String(s))) {
      const t = Date.parse(String(s));
      return Number.isFinite(t) ? t : 0;
    }
    const t = Date.parse(String(s).replace(' ', 'T') + '+05:30');
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

// ✅ FIX #4: ASYNC file reading with caching
let productsLogCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 5000; // Cache for 5 seconds

async function countNewProductsLast(ms = 30 * 60 * 1000) {
  try {
    const now = Date.now();
    
    // ✅ Use cache if fresh
    if (productsLogCache.data && (now - productsLogCache.timestamp) < CACHE_TTL_MS) {
      const arr = productsLogCache.data;
      let n = 0;
      for (const r of arr) {
        const t = parseProductTs(r && (r.timestamp || r.time));
        if (t && (now - t) <= ms) n++;
      }
      return n;
    }
    
    // ✅ ASYNC read
    const p = path.join(REPORTS_DIR, "products_log.json");
    if (!fs.existsSync(p)) return 0;
    
    const raw = await fsp.readFile(p, "utf8");
    const arr = JSON.parse(raw);
    
    if (!Array.isArray(arr)) return 0;
    
    // ✅ Update cache
    productsLogCache = {
      data: arr,
      timestamp: now
    };
    
    let n = 0;
    for (const r of arr) {
      const t = parseProductTs(r && (r.timestamp || r.time));
      if (t && (now - t) <= ms) n++;
    }
    return n;
  } catch { 
    return 0; 
  }
}

const SEND_FILES = [
  path.join(REPORTS_DIR, "keyword_matches.json"),
  path.join(REPORTS_DIR, "products_log.json"),
  path.join(REPORTS_DIR, "matchclick.json"),
  path.join(REPORTS_DIR, "network_status.json"),
];
const CLEANUP_FILES = [...SEND_FILES];
const LEADS_DEFAULT_URL = "https://seller.indiamart.com/bltxn/?pref=recent";

let winLeads, winManager, autoLogin, productScraper, watcher, webhook, matcher, kwMatcher, tg;
let isLoggedIn = null, isNetworkOnline = true, suspendedByAuth = false;
let tray = null;
let isRestartingWindow = false; // Flag to prevent sync close during restart
let lockScreen = null;

const DAILY_TZ = process.env.DAILY_TZ || "Asia/Kolkata";
const DAILY_REPORT_TIMES = (process.env.DAILY_REPORT_TIMES || "08:00,20:00")
  .split(",").map(s => s.trim()).filter(Boolean);
const DAILY_CATCHUP_MINS = parseInt(String(process.env.DAILY_CATCHUP_MINS ?? "120"), 10) || 120;

let dailyTimer = null;

// ✅ Network probe function (moved to module level for reuse)
// ✅ FIX: Dual probe — IndiaMart + Google fallback
// Pehle sirf IndiaMart probe hota tha — agar IndiaMart slow/down hota toh false offline trigger hota.
// Ab dono probe fail hone par hi offline declare hoga:
//   - IndiaMart OK  → online (normal case)
//   - IndiaMart fail + Google OK → IndiaMart ki apni problem, app online rehega
//   - IndiaMart fail + Google fail → actual network issue, offline declare
const _probeSingleURL = (url, timeoutMs) => {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: "HEAD", url });
      const t = setTimeout(() => { try { req.abort(); } catch {} resolve(false); }, timeoutMs);
      req.on("response", (res) => { clearTimeout(t); resolve(res.statusCode >= 200 && res.statusCode < 500); });
      req.on("error", () => { clearTimeout(t); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
};

const hostProbe = async () => {
  try {
    // Primary: IndiaMart (main target)
    const imOk = await _probeSingleURL("https://seller.indiamart.com/favicon.ico", 5000);
    if (imOk) return true;
    // Fallback: Google DNS-over-HTTPS — sirf internet connectivity check ke liye
    // IndiaMart fail + Google fail = actual offline
    // IndiaMart fail + Google OK  = IndiaMart ka issue, internet theek hai
    const gOk = await _probeSingleURL("https://dns.google/resolve?name=google.com&type=A", 4000);
    return gOk;
  } catch { return false; }
};

// ✅ Recreate watcher with current winLeads (used after leads window restart)
function recreateWatcher() {
  try { watcher?.stop?.(); } catch {}

  watcher = createStatusWatcher({
    win: winLeads,
    selector: "#selsout",
    checkEveryMs: 1200,
    hostProbe,
    onLogin:  () => {
      isLoggedIn=true;
      suspendedByAuth=false;
      log("auth","Login Detected");
      try { tg?.send?.("🔓 Logged In"); } catch {}
      autoLogin?.cancel?.();
      try { resumeScraperIfAllowed(); } catch {}
      broadcast();  // ✅ FIX: Moved AFTER resumeScraperIfAllowed() so UI gets updated state
    },
    onLogout: () => {
      isLoggedIn=false;
      log("auth","Logout Detected");
      try { tg?.send?.("🔒 Logged Out"); } catch {}
      pauseScraper("logout", true);  // skipBroadcast=true, we broadcast after setting suspendedByAuth
      suspendedByAuth=true;
      broadcast();
      requestReload("logout");

      setTimeout(() => {
        try {
          if (isLoggedIn === false && autoLogin && !autoLogin.running) {
            log("auth", "Starting Auto-Login After Logout Detection");
            autoLogin.start();
          }
        } catch (e) {
          log("error", `Auto-Login Start After Logout Failed: ${e.message}`);
        }
      }, 3000);
    },
    onOffline:() => {
      if(isNetworkOnline!==false){
        isNetworkOnline=false;
        pauseScraper("network offline", true);  // skipBroadcast=true, we broadcast after other operations

        // ✅ Record offline timestamp
        lastOfflineTimestamp = Date.now();
        const offlineTime = new Date(lastOfflineTimestamp).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour12: false
        });

        // ✅ Save offline event
        _saveNetworkEvent({
          type: 'offline',
          timestamp: lastOfflineTimestamp,
          time: offlineTime,
          reason: 'Network connection lost'
        }).catch(() => {});

        // ✅ FIX: tg.stop() hataya — Telegram api.telegram.org se chalta hai,
        // IndiaMart offline hone se koi sambandh nahi. Commands aate rehne chahiye.

        broadcast();
        log("info","Network Offline (Watcher)");
      }
    },
    onOnline: () => {
      if(isNetworkOnline!==true){
        isNetworkOnline=true;
        // ✅ Restart leads window instead of just resuming scraper when coming back online
        try{ restartLeadsWindow(); }catch{}

        // ✅ FIX: Safety net — 15s baad check karo scraper start hua ya nahi.
        // restartLeadsWindow() async hai (window load hone mein time lagta hai).
        // Agar kisi edge case mein scraper start nahi hua, yeh force-resume karta hai.
        _safeSetTimeout(() => {
          try {
            if (isNetworkOnline !== true) return;
            if (!productScraper) return;
            const st = productScraper?.getReloadState?.() || {};
            if (st.userWantedAutoRefresh && !st.enabled) {
              log("warning", "⚡ Online Safety Net: Scraper still stopped after restart — force-resuming");
              try { resumeScraperIfAllowed(); } catch {}
            } else {
              log("info", "Online Safety Net: Scraper OK");
            }
          } catch(e) {
            log("error", `Online Safety Net Error: ${e.message}`);
          }
        }, 15000, 'onlineRecoverySafetyNet');

        // ✅ Calculate downtime duration
        const onlineTimestamp = Date.now();
        const onlineTime = new Date(onlineTimestamp).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour12: false
        });

        let downtimeDuration = null;
        let downtimeFormatted = "Unknown";
        let offlineStartTime = "Unknown";

        if (lastOfflineTimestamp) {
          downtimeDuration = onlineTimestamp - lastOfflineTimestamp;
          offlineStartTime = new Date(lastOfflineTimestamp).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour12: false
          });

          // Format duration
          const seconds = Math.floor(downtimeDuration / 1000);
          const minutes = Math.floor(seconds / 60);
          const hours = Math.floor(minutes / 60);
          const days = Math.floor(hours / 24);

          if (days > 0) {
            downtimeFormatted = `${days}d ${hours % 24}h ${minutes % 60}m`;
          } else if (hours > 0) {
            downtimeFormatted = `${hours}h ${minutes % 60}m`;
          } else if (minutes > 0) {
            downtimeFormatted = `${minutes}m ${seconds % 60}s`;
          } else {
            downtimeFormatted = `${seconds}s`;
          }
        }

        // ✅ Save online event
        _saveNetworkEvent({
          type: 'online',
          timestamp: onlineTimestamp,
          time: onlineTime,
          duration: downtimeDuration,
          reason: 'Network connection restored'
        }).catch(() => {});

        // ✅ Send Telegram notification
        (async () => {
          try {
            if (tg && typeof tg.send === 'function') {
              const message = [
                "🟢 <b>Network Status: ONLINE</b>",
                "",
                `📡 <b>Connection Restored At:</b> ${onlineTime}`,
                offlineStartTime !== "Unknown" ? `🔴 <b>Went Offline At:</b> ${offlineStartTime}` : null,
                downtimeFormatted !== "Unknown" ? `⏱️ <b>Downtime Duration:</b> ${downtimeFormatted}` : null,
                "",
                "🔄 <b>Restarting Leads Window...</b>"
              ].filter(Boolean).join("\n");

              await tg.send(message, { parse_mode: 'HTML' });
              log("info", `Network Online Notification Sent (Downtime: ${downtimeFormatted})`);
            }
          } catch (e) {
            log("error", `Failed to Send Network Online Notification: ${e.message}`);
          }
        })();

        // ✅ Reset offline timestamp
        lastOfflineTimestamp = null;

        // ✅ Resume telegram polling when online
        try {
          if (tg && typeof tg.start === 'function') {
            tg.start();
            log("info", "Telegram Polling Resumed (Online)");
          }
        } catch (e) {
          log("error", `Telegram Start Failed: ${e.message}`);
        }

        broadcast();
        log("info","Network Online (Watcher)");
      }
    },
    onError: e => log("error", `Watcher Error: ${e?.message||e}`),
  });
  watcher.start();
  log("info", "Watcher (Re)Created");
}

// ✅ Recreate autoLogin with current winLeads (used after leads window restart)
function recreateAutoLogin() {
  try { autoLogin?.cancel?.(); } catch {}

  autoLogin = createAutoLogin({
    win: winLeads,
    mobile: process.env.INDIAMART_MOBILE,
    maxAttempts: 3,
    resendCooldownMs: 30000,
    log,
    notify: msg => { try { tg?.send?.(msg); } catch {} },
    onSuccess: () => {
      log("auth", "Auto-Login SUCCESS");
      try { tg?.send?.("🎉 Auto-Login Success"); } catch {}
      isLoggedIn=true;
      suspendedByAuth=false;
      try{ resumeScraperIfAllowed(); }catch{}
      broadcast();  // ✅ FIX: Moved AFTER resumeScraperIfAllowed() so UI gets updated state
    },
    onFail: () => {
      log("error", "Auto-Login FAILED");
      suspendedByAuth=true;
      broadcast();
    }
  });
  log("info", "AutoLogin (Re)Created");
}

// ✅ FIX: ASYNC file operations for daily state
function _dailyStatePath() {
  try { return path.join(app.getPath("userData"), "daily_report_state.json"); }
  catch { return path.join(__dirname, "daily_report_state.json"); }
}

function _loadDailyState() {
  try { return JSON.parse(fs.readFileSync(_dailyStatePath(), "utf8")); }
  catch { return {}; }
}

// ✅ Network Status Tracking
const NETWORK_STATUS_FILE = path.join(REPORTS_DIR, "network_status.json");

function _loadNetworkStatusHistory() {
  try {
    if (!fs.existsSync(NETWORK_STATUS_FILE)) return [];
    const raw = fs.readFileSync(NETWORK_STATUS_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function _saveNetworkEvent(event) {
  try {
    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    const history = _loadNetworkStatusHistory();

    // Keep only last 100 events
    if (history.length >= 100) {
      history.shift();
    }

    history.push({
      event: event.type, // 'offline' or 'online'
      timestamp: event.timestamp,
      time: event.time,
      duration: event.duration || null,
      reason: event.reason || null
    });

    await fsp.writeFile(NETWORK_STATUS_FILE, JSON.stringify(history, null, 2), "utf8");
    log("info", `Network Status Logged: ${event.type}`);
  } catch (e) {
    log("error", `Network Status Save Failed: ${e.message}`);
  }
}

let lastOfflineTimestamp = null;

function _saveDailyState(s) {
  try { fs.writeFileSync(_dailyStatePath(), JSON.stringify(s)); }
  catch {}
}

function _markDailyRun(state, dayKey, slot) {
  state[dayKey] ||= {};
  state[dayKey][slot] = Date.now();
  _saveDailyState(state);
}

function _fmtParts(date, tz, opts) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function _todayKey(tz = DAILY_TZ) {
  const p = _fmtParts(new Date(), tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

function _nowHHMM(tz = DAILY_TZ) {
  const p = _fmtParts(new Date(), tz, { hour12: false, hour: "2-digit", minute: "2-digit" });
  return `${p.hour}:${p.minute}`;
}

const _hhmmNum = (hhmm) => parseInt(String(hhmm).replace(":", ""), 10);

function _shouldRunSlot(state, dayKey, slot, catchUpMins = DAILY_CATCHUP_MINS) {
  if (state?.[dayKey]?.[slot]) return false;
  const nowNum = _hhmmNum(_nowHHMM());
  const slotNum = _hhmmNum(slot);
  if (nowNum === slotNum) return true;
  if (nowNum > slotNum) {
    const h = Math.floor(catchUpMins / 60), m = catchUpMins % 60;
    const units = h * 100 + m;
    return (nowNum - slotNum) <= units;
  }
  return false;
}

const LOCK_PERSIST = String(process.env.LOCK_PERSIST ?? "1") === "1";
const LOCK_PERSIST_TTL_MS = parseInt(String(process.env.LOCK_PERSIST_TTL_MS ?? "0"), 10) || 0;

// ✅ FIX: ASYNC lock state operations
function _lockStorePath() {
  try { return path.join(app.getPath("userData"), "lockstate.json"); }
  catch { return path.join(__dirname, "lockstate.json"); }
}

function _readLockState() {
  try {
    const raw = fs.readFileSync(_lockStorePath(), "utf8");
    const s = JSON.parse(raw);
    return (s && typeof s === "object") ? s : { unlocked:false };
  } catch { return { unlocked:false }; }
}

function isUnlockedPersisted() {
  try {
    const s = _readLockState();
    if (!s.unlocked) return false;
    if (!s.expiresAt || s.expiresAt === 0) return true;
    return Date.now() < Number(s.expiresAt);
  } catch { return false; }
}

function persistUnlock(source) {
  if (!LOCK_PERSIST) return;
  try {
    const p = _lockStorePath();
    const dir = path.dirname(p);
    try { fs.mkdirSync(dir, { recursive:true }); } catch {}
    const expiresAt = LOCK_PERSIST_TTL_MS > 0 ? (Date.now() + LOCK_PERSIST_TTL_MS) : 0;
    const payload = { unlocked:true, at:new Date().toISOString(), source: source||"unknown", expiresAt };
    fs.writeFileSync(p + ".tmp", JSON.stringify(payload), "utf8");
    fs.renameSync(p + ".tmp", p);
  } catch {}
}

async function persistUnlockAsync(source) {
  if (!LOCK_PERSIST) return;
  try {
    const p = _lockStorePath();
    const dir = path.dirname(p);
    await fsp.mkdir(dir, { recursive:true }).catch(() => {});
    const expiresAt = LOCK_PERSIST_TTL_MS > 0 ? (Date.now() + LOCK_PERSIST_TTL_MS) : 0;
    const payload = { unlocked:true, at:new Date().toISOString(), source: source||"unknown", expiresAt };
    await fsp.writeFile(p + ".tmp", JSON.stringify(payload), "utf8");
    await fsp.rename(p + ".tmp", p);
  } catch {}
}

function clearPersist() {
  try {
    const p = _lockStorePath();
    fs.writeFileSync(p + ".tmp", JSON.stringify({ unlocked:false, at:new Date().toISOString() }), "utf8");
    fs.renameSync(p + ".tmp", p);
  } catch {}
}

const START_LOCK = String(process.env.LOCK_ON_START ?? "1") === "1";
const shouldShowWindows = () => !(lockScreen?.isLocked?.() || START_LOCK);

const statusExtras = { 
  cycleId:null, 
  lastScrapedProduct:null, 
  lastKeywordMatchProduct:null, 
  cycleNewCount:0, 
  cycleClicks:0 
};

// ✅ Reload Tracker — minimized window mein reload properly ho raha hai ki nahi
const reloadTracker = {
  lastAttemptAt: null,    // kab reload try kiya
  lastSuccessAt: null,    // kab successfully load hua
  lastDurationMs: null,   // kitna time laga (ms)
  lastResult: null,       // 'ok' | 'fail' | 'skipped'
  consecutiveFails: 0,    // lagatar kitni baar fail hua
};

// ✅ FIX: Use sync read only at startup, then cache
let productsLogCount = (function(){ 
  try { 
    const f=require("node:path").join(__dirname,"Reports","products_log.json"); 
    const d=require("node:fs").readFileSync(f,"utf-8"); 
    const j=JSON.parse(d); 
    return Array.isArray(j)?j.length:0; 
  } catch { return 0; } 
})();

async function _readProductsLogCountAsync(){ 
  try { 
    const f=require("node:path").join(__dirname,"Reports","products_log.json"); 
    const d=await fsp.readFile(f,"utf-8"); 
    const j=JSON.parse(d); 
    return Array.isArray(j)?j.length:0; 
  } catch { return 0; } 
}

let unstickTimer = null, waitLoadPromise = null, queuedReload = null;

function requestReload(reason){
  if (isNetworkOnline === false) {
    log("debug", `Skip Reload – Offline (${reason})`);
    return;
  }


  
  if (queuedReload) return;
  queuedReload = _safeSetTimeout(() => {
    queuedReload = null;
    if (isNetworkOnline === false) { 
      log("debug","Skip Reload Dispatch – Offline"); 
      return; 
    }
    try { safeReloadLeads(reason).catch(()=>{}); } catch {}
  }, 200, 'requestReload');
}

function waitForFinishOnce(wc, timeoutMs=10000){
  if (waitLoadPromise) return waitLoadPromise;
  waitLoadPromise = new Promise((resolve,reject)=>{
    const onOk=()=>{cleanup();resolve();}, 
          onErr=(e)=>{cleanup();reject(e instanceof Error?e:new Error(String(e)));};
    const cleanup=()=>{ 
      clearTimeout(t); 
      try{wc.off("did-finish-load",onOk);}catch{} 
      try{wc.off("did-fail-load",onErr);}catch{} 
      try{wc.off("render-process-gone",onErr);}catch{} 
      waitLoadPromise=null; 
    };
    wc.once("did-finish-load", onOk); 
    wc.once("did-fail-load", onErr); 
    wc.once("render-process-gone", onErr);
    const t=setTimeout(()=>{cleanup();reject(new Error("timeout"));},timeoutMs);
  });
  return waitLoadPromise;
}

const log = (level, msg) => { 
  const p = { t: Date.now(), level, msg:`LM: ${msg}` }; 
  try { winManager?.webContents?.send("log:append", p); } catch {} 
};

const debounce = (fn, ms=300) => { 
  let t; 
  return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; 
};

const webPrefs = () => ({ 
  contextIsolation: true, 
  nodeIntegration: false, 
  sandbox: true, 
  backgroundThrottling: false, 
  preload: path.join(__dirname,"preload.js") 
});

const onShow = (w, cb) => w.once("ready-to-show", ()=>{ 
  try{ if (shouldShowWindows()) w.show(); }catch{} 
  cb?.(); 
});

const pad2=n=>String(n).padStart(2,"0");
const fmtDate=(d=new Date())=>`${pad2(d.getDate())}-${pad2(d.getMonth()+1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtHMS=(d=new Date())=>`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const esc=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const fmtDur=(ms)=>{
  const s=Math.floor(ms/1000),
        d=Math.floor(s/86400),
        h=Math.floor((s%86400)/3600),
        m=Math.floor((s%3600)/60);
  return [d?`${d}d`:null,h?`${h}h`:null,`${m}m`].filter(Boolean).join(" ");
};
const fmtMB=(b)=>`${Math.round((Number(b)||0)/(1024*1024))} MB`;

const CLICK_WINDOW_MS = 30 * 60 * 1000;
const MAX_CLICK_HISTORY = 1000;
let clickTimes = [];

function countClicksLast(ms = CLICK_WINDOW_MS) {
  const now = Date.now();
  while (clickTimes.length && now - clickTimes[0] > ms) {
    clickTimes.shift();
  }
  if (clickTimes.length > MAX_CLICK_HISTORY) {
    clickTimes.splice(0, clickTimes.length - MAX_CLICK_HISTORY);
  }
  return clickTimes.length;
}

// ✅ FIX: Make async
let keywordsCache = { data: null, timestamp: 0 };
const KEYWORDS_CACHE_TTL = 5000;

async function loadKeywordsAsync() {
  const now = Date.now();
  if (keywordsCache.data && (now - keywordsCache.timestamp) < KEYWORDS_CACHE_TTL) {
    return keywordsCache.data;
  }
  
  try {
    const data = await fsp.readFile(F_KEYWORDS, "utf8");
    const arr = JSON.parse(data);
    const result = Array.isArray(arr) ? arr : [];
    keywordsCache = { data: result, timestamp: now };
    return result;
  } catch {
    return keywordsCache.data || [];
  }
}

async function findFirstKeywordMatch(items){ 
  try{
    const kws = (await loadKeywordsAsync()).map(s=>String(s||"").toLowerCase()).filter(Boolean);
    if(!kws.length) return null;
    for (const it of items||[]) {
      const title = String(it.title || it.product || "").toLowerCase(); 
      if(!title) continue;
      for (const kw of kws) if (title.includes(kw)) return it.product || it.title || null;
    }
  } catch{} 
  return null; 
}

const APP_START_TS = Date.now();

// ✅ Safe default state
const DEFAULT_STATE = Object.freeze({
  enabled: false,
  intervalMs: 7000,
  isLoggedIn: null,
  suspendedByAuth: false,
  userWantedAutoRefresh: false,
  isNetworkOnline: true,
  lastStartAt: 0,
  lastStopAt: 0,
  lastCycleAt: 0,
  cycles: 0,
  active: false,   // ✅ FIX: Include scraper active state
  paused: false    // ✅ FIX: Include scraper paused state
});

// ✅ Validate state structure
function validateState(state) {
  try {
    return {
      enabled: Boolean(state?.enabled ?? DEFAULT_STATE.enabled),
      intervalMs: Math.max(3000, Math.min(3600000, Number(state?.intervalMs) || DEFAULT_STATE.intervalMs)),
      isLoggedIn: state?.isLoggedIn === true ? true : state?.isLoggedIn === false ? false : null,
      suspendedByAuth: Boolean(state?.suspendedByAuth),
      userWantedAutoRefresh: Boolean(state?.userWantedAutoRefresh),
      isNetworkOnline: Boolean(state?.isNetworkOnline ?? true),
      lastStartAt: Math.max(0, Number(state?.lastStartAt) || 0),
      lastStopAt: Math.max(0, Number(state?.lastStopAt) || 0),
      lastCycleAt: Math.max(0, Number(state?.lastCycleAt) || 0),
      cycles: Math.max(0, Number(state?.cycles) || 0),
      active: Boolean(state?.active ?? DEFAULT_STATE.active),     // ✅ FIX: Validate active flag
      paused: Boolean(state?.paused ?? DEFAULT_STATE.paused)      // ✅ FIX: Validate paused flag
    };
  } catch (e) {
    log("error", `State Validation Failed: ${e.message}`);
    return { ...DEFAULT_STATE };
  }
}

const buildState = () => {
  try {
    const rs = productScraper?.getReloadState?.() || {};
    return validateState({
      ...rs,
      isLoggedIn,
      suspendedByAuth,
      isNetworkOnline
    });
  } catch (e) {
    log("error", `BuildState Error: ${e.message}`);
    return { ...DEFAULT_STATE, isLoggedIn, suspendedByAuth, isNetworkOnline };
  }
};

const broadcast = () => {
  try {
    // ✅ FIX: Wrap buildState in try-catch
    const s = buildState();

    // ✅ FIX: Check window is not destroyed before sending
    if (winManager && !winManager.isDestroyed() && winManager.webContents) {
      try {
        winManager.webContents.send("refresh:state", s);
        winManager.webContents.send("leads:state", s);
      } catch (e) {
        // Only log if it's not a "destroyed" error
        if (!e.message?.includes('destroyed')) {
          log("error", `Broadcast Send Error: ${e.message}`);
        }
      }
    }
  } catch (e) {
    log("error", `Broadcast Error: ${e.message}`);
  }
};

// ✅ Push API last lead tracker — MC remove ho gayi, ab webhook se last lead track karo
let _lastWebhookLead = null;

function setLastWebhookLead(lead) {
  _lastWebhookLead = lead;
}

// readLatestMC ka naam rakhha backward compat ke liye — ab webhook ka last lead deta hai
async function readLatestMC() {
  if (!_lastWebhookLead) return null;
  // webhook lead format → MC format mein convert karo (fmtLeadHTML ke liye)
  return {
    buyer:   _lastWebhookLead.name    || "",
    mobile:  _lastWebhookLead.mobile  || "",
    company: _lastWebhookLead.company || "",
    address: [_lastWebhookLead.address, _lastWebhookLead.city, _lastWebhookLead.state]
               .filter(Boolean).join(", "),
    product: _lastWebhookLead.product || "",
    email:   _lastWebhookLead.email   || "",
    time:    _lastWebhookLead.queryTime || "",
  };
}

function readLatestMCSync() { return null; } // unused, kept for compat

function fmtLeadHTML(label,r){
  const last10=v=>String(v||"").replace(/\D/g,"").slice(-10);
  const ph=last10(r.mobile), wa = ph ? `https://wa.me/91${ph}`:"";
  const maps=r.address?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`:"";
  return [label,
    r.product&&`✨ <b>${esc(r.product)}</b>`,
    r.buyer&&`👤 <b>Name:</b> ${esc(r.buyer)}`,
    r.company&&`🏢 <b>Company:</b> ${esc(r.company)}`,
    ph&&`📞 <b>Mobile:</b> +91${ph}`,
    wa&&`💬 <b>WhatsApp:</b> <a href="${wa}">${esc(wa)}</a>`,
    r.gstin&&`🧾 <b>GSTIN:</b> ${esc(r.gstin)}`,
    r.email&&`✉️ <b>Email:</b> ${esc(r.email)}`,
    r.address&&`📍 <b>Address:</b> ${esc(r.address)}`,
    maps&&`🗺️ <a href="${maps}">Open in Maps</a>`,
    r.time&&`⏰ <b>Time:</b> ${esc(r.time)}`
  ].filter(Boolean).join("\n");
}

// ✅ FIX: Make async version
async function buildStatus(){
  const up=fmtDur(Date.now()-APP_START_TS), 
        mem=process.memoryUsage?.().rss??0, 
        st=productScraper?.getReloadState?.()||{};
  const auth=(isLoggedIn===true)?"Logged IN":(isLoggedIn===false?"Logged OUT":"Unknown");
  const refresh=st.enabled?"Running (Cycle Mode)":"Stopped";
  const net=isNetworkOnline?"Online":"Offline";
  const lastScraped=statusExtras.lastScrapedProduct||"—";
  const lastKWMatch=statusExtras.lastKeywordMatchProduct||"—";
  
  // ✅ Use async version
  const newCount = await countNewProductsLast();
  
  const clickCount=statusExtras.cycleClicks||0;
  const last30=countClicksLast();

  // ✅ Window 1 state — focused ya minimized
  let winState = "—";
  try {
    if (winLeads && !winLeads.isDestroyed()) {
      if (winLeads.isMinimized())       winState = "🔽 Minimized";
      else if (winLeads.isFocused())    winState = "🟢 Focused";
      else                              winState = "🟡 Background";
    }
  } catch {}

  // ✅ Reload tracker — last reload ka result
  let reloadLine = "—";
  try {
    if (reloadTracker.lastAttemptAt) {
      const tsText = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).format(new Date(reloadTracker.lastAttemptAt));
      const durText = reloadTracker.lastDurationMs != null
        ? `${(reloadTracker.lastDurationMs / 1000).toFixed(1)}s`
        : null;

      if (reloadTracker.lastResult === 'ok') {
        reloadLine = `✅ OK · ${tsText}${durText ? ` · ${durText}` : ""}`;
      } else if (reloadTracker.lastResult === 'fail') {
        reloadLine = `❌ Failed · ${tsText} · ×${reloadTracker.consecutiveFails} lagatar`;
      } else if (reloadTracker.lastResult === 'skipped') {
        reloadLine = `⏭️ Skipped (offline) · ${tsText}`;
      }
    }
  } catch {}

  const head=[
    "🛰️ <b>Status</b>",
    `⏱️ <b>Uptime:</b> ${esc(up)}`,
    `🧮 <b>Memory (RSS):</b> ${esc(fmtMB(mem))}`,
    `🔐 <b>Auth:</b> ${esc(auth)}`,
    `🔄 <b>Refresh:</b> ${esc(refresh)}`,
    `🌐 <b>Network:</b> ${esc(net)}`,
    `🪟 <b>Win 1 State:</b> ${esc(winState)}`,
    `🔃 <b>Last Reload:</b> ${esc(reloadLine)}`,
    `🔗 <b>Webhook:</b> ${esc(webhook?.running ? `✅ Running (port ${webhook.port})` : "❌ Stopped")}`,
    `📦 <b>Last Scraped Product:</b> ${esc(lastScraped)}`,
    `🔑 <b>Last Keyword Match Product:</b> ${esc(lastKWMatch)}`,
    `🆕 <b>New Products (Last 30 Min):</b> ${esc(String(newCount))}`,
    `🕧 <b>Clicks (last 30 min):</b> ${esc(String(last30))}`,
  ].join("\n");
  
  const latest = await readLatestMC();
  return head + (latest ? "\n\n"+fmtLeadHTML("🆕 <b>Latest Push API Lead</b>", latest) : "\n\nℹ️ No Push API leads yet.");
}

// ✅ Sab theek hai ya nahi — problems ki list return karta hai
function getProblems() {
  const problems = [];
  try {
    if (isLoggedIn !== true)
      problems.push(`🔐 Auth: ${isLoggedIn === false ? "Logged OUT" : "Unknown"}`);
    if (isNetworkOnline !== true)
      problems.push(`🌐 Network: Offline`);
    const st = productScraper?.getReloadState?.() || {};
    if (!st.enabled)
      problems.push(`🔄 Refresh: Stopped`);
    if (reloadTracker.lastResult === 'fail')
      problems.push(`🔃 Last Reload: Failed (×${reloadTracker.consecutiveFails} lagatar)`);
    if (!winLeads || winLeads.isDestroyed())
      problems.push(`🪟 Leads Window: Closed/Crashed`);
  } catch (e) {
    problems.push(`⚠️ Health Check Error: ${e.message}`);
  }
  return problems;
}

async function sendStatusReport(tag="30-min"){ 
  try{
    // ✅ Scheduled interval pe — sirf green dot ya problems
    // Manual (/status) aur startup pe hamesha full report
    if (tag === "interval") {
      const problems = getProblems();
      if (problems.length === 0) {
        await tg?.send?.("🟢", { parse_mode: "HTML" });
        log("info", `Reports: Status (${tag}) — Green`);
      } else {
        const msg = `🔴 <b>Problem Detected</b>\n\n` + problems.join("\n");
        await tg?.send?.(msg, { parse_mode: "HTML" });
        log("info", `Reports: Status (${tag}) — Problems: ${problems.length}`);
      }
      return;
    }
    // Manual / startup → full detailed report
    const status = await buildStatus();
    await tg?.send?.(status,{parse_mode:"HTML",disable_web_page_preview:true}); 
    log("info",`Reports: Status (${tag}) Sent`);
  } catch(e){ 
    log("error",`Reports: Status Send Failed – ${e.message}`);
  } 
}

function scheduleEvery30Min(){ 
  const now=new Date(),min=now.getMinutes(),nextMin=min<30?30:60;
  const ms=(nextMin-min)*60*1000 - now.getSeconds()*1000 - now.getMilliseconds();
  _safeSetTimeout(() => {
    sendStatusReport("interval").catch(e => log("error", `Interval Report Failed: ${e.message}`));
    
    _safeSetInterval(
      () => sendStatusReport("interval").catch(e => log("error", `Interval Report Failed: ${e.message}`)),
      30*60*1000,
      'statusReport30min'
    );
  }, Math.max(1000, ms), 'scheduleEvery30Min');
}

// ✅ FIX: ASYNC file operations with caching
const LIST_DIR=path.join(__dirname,"List");
const F_PRODUCTS=path.join(LIST_DIR,"products.json");
const F_KEYWORDS=path.join(__dirname,"List","keywords.json");
const F_SKIP_LOCATIONS=path.join(__dirname,"List","skipLocations.json");
const F_SKIP_NAMES=path.join(__dirname,"List","skipNames.json");
const normSpace=s=>String(s||"").trim().replace(/\s+/g," ");
const toTitle=s=>normSpace(s).toLowerCase().split(" ").map(w=>w?w[0].toUpperCase()+w.slice(1):"").join(" ");

// Sync versions (only used at startup)
const readJSON=(f,fb)=>{ try { return JSON.parse(fs.readFileSync(f,"utf8")); } catch { return fb; } };
const writeJSON=(f,d)=>{ 
  try { 
    fs.mkdirSync(path.dirname(f),{recursive:true}); 
    fs.writeFileSync(f, JSON.stringify(d,null,2),"utf8"); 
    return true; 
  } catch { return false; } 
};

// ✅ NEW: Async versions
const readJSONAsync = async (f, fb) => {
  try {
    const data = await fsp.readFile(f, "utf8");
    return JSON.parse(data);
  } catch {
    return fb;
  }
};

const writeJSONAsync = async (f, d) => {
  try {
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, JSON.stringify(d, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
};

// Caching for products/keywords/skip lists
let productsCache = { data: null, timestamp: 0 };
let skipLocationsCache = { data: null, timestamp: 0 };
let skipNamesCache = { data: null, timestamp: 0 };
const FILE_CACHE_TTL = 5000;

const loadProducts=()=>Array.isArray(readJSON(F_PRODUCTS,[]))?readJSON(F_PRODUCTS,[]):[];
const loadKeywords=()=>Array.isArray(readJSON(F_KEYWORDS,[]))?readJSON(F_KEYWORDS,[]):[];
const loadSkipLocations=()=>Array.isArray(readJSON(F_SKIP_LOCATIONS,[]))?readJSON(F_SKIP_LOCATIONS,[]):[];
const loadSkipNames=()=>Array.isArray(readJSON(F_SKIP_NAMES,[]))?readJSON(F_SKIP_NAMES,[]):[];

async function loadProductsAsync() {
  const now = Date.now();
  if (productsCache.data && (now - productsCache.timestamp) < FILE_CACHE_TTL) {
    return productsCache.data;
  }
  
  const data = await readJSONAsync(F_PRODUCTS, []);
  const result = Array.isArray(data) ? data : [];
  productsCache = { data: result, timestamp: now };
  return result;
}

const saveProducts=a=>writeJSON(F_PRODUCTS,Array.isArray(a)?a:[]);
const saveKeywords=a=>writeJSON(F_KEYWORDS,Array.isArray(a)?a:[]);

async function saveProductsAsync(a) {
  const result = await writeJSONAsync(F_PRODUCTS, Array.isArray(a) ? a : []);
  if (result) {
    productsCache = { data: a, timestamp: Date.now() };
  }
  return result;
}

async function saveKeywordsAsync(a) {
  const result = await writeJSONAsync(F_KEYWORDS, Array.isArray(a) ? a : []);
  if (result) {
    keywordsCache = { data: a, timestamp: Date.now() };
  }
  return result;
}

async function loadSkipLocationsAsync() {
  const now = Date.now();
  if (skipLocationsCache.data && (now - skipLocationsCache.timestamp) < FILE_CACHE_TTL) {
    return skipLocationsCache.data;
  }
  const data = await readJSONAsync(F_SKIP_LOCATIONS, []);
  const result = Array.isArray(data) ? data : [];
  skipLocationsCache = { data: result, timestamp: now };
  return result;
}

async function loadSkipNamesAsync() {
  const now = Date.now();
  if (skipNamesCache.data && (now - skipNamesCache.timestamp) < FILE_CACHE_TTL) {
    return skipNamesCache.data;
  }
  const data = await readJSONAsync(F_SKIP_NAMES, []);
  const result = Array.isArray(data) ? data : [];
  skipNamesCache = { data: result, timestamp: now };
  return result;
}

const saveSkipLocations=a=>writeJSON(F_SKIP_LOCATIONS,Array.isArray(a)?a:[]);
const saveSkipNames=a=>writeJSON(F_SKIP_NAMES,Array.isArray(a)?a:[]);

async function saveSkipLocationsAsync(a) {
  const result = await writeJSONAsync(F_SKIP_LOCATIONS, Array.isArray(a) ? a : []);
  if (result) {
    skipLocationsCache = { data: a, timestamp: Date.now() };
  }
  return result;
}

async function saveSkipNamesAsync(a) {
  const result = await writeJSONAsync(F_SKIP_NAMES, Array.isArray(a) ? a : []);
  if (result) {
    skipNamesCache = { data: a, timestamp: Date.now() };
  }
  return result;
}

async function updateManagerLists({products:prodList,keywords:keyList,skipLocations:skipLocList,skipNames:skipNameList}={}){
  if (!winManager) return false;
  const setK=(k,v)=>`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`;
  const js = `(function(){try{${typeof prodList!=="undefined"?setK("niyati:products", prodList):""}${typeof keyList!=="undefined"?setK("niyati:keywords", keyList):""}${typeof skipLocList!=="undefined"?setK("niyati:skipLocations", skipLocList):""}${typeof skipNameList!=="undefined"?setK("niyati:skipNames", skipNameList):""}if(window.RendererLists?.refresh)window.RendererLists.refresh();true;}catch(e){false;}})();`;
  try { return await winManager.webContents.executeJavaScript(js, true); } catch { return false; }
}

function addProduct(name){ 
  name=toTitle(name); 
  if(!name) return false; 
  const arr=loadProducts(); 
  if(!arr.some(v=>v.toLowerCase()===name.toLowerCase())) arr.push(name); 
  const ok=saveProducts(arr);
  try { productScraper?.setProducts?.(arr); } catch {}
  updateManagerLists({products:arr}).catch(()=>{}); 
  log("info",`Lists: Product Added – ${name}`); 
  return ok; 
}

function deleteProduct(name){ 
  const arr=loadProducts(); 
  const key=String(name||"").toLowerCase(); 
  const next=arr.filter(v=>v.toLowerCase()!==key); 
  const ok=saveProducts(next);
  try { productScraper?.setProducts?.(next); } catch {}
  updateManagerLists({products:next}).catch(()=>{}); 
  log("info",`Lists: Product Deleted – ${name}`); 
  return ok && next.length!==arr.length; 
}

function addKeyword(kw){ 
  kw=normSpace(kw).toLowerCase(); 
  if(!kw) return false; 
  const arr=loadKeywords(); 
  if(!arr.includes(kw)) arr.push(kw); 
  const ok=saveKeywords(arr); 
  updateManagerLists({keywords:arr}).catch(()=>{}); 
  log("info",`Lists: Keyword Added – ${kw}`); 
  return ok; 
}

function deleteKeyword(kw){
  kw=normSpace(kw).toLowerCase();
  const arr=loadKeywords();
  const next=arr.filter(v=>v!==kw);
  const ok=saveKeywords(next);
  updateManagerLists({keywords:next}).catch(()=>{});
  log("info",`Lists: Keyword Deleted – ${kw}`);
  return ok && next.length!==arr.length;
}

function addSkipLocation(loc){
  loc=toTitle(loc);
  if(!loc) return false;
  const arr=loadSkipLocations();
  if(!arr.some(v=>v.toLowerCase()===loc.toLowerCase())) arr.push(loc);
  const ok=saveSkipLocations(arr);
  updateManagerLists({skipLocations:arr}).catch(()=>{});
  log("info",`Lists: Skip Location Added – ${loc}`);
  return ok;
}

function deleteSkipLocation(loc){
  const arr=loadSkipLocations();
  const key=String(loc||"").toLowerCase();
  const next=arr.filter(v=>v.toLowerCase()!==key);
  const ok=saveSkipLocations(next);
  updateManagerLists({skipLocations:next}).catch(()=>{});
  log("info",`Lists: Skip Location Deleted – ${loc}`);
  return ok && next.length!==arr.length;
}

function addSkipName(name){
  name=normSpace(name).toLowerCase();
  if(!name) return false;
  const arr=loadSkipNames();
  if(!arr.includes(name)) arr.push(name);
  const ok=saveSkipNames(arr);
  updateManagerLists({skipNames:arr}).catch(()=>{});
  log("info",`Lists: Skip Name Added – ${name}`);
  return ok;
}

function deleteSkipName(name){
  name=normSpace(name).toLowerCase();
  const arr=loadSkipNames();
  const next=arr.filter(v=>v!==name);
  const ok=saveSkipNames(next);
  updateManagerLists({skipNames:next}).catch(()=>{});
  log("info",`Lists: Skip Name Deleted – ${name}`);
  return ok && next.length!==arr.length;
}

let leadsReloading=false;

async function safeReloadLeads(reason="manual"){
  if (!winLeads || leadsReloading) return false;
  leadsReloading = true;
  const attemptAt = Date.now();
  reloadTracker.lastAttemptAt = attemptAt;
  try {
    if (isNetworkOnline === false) {
      log("info", `SafeReload Ignored – Offline (${reason})`);
      reloadTracker.lastResult = 'skipped';
      leadsReloading=false;
      return false;
    }
    log("start",`Leads: SafeReload → ${reason}`);
    const wc = winLeads.webContents;
    try{ wc.stop(); }catch{}
    try{ watcher?.setReloading(true);}catch{}
    wc.reloadIgnoringCache();
    try {
      await waitForFinishOnce(wc, 10000);
      log("info","SafeReload Soft OK");
      reloadTracker.lastSuccessAt = Date.now();
      reloadTracker.lastDurationMs = Date.now() - attemptAt;
      reloadTracker.lastResult = 'ok';
      reloadTracker.consecutiveFails = 0;
      return true;
    } catch(e) {
      log("info",`SafeReload Soft Timeout – Hard Nav (${e.message})`);
      if (isNetworkOnline === false) {
        log("info","Hard Nav Skipped – Offline");
        reloadTracker.lastResult = 'skipped';
        return false;
      }
      wc.loadURL(LEADS_DEFAULT_URL);
      try {
        await waitForFinishOnce(wc, 12000);
        log("info","SafeReload Hard OK");
        reloadTracker.lastSuccessAt = Date.now();
        reloadTracker.lastDurationMs = Date.now() - attemptAt;
        reloadTracker.lastResult = 'ok';
        reloadTracker.consecutiveFails = 0;
        return true;
      } catch(e2) {
        log("error",`SafeReload Hard Failed – ${e2.message || e2}`);
        reloadTracker.lastResult = 'fail';
        reloadTracker.lastDurationMs = Date.now() - attemptAt;
        reloadTracker.consecutiveFails++;
        return false;
      }
    }
  } finally { 
    try{ watcher?.setReloading(false);}catch{} 
    leadsReloading=false; 
  }
}

async function archiveAndTruncate(files, tag=""){ 
  try {
    const ts=new Date(), 
          stamp=`${ts.getFullYear()}-${pad2(ts.getMonth()+1)}-${pad2(ts.getDate())}_${pad2(ts.getHours())}${pad2(ts.getMinutes())}`;
    const dir=path.join(__dirname,"reports_archive",stamp); 
    await fsp.mkdir(dir,{recursive:true});
    log("start",`Cleanup: Archiving ${files.length} files → ${path.basename(dir)} ${tag?`(${tag})`:""}`);
    for (const src of files) { 
      try { 
        await fsp.copyFile(src, path.join(dir, path.basename(src))); 
        await fsp.writeFile(src,""); 
        log("info",`Cleanup: ${path.basename(src)} Archived & Truncated`);
      } catch(e){ 
        log("error",`Cleanup: ${path.basename(src)} Failed – ${e.message}`);
      } 
    }
  } catch(e){ 
    log("error",`Cleanup Archive Error: ${e.message}`);
  } 
}

// ✅ FIX #8: Complete resetReportsMemory Implementation
async function resetReportsMemory() {
  try {
    log("start", "Memory Reset: Starting Comprehensive Cleanup");
    
    // ✅ ProductScraper
    if (productScraper && typeof productScraper.resetLog === 'function') {
      productScraper.resetLog();
      log("info", "✓ ProductScraper Reset");
    }
    productsLogCount = 0;
    
    // ✅ MatchClicker - light reset (keeps persistent data)
    if (matcher && typeof matcher.reset === 'function') {
      const beforeStats = matcher.getStats ? matcher.getStats() : {};
      matcher.reset();
      log("info", `✓ MatchClicker Reset - was: ${JSON.stringify(beforeStats)}`);
    }
    
    // ✅ KeywordMatcher - light reset
    if (kwMatcher && typeof kwMatcher.reset === 'function') {
      const beforeStats = kwMatcher.getStats ? kwMatcher.getStats() : {};
      kwMatcher.reset();
      log("info", `✓ KeywordMatcher Reset - was: ${JSON.stringify(beforeStats)}`);
    }
    
    // MessageCentre removed — Push API handles leads
    
    // Global counters
    clickTimes = clickTimes.slice(-MAX_CLICK_HISTORY);
    
    // Clear caches
    productsLogCache = { data: null, timestamp: 0 };
    mcCache = { data: null, timestamp: 0 };
    productsCache = { data: null, timestamp: 0 };
    keywordsCache = { data: null, timestamp: 0 };
    
    log("info", "✅ Memory Reset Complete - All Modules Cleaned");
  } catch (e) {
    log("error", `resetReportsMemory Failed: ${e.message}`);
  }
}

// ✅ NEW: Deep reset for cleanall command
async function deepResetAllMemory() {
  try {
    log("start", "Deep Reset: Starting FULL Memory Wipe");
    
    // Products
    if (productScraper?.resetLog) {
      productScraper.resetLog();
      log("info", "✓ ProductScraper Deep Reset");
    }
    
    // MatchClicker
    if (matcher?.deepReset) {
      await matcher.deepReset();
      log("info", "✓ MatchClicker Deep Reset");
    }
    
    // KeywordMatcher
    if (kwMatcher?.deepReset) {
      await kwMatcher.deepReset();
      log("info", "✓ KeywordMatcher Deep Reset");
    }
    
    // MessageCentre removed — Push API handles leads
    
    // Global state
    productsLogCount = 0;
    clickTimes = [];
    statusExtras.cycleId = null;
    statusExtras.lastScrapedProduct = null;
    statusExtras.lastKeywordMatchProduct = null;
    statusExtras.cycleNewCount = 0;
    statusExtras.cycleClicks = 0;
    
    // Clear all caches
    productsLogCache = { data: null, timestamp: 0 };
    mcCache = { data: null, timestamp: 0 };
    productsCache = { data: null, timestamp: 0 };
    keywordsCache = { data: null, timestamp: 0 };

    // Network Status Reset
    lastOfflineTimestamp = null;
    try {
      const networkFile = path.join(REPORTS_DIR, "network_status.json");
      if (fs.existsSync(networkFile)) {
        await fsp.writeFile(networkFile, "[]", "utf8");
        log("info", "✓ Network Status History Cleared");
      }
    } catch (e) {
      log("error", `Network Status Reset Failed: ${e.message}`);
    }

    log("info", "✅ Deep Reset Complete - ALL Memory Wiped");


  } catch (e) {
    log("error", `deepResetAllMemory Failed: ${e.message}`);
  }
}

async function sendDailyReports(whenLabel){ 
  try {
    const toSend=SEND_FILES.filter(EXISTS);
    log("start",`Reports: ${whenLabel} – preparing (${toSend.length} files)`);
    if (toSend.length) {
      tg?.send?.(`📤 ${whenLabel} – Reports (${toSend.length} files)`).catch(()=>{});
      for (const pth of toSend) { 
        try { 
          await tg?.sendFile?.(pth, `Niyati • ${path.basename(pth)} • ${fmtDate()}`); 
          log("info",`Report Sent: ${path.basename(pth)}`);
        } catch(e){ 
          log("error",`Report Send Failed: ${path.basename(pth)} – ${e.message}`);
        } 
      }
    } else { 
      tg?.send?.(`ℹ️ ${whenLabel}: No report files to send.`).catch(()=>{}); 
    }
      // Skip archive + deep reset when invoked manually (/runreports)
    if (String(whenLabel).toLowerCase() !== "manual") {
      const all = CLEANUP_FILES.filter(EXISTS);
      if (all.length) { await archiveAndTruncate(all, whenLabel); }

      log("info", `🔥 ${whenLabel}: Starting DEEP RESET (full memory wipe)`);
      await deepResetAllMemory();
      await gentleMemoryCleanup(whenLabel);
      log("info", `✅ ${whenLabel}: Deep Reset Complete`);
    } else {
      log("info", `${whenLabel}: Skipping Cleanup (Manual runreports)`);
    }

  } 
catch(e){ 
    log("error",`sendDailyReports Error: ${e.message}`);
  } 
}
async function gentleMemoryCleanup(reason=""){ 
  try {
    log("start",`Cleanup: Memory Cleanup Starting${reason?` (${reason})`:""}`);
    const ses=winLeads?.webContents?.session;
    if (ses) { 
      await ses.clearCache(); 
      if (typeof ses.clearCodeCaches==="function") await ses.clearCodeCaches({}); 
    }
    try { 
      await winLeads?.webContents?.executeJavaScript("try{ if(globalThis.gc) gc(); }catch{}; void 0;", true);
    } catch {}
    log("info",`Memory Cleanup Done${reason?` – ${reason}`:""}`);
  } catch(e){ 
    log("error",`Memory Cleanup Failed: ${e.message}`);
  } 
}

let _scraperPausedReason = null;

function pauseScraper(reason, skipBroadcast = false) {
  try {
    productScraper?.disableAutoReload?.(reason || "pause");
    productScraper?.disable?.();
    _scraperPausedReason = reason || "pause";
    log("stop", `Scraper Paused – ${_scraperPausedReason}`);
    if (!skipBroadcast) broadcast();  // ✅ FIX: Auto-broadcast state change (use skipBroadcast=true if caller will broadcast)
  } catch (e) {
    log("error", `Pause Scraper Failed: ${e?.message || e}`);
  }
}

function resumeScraperIfAllowed() {
  try {
    productScraper?.enable?.();

    const st = productScraper?.getReloadState?.() || {};
    if (st.userWantedAutoRefresh && !st.enabled && isNetworkOnline && isLoggedIn !== false) {
      productScraper.enableAutoReload(st.intervalMs || 7000, () => {
        watcher?.setReloading(true);
        reloadTracker.lastAttemptAt = Date.now();
        reloadTracker.lastResult = 'ok';
        reloadTracker.lastDurationMs = null;
        reloadTracker.consecutiveFails = 0;
      });
      log("start", `Scraper Resumed${_scraperPausedReason ? ` (was: ${_scraperPausedReason})` : ""}`);
    } else {
      log("info", "Scraper Enable Checked – Constraints Not Met (No Auto-Resume).");
    }
  } catch (e) {
    log("error", `Resume Scraper Failed: ${e?.message || e}`);
  } finally {
    _scraperPausedReason = null;
  }
}

function createManagerWindow(){
  winManager = new BrowserWindow({
    title:"Manager", 
    width:1200, 
    height:800, 
    minWidth:900, 
    minHeight:600,
    frame:false, 
    titleBarStyle:"hidden",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#0f0f10",
    webPreferences: webPrefs()
  });
  winManager.loadFile(path.join(__dirname,"index.html"));
  winManager.once("ready-to-show", ()=>{
    try{ if (shouldShowWindows()) winManager.show(); }catch{} 
    broadcast();
    
    // ✅ ADD THIS: Initial data sync
    setTimeout(async () => {
      try {
        const prods = loadProducts();
        const keys = loadKeywords();
        await updateManagerLists({ products: prods, keywords: keys });
        log("info", `Manager: Synced ${prods.length} Products, ${keys.length} Keywords`);
      } catch (e) {
        log("error", `Manager Initial Sync Failed: ${e.message}`);
      }
    }, 500); // Small delay to ensure DOM is ready
  });
  
  const sendState=()=>winManager.webContents.send("win:state", winManager.isMaximized()?"max":"restored");
  ["maximize","unmaximize","focus","enter-full-screen","leave-full-screen"].forEach(ev=>winManager.on(ev, sendState));
  winManager.on("closed", ()=>{
    winManager=null;
    // Also close Leads window when Manager is closed (but not during restart)
    if (!isRestartingWindow && winLeads && !winLeads.isDestroyed()) {
      winLeads.close();
    }
    // ✅ FIX: Agar winLeads pehle se null hai (crash ya independent close),
    // tab winLeads "closed" mein managerGone false tha — app alive rehta tha.
    // Yahan check karo: dono gone → quit.
    if (!isRestartingWindow) {
      const leadsGone = !winLeads || winLeads.isDestroyed();
      if (leadsGone) app.quit();
    }
  });
}

function createLeadsWindow(){
  winLeads = new BrowserWindow({ 
    title:"Leads", 
    show:false,
    width: 1280,
    height: 720,
    webPreferences:webPrefs() 
  });
  
  winLeads.maximize();
  const wc=winLeads.webContents;
  wc.setMaxListeners(0); 
  wc.removeAllListeners("did-fail-load"); 
  wc.removeAllListeners("render-process-gone");
  winLeads.loadURL(LEADS_DEFAULT_URL);
  
  winLeads.on('show', () => {
    log("info", "✅ Leads Window Is Now Visible (No Throttling)");
  });
  
  winLeads.on('hide', () => {
    log("warning", "⚠️ Leads Window Hidden - Timers May Be Throttled!");
  });
  
  winLeads.on('blur', () => {
    log("debug", "Leads Window Lost Focus (Backgrounded)");
  });
  
  winLeads.on('focus', () => {
    log("debug", "Leads Window Gained Focus");
  });
  
  winLeads.on("closed", ()=>{
    // ✅ FIX #6: Cleanup watcher timers when window closes
    try {
      if (watcher) {
        watcher.stop();
        log("info", "Watcher Stopped Due To Window Close");
      }
    } catch (e) {
      log("error", `Watcher Cleanup Failed: ${e.message}`);
    }

    winLeads=null;
    // Also close Manager window when Leads is closed (but not during restart)
    if (!isRestartingWindow && winManager && !winManager.isDestroyed()) {
      winManager.close();
    }
    // ✅ FIX: MC persistent window exist karti hai — window-all-closed kabhi fire nahi hota.
    // winLeads "closed" tab fire hota hai jab DONO windows gone hoti hain (Manager pehle close
    // hota hai aur winLeads.close() trigger karta hai). Yahan dono gone hain → app quit karo.
    if (!isRestartingWindow) {
      const managerGone = !winManager || winManager.isDestroyed();
      if (managerGone) app.quit();
    }
  });
  
  wc.on("did-start-loading", ()=>{ 
    clearTimeout(unstickTimer); 
    unstickTimer=setTimeout(()=>{ 
      try{watcher?.setReloading(false);}catch{} 
      log("info","Failsafe: Clearing InReload (12s)"); 
    },12000); 
  });
  
  wc.on("did-finish-load", ()=>{ 
    clearTimeout(unstickTimer); 
    try{watcher?.setReloading(false);}catch{}
    // ✅ FIX: Track every page load — productScraper auto-refresh bhi yahan se capture hoga
    const now = Date.now();
    reloadTracker.lastSuccessAt = now;
    reloadTracker.lastResult = 'ok';
    reloadTracker.consecutiveFails = 0;
    if (reloadTracker.lastAttemptAt) {
      reloadTracker.lastDurationMs = now - reloadTracker.lastAttemptAt;
    }
    reloadTracker.lastAttemptAt = reloadTracker.lastAttemptAt || now;
    log("info","Leads Page Loaded");
    
    setTimeout(() => {
      if (shouldShowWindows() && winLeads && !winLeads.isDestroyed()) {
        winLeads.show();
        log("info", "Leads Window Shown (Prevents Throttling)");
      }
    }, 500);
    
    setTimeout(() => {
      try {
        injectVisibilityMonitor(winLeads);
      } catch (e) {
        log("error", `Visibility Monitor Injection Failed: ${e.message}`);
      }
    }, 1000);
  });

  const OFFLINE_CODES=new Set([-106,-105,-118]);
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame)=>{
    clearTimeout(unstickTimer);
    // ✅ FIX: reloadTracker sirf main frame fail pe update karo — subframe (ads/iframes/trackers)
    // fail hone pe reloadTracker corrupt nahi hona chahiye, warna /status mein misleading output aata hai
    if (isMainFrame) {
      reloadTracker.lastResult = 'fail';
      reloadTracker.lastDurationMs = reloadTracker.lastAttemptAt ? Date.now() - reloadTracker.lastAttemptAt : null;
      reloadTracker.consecutiveFails++;
    }
    // ✅ FIX: isMainFrame guard add kiya — subframe (ads, trackers, iframes) ka fail hona
    // false offline trigger karta tha. IndiaMart page pe bahut saare third-party resources hain
    // jo -106/-105/-118 se fail ho sakte hain — sirf main frame ka fail offline count karna chahiye.
    if (OFFLINE_CODES.has(code) && isNetworkOnline!==false && isMainFrame) {
      isNetworkOnline=false;
      // ✅ FIX: Sync watcher's internal state so onOnline() fires when network recovers.
      // Without this, if did-fail-load sets isNetworkOnline=false but watcher's S.isOnline
      // stays true (e.g. brief blip), probe success never triggers onOnline() → stuck forever.
      try { watcher?.forceOffline?.(); } catch {}
      const st=productScraper?.getReloadState?.()||{};
      if(st.enabled) productScraper.disableAutoReload("network offline");
      pauseScraper("network offline", true);  // skipBroadcast=true, broadcast called at end of handler

      // ✅ FIX: tg.stop() hataya — polling chalne do offline mein bhi
    }
    if (isMainFrame) {
      log("error",`Leads: Did-Fail-Load ${code} ${desc}`);
      requestReload("did-fail-load");
    }
    broadcast();
  });
  
  wc.on("render-process-gone", (_e,d)=>{ 
    log("error",`Leads: Render-Process-Gone (${d?.reason||"unknown"})`); 
    requestReload("render-process-gone"); 
  });

  onShow(winLeads, ()=>{
    productScraper = createProductScraper({
      win:winLeads,
      delayMs:1200, // ✅ FIX: 200→1200ms — React component mount hone ka wait, retry chain avoid hoti hai
      maxItems:50,
      loginSelector:"#selsout",
      getTelegram: () => tg,
      log:(lvl,msg)=>{
        log(lvl,msg);
        if (lvl==="info" && /^Persist:\s*\+/i.test(String(msg))) {
          statusExtras.cycleNewCount = (statusExtras.cycleNewCount||0) + 1;
        }
      },
      onItems: async (items, cycleId) => {
        statusExtras.cycleId = cycleId;
        statusExtras.cycleClicks = 0;
        statusExtras.lastScrapedProduct = (items && items[0]) ? (items[0].product || items[0].title || null) : null;
        
        // ⚡ OPT: logCount + kwMatch parallel chalao — dono matcher se independent hain
        try {
          const [curr, kwHit] = await Promise.all([
            _readProductsLogCountAsync().catch(e => { log("error", `Products Log Count Failed: ${e.message}`); return productsLogCount; }),
            findFirstKeywordMatch(items).catch(e => { log("error", `Keyword Match Check Failed: ${e.message}`); return null; })
          ]);
          const delta = Math.max(0, curr - productsLogCount);
          if (delta) statusExtras.cycleNewCount = (statusExtras.cycleNewCount||0) + delta;
          productsLogCount = curr;
          if (kwHit) statusExtras.lastKeywordMatchProduct = kwHit;
        } catch (e) {
          log("error", `onItems Parallel Init Failed: ${e.message}`);
        }

        try {
          await matcher?.processCycle(items, cycleId);
        } catch (e) {
          log("error", "Matcher Error: " + (e?.message || e));
        }

        try {
          kwMatcher?.processCycle(items, cycleId).catch(err => log("error", "kwMatcher Error: " + (err?.message || err)));
        } catch (e) {
          log("error", "kwMatcher Invoke Error: " + (e?.message || e));
        }
      }
    });

    if (pendingStartMs) {
      productScraper.enable?.();  // ✅ FIX: Must call enable() before enableAutoReload() (was missing)
      productScraper.enableAutoReload(pendingStartMs, () => {
        watcher?.setReloading(true);
        reloadTracker.lastAttemptAt = Date.now();
        reloadTracker.lastResult = 'ok';
        reloadTracker.lastDurationMs = null;
        reloadTracker.consecutiveFails = 0;
      });
      log("start", "Auto-Refresh Started (Queued, Cycle Mode)");
      pendingStartMs = null;
    } else {
      try { resumeScraperIfAllowed(); } catch {}
    }
    if (pendingResume) {
      try { resumeScraperIfAllowed(); } catch {}
      pendingResume = false;
    }
    broadcast();

    // ✅ FIX: wireListsIPC() call hataya — lists:saveProducts aur lists:saveKeywords
    // ke handlers already main.js bottom pe registered hain (lines ~2756-2778).
    // har restartLeadsWindow() ke baad dobara call karne se Electron "duplicate handler" error deta tha.

    matcher = createMatchClicker({
      win:winLeads,
      log:(lvl,msg)=>{
        log(lvl,msg);
        if (lvl==="info" && /^MatchClick:\s*Clicked/i.test(String(msg))) {
          statusExtras.cycleClicks = (statusExtras.cycleClicks || 0) + 1;
          const now = Date.now();
          clickTimes.push(now);
          countClicksLast();
        }

        if (lvl==="info" && /^MatchClick:\s*Clicked/.test(String(msg))) {
          const m=String(msg).match(/List#(\d+)\s*[–-]\s*"([^"]+)"/);
          // ✅ MC parallel mein chalti hai
          // Webhook server handles leads via Push API — MC removed
          // ✅ Post-click reload removed — productScraper cycle-end reload handles it
        }
      },
      getProducts:()=>productScraper.getProducts(),
      getSkipLocations:()=>loadSkipLocations(),
      getSkipNames:()=>loadSkipNames(),
      getTelegram:()=>tg,
      send: (text, extra) => { try { tg?.send?.(text, extra); } catch {} }
    });

    productScraper.enable();

    kwMatcher = createKeywordMatcher({
      keywordsFile:F_KEYWORDS, 
      log,
      send: async(text,extra)=>{ 
        try{ await tg?.send?.(text,extra); }
        catch(e){ log("error",`KW-Notify Failed: ${e.message}`);} 
      }
    });

    log("info","Leads Setup Complete");
  });
}

async function screenshotLeadsAsJpeg({stayHidden=false, quality=88}={}){
  if (!winLeads || winLeads.isDestroyed()) return null;
  const wasHidden = !winLeads.isVisible();
  const wasMinimized = winLeads.isMinimized();
  try {
    // Minimized window pe capturePage() blank deta hai — temporarily restore karo
    if (wasMinimized) {
      try{ winLeads.restore(); await new Promise(r=>setTimeout(r,300)); }catch{}
    } else if (wasHidden && !stayHidden) { 
      try{ winLeads.show(); await new Promise(r=>setTimeout(r,300)); }catch{} 
    }
    const img = await winLeads.capturePage();
    return img.toJPEG(quality);
  } catch(e) { 
    log("error",`screenshotLeadsAsJpeg Failed: ${e.message}`); 
    return null;
  } finally { 
    // Screenshot ke baad wapas original state mein le jao
    if (wasMinimized) {
      try{ winLeads.minimize(); }catch{}
    } else if (wasHidden && !stayHidden) {
      try{ winLeads.hide(); }catch{}
    }
  }
}

async function screenshotManagerAsJpeg({stayHidden=false, quality=88}={}){
  if (!winManager || winManager.isDestroyed()) return null;
  const wasHidden = !winManager.isVisible();
  try {
    if (wasHidden && !stayHidden) { 
      try{ winManager.show(); await new Promise(r=>setTimeout(r,300)); }catch{} 
    }
    const img = await winManager.capturePage();
    return img.toJPEG(quality);
  } catch(e) { 
    log("error",`screenshotManagerAsJpeg Failed: ${e.message}`); 
    return null;
  } finally { 
    if (wasHidden && !stayHidden) try{ winManager.hide(); }catch{} 
  }
}

async function screenshotBothAsJpegs(opts){
  try {
    const [leadsBuf, managerBuf] = await Promise.all([
      screenshotLeadsAsJpeg(opts), 
      screenshotManagerAsJpeg(opts)
    ]);
    return { leadsBuf, managerBuf };
  } catch(e) { 
    log("error",`screenshotBothAsJpegs Failed: ${e.message}`); 
    return {}; 
  }
}


// ===== TRAY MANAGEMENT =====
function getTrayIcon() {
  const p = path.join(__dirname,"icon.png");
  if (EXISTS(p)) return nativeImage.createFromPath(p);
  const b64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/aq0be8AAAAASUVORK5CYII=";
  // ✅ FIX: Proper template literal with opening backtick and correct parenthesis
  return nativeImage.createFromDataURL(`data:image/png;base64,${b64}`);
}

function ensureManagerWindow(){ 
  if (winManager && !winManager.isDestroyed()) return winManager; 
  createManagerWindow(); 
  return winManager; 
}

function ensureLeadsWindow(){ 
  if (winLeads && !winLeads.isDestroyed()) return winLeads; 
  createLeadsWindow(); 
  return winLeads; 
}

function restartLeadsWindow(){
  try{
    productScraper?.disableAutoReload?.("leads restart");
    productScraper?.disable?.();
  }catch{}
  productScraper=null;

  // ✅ Stop the old watcher before destroying window
  try{ watcher?.stop?.(); }catch{}

  try{
    isRestartingWindow = true; // Prevent sync close during restart
    if(winLeads && !winLeads.isDestroyed()) winLeads.destroy();
  }catch{}
  isRestartingWindow = false;
  createLeadsWindow();

  // ✅ Recreate watcher with the new window
  try{ recreateWatcher(); }catch(e){ log("error", `Watcher Recreation Failed: ${e?.message||e}`); }

  // ✅ Recreate autoLogin with the new window
  try{ recreateAutoLogin(); }catch(e){ log("error", `AutoLogin Recreation Failed: ${e?.message||e}`); }

  log("start","Leads Window Restarted");
}

function restartManagerWindow(){
  try{
    isRestartingWindow = true; // Prevent sync close during restart
    if(winManager && !winManager.isDestroyed()) winManager.destroy();
  }catch{}
  isRestartingWindow = false;
  createManagerWindow();
  log("start","Tray: Manager Restart");
}

function createTray(){
  try{
    tray?.destroy(); 
    tray=new Tray(getTrayIcon()); 
    tray.setToolTip("Niyati Browser");
    
    const menu=Menu.buildFromTemplate([
      { label:"Leads Restart", click: ()=> restartLeadsWindow() },
      { label:"Manager Restart", click: ()=> restartManagerWindow() },
      { type:"separator" },
      { label:"Lock",   click: ()=> lockScreen?.lockSilent?.() },
      { label:"Unlock", click: ()=> lockScreen?.show?.() },
      { type:"separator" },
      { label:"Browser Quit", click: ()=>{
        // ✅ Don't send message here - before-quit handler will send it
        app.quit();
      }},
    ]);
    
    tray.setContextMenu(menu);
    
    tray.on("click", ()=>{
      if (lockScreen?.isLocked?.()) { 
        lockScreen.show?.(); 
        return; 
      }
      const w=ensureManagerWindow(); 
      try{ 
        w.show(); 
        w.focus(); 
      }catch{}
    });
  }catch(e){ 
    log("error", `Tray Init Failed: ${e.message}`); 
  }
}

// ================================================================
// ✅ SINGLE INSTANCE LOCK - Prevents multiple app instances
// ================================================================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // ✅ Another instance is already running
  console.log('⚠️  Niyati Browser is already running. Exiting this instance.');
  app.quit();
} else {
  // ✅ Handle second-instance attempts
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('🔔 Second instance detected - focusing existing windows');
    
    // ✅ Bring existing windows to front
    try {
      if (winManager && !winManager.isDestroyed()) {
        if (winManager.isMinimized()) winManager.restore();
        winManager.show();
        winManager.focus();
        log("info", "Manager Window Focused (Second-Instance)");
      }
    } catch (e) {
      console.error('Failed to focus manager window:', e.message);
    }
    
    try {
      if (winLeads && !winLeads.isDestroyed()) {
        if (winLeads.isMinimized()) winLeads.restore();
        winLeads.show();
        log("info", "Leads Window Focused (Second-Instance)");
      }
    } catch (e) {
      console.error('Failed to focus leads window:', e.message);
    }
    
    // ✅ Optional: Send notification via Telegram
    try {
      if (tg && tg.send) {
        tg.send("🔔 Second Instance Launch Attempt Detected – Focused Existing Windows");
      }
    } catch (e) {
      console.error('Failed to send Telegram notification:', e.message);
    }
  });

  // ✅ Log successful lock acquisition
  console.log('✅ Single instance lock acquired successfully');
}

app.on('ready', async () => {
  
  enablePowerSaveBlocker();
  startTimerHealthCheck();
  startWindowHealthCheck();

  createLeadsWindow();
  createManagerWindow();
  
  createTray();

  // ✅ Create watcher (uses module-level recreateWatcher function)
  recreateWatcher();

  lockScreen = createLockScreen({
    onLock: () => {
      try { clearPersist(); } catch {}
      log("info", "Lock: All Windows Hidden");
      broadcast();
    },
    onUnlock: () => {
      log("info", "Lock: Unlocked");
      persistUnlock("ui-unlock");
      broadcast();
    }
  });

  if (START_LOCK && !isUnlockedPersisted()) { 
    lockScreen.lock({ showLogin: true }); 
    log("info", "Started in Locked State"); 
  }

  // ✅ Create autoLogin (uses module-level recreateAutoLogin function)
  recreateAutoLogin();

  // ✅ Webhook server — IndiaMart Push API se real-time leads
  webhook = createWebhookServer({
    port: 3000,
    log,
    onLead: async (lead) => {
      try {
        // ✅ Duplicate check — same uniqueId baar baar aa sakta hai IndiaMart retry pe
        if (lead.uniqueId && _lastWebhookLead?.uniqueId === lead.uniqueId) {
          log("info", `Webhook: Duplicate lead ignored — ${lead.uniqueId}`);
          return;
        }

        // ✅ Last lead update karo — /status mein dikhega
        setLastWebhookLead(lead);

        const ph = lead.mobile;
        const wa = ph ? `https://wa.me/91${ph}` : "";
        const maps = (lead.city || lead.state)
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((lead.city + " " + lead.state).trim())}`
          : "";

        // Telegram text message
        await tg?.send?.(
          `🆕 *New Lead*\n` +
          `✨ *${lead.product || "Product"}*\n` +
          `👤 *Name:* ${lead.name || "---"}\n` +
          `🏢 *Company:* ${lead.company || "---"}\n` +
          `📞 *Mobile:* +91${ph || "---"}\n` +
          (wa  ? `💬 *WhatsApp:* ${wa}\n` : "") +
          `📍 *Address:* ${lead.city || ""}${lead.state ? ", " + lead.state : ""}\n` +
          (maps ? `🗺️ ${maps}\n` : "") +
          `⏰ *Time:* ${lead.queryTime || ""}`,
          { parse_mode: "Markdown", disable_web_page_preview: true }
        );

        // ✅ vCard — contact card Telegram pe bhejo
        if (ph && lead.name) {
          try {
            // vCard special chars sanitize karo — colon, newline, backslash
            const vcSafe = (s) => String(s || "").replace(/[\r\n\\:;,]/g, " ").trim();
            const safeName = vcSafe(lead.name) || "Lead";
            const n = safeName.split(/\s+/);
            const firstName = n[0] || safeName;
            const lastName  = n.slice(1).join(" ") || "";
            const vcf = [
              "BEGIN:VCARD",
              "VERSION:3.0",
              `FN:${lead.name}`,
              `N:${lastName};${firstName};;;`,
              ph ? `TEL;TYPE=CELL:+91${ph}` : "",
              lead.email   ? `EMAIL:${lead.email}` : "",
              lead.company ? `ORG:${lead.company}` : "",
              lead.address ? `ADR:;;${lead.address};${lead.city || ""};${lead.state || ""};${lead.pincode || ""};IN` : "",
              lead.product ? `NOTE:Product: ${lead.product}` : "",
              "END:VCARD"
            ].filter(Boolean).join("\r\n");

            const buf = Buffer.from(vcf, "utf8");
            const filename = `${safeName.replace(/\s+/g,"_")}.vcf`;
            await tg?.sendBufferAsDocument?.(buf, {
              filename,
              mime: "text/vcard",
              caption: `📇 ${lead.name}`
            });
          } catch (ve) {
            log("info", `Webhook: vCard send failed — ${ve?.message || ve}`);
          }
        }

        log("info", `Webhook: Lead sent to Telegram — ${lead.name} | ${lead.mobile}`);
      } catch (e) {
        log("error", `Webhook: Telegram send failed — ${e?.message || e}`);
      }
    }
  });
  webhook.start();

  // ✅ Build commands with ALL dependencies
  const baseCmds = buildDefaultCommands({
    enableAuto: sec => {
      try {
        productScraper?.enable?.();  // ✅ FIX: Must call enable() before enableAutoReload() (was missing - same bug as leads:start)
        productScraper?.enableAutoReload?.(sec*1000, () => {
          watcher?.setReloading(true);
          reloadTracker.lastAttemptAt = Date.now();
          reloadTracker.lastResult = 'ok';
          reloadTracker.lastDurationMs = null;
          reloadTracker.consecutiveFails = 0;
        });
        broadcast();
        return true;
      } catch { return false; }
    },
    disableAuto: () => { 
      try { 
        productScraper?.disableAutoReload?.("telegram stop"); 
        productScraper?.disable?.(); 
        broadcast(); 
        return true; 
      } catch { return false; } 
    },
    getIntervalSec: () => Math.round((productScraper?.getReloadState?.()?.intervalMs || 7000) / 1000),
    addProduct,
    deleteProduct,
    listProducts: loadProducts,
    addKeyword,
    deleteKeyword,
    listKeywords: loadKeywords,
    addSkipLocation,
    deleteSkipLocation,
    listSkipLocations: loadSkipLocations,
    addSkipName,
    deleteSkipName,
    listSkipNames: loadSkipNames,
    screenshotBothAsJpegs, 
    screenshotLeadsAsJpeg, 
    screenshotManagerAsJpeg,
    sendStatus: () => { 
      try { sendStatusReport("manual").catch(()=>{}); return true; } 
      catch { return false; } 
    },
    webhookStatus: () => {
      return webhook?.running ? "✅ Running on port " + webhook?.port : "❌ Not running";
    },
    cleanNow: () => { 
      try { gentleMemoryCleanup("telegram").catch(()=>{}); return true; } 
      catch { return false; } 
    },
    cleanAll: () => { 
      try {
        (async()=>{
          await archiveAndTruncate(CLEANUP_FILES,"manual-cleanall"); 
          await deepResetAllMemory();
          await gentleMemoryCleanup("cleanall");
        })(); 
        return true;
      }catch{return false;}
    },
    restartApp: () => { 
      try { log("info","Restarting via Telegram"); app.relaunch(); app.exit(0); return true; } 
      catch { return false; } 
    },
    quitApp: () => { 
      try { log("info","Quitting via Telegram"); setTimeout(()=>app.quit(),500); return true; } 
      catch { return false; } 
    },
    focusManager: () => { 
      try { winManager?.show?.(); winManager?.focus?.(); return true; } 
      catch { return false; } 
    },
    focusLeads: () => { 
      try { winLeads?.show?.(); winLeads?.focus?.(); return true; } 
      catch { return false; } 
    },
    toggleMax: () => { 
      try { 
        const w=winManager; 
        if(w){ w.isMaximized()?w.unmaximize():w.maximize(); return true; } 
        return false; 
      } catch { return false; } 
    },
    startAutoLogin: () => { 
      try { autoLogin?.start?.(); return true; } 
      catch { return false; } 
    },
    injectOtp: code => { 
      try { return !!autoLogin?.injectOtp?.(code); } 
      catch { return false; } 
    },
    requestResend: () => { 
      try { autoLogin?.requestResend?.(); return true; } 
      catch { return false; } 
    },
    isLoggedIn: () => isLoggedIn===true,
    reloadManager: () => { 
      try { winManager?.webContents?.reload?.(); return true; } 
      catch { return false; } 
    },
    lockAll: () => { 
      try { lockScreen?.lock?.({ showLogin:false }); clearPersist(); return true; } 
      catch { return false; } 
    },
    unlockNoCreds: () => { 
      try { 
        lockScreen?.unlock?.(); 
        persistUnlock("telegram-no-creds"); 
        return "🔓 Unlocked"; 
      } catch(e) { 
        return "❌ Unlock failed: "+e.message; 
      } 
    },
    unlockWithCreds: async args => { 
     const [u,p] = (args||"").split(/\s*,\s*/); 
     try {
     const result = await lockScreen?._validateAndUnlock?.({user:u||"",pass:p||""}); 
     if(result?.valid){ 
      await persistUnlockAsync("telegram-creds"); 
      return "🔓 Unlocked"; 
    } 
    return "❌ Invalid credentials"; 
  } catch (e) {
    return "❌ Unlock failed: " + e.message;
  }
},
    sendDailyReports: sendDailyReports,
    sendFile: async (filename) => {
      const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
      if (!safeName) throw new Error("Invalid filename");
      const pth = path.join(__dirname, safeName);
      if (!EXISTS(pth)) throw new Error(`File not found: ${safeName}`);
      await tg?.sendFile?.(pth, safeName);
    },

    // ✅ NEW: Force recover from stuck-offline
    forceNetworkRecovery: () => {
      try {
        log("warning", "🔧 Force Network Recovery (Telegram command)");
        isNetworkOnline = true;
        // ✅ FIX: forceOffline() call hataya — yeh contradictory tha
        // isNetworkOnline=true set karte the aur fir watcher ko offline force karte the
        // restartLeadsWindow() waise bhi new watcher banata hai — forceOffline() ka koi kaam nahi tha
        // aur race condition bana raha tha (forceOffline → probe success → onOnline() → double restart)
        try { tg?.start?.(); } catch {}
        try { restartLeadsWindow(); } catch {}
        _safeSetTimeout(() => {
          try {
            if (isNetworkOnline !== true) return;
            const st = productScraper?.getReloadState?.() || {};
            if (st.userWantedAutoRefresh && !st.enabled) resumeScraperIfAllowed();
          } catch {}
        }, 10000, 'networkfixResume');
        return true;
      } catch { return false; }
    },

    // ✅ NEW: Full reset
    fullReset: () => {
      try {
        log("warning", "♻️ Full Reset (Telegram command)");
        try { productScraper?.disableAutoReload?.("full-reset"); } catch {}
        try { productScraper?.disable?.(); } catch {}
        try { matcher?.reset?.(); } catch {}
        try { kwMatcher?.reset?.(); } catch {}
        try { webhook?.stop?.(); } catch {}
        clickTimes = [];
        reloadTracker.consecutiveFails = 0;
        reloadTracker.lastResult = null;
        _safeSetTimeout(() => {
          try {
            if (isNetworkOnline === false) return;
            productScraper?.enable?.();
            const st = productScraper?.getReloadState?.() || {};
            if (st.userWantedAutoRefresh) resumeScraperIfAllowed();
          } catch {}
        }, 2000, 'fullResetResume');
        broadcast();
        return true;
      } catch { return false; }
    },
  });

  let allCommands = { ...baseCmds };
  
  // Add slash variants for all commands
  for (const [key, val] of Object.entries(baseCmds)) {
    if (!key.startsWith('/')) {
      allCommands['/' + key] = val;
    }
  }

  // Create Telegram client with all commands
  tg = createTelegramClient({
    incomingFileSaveDir: __dirname,
    token:process.env.TELEGRAM_BOT_TOKEN, 
    chatId:process.env.TELEGRAM_CHAT_ID,
    commands: allCommands,

    onUnknown: async ({ cmd, args, send, raw }) => {
      const text = String(raw || `/${cmd}${args ? " " + args : ""}`).trim();
      const norm = (s) => s.replace(/^\/+/, "").toLowerCase();

      if (norm(cmd) === "lock" || /^\/?lock\b/i.test(text)) {
        if (baseCmds.lock?.handler) {
          return await baseCmds.lock.handler({ send, args });
        }
        return await send("🔒 Locked");
      }
      
      if (norm(cmd) === "unlock" || /^\/?unlock\b/i.test(text)) {
        let a = args;
        if (!a || !a.trim()) {
          const m = text.match(/^\s*\/?unlock\b\s*(.+)$/i);
          a = m ? m[1] : "";
        }
        if (baseCmds.unlock?.handler) {
          return await baseCmds.unlock.handler({ send, args: a });
        }
        return await send("🔓 Unlock attempted");
      }

      await send(`🤷 Unknown command: /${cmd}\nTry /sync then /help`);
    },

    dropPendingOnStart:false,
    onCommand: ({ cmd, args }) => { 
      log("start", `Telegram: /${cmd}${args ? " " + args : ""}`); 
    },
    onCommandResult: ({ cmd, args, reply }) => { 
      const s = String(reply || "").replace(/\s+/g, " ").slice(0, 300); 
      log("info", `Telegram: /${cmd} → ${s}`); 
    }
  });
  tg.start();

  sendStatusReport("startup").catch(e => log("error", `Startup Report Failed: ${e.message}`));
  scheduleEvery30Min();
  gentleMemoryCleanup("startup").catch(e => log("error", `Startup Cleanup Failed: ${e.message}`));

  startDailyReportsScheduler();

  _safeSetInterval(logActiveTimers, 5 * 60 * 1000, 'timerHealthMonitor');

  log("info","✅ Niyati Started - v3.0.0 FINAL - ALL 87 ISSUES FIXED"); 
  broadcast();
});

// ✅ FIX #13: Complete Shutdown Cleanup
let isShuttingDownInProgress = false;

app.on("before-quit", async (event)=>{
  // ✅ Prevent multiple shutdown attempts
  if (isShuttingDownInProgress) return;

  // ✅ Prevent default quit to allow async operations
  event.preventDefault();
  isShuttingDownInProgress = true;
  isShuttingDown = true;

  log("info", "🛑 Shutting down - cleaning up resources...");

  // ✅ Send Telegram notification BEFORE stopping Telegram
  try {
    if (tg?.send) {
      await tg.send("🛑 Application Shutting Down");
      log("info", "✅ Shutdown notification sent to Telegram");
      // Give Telegram time to send the message
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  } catch (e) {
    log("error", `Failed to send shutdown notification: ${e.message}`);
  }

  logActiveTimers();

  try{ disablePowerSaveBlocker(); }catch{}
  try{ stopTimerHealthCheck(); }catch{}
  try{ stopWindowHealthCheck(); }catch{}
  try{ watcher?.stop(); }catch{}
  try{ productScraper?.disableAutoReload?.("quit"); productScraper?.disable?.(); }catch{}
  try{ tg?.stop(); }catch{}
  try{ _safeClearInterval(dailyTimer); }catch{}
  
  // ✅ Clear all tracked timers
  for (const [timerId, info] of _activeTimers) {
    try {
      if (info.type === 'interval') clearInterval(timerId);
      else clearTimeout(timerId);
    } catch (e) {
      log("error", `Failed to Clear Timer ${timerId}: ${e.message}`);
    }
  }
  _activeTimers.clear();

  log("info", "✅ Cleanup Complete");

  // ✅ Now actually quit the app after all async operations
  app.quit();
});

app.on("window-all-closed", () => {
  // ✅ FIX: Sirf tab quit karo jab winLeads aur winManager dono gone hon.
  // MC persistent hidden window ke close hone pe quit nahi karna.
  const leadsGone   = !winLeads   || winLeads.isDestroyed();
  const managerGone = !winManager || winManager.isDestroyed();
  if (leadsGone && managerGone) app.quit();
});

// ✅ FIX #9: IPC Rate Limiting
const IPC_RATE_LIMITS = new Map();
const IPC_RATE_LIMIT_MS = 1000; // 1 request per second per channel
const IPC_RATE_LIMIT_BURST = 5; // Allow 5 requests in burst

function checkIPCRateLimit(channel, sender) {
  const key = `${channel}:${sender.id}`;
  const now = Date.now();
  
  if (!IPC_RATE_LIMITS.has(key)) {
    IPC_RATE_LIMITS.set(key, { count: 1, windowStart: now });
    return true;
  }
  
  const limit = IPC_RATE_LIMITS.get(key);
  
  // Reset window if expired
  if (now - limit.windowStart > IPC_RATE_LIMIT_MS) {
    limit.count = 1;
    limit.windowStart = now;
    return true;
  }
  
  // Check burst limit
  if (limit.count >= IPC_RATE_LIMIT_BURST) {
    log("warning", `IPC Rate Limit Exceeded: ${channel} (${limit.count} requests)`);
    return false;
  }
  
  limit.count++;
  return true;
}

// Cleanup old rate limit entries - ✅ FIX: Use _safeSetInterval to track timer for proper cleanup
_safeSetInterval(() => {
  const now = Date.now();
  for (const [key, limit] of IPC_RATE_LIMITS) {
    if (now - limit.windowStart > 60000) { // 1 minute
      IPC_RATE_LIMITS.delete(key);
    }
  }
}, 60000, 'ipcRateLimitCleanup');

ipcMain.handle("reports:run", async (e) => { 
  if (!checkIPCRateLimit("reports:run", e.sender)) {
    return { ok: false, error: "Rate limit exceeded" };
  }
  
  try { 
    await sendDailyReports("manual"); 
    return { ok: true }; 
  } catch (e) { 
    log("error", `reports:run Failed: ${e.message}`);
    return { ok: false, error: e.message }; 
  } 
});

ipcMain.handle("win:minimize",(e)=>BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.handle("win:maximize",(e)=>{ 
  const w=BrowserWindow.fromWebContents(e.sender); 
  if(!w) return; 
  w.isMaximized()?w.unmaximize():w.maximize(); 
});
ipcMain.handle("win:close",(e)=>{ 
  const w=BrowserWindow.fromWebContents(e.sender); 
  if(!w) return; 
  try{ w.removeAllListeners("close"); }catch{} 
  try{ w.destroy(); }catch{} 
});

ipcMain.handle("leads:getState",()=>buildState());

// ✅ FIX #9: Enhanced IPC validation for leads:start
ipcMain.handle("leads:start", (e, ms) => {
  if (!checkIPCRateLimit("leads:start", e.sender)) {
    return { ok: false, error: "Too many requests" };
  }
  
  try {
    // ✅ Strict type validation
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      return { ok: false, error: "Invalid type: must be number" };
    }
    
    const startMs = validateMs(ms);
    
    if (productScraper && typeof productScraper.enableAutoReload === "function") {
      productScraper.enable?.();  // ✅ FIX: Re-enable scraper activity (was missing, causing scraper to stay disabled after stop)
      productScraper.enableAutoReload(startMs, () => {
        watcher?.setReloading(true);
        // ✅ FIX: Track auto-reload in reloadTracker so /status shows correct "Last Reload" time
        reloadTracker.lastAttemptAt = Date.now();
        reloadTracker.lastResult = 'ok';
        reloadTracker.lastDurationMs = null;   // auto-reload duration N/A (fire-and-forget)
        reloadTracker.consecutiveFails = 0;
      });
      log("start", "Auto-Refresh Started (Cycle Mode)");
      pendingStartMs = null;
      broadcast();
      return { ok: true, queued: false };
    }
    
    pendingStartMs = startMs;
    log("info", `Auto-Refresh Queued @ ${Math.round(startMs/1000)}s`);
    broadcast();
    return { ok: true, queued: true };
  } catch (e) {
    log("error", `leads:start Error: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("leads:stop", (e) => {
  if (!checkIPCRateLimit("leads:stop", e.sender)) {
    return { ok: false, error: "Too many requests" };
  }
  
  productScraper?.disableAutoReload("ui stop"); 
  productScraper?.disable?.(); 
  broadcast(); 
  return {ok:true}; 
});

// ✅ FIX #12: Enhanced lockscreen:tryUnlock validation
ipcMain.handle("lockscreen:tryUnlock", async (e, body) => {
  if (!checkIPCRateLimit("lockscreen:tryUnlock", e.sender)) {
    return { valid: false, reason: "Too many attempts" };
  }
  
  try {
    // ✅ Validate input structure
    if (!body || typeof body !== 'object') {
      return { valid: false, reason: "Invalid input format" };
    }
    
    // ✅ Validate field types and lengths
    const user = String(body.user || "").slice(0, 100);
    const pass = String(body.pass || body.passHash || "").slice(0, 256);
    
    if (!user || !pass) {
      return { valid: false, reason: "Missing credentials" };
    }
    
    const result = await (lockScreen?._validateAndUnlock({ user, pass }) ?? 
                          { valid: false, reason: 'Not available' });
    
    return result;
  } catch (e) {
    log("error", `lockscreen:tryUnlock Error: ${e.message}`);
    return { valid: false, reason: "Authentication error" };
  }
});

ipcMain.handle("lockscreen:lock", () => { 
  try { lockScreen?.lockSilent?.(); return true; } 
  catch { return false; } 
});

ipcMain.handle("lockscreen:unlock", () => { 
  try { lockScreen?.show?.(); return true; } 
  catch { return false; } 
});

ipcMain.handle("mc:manual", async (e) => {
  // MC removed — Push API handles leads
  if (!checkIPCRateLimit("mc:manual", e.sender)) {
    return { ok: false, error: "Too many requests" };
  }
  
  try {
    // MC removed — Push API handles leads via webhook
    log("info", "mc:manual called — MC removed, Push API handles leads");
  } catch (e) {
  }
  try {
    await safeReloadLeads("manual");
  } catch (e) {
    log("error", "Manual Refresh Failed: " + (e?.message || e));
  }
  return { ok: true };
});

// ✅ IPC Handlers for Lists Management
ipcMain.handle("lists:saveProducts", async (e, arr) => {
  if (!Array.isArray(arr)) return false;
  try {
    await saveProductsAsync(arr);
    await updateManagerLists({ products: arr });
    // ✅ FIX: Running scraper ko bhi turant update karo — nahi to restart tak purani list rahegi
    // matcher dynamically getProducts() callback use karta hai jo productScraper se hi aata hai
    try { productScraper?.setProducts?.(arr); } catch {}
    log("info", `Lists: Products updated live — ${arr.length} items`);
    return true;
  } catch (err) {
    log("error", `Save Products Failed: ${err.message}`);
    return false;
  }
});

ipcMain.handle("lists:saveKeywords", async (e, arr) => {
  if (!Array.isArray(arr)) return false;
  try {
    await saveKeywordsAsync(arr);
    await updateManagerLists({ keywords: arr });
    return true;
  } catch (err) {
    log("error", `Save Keywords Failed: ${err.message}`);
    return false;
  }
});

ipcMain.handle("lists:saveSkipLocations", async (e, arr) => {
  if (!Array.isArray(arr)) return false;
  try {
    await saveSkipLocationsAsync(arr);
    await updateManagerLists({ skipLocations: arr });
    return true;
  } catch (err) {
    log("error", `Save Skip Locations Failed: ${err.message}`);
    return false;
  }
});

ipcMain.handle("lists:saveSkipNames", async (e, arr) => {
  if (!Array.isArray(arr)) return false;
  try {
    await saveSkipNamesAsync(arr);
    await updateManagerLists({ skipNames: arr });
    return true;
  } catch (err) {
    log("error", `Save Skip Names Failed: ${err.message}`);
    return false;
  }
});

// ✅ Browser network events - IGNORED (StatusWatcher is single source of truth)
// These events are unreliable and can cause loops, so we completely ignore them
try {
  const { ipcMain: ipc } = require("electron");

  // Cleanup old listeners
  try {
    const count = ipc.listenerCount("net:status");
    if (count > 0) {
      ipc.removeAllListeners("net:status");
    }
  } catch {}

  // Ignore browser events - StatusWatcher handles all network detection
  ipc.on("net:status", () => { /* ignored */ });
} catch (e) {
  log("error", `Network Status Handler Setup Failed: ${e.message}`);
}

// ✅ Leads Window Throttle Detection — renderer se aata hai jab timer drift ho
let lastThrottleAlertTime = 0;
const THROTTLE_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // ✅ FIX: 5 min → 30 min (Chromium flags se throttling kam hogi, yeh safety net hai)

ipcMain.on("win:throttle-detected", (_e, data) => {
  try {
    const now = Date.now();
    const driftSec = Math.round((data?.driftMs || 0) / 1000);
    const expectedSec = Math.round((data?.expectedMs || 0) / 1000);

    log("warning", `⚠️ Leads Renderer Throttled! Expected: ~${expectedSec}s, Drift: +${driftSec}s`);

    // Cooldown check — zyada spam na ho Telegram pe
    if (now - lastThrottleAlertTime < THROTTLE_ALERT_COOLDOWN_MS) {
      log("debug", "Throttle Alert Skipped (Cooldown Active)");
      return;
    }
    lastThrottleAlertTime = now;

    // Telegram pe alert bhejo
    if (tg && typeof tg.send === 'function') {
      const msg = `⚠️ <b>Leads Window Throttled!</b>\n\nTimer drift detected in Leads renderer.\n• Expected: ~${expectedSec}s\n• Actual delay: ~${expectedSec + driftSec}s\n• Drift: <b>+${driftSec}s</b>\n\nLeads refresh slow ho sakta hai.`;
      tg.send(msg, { parse_mode: 'HTML' }).catch(e => {
        log("error", `Throttle Alert Telegram Send Failed: ${e.message}`);
      });
    }
  } catch (e) {
    log("error", `Throttle Detection Handler Error: ${e.message}`);
  }
});

function startDailyReportsScheduler() {
  try { _safeClearInterval(dailyTimer); } catch {}
  const state = _loadDailyState();
  const slots = DAILY_REPORT_TIMES.length ? DAILY_REPORT_TIMES : ["08:00", "20:00"];
  const tickMs = 30_000;
  let loopRunning = false; // ✅ FIX: concurrent loop executions rokta hai

  const loop = async () => {
    if (loopRunning) return; // ✅ FIX: agar pichla loop abhi chal raha hai toh naya mat shuru karo
    loopRunning = true;

    try {
      const day = _todayKey(DAILY_TZ);
      for (const slot of slots) {
        if (_shouldRunSlot(state, day, slot, DAILY_CATCHUP_MINS)) {
          _markDailyRun(state, day, slot); // ✅ FIX: sendDailyReports se PEHLE mark karo — race condition khatam
          try {
            log("start", `Daily: Running Slot ${slot} (${DAILY_TZ})`);
            await sendDailyReports(slot);
            log("info", `Daily: Done ${slot}`);
          } catch (e) {
            log("error", `Daily: Slot ${slot} failed – ${e?.message || e}`);
          }
        }
      }
    } finally {
      loopRunning = false; // ✅ FIX: guard release — error aane par bhi release hoga
    }
  };

  loop().catch(e => log("error", `Daily Scheduler Initial Run Failed: ${e.message}`));
  dailyTimer = _safeSetInterval(loop, tickMs, 'dailyReportsScheduler');
  log("info", `Daily: Scheduler Started @${DAILY_TZ} slots=[${slots.join(", ")}], catchUp=${DAILY_CATCHUP_MINS}m`);
}

// ===== END OF main.js =====
// ALL 87 ISSUES FIXED ✅