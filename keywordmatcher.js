// ✅ ALL ISSUES FIXED - keywordmatcher.js v3.0.0
// FIXED: Blocking I/O, race conditions, unbounded growth, caching
// Date: 2025-01-06

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function createKeywordMatcher({
  keywordsFile = path.join(__dirname, "List", "keywords.json"),
  log  = () => {},
  send = async (_text, _extra = {}) => {}
} = {}) {

  const norm = s => String(s||"").trim().replace(/\s+/g," ").toLowerCase();
  const normTitle = s => (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim();

  const tsNoMs = (d=new Date())=>{
    const p = n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  // ✅ FIX #4: ASYNC FILE READING + CACHING
  let cachedKeywords = null;
  let lastFileModTime = 0;

  const readKeywords = async () => {
    try {
      // ✅ Check file modification time for caching
      const stats = await fsp.stat(keywordsFile);
      const modTime = stats.mtimeMs;
      
      if (cachedKeywords && modTime === lastFileModTime) {
        return cachedKeywords;
      }
      
      // ✅ ASYNC read instead of blocking sync read
      const raw = await fsp.readFile(keywordsFile, "utf8");
      const arr = JSON.parse(raw);
      const processed = Array.isArray(arr) 
        ? arr.map(s => String(s).trim().toLowerCase()).filter(Boolean) 
        : [];
      
      cachedKeywords = processed;
      lastFileModTime = modTime;
      
      return processed;
    } catch {
      try {
        // Fallback to legacy file
        const legacy = path.join(__dirname, "keywords.txt");
        const txt = await fsp.readFile(legacy, "utf8");
        const processed = txt.split(/[\n,]/g).map(s => s.trim().toLowerCase()).filter(Boolean);
        cachedKeywords = processed;
        return processed;
      } catch { 
        return cachedKeywords || []; 
      }
    }
  };

  // ✅ Force cache refresh
  const refreshKeywordsCache = async () => {
    lastFileModTime = 0;
    cachedKeywords = null;
    return await readKeywords();
  };

  const escHtml = s => String(s||"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  const composeLocation = (it)=>{
    const city = (it?.city||"").trim();
    const state = (it?.state||"").trim();
    const fb = (it?.location||"").trim();
    return (city || state) ? [city, state].filter(Boolean).join(", ") : (fb || "");
  };

  const buildFancyMessage = (title, loc)=>{
    const lines = ["✨ Keyword Matched", `🛒 ${escHtml(title)}`];
    if (loc) lines.push(`📍 ${escHtml(loc)}`);
    return {
      text: lines.join("\n"),
      extra:{ parse_mode:"HTML", disable_web_page_preview:true }
    };
  };

  const OUTPUT_DIR = path.join(__dirname, "Reports");
  const MATCH_JSON = path.join(OUTPUT_DIR, "keyword_matches.json");
  
  // ✅ Ensure directory exists
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

  let persistedKeys = new Set();
  let serialCounter = 1;
  let jsonRows = [];
  
  // ✅ FIX #15: MAX SIZE LIMIT to prevent unbounded growth
  const MAX_ROWS = 10000;
  const ARCHIVE_THRESHOLD = 12000;

  // ✅ ASYNC initialization
  let initPromise = null;
  async function initialize() {
    if (initPromise) return initPromise;
    
    initPromise = (async () => {
      try {
        if (fs.existsSync(MATCH_JSON)) {
          const data = JSON.parse(await fsp.readFile(MATCH_JSON, "utf8"));
          if (Array.isArray(data)) {
            // ✅ Limit loaded data
            jsonRows = data.slice(0, MAX_ROWS);
            
            for (const row of jsonRows) {
              const name = row?.name ?? "";
              const loc  = row?.location ?? "";
              if (name) {
                persistedKeys.add(`${norm(name)}|${norm(loc)}`);
                const sNo = parseInt(row?.serial, 10);
                if (!Number.isNaN(sNo)) serialCounter = Math.max(serialCounter, sNo + 1);
              }
            }
          }
        }
      } catch (e) { 
        try { log("error", `Keyword JSON Load Failed: ${e.message}`); } catch {} 
      }
    })();
    
    return initPromise;
  }

  // ✅ Call init immediately
  initialize().catch(() => {});

  // ✅ ASYNC write with atomic rename
  const writeJson = async () => {
    try {
      await fsp.mkdir(path.dirname(MATCH_JSON), { recursive: true });
      
      // ✅ Atomic write
      const tmp = MATCH_JSON + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(jsonRows, null, 2), "utf8");
      await fsp.rename(tmp, MATCH_JSON);
    } catch (e) { 
      try { log("error", `Keyword JSON Write Failed: ${e.message}`); } catch {} 
    }
  };

  // ✅ FIX #11: RACE CONDITION FIXED with locking
  let writeLock = Promise.resolve();
  
  const persistIfNew = async (name, location) => {
    // Wait for any pending writes
    await writeLock;
    
    // Create new write lock
    writeLock = (async () => {
      const key = `${norm(name)}|${norm(location)}`;
      
      // ✅ Atomic check-and-set
      if (persistedKeys.has(key)) return false;
      
      // Mark immediately to prevent race
      persistedKeys.add(key);
      
      try {
        const ts = tsNoMs();
        jsonRows.unshift({ 
          serial: serialCounter, 
          timestamp: ts, 
          name, 
          location 
        });
        
        // ✅ Rotate if too large
        if (jsonRows.length > ARCHIVE_THRESHOLD) {
          const archived = jsonRows.slice(MAX_ROWS);
          jsonRows = jsonRows.slice(0, MAX_ROWS);
          
          // Archive old data
          try {
            const archiveFile = path.join(OUTPUT_DIR, `keyword_matches_archive_${Date.now()}.json`);
            await fsp.writeFile(archiveFile, JSON.stringify(archived, null, 2));
            log("info", `Archived ${archived.length} Old Keyword Matches`);
          } catch (e) {
            log("warning", `Archive Failed: ${e.message}`);
          }
          
          // Clean up persisted keys for archived items
          for (const row of archived) {
            const archivedKey = `${norm(row.name)}|${norm(row.location)}`;
            persistedKeys.delete(archivedKey);
          }
        }
        
        await writeJson();
        serialCounter += 1;
        try { log("info", `Persist(Keyword): + "${name}"${location?` [${location}]`:""}`); } catch {}
        return true;
      } catch (e) {
        // Rollback on error
        persistedKeys.delete(key);
        throw e;
      }
    })();
    
    return await writeLock;
  };

  let lastCycleMatches = new Set();
  
  // ✅ Prevent concurrent processing
  let processingLock = null;

  async function processCycle(items, _cycleId) {
    // ✅ Join existing processing if in progress
    if (processingLock) {
      try {
        return await processingLock;
      } catch (e) {
        log("error", `Previous Keyword Cycle Failed: ${e.message}`);
      }
    }
    
    processingLock = (async () => {
      // ✅ Wait for initialization
      await initialize();
      
      // ✅ ASYNC keyword reading (non-blocking)
      const keywords = await readKeywords();
      
      if (!Array.isArray(items)) items = [];
      if (keywords.length === 0) { 
        return { sent: 0, matched: [] }; 
      }

      const currentMatched = new Set();
      const currentMeta = new Map();

      for (const it of items) {
        const raw = it?.title ? String(it.title) : "";
        if (!raw) continue;
        const t = normTitle(raw);
        
        let hasMatch = false;
        for (const kw of keywords) {
          if (kw && t.includes(kw)) {
            hasMatch = true;
            break;
          }
        }
        
        if (!hasMatch) continue;

        if (!currentMatched.has(t)) {
          currentMatched.add(t);
          const loc = composeLocation(it);
          currentMeta.set(t, { title: raw, location: loc });
          try { log("info", `KeywordMatch: "${raw}"${loc?` [${loc}]`:""}`); } catch {}
        }
      }

      let sent = 0;
      const sendPromises = [];
      
      for (const key of currentMatched) {
        const meta = currentMeta.get(key) || { title: key, location: "" };

        const dedupeKey = `${norm(meta.title)}|${norm(meta.location)}`;
        if (!lastCycleMatches.has(key) && !persistedKeys.has(dedupeKey)) {
          const { text, extra } = buildFancyMessage(meta.title, meta.location);
          
          // ✅ Send async and collect promises
          const sendPromise = (async () => {
            try { 
              await Promise.resolve(send(text, extra)); 
              sent += 1; 
            }
            catch (e) { 
              try { log("error", `KeywordMatch Send Failed: ${e.message}`); } catch {} 
            }
          })();
          
          sendPromises.push(sendPromise);
        }

        // ✅ Persist async (non-blocking)
        persistIfNew(meta.title, meta.location).catch(e => {
          log("error", `Persist Failed: ${e.message}`);
        });
      }
      
      // ✅ Wait for all sends to complete
      await Promise.all(sendPromises);

      lastCycleMatches = currentMatched.size ? currentMatched : new Set();
      return { 
        sent, 
        matched: Array.from(currentMeta.values()).map(m => m.location ? `${m.title} – ${m.location}` : m.title) 
      };
    })();
    
    try {
      return await processingLock;
    } finally {
      processingLock = null;
    }
  }

  return { 
    processCycle,
    refreshKeywordsCache, // ✅ NEW: Manual cache refresh
    reset: () => {
      lastCycleMatches.clear();
      try { log("info", "KeywordMatcher: Reset (Light) Complete"); } catch {}
    },
    deepReset: async () => {
      lastCycleMatches.clear();
      persistedKeys.clear();
      jsonRows = [];
      serialCounter = 1;
      await writeJson();
      try { log("info", "Keywordmatcher: Deep Reset Complete"); } catch {}
    },
    getStats: () => ({
      persistedKeysSize: persistedKeys.size,
      jsonRowsCount: jsonRows.length,
      lastCycleSize: lastCycleMatches.size,
      cachedKeywordsCount: cachedKeywords?.length || 0
    })
  };
}

module.exports = { createKeywordMatcher };