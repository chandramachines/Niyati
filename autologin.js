// ✅ ALL FIXES APPLIED - autologin.js v2.2.0
// FIX #7: Enhanced OTP loop error handling

const DELAY_MIN_MS = 1000, DELAY_MAX_MS = 4000;
const rand = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const delay1to4 = ()=>sleep(rand(DELAY_MIN_MS,DELAY_MAX_MS));

// ✅ Constants for loop protection
const MAX_POLL_ITERATIONS = 600; // 10 minutes at 1s/iteration

function createAutoLogin({
  win,
  log = () => {},
  notify = () => {},
  onSuccess = () => {},
  onFail = () => {},
  mobile,
  maxAttempts = 3,
  resendCooldownMs = 30000
} = {}) {

  const SEL = {
    mob: "#mobNo",
    loginBtn: "#root > div.loginPage.reactLogin > div.row.bannerRow > div > div:nth-child(5) > div > div.banner-cta > button",
    reqOtp: "#reqOtpMobBtn",
    otp1: "#first", otp2: "#second", otp3: "#third", otp4: "#fourth_num",
    otp5: "#fifth", otp6: "#sixth",
    submitOtp: "#sbmtbtnOtp",
    otpErr: "#otp_verify_err",
    loggedIn: "#selsout"
  };

  let running = false;
  let externalOtp = null;
  let resendFlag = false;
  let attempts = 0;
  let lastResendAt = 0;

  const maskMobile = (m) => (m || "").replace(/\d(?=\d{4})/g, "•");

  async function isAlive() {
    try { 
      return !!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()); 
    }
    catch { return false; }
  }

  async function execJS(js){
    if (!(await isAlive())) return null;
    return win.webContents.executeJavaScript(js, true);
  }

  async function waitForSelector(sel, timeoutMs=15000){
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!running || !(await isAlive())) return false;
      try { 
        if (await execJS(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; 
      } catch (e) { 
        try { log("error", `WaitForSelector: ${e?.message||e}`); } catch {}
      }
      await sleep(250);
    }
    return false;
  }

  async function hardReloadAndWait(){
    if (!(await isAlive())) return;
    try { win.webContents.reloadIgnoringCache(); } catch {}
    for (let i=0;i<150;i++){
      if (!running || !(await isAlive())) return;
      try {
        const rs = await execJS("document.readyState");
        if (rs === "interactive" || rs === "complete") break;
      } catch {}
      await sleep(100);
    }
  }

  async function typeValue(sel, value){
    return execJS(`
      (function(){
        const el = document.querySelector(${JSON.stringify(sel)});
        if(!el) return false;
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })();
    `);
  }

  async function clickSel(sel){
    return execJS(`
      (function(){
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el || el.disabled) return false;
        el.click();
        return true;
      })();
    `);
  }

  async function readText(sel){
    return execJS(`(function(){const el=document.querySelector(${JSON.stringify(sel)}); return el?(el.textContent||el.innerText||"").trim():null; })();`);
  }

  async function exists(sel){ 
    return !!(await execJS(`!!document.querySelector(${JSON.stringify(sel)})`)); 
  }

  async function getOtpSelectors(){
    const candidates = [SEL.otp1, SEL.otp2, SEL.otp3, SEL.otp4, SEL.otp5, SEL.otp6];
    const present = [];
    for (const s of candidates) { 
      if (await exists(s)) present.push(s); 
    }
    return present.length ? present : [SEL.otp1, SEL.otp2, SEL.otp3, SEL.otp4];
  }

  async function clearOtpFields(sels){
    for (const s of sels) { 
      await typeValue(s, ""); 
      await sleep(80); 
    }
  }

  async function fillOtpFields(code){
    const digits = String(code||"").replace(/\D/g,"").split("");
    const sels = await getOtpSelectors();
    const n = Math.min(digits.length, sels.length);
    if (n < 4) return false;
    await clearOtpFields(sels);
    for (let i=0; i<n; i++){
      const ok = await typeValue(sels[i], digits[i]);
      if (!ok) return false;
      await sleep(120);
    }
    return true;
  }

  // ✅ FIX #7: Enhanced error handling in OTP wait loop
  async function waitForOtpOrUser(maxMs = 5*60*1000){
    const started = Date.now();
    let iterations = 0;
    let consecutiveErrors = 0; // ✅ Track error rate
    const MAX_CONSECUTIVE_ERRORS = 10;
    
    notify("⌛ Waiting for OTP (Up to 5 Min). Use /otp 1234 or /resend.");
    
    while (true) {
      try { // ✅ Wrap entire loop body in try-catch
        const elapsed = Date.now() - started;
        
        // ✅ Check exit conditions FIRST
        if (!running || !(await isAlive())) return "cancelled";
        if (elapsed >= maxMs) return "timeout";
        
        // ✅ Safety counter to prevent infinite loops
        if (++iterations > MAX_POLL_ITERATIONS) {
          log("error", "OTP Wait: Max Iterations Exceeded");
          return "timeout";
        }
        
        // ✅ Check error rate
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("error", `OTP Wait: Too Many Errors (${consecutiveErrors}), Aborting`);
          return "error-abort";
        }

        if (resendFlag) {
          try {
            resendFlag = false;
            const now = Date.now();
            if (now - lastResendAt > resendCooldownMs) {
              lastResendAt = now;
              await clickSel(SEL.reqOtp);
              notify("🖱️ Clicked Request OTP");
            } else {
              notify("🕒 Resend Ignored (Cooldown)");
            }
          } catch (e) {
            log("error", `Resend Failed: ${e.message}`);
            resendFlag = false; // ✅ Reset flag on error
          }
        }

        if (externalOtp) {
          try {
            const code = externalOtp; 
            externalOtp = null;
            if (await fillOtpFields(code)) return "filled";
          } catch (e) {
            log("error", `OTP Fill Failed: ${e.message}`);
            externalOtp = null; // ✅ Reset on error
          }
        }

        // ✅ Check if user manually filled OTP
        const filled = await execJS(`
          (function(){
            const getV = (s)=> (document.querySelector(s)?.value||"").trim();
            const sels = [${[SEL.otp1, SEL.otp2, SEL.otp3, SEL.otp4, SEL.otp5, SEL.otp6].map(s=>JSON.stringify(s)).join(",")}].filter(Boolean);
            const vals = sels.map(getV).filter(Boolean);
            return vals.join("");
          })();
        `);
        if (filled && /^\d{4,8}$/.test(filled)) return "user-filled";

        // ✅ Reset error counter on successful iteration
        consecutiveErrors = 0;
        
      } catch (loopError) {
        consecutiveErrors++;
        log("error", `OTP Loop Error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${loopError.message}`);
        // ✅ Continue loop - don't break on errors
      }
      
      // ✅ Sleep at END of loop with fallback
      await sleep(1000).catch(() => {
        log("warning", "Sleep Failed, Using Sync Delay");
        return new Promise(resolve => setTimeout(resolve, 1000));
      });
    }
  }

  function reset(){ 
    externalOtp=null; 
    resendFlag=false; 
    attempts=0; 
  }

  function injectOtp(code){
    if(!code || !/^\d{4,8}$/.test(code.trim())) return false;
    externalOtp = code.trim();
    log("info", "OTP Injected");
    notify("📩 OTP Received, Will Submit.");
    return true;
  }

  function requestResend(){
    resendFlag = true;
    notify("🔄 Resend Requested — Will Click.");
  }

  async function resolveMobile(){
    const cfg = String(mobile ?? process.env.INDIAMART_MOBILE ?? "").trim();
    if (cfg) return cfg;
    try {
      const inPage = await execJS(`(document.querySelector(${JSON.stringify(SEL.mob)})?.value||"").trim()`);
      return inPage || "";
    } catch { return ""; }
  }

  async function runOnce(){
    attempts += 1;
    const tag = `🎯Attempt ${attempts}/${maxAttempts}`;

    await hardReloadAndWait();
    await delay1to4();
    log("info", `${tag}: 🔄 Page Hard Reloaded`);
    notify(`${tag}: 🔄 Page Hard Reloaded`);

    try {
      const already = await exists(SEL.loggedIn);
      if (already) {
        log("auth", `${tag}: Already Logged-In; Skipping`);
        notify(`${tag}: 🔓 Already Logged-In ✓`);
        return true;
      }
    } catch {}

    if (!(await waitForSelector(SEL.mob, 15000))) {
      const late = await exists(SEL.loggedIn).catch(()=>false);
      if (late) {
        log("auth", `${tag}: Logged-In (Late Detect)`);
        notify(`${tag}: 🔓 Logged-In ✓`);
        return true;
      }
      log("error", `${tag}: Login Form Not Visible; Aborting Attempt`);
      notify(`${tag}: ⚠️ Login Form Not Visible; Will Retry.`);
      return false;
    }

    const MOBILE = await resolveMobile();
    if (!MOBILE) {
      notify(`${tag}: ⚙️ No Mobile Configured (Set INDIAMART_MOBILE Or Pass options.mobile)`);
      log("error", `${tag}: Missing Mobile; Cannot Continue`);
      return false;
    }

    const a1 = await typeValue(SEL.mob, MOBILE);
    await delay1to4();
    log(a1?"info":"error", `${tag}: 📱 Fill Mobile ${a1?"OK":"FAIL"} (${maskMobile(MOBILE)})`);
    notify(`${tag}: 📱 Mobile ${a1?"Filled":"Missing"}`);

    if (!(await waitForSelector(SEL.loginBtn, 8000))) {
      log("error", `${tag}: Login Button Missing`);
      notify(`${tag}: 🔘 Login Button Missing`);
      return false;
    }
    const a2 = await clickSel(SEL.loginBtn);
    await delay1to4();
    log(a2?"info":"error", `${tag}: 🟢 Click Login ${a2?"OK":"FAIL"}`);
    notify(`${tag}: 🟢 Click Login ${a2?"OK":"FAIL"}`);

    if (!(await waitForSelector(SEL.reqOtp, 12000))) {
      log("error", `${tag}: Request OTP Button Missing`);
      notify(`${tag}: ⛔ Request OTP Button Missing`);
      return false;
    }
    const a3 = await clickSel(SEL.reqOtp);
    await delay1to4();
    log(a3?"info":"error", `${tag}: 🔢 Request OTP ${a3?"OK":"FAIL"}`);
    notify(`${tag}: 🔢 Request OTP ${a3?"OK":"FAIL"}`);

    let otpRetries = 0; 
    const OTP_RETRY_LIMIT = 3;
    
    while (otpRetries <= OTP_RETRY_LIMIT) {
      const res = await waitForOtpOrUser();
      if (res === "cancelled") {
        log("info", `${tag}: Cancelled`);
        return false;
      }
      if (res === "timeout") {
        log("error", `${tag}: OTP Wait Timeout (5 Min)`);
        notify(`${tag}: ⏲️ OTP Timeout. Use /Resend Then /Otp 1234.`);
        return false;
      }
      if (res === "error-abort") {
        log("error", `${tag}: Too Many Errors In OTP Loop`);
        notify(`${tag}: 💥 OTP Loop Aborted Due To Errors.`);
        return false;
      }

      if (!(await waitForSelector(SEL.submitOtp, 8000))) {
        log("error", `${tag}: Submit OTP Button Missing`);
        notify(`${tag}: 🔘 Submit OTP Button Missing`);
        return false;
      }
      const sub = await clickSel(SEL.submitOtp);
      await delay1to4();
      log(sub?"info":"error", `${tag}: Submit OTP ${sub?"OK":"FAIL"}`);
      notify(`${tag}: 📤 Submit OTP ${sub?"OK":"FAIL"}`);

      const errVis = await exists(SEL.otpErr);
      if (errVis) {
        const txt = (await readText(SEL.otpErr)) || "OTP Verification Error.";
        otpRetries += 1;
        notify(`${tag}: ⚠️ ${txt} (Retry ${otpRetries}/${OTP_RETRY_LIMIT})`);
        log("error", `${tag}: ${txt} (Retry ${otpRetries}/${OTP_RETRY_LIMIT})`);
        if (otpRetries > OTP_RETRY_LIMIT) {
          notify(`${tag}: 🔁 OTP Incorrect Multiple Times. Will Retry In Next Attempt.`);
          return false;
        }
        continue;
      }

      const ok = await exists(SEL.loggedIn);
      if (ok) {
        log("auth", `${tag}: Login Success`);
        notify(`${tag}: 🎉 Login Success ✓`);
        return true;
      }
      await sleep(1500);
    }
    return false;
  }

  async function start(){
    if (running) {
      notify("🟡 Auto-Login Already Running");
      return;
    }
    running = true;
    reset();
    notify(`▶️ Auto-Login Started (Max ${maxAttempts} Attempt${maxAttempts>1?"s":""}).`);

    let success = false;
    try {
      for (let i=0; i<maxAttempts; i++) {
        if (!running) break;
        const ok = await runOnce();
        if (ok) { 
          success = true; 
          break; 
        }
        const backoff = Math.min(30000, (2 ** (i+1)) * 1000) + rand(0, 1000);
        await sleep(backoff);
      }
    } catch (e) {
      log("error", `Auto-Login Error: ${e?.message || e}`);
      notify(`🐞 Auto-Login Error: ${e?.message || e}`);
    } finally {
      running = false;
    }

    if (success) onSuccess(); 
    else onFail();
  }

  function cancel(){
    running=false;
    reset();
    notify("🚫 Auto-Login Cancelled.");
  }

  return { 
    start, 
    cancel, 
    injectOtp, 
    requestResend, 
    get running(){ return running; } 
  };
}

module.exports = { createAutoLogin };