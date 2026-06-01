// visibility-monitor.js
// Monitors page visibility to detect background throttling

function injectVisibilityMonitor(win) {
  if (!win || win.isDestroyed()) return;

  // ✅ FIX: Added cleanup mechanism to prevent memory leaks
  const code = `
    (function() {
      // Cleanup existing monitor if re-injected
      if (window.__niyatiVisibilityMonitor) {
        if (window.__niyatiVisibilityCleanup) {
          window.__niyatiVisibilityCleanup();
        }
      }
      window.__niyatiVisibilityMonitor = true;

      let lastState = !document.hidden;
      let intervalId = null;

      // ── Timer Drift Detector ──────────────────────────────────────────
      // Renderer ke andar actual setTimeout delay measure karta hai.
      // Agar expected 10s hai aur actual 30s+ laga — throttling ho rahi hai.
      const DRIFT_CHECK_MS = 10000;       // har 10s pe check
      const DRIFT_THRESHOLD_MS = 5000;    // 5s se zyada delay = throttled
      const DRIFT_COOLDOWN_MS = 60000;    // ek baar alert ke baad 60s tak dobara nahi
      let driftTimerId = null;
      let lastDriftAlert = 0;

      function scheduleDriftCheck() {
        const scheduledAt = Date.now();
        driftTimerId = setTimeout(function tick() {
          const actualElapsed = Date.now() - scheduledAt;
          const drift = actualElapsed - DRIFT_CHECK_MS;

          if (drift > DRIFT_THRESHOLD_MS) {
            const now = Date.now();
            if (now - lastDriftAlert > DRIFT_COOLDOWN_MS) {
              lastDriftAlert = now;
              console.warn('[Niyati] Timer Drift Detected! Expected:', DRIFT_CHECK_MS + 'ms, Got:', actualElapsed + 'ms, Drift:', drift + 'ms');
              // Main process ko IPC se report karo
              try {
                window.ThrottleMonitor?.report({
                  driftMs: drift,
                  expectedMs: DRIFT_CHECK_MS,
                  source: 'leads-renderer'
                });
              } catch(e) {}
            }
          }

          // Next check schedule karo (loop)
          if (window.__niyatiVisibilityMonitor) {
            scheduleDriftCheck();
          }
        }, DRIFT_CHECK_MS);
      }
      // ─────────────────────────────────────────────────────────────────

      function checkVisibility() {
        const nowHidden = document.hidden;
        if (nowHidden !== !lastState) {
          lastState = !nowHidden;
          console.log('[Niyati] Visibility Changed:', lastState ? 'VISIBLE' : 'HIDDEN');
        }

        // Update marker
        const marker = document.getElementById('niyati-visibility-marker') ||
                      document.createElement('div');
        marker.id = 'niyati-visibility-marker';
        marker.setAttribute('data-visible', String(lastState));
        marker.setAttribute('data-last-check', Date.now());
        marker.style.display = 'none';
        if (!marker.parentNode && document.body) document.body.appendChild(marker);
      }

      document.addEventListener('visibilitychange', checkVisibility);

      // Periodic check as backup
      intervalId = setInterval(checkVisibility, 5000);

      // Start drift detector
      scheduleDriftCheck();

      // ✅ FIX: Cleanup function to remove event listener and clear interval
      window.__niyatiVisibilityCleanup = function() {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        if (driftTimerId) {
          clearTimeout(driftTimerId);
          driftTimerId = null;
        }
        document.removeEventListener('visibilitychange', checkVisibility);
        const marker = document.getElementById('niyati-visibility-marker');
        if (marker && marker.parentNode) marker.parentNode.removeChild(marker);
        window.__niyatiVisibilityMonitor = false;
        console.log('[Niyati] Visibility Monitor Cleaned Up');
      };

      // ✅ FIX: Auto-cleanup on page unload
      window.addEventListener('beforeunload', window.__niyatiVisibilityCleanup);

      console.log('[Niyati] Visibility Monitor Installed (with drift detector)');
      checkVisibility();
    })();
  `;

  try {
    win.webContents.executeJavaScript(code, true);
  } catch (e) {
    console.error('Failed to inject visibility monitor:', e);
  }
}

module.exports = { injectVisibilityMonitor };
