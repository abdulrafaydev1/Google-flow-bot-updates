const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const puppeteer = require('puppeteer-core');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ZeeFlowController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.profileNumber = Math.max(1, parseInt(options.profileNumber, 10) || 1);
    this.debugPort =
      Number(options.debugPort) || 9222 + (this.profileNumber - 1);
    this.isRunning = false;
    this.currentServerNumber = 1;
  }

  /**
   * Emits a timestamped log event compatible with FlowController and the renderer UI.
   */
  log(message, level = 'info') {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const entry = {
      timestamp: timeStr,
      level,
      message,
      formatted: `[${timeStr}] ${message}`
    };
    this.emit('log', entry);
  }

  /**
   * Resolves the popup filename from a parsed Chrome extension manifest object.
   */
  _extractPopupFromManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return 'popup.html';
    const rawPopup =
      (manifest.action && manifest.action.default_popup) ||
      (manifest.browser_action && manifest.browser_action.default_popup) ||
      (manifest.page_action && manifest.page_action.default_popup) ||
      'popup.html';
    return String(rawPopup || 'popup.html').replace(/^\/+/, '');
  }

  /**
   * Checks whether a manifest object or extension metadata matches ZeeFlow.
   */
  _isZeeFlowManifest(manifest, extPath = '') {
    const name = String((manifest && manifest.name) || '');
    const shortName = String((manifest && manifest.short_name) || '');
    const desc = String((manifest && manifest.description) || '');
    const title = String(
      (manifest && manifest.action && manifest.action.default_title) ||
        (manifest && manifest.browser_action && manifest.browser_action.default_title) ||
        ''
    );
    const combined = `${name} ${shortName} ${desc} ${title} ${extPath}`;
    return /zeeflow|zee\s*flow/i.test(combined);
  }

  /**
   * Automatically discovers the installed ZeeFlow extension ID and popup URL
   * inside the persistent Debug Chrome profile using 3 fallbacks:
   *  1. Profile Preferences & Secure Preferences (prioritizing enabled entries)
   *  2. Profile Default/Extensions & Default/UnpackedExtensions directory scan
   *  3. Live CDP browser.targets() inspection
   */
  async findZeeFlowExtension(userDataDir, browser = null) {
    const candidateMap = new Map();

    const registerCandidate = (extensionId, defaultPopup, meta = {}) => {
      if (!extensionId || !/^[a-p]{32}$/i.test(extensionId)) return;
      const id = extensionId.toLowerCase();
      const cleanPopup = String(defaultPopup || 'popup.html').replace(/^\/+/, '');
      const existing = candidateMap.get(id) || {
        extensionId: id,
        defaultPopup: cleanPopup,
        popupUrl: `chrome-extension://${id}/${cleanPopup}`,
        isEnabled: false,
        pathExists: false,
        isLiveTarget: false,
        mtimeMs: 0,
        extPath: ''
      };

      if (defaultPopup) {
        existing.defaultPopup = cleanPopup;
        existing.popupUrl = `chrome-extension://${id}/${cleanPopup}`;
      }
      if (meta.isEnabled) existing.isEnabled = true;
      if (meta.pathExists) existing.pathExists = true;
      if (meta.isLiveTarget) existing.isLiveTarget = true;
      if (meta.mtimeMs && meta.mtimeMs > existing.mtimeMs) existing.mtimeMs = meta.mtimeMs;
      if (meta.extPath) existing.extPath = meta.extPath;

      candidateMap.set(id, existing);
    };

    const defaultProfileDir = userDataDir ? path.join(userDataDir, 'Default') : null;

    // 1. Check Default/Preferences and Default/Secure Preferences
    if (defaultProfileDir && fs.existsSync(defaultProfileDir)) {
      for (const prefFileName of ['Secure Preferences', 'Preferences']) {
        const prefPath = path.join(defaultProfileDir, prefFileName);
        if (!fs.existsSync(prefPath)) continue;

        try {
          const raw = fs.readFileSync(prefPath, 'utf8');
          const prefs = JSON.parse(raw);
          const settings = (prefs && prefs.extensions && prefs.extensions.settings) || {};

          for (const [extId, entry] of Object.entries(settings)) {
            if (!entry || typeof entry !== 'object') continue;

            let manifest = entry.manifest || null;
            let extPath = entry.path || '';
            let resolvedPath = extPath;

            if (extPath && !path.isAbsolute(extPath)) {
              resolvedPath = path.join(defaultProfileDir, 'Extensions', extPath);
            }

            let pathExists = false;
            let mtimeMs = 0;
            if (resolvedPath && fs.existsSync(resolvedPath)) {
              pathExists = true;
              try {
                mtimeMs = fs.statSync(resolvedPath).mtimeMs || 0;
              } catch (_) {
                // Ignore stat error
              }
              const diskManifestPath = path.join(resolvedPath, 'manifest.json');
              if (!manifest && fs.existsSync(diskManifestPath)) {
                try {
                  manifest = JSON.parse(fs.readFileSync(diskManifestPath, 'utf8'));
                } catch (_) {
                  // Ignore invalid manifest JSON
                }
              }
            }

            if (this._isZeeFlowManifest(manifest, resolvedPath)) {
              const disableReasons = Array.isArray(entry.disable_reasons)
                ? entry.disable_reasons
                : [];
              const isEnabled = disableReasons.length === 0 && entry.state !== 0;
              const defaultPopup = this._extractPopupFromManifest(manifest);

              registerCandidate(extId, defaultPopup, {
                isEnabled,
                pathExists,
                mtimeMs,
                extPath: resolvedPath
              });
            }
          }
        } catch (_) {
          // Continue to next discovery source
        }
      }

      // 2. Scan Default/Extensions/<id>/<version>/manifest.json on disk
      const extensionsRoot = path.join(defaultProfileDir, 'Extensions');
      if (fs.existsSync(extensionsRoot)) {
        try {
          const extIds = fs.readdirSync(extensionsRoot);
          for (const extId of extIds) {
            const extIdDir = path.join(extensionsRoot, extId);
            let isDir = false;
            try {
              isDir = fs.statSync(extIdDir).isDirectory();
            } catch (_) {
              isDir = false;
            }
            if (!isDir) continue;

            const versions = fs.readdirSync(extIdDir);
            for (const ver of versions) {
              const verDir = path.join(extIdDir, ver);
              const manifestPath = path.join(verDir, 'manifest.json');
              if (!fs.existsSync(manifestPath)) continue;
              try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                if (this._isZeeFlowManifest(manifest, verDir)) {
                  const stat = fs.statSync(verDir);
                  registerCandidate(extId, this._extractPopupFromManifest(manifest), {
                    pathExists: true,
                    mtimeMs: stat.mtimeMs || 0,
                    extPath: verDir
                  });
                }
              } catch (_) {
                // Ignore malformed manifest
              }
            }
          }
        } catch (_) {
          // Ignore directory scan errors
        }
      }
    }

    // 3. Check live CDP targets in the running Chrome browser
    if (browser && typeof browser.targets === 'function') {
      try {
        const targets = browser.targets();
        for (const target of targets) {
          const tUrl = typeof target.url === 'function' ? target.url() : '';
          const match = tUrl.match(/^chrome-extension:\/\/([a-p]{32})\//i);
          if (!match) continue;
          const liveId = match[1].toLowerCase();

          if (candidateMap.has(liveId)) {
            registerCandidate(liveId, null, { isLiveTarget: true, isEnabled: true });
          } else if (liveId !== 'nmmhkkegccagdldgiimedpiccmgmieda') {
            // Also register live extension targets as fallback candidates in case Preferences hasn't flushed to disk yet
            registerCandidate(liveId, 'popup.html', { isLiveTarget: true, isEnabled: false });
          }
        }
      } catch (_) {
        // Ignore target scan errors
      }
    }

    const candidates = Array.from(candidateMap.values()).sort((a, b) => {
      if (a.isLiveTarget !== b.isLiveTarget) return a.isLiveTarget ? -1 : 1;
      if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1;
      if (a.pathExists !== b.pathExists) return a.pathExists ? -1 : 1;
      return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });

    if (candidates.length === 0) {
      throw new Error(
        'ZeeFlow extension not found in Debug Chrome profile. Please ensure ZeeFlow is installed and enabled.'
      );
    }

    const best = candidates[0];
    return {
      extensionId: best.extensionId,
      popupUrl: best.popupUrl,
      candidates
    };
  }

  /**
   * Automates the ZeeFlow extension popup inside Debug Chrome:
   *  1. Cleans up leftover duplicate Google Flow tabs before starting
   *  2. Opens ZeeFlow popup.html in a tab
   *  3. Clicks Refresh (↻) and waits for "Refreshed Successfully"
   *  4. Opens Server dropdown and selects Server 1 ("Server _ 1 _ Google Flow")
   *  5. Clicks "Load Server Data" and waits for "Server Loaded Successfully"
   *  6. Clicks "Open Flow" and closes all extra/temporary tabs so strictly 1 Flow tab remains
   */
  async runZeeFlowSetup(browser, userDataDir, options = {}) {
    const serverNumber = Number(options.serverNumber) || 1;

    // Pre-cleanup: Close any leftover duplicate flow.google.com / labs.google tabs from prior sessions
    // while keeping 1 blank/base tab alive so the browser window stays open.
    try {
      const initialPages = await browser.pages();
      if (initialPages.length > 0) {
        let basePage = initialPages.find((p) => {
          const u = (p.url() || '').toLowerCase();
          return !u.includes('flow.google.com') && !u.includes('labs.google');
        });

        if (!basePage) {
          basePage = initialPages[0];
          await basePage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        }

        for (const p of initialPages) {
          if (p !== basePage) {
            await p.close().catch(() => {});
          }
        }
      }
    } catch (_) {
      // Ignore pre-cleanup errors
    }

    this.log('🔍 Locating ZeeFlow extension in Debug Chrome profile...');
    const extInfo = await this.findZeeFlowExtension(userDataDir, browser);

    const existingPages = await browser.pages();
    const blankTab = existingPages.find((p) => {
      const u = (p.url() || '').toLowerCase();
      return u === 'about:blank' || u.startsWith('chrome://newtab');
    });
    const extPage = blankTab || (await browser.newPage());
    await extPage.bringToFront().catch(() => {});

    // Navigate to ZeeFlow popup URL (trying candidate IDs in priority order if multiple unpacked IDs exist)
    let loadedCandidate = null;
    const candidatesToTry =
      Array.isArray(extInfo.candidates) && extInfo.candidates.length > 0
        ? extInfo.candidates
        : [{ extensionId: extInfo.extensionId, popupUrl: extInfo.popupUrl }];

    for (const candidate of candidatesToTry) {
      try {
        await extPage.goto(candidate.popupUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 10000
        });

        const isZeeFlowDom = await extPage
          .evaluate(() => {
            return Boolean(
              document.getElementById('dashboard') ||
                document.getElementById('loginCard') ||
                document.getElementById('refreshBtn') ||
                document.getElementById('loadServerBtn') ||
                /zeeflow/i.test(document.title || '') ||
                /backend\s*server|load\s*server\s*data/i.test(
                  (document.body && document.body.innerText) || ''
                )
            );
          })
          .catch(() => false);

        if (isZeeFlowDom) {
          loadedCandidate = candidate;
          break;
        }
      } catch (_) {
        // Try next candidate extension ID if this one was disabled/unloaded
      }
    }

    if (!loadedCandidate) {
      throw new Error(
        `Could not load ZeeFlow extension popup (${extInfo.popupUrl}). Please verify ZeeFlow is enabled in chrome://extensions.`
      );
    }

    this.log(`🧩 Opened ZeeFlow extension (${loadedCandidate.extensionId}). Waiting for dashboard...`);

    // Wait up to 15 seconds for ZeeFlow dashboard (or login/maintenance state) to initialize
    const dashboardStart = Date.now();
    let uiState = { ready: false, loggedOut: false, maintenance: false };

    while (Date.now() - dashboardStart < 15000) {
      uiState = await extPage
        .evaluate(() => {
          const dashboard = document.getElementById('dashboard');
          const loginCard = document.getElementById('loginCard');
          const maintenance = document.getElementById('zeeflowMaintenanceScreen');
          const refreshBtn = document.getElementById('refreshBtn');
          const loadBtn = document.getElementById('loadServerBtn');
          const openFlowBtn = document.getElementById('openFlowBtn');

          const isVisible = (el) => {
            if (!el) return false;
            if (el.hidden || el.classList.contains('hidden')) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return true;
          };

          if (isVisible(maintenance)) {
            return { ready: false, loggedOut: false, maintenance: true };
          }

          if (isVisible(dashboard) && (refreshBtn || loadBtn || openFlowBtn)) {
            return { ready: true, loggedOut: false, maintenance: false };
          }

          const bodyText = (document.body && document.body.innerText) || '';
          if (/backend\s*server/i.test(bodyText) && /load\s*server\s*data/i.test(bodyText)) {
            return { ready: true, loggedOut: false, maintenance: false };
          }

          const loginVisible = isVisible(loginCard) && (!dashboard || dashboard.classList.contains('hidden'));
          return { ready: false, loggedOut: loginVisible, maintenance: false };
        })
        .catch(() => ({ ready: false, loggedOut: false, maintenance: false }));

      if (uiState.ready || uiState.maintenance) break;
      // Allow popup.js up to 4 seconds to restore auth session before concluding user is logged out
      if (uiState.loggedOut && Date.now() - dashboardStart > 4000) break;
      await delay(350);
    }

    if (uiState.maintenance) {
      throw new Error('ZeeFlow extension currently shows "Under Maintenance" screen.');
    }

    if (!uiState.ready) {
      if (uiState.loggedOut) {
        throw new Error(
          'ZeeFlow extension is on the Login screen. Please log into ZeeFlow once in Debug Chrome, then click Launch Chrome again.'
        );
      }
      throw new Error('Timed out waiting for ZeeFlow dashboard controls to become visible.');
    }

    await delay(500);

    // =========================================================================
    // STEP 1: Click Refresh (↻) button next to Backend Server & wait for
    //         "Refreshed Successfully" ("✓ Refreshed Successfully")
    // =========================================================================
    this.log('🔄 ZeeFlow Step 1/4: Clicking Refresh (↻) next to Backend Server...');

    const refreshClicked = await extPage.evaluate(() => {
      const msgEl = document.getElementById('serverMessage');
      if (msgEl) msgEl.textContent = '';

      // Primary selector from ZeeFlow popup.html
      const directBtn =
        document.getElementById('refreshBtn') ||
        document.querySelector('.server-card .refresh-button') ||
        document.querySelector('button[title="Refresh"]');
      if (directBtn) {
        directBtn.click();
        return true;
      }

      // Fallback: find button inside Backend Server header row (excluding Sign Out / Load / Open Flow)
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim();
        const title = (btn.getAttribute('title') || btn.getAttribute('aria-label') || '').trim();
        if (/sign\s*out|load\s*server|open\s*flow|login/i.test(text)) continue;
        if (text.includes('↻') || /refresh/i.test(title)) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!refreshClicked) {
      throw new Error('Could not find the Refresh (↻) button inside ZeeFlow.');
    }

    const refreshTimeoutMs = 25000;
    const refreshStart = Date.now();
    let refreshSucceeded = false;

    while (Date.now() - refreshStart < refreshTimeoutMs) {
      const statusCheck = await extPage
        .evaluate(() => {
          const msgEl = document.getElementById('serverMessage');
          const msgText = (msgEl && (msgEl.innerText || msgEl.textContent) ? msgEl.innerText || msgEl.textContent : '').trim();
          const bodyText = (document.body && document.body.innerText) || '';
          const combined = `${msgText}\n${bodyText}`;
          if (/refreshed\s+successfully/i.test(combined)) {
            return { done: true, message: msgText || '✓ Refreshed Successfully' };
          }
          return { done: false, message: msgText };
        })
        .catch(() => ({ done: false, message: '' }));

      if (statusCheck.done) {
        refreshSucceeded = true;
        this.log(`✅ ZeeFlow: Refreshed Successfully! (${statusCheck.message || '✓ Refreshed Successfully'})`, 'success');
        break;
      }
      await delay(400);
    }

    if (!refreshSucceeded) {
      this.log('⚠️ ZeeFlow Refresh confirmation text did not appear within 25s; proceeding to Server 1 selection...', 'warn');
    }

    await delay(600);

    // =========================================================================
    // STEP 2: Open Server Dropdown & Select Server 1 ("Server _ 1 _ Google Flow")
    // =========================================================================
    this.log(`🔽 ZeeFlow Step 2/4: Selecting Server ${serverNumber} (Server _ ${serverNumber} _ Google Flow)...`);

    // Open the custom dropdown menu if present
    await extPage.evaluate(() => {
      const dropdownBtn =
        document.getElementById('serverDropdownButton') ||
        document.querySelector('.server-dropdown-button');
      if (dropdownBtn) {
        dropdownBtn.click();
      }
    });

    await delay(350);

    const serverSelection = await extPage.evaluate((targetServerNum) => {
      const targetKey = `server${targetServerNum}`;
      const serverRegex = new RegExp(`server\\s*[_\\-\\s]*0?${targetServerNum}\\b`, 'i');
      let chosenLabel = '';

      // 1. Custom dropdown option button: .server-option[data-server="server1"]
      const customOptions = Array.from(
        document.querySelectorAll('#serverDropdownMenu .server-option, .server-dropdown-menu button, .server-option')
      );

      let targetBtn =
        customOptions.find(
          (el) => (el.getAttribute('data-server') || '').toLowerCase() === targetKey
        ) ||
        customOptions.find((el) => {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          return serverRegex.test(t) && /google\s*flow|flow/i.test(t);
        }) ||
        customOptions.find((el) => {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          return serverRegex.test(t);
        });

      if (targetBtn) {
        chosenLabel = (targetBtn.innerText || targetBtn.textContent || '')
          .replace(/✓/g, '')
          .replace(/☷/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        targetBtn.click();
      }

      // 2. Also synchronize hidden or visible native <select id="sessionSelect">
      const selects = Array.from(document.querySelectorAll('select#sessionSelect, select'));
      for (const sel of selects) {
        const opts = Array.from(sel.options || []);
        const matchedOpt =
          opts.find((o) => (o.value || '').toLowerCase() === targetKey) ||
          opts.find((o) => serverRegex.test(o.textContent || '') && /google\s*flow|flow/i.test(o.textContent || '')) ||
          opts.find((o) => serverRegex.test(o.textContent || ''));

        if (matchedOpt) {
          sel.value = matchedOpt.value;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          if (!chosenLabel) {
            chosenLabel = (matchedOpt.textContent || '').replace(/\s+/g, ' ').trim();
          }
        }
      }

      // Verify displayed label in #selectedServerText
      const selectedTextEl = document.getElementById('selectedServerText');
      if (selectedTextEl && targetBtn && !serverRegex.test(selectedTextEl.textContent || '')) {
        selectedTextEl.textContent = chosenLabel || `Server _ ${targetServerNum} _ Google Flow`;
      }

      const finalDisplayed = selectedTextEl
        ? (selectedTextEl.innerText || selectedTextEl.textContent || '').replace(/\s+/g, ' ').trim()
        : chosenLabel;

      return {
        success: Boolean(targetBtn || chosenLabel),
        label: finalDisplayed || chosenLabel || `Server _ ${targetServerNum} _ Google Flow`
      };
    }, serverNumber);

    if (!serverSelection.success) {
      throw new Error(`Could not select Server ${serverNumber} in ZeeFlow dropdown.`);
    }

    this.log(`✅ ZeeFlow: Selected "${serverSelection.label}"`, 'success');
    await delay(500);

    // =========================================================================
    // STEP 3: Click "Load Server Data" & wait for
    //         "Server Loaded Successfully" ("✓ Done, Server Loaded Successfully")
    // =========================================================================
    this.log('📥 ZeeFlow Step 3/4: Clicking "Load Server Data" and waiting for confirmation...');

    const loadClicked = await extPage.evaluate(() => {
      const msgEl = document.getElementById('serverMessage');
      if (msgEl) msgEl.textContent = '';

      const loadBtn =
        document.getElementById('loadServerBtn') ||
        document.querySelector('.load-button');
      if (loadBtn) {
        loadBtn.click();
        return true;
      }

      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const fallback = buttons.find((b) =>
        /load\s*server\s*data/i.test((b.innerText || b.textContent || '').trim())
      );
      if (fallback) {
        fallback.click();
        return true;
      }
      return false;
    });

    if (!loadClicked) {
      throw new Error('Could not find "Load Server Data" button in ZeeFlow.');
    }

    const loadTimeoutMs = 35000;
    const loadStart = Date.now();
    let loadSucceeded = false;

    while (Date.now() - loadStart < loadTimeoutMs) {
      const loadStatus = await extPage
        .evaluate(() => {
          const msgEl = document.getElementById('serverMessage');
          const msgText = (msgEl && (msgEl.innerText || msgEl.textContent) ? msgEl.innerText || msgEl.textContent : '').trim();
          const bodyText = (document.body && document.body.innerText) || '';
          const combined = `${msgText}\n${bodyText}`;

          if (/server\s+loaded\s+successfully|done,\s*server\s+loaded/i.test(combined)) {
            return { done: true, error: null, message: msgText || '✓ Done, Server Loaded Successfully' };
          }
          if (/failed\s+to\s+load|error\s+loading\s+server/i.test(msgText)) {
            return { done: false, error: msgText, message: msgText };
          }
          return { done: false, error: null, message: msgText };
        })
        .catch(() => ({ done: false, error: null, message: '' }));

      if (loadStatus.done) {
        loadSucceeded = true;
        this.log(`✅ ZeeFlow: Done, Server Loaded Successfully! (${loadStatus.message})`, 'success');
        break;
      }

      if (loadStatus.error) {
        throw new Error(`ZeeFlow Load Server Data returned an error: ${loadStatus.error}`);
      }

      await delay(500);
    }

    if (!loadSucceeded) {
      throw new Error('Timed out (35s) waiting for "Server Loaded Successfully" in ZeeFlow.');
    }

    await delay(700);

    // =========================================================================
    // STEP 4: Click "Open Flow" & Enforce Strictly 1 Single Google Flow Tab
    // =========================================================================
    this.log('🚀 ZeeFlow Step 4/4: Clicking "Open Flow" and waiting for Google Flow tab...');

    const openFlowClicked = await extPage.evaluate(() => {
      const openBtn =
        document.getElementById('openFlowBtn') ||
        document.querySelector('.flow-button');
      if (openBtn) {
        openBtn.click();
        return true;
      }

      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const fallback = buttons.find((b) =>
        /open\s*flow/i.test((b.innerText || b.textContent || '').trim())
      );
      if (fallback) {
        fallback.click();
        return true;
      }
      return false;
    });

    if (!openFlowClicked) {
      throw new Error('Could not find "Open Flow" button in ZeeFlow.');
    }

    // Wait up to 25 seconds for a Google Flow tab (flow.google.com or labs.google/fx/tools/flow) to open
    const flowTabStart = Date.now();
    let flowPage = null;

    while (Date.now() - flowTabStart < 25000) {
      const pages = await browser.pages();
      const flowTabs = pages.filter((p) => {
        if (p === extPage) return false;
        const u = (p.url() || '').toLowerCase();
        return u.includes('flow.google.com') || u.includes('labs.google/fx/tools/flow') || u.includes('labs.google');
      });

      if (flowTabs.length > 0) {
        // Pick the newest Google Flow tab
        flowPage = flowTabs[flowTabs.length - 1];
        break;
      }
      await delay(500);
    }

    // Fallback: if Open Flow navigated or hadn't opened a tab yet, open https://flow.google.com/ directly
    if (!flowPage) {
      this.log('⚠️ ZeeFlow "Open Flow" did not spawn a new tab within 25s; opening https://flow.google.com/ directly...', 'warn');
      flowPage = await browser.newPage();
      await flowPage.goto('https://flow.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }).catch(() => {});
    }

    // Wait for the Google Flow tab to settle on flow.google.com / labs.google
    await delay(1200);
    await flowPage.bringToFront().catch(() => {});

    // Close the ZeeFlow extension tab and ANY other extra/blank/duplicate tabs so STRICTLY 1 Google Flow tab remains
    const allPagesAfterOpen = await browser.pages();
    for (const page of allPagesAfterOpen) {
      if (page !== flowPage) {
        await page.close().catch(() => {});
      }
    }

    this.log('✅ Google Flow opened cleanly (strictly 1 tab open).', 'success');
    return flowPage;
  }

  /**
   * Computes a fresh random delay in milliseconds between minSec and maxSec (clamped 0-120s).
   */
  getRandomDelayMs(minSec, maxSec) {
    let min = Number.isFinite(Number(minSec)) ? Math.max(0, Math.min(120, Number(minSec))) : 2;
    let max = Number.isFinite(Number(maxSec)) ? Math.max(0, Math.min(120, Number(maxSec))) : 6;
    if (min > max) [min, max] = [max, min];
    const minMs = Math.round(min * 1000);
    const maxMs = Math.round(max * 1000);
    if (maxMs <= minMs) return minMs;
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }

  /**
   * Inside the single Google Flow tab:
   *  1. Waits for the dashboard/page to load and locates "+ New project" / "New project"
   *  2. Waits a fresh random delay between newProjectDelayMinSec and newProjectDelayMaxSec
   *  3. Clicks "+ New project" and waits for the new project workspace (/project/...) to load
   */
  async createFlowProject(flowPage, options = {}) {
    if (!flowPage || flowPage.isClosed()) {
      throw new Error('Google Flow tab is not available for creating a new project.');
    }

    await flowPage.bringToFront().catch(() => {});
    this.log('⏳ Waiting for Google Flow interface to finish loading...');

    // Wait up to 20 seconds for Google Flow to hydrate (either project list with "New project" or an editor workspace)
    const loadStart = Date.now();
    let foundNewProjectBtn = null;

    const findNewProjectButtonCoords = async () => {
      return await flowPage
        .evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll('button, a, [role="button"]')
          );
          for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 16) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
              continue;
            }
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
            if (/\+?\s*new\s+project/i.test(text) || /\+?\s*new\s+project/i.test(aria) || /^create\s+project$/i.test(text)) {
              return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                text: text || aria || 'New project'
              };
            }
          }
          return null;
        })
        .catch(() => null);
    };

    while (Date.now() - loadStart < 20000) {
      foundNewProjectBtn = await findNewProjectButtonCoords();
      if (foundNewProjectBtn) break;

      // Check if we landed inside an existing project URL (/project/...) instead of the home project list
      const currentUrl = flowPage.url() || '';
      if (/\/project\//i.test(currentUrl) && Date.now() - loadStart > 4000) {
        this.log('↩️ Landed inside an existing project; navigating to Google Flow home list to create a New Project...');
        await flowPage
          .goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 25000 })
          .catch(() => {});
        await delay(1500);
      } else {
        await delay(500);
      }
    }

    if (!foundNewProjectBtn) {
      // One more attempt after ensuring we are on the root dashboard
      await flowPage
        .goto('https://flow.google.com/', { waitUntil: 'domcontentloaded', timeout: 25000 })
        .catch(() => {});
      await delay(2000);
      foundNewProjectBtn = await findNewProjectButtonCoords();
    }

    if (!foundNewProjectBtn) {
      throw new Error('Could not find "+ New project" button on Google Flow dashboard.');
    }

    // Apply configurable random human delay RIGHT BEFORE clicking "New Project"
    let min =
      options.newProjectDelayMinSec !== undefined &&
      options.newProjectDelayMinSec !== null &&
      options.newProjectDelayMinSec !== '' &&
      Number.isFinite(Number(options.newProjectDelayMinSec))
        ? Math.max(0, Math.min(120, Number(options.newProjectDelayMinSec)))
        : 2;
    let max =
      options.newProjectDelayMaxSec !== undefined &&
      options.newProjectDelayMaxSec !== null &&
      options.newProjectDelayMaxSec !== '' &&
      Number.isFinite(Number(options.newProjectDelayMaxSec))
        ? Math.max(0, Math.min(120, Number(options.newProjectDelayMaxSec)))
        : 6;
    if (min > max) [min, max] = [max, min];

    const delayMs = this.getRandomDelayMs(min, max);
    if (delayMs > 0) {
      this.log(
        `⏳ Human delay: Waiting ${(delayMs / 1000).toFixed(2)}s (random range ${min}s–${max}s) before clicking "New Project"...`
      );
      await new Promise((r) => setTimeout(r, delayMs));
      const refreshedBtn = await findNewProjectButtonCoords();
      if (refreshedBtn) {
        foundNewProjectBtn = refreshedBtn;
      }
    }

    const previousUrl = flowPage.url();
    this.log(`➕ Clicking "${foundNewProjectBtn.text}" button at (${foundNewProjectBtn.x}, ${foundNewProjectBtn.y})...`);

    // Click New Project using native mouse event + DOM click fallback
    await flowPage.mouse.move(foundNewProjectBtn.x, foundNewProjectBtn.y, { steps: 6 });
    await delay(120);
    await flowPage.mouse.click(foundNewProjectBtn.x, foundNewProjectBtn.y);

    // Wait up to 20 seconds for the new project workspace URL (/project/<id>) or prompt box to appear
    const projectWaitStart = Date.now();
    let workspaceReady = false;

    while (Date.now() - projectWaitStart < 20000) {
      const currentUrl = flowPage.url() || '';
      const hasWorkspace = await flowPage
        .evaluate((prevUrl) => {
          const urlChangedToProject =
            window.location.href !== prevUrl && /\/project\//i.test(window.location.href);
          const hasPromptBox = Boolean(
            document.querySelector('textarea') ||
              document.querySelector('[contenteditable="true"]') ||
              document.querySelector('[role="textbox"]')
          );
          return urlChangedToProject || (hasPromptBox && /\/project\//i.test(window.location.href));
        }, previousUrl)
        .catch(() => false);

      if (hasWorkspace || (/\/project\//i.test(currentUrl) && currentUrl !== previousUrl)) {
        workspaceReady = true;
        break;
      }

      // If 4 seconds elapsed and URL hasn't changed, trigger DOM .click() on New project button as backup
      if (Date.now() - projectWaitStart > 3500 && Date.now() - projectWaitStart < 4500) {
        await flowPage
          .evaluate(() => {
            const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
            const btn = els.find((el) =>
              /\+?\s*new\s+project/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim())
            );
            if (btn) btn.click();
          })
          .catch(() => {});
      }

      await delay(500);
    }

    if (!workspaceReady) {
      this.log('⚠️ Project URL transition took longer than expected; continuing startup...', 'warn');
    }

    await delay(1200);
    this.log('✅ New Google Flow project created and ready.', 'success');
    return true;
  }

  /**
   * Backwards-compatible alias for createFlowProject.
   */
  async createAndRenameFlowProject(flowPage) {
    return this.createFlowProject(flowPage);
  }

  /**
   * Full end-to-end startup sequence invoked after Debug Chrome launches on port 9222:
   *  1. Connects to Chrome CDP on port 9222
   *  2. Runs ZeeFlow setup (Refresh -> Server 1 -> Load Server Data -> Open Flow -> 1 Tab cleanup)
   *  3. Clicks New Project in Google Flow and waits for the workspace to load
   */
  async runFullStartupSequence(options = {}) {
    if (this.isRunning) {
      this.log('⚠️ ZeeFlow startup sequence is already running.', 'warn');
      return { success: false, error: 'ZeeFlow startup sequence is already running.' };
    }

    const cdpPort =
      Number(options.debugPort) || Number(options.cdpPort) || Number(this.debugPort) || 9222;
    const userDataDir = options.userDataDir;
    const serverNumber = Number(options.serverNumber) || 1;
    const browserURL = `http://127.0.0.1:${cdpPort}`;

    this.isRunning = true;
    let browser = null;

    try {
      this.log(`🔌 Connecting to Debug Chrome (${browserURL}) for automated ZeeFlow + New Project setup...`);
      browser = await puppeteer.connect({
        browserURL,
        defaultViewport: null
      });

      const flowPage = await this.runZeeFlowSetup(browser, userDataDir, { serverNumber });
      this.currentServerNumber = serverNumber;
      await this.createFlowProject(flowPage, {
        newProjectDelayMinSec: options.newProjectDelayMinSec,
        newProjectDelayMaxSec: options.newProjectDelayMaxSec
      });

      return {
        success: true,
        serverNumber: this.currentServerNumber,
        tabUrl: flowPage && !flowPage.isClosed() ? flowPage.url() : null
      };
    } catch (err) {
      this.log(`⚠️ ZeeFlow / Startup Automation Notice: ${err.message}`, 'warn');
      return {
        success: false,
        error: err.message
      };
    } finally {
      this.isRunning = false;
      if (browser) {
        try {
          browser.disconnect();
        } catch (_) {
          // Ignore disconnect errors
        }
      }
    }
  }

  /**
   * Cycles to the next ZeeFlow Google Flow server (1 -> 2 -> 3 -> 1), loads server data,
   * reopens Google Flow (strictly 1 single tab), and restores the active project URL if provided.
   */
  async switchToNextServerAndReopenFlow(options = {}) {
    if (this.isRunning) {
      this.log('⚠️ ZeeFlow automation is already running.', 'warn');
      return { success: false, error: 'ZeeFlow automation is already running.' };
    }

    const cdpPort =
      Number(options.debugPort) || Number(options.cdpPort) || Number(this.debugPort) || 9222;
    const userDataDir = options.userDataDir;
    const targetProjectUrl = String(options.targetProjectUrl || '').trim();
    const current = Number(this.currentServerNumber) || 1;
    const nextServer = (current % 3) + 1;
    const browserURL = `http://127.0.0.1:${cdpPort}`;

    this.isRunning = true;
    let browser = null;

    try {
      this.log(
        `🔄 ZeeFlow Auto-Switch: Switching from Server ${current} to Server ${nextServer}...`,
        'warn'
      );
      browser = await puppeteer.connect({
        browserURL,
        defaultViewport: null
      });

      const flowPage = await this.runZeeFlowSetup(browser, userDataDir, {
        serverNumber: nextServer
      });
      this.currentServerNumber = nextServer;

      if (
        targetProjectUrl &&
        /\/project\//i.test(targetProjectUrl) &&
        flowPage &&
        !flowPage.isClosed()
      ) {
        const openedUrl = flowPage.url() || '';
        if (openedUrl !== targetProjectUrl) {
          this.log(`↩️ Restoring active Google Flow project workspace (${targetProjectUrl})...`);
          await flowPage
            .goto(targetProjectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(() => {});
          await delay(2500);
        }
      } else if (flowPage && !flowPage.isClosed() && !/\/project\//i.test(flowPage.url() || '')) {
        await delay(2000);
      }

      this.log(
        `✅ ZeeFlow Auto-Switch complete: Now active on Server ${nextServer}.`,
        'success'
      );
      return {
        success: true,
        serverNumber: nextServer,
        tabUrl: flowPage && !flowPage.isClosed() ? flowPage.url() : null
      };
    } catch (err) {
      this.log(`⚠️ ZeeFlow Auto-Switch Notice: ${err.message}`, 'warn');
      return {
        success: false,
        serverNumber: current,
        error: err.message
      };
    } finally {
      this.isRunning = false;
      if (browser) {
        try {
          browser.disconnect();
        } catch (_) {
          // Ignore disconnect errors
        }
      }
    }
  }
}

module.exports = { ZeeFlowController };
