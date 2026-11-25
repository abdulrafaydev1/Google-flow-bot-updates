const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const configManager = require('./configManager');

let electronApp = null;
try {
  const electron = require('electron');
  electronApp = electron.app || (electron.remote && electron.remote.app);
} catch (_) {
  electronApp = null;
}

class ChromeLauncher {
  constructor() {
    this.chromeProcess = null;
  }

  /**
   * Resolves the persistent Chrome user profile directory inside AppData:
   * - Profile 1: <AppData>/FlowBotChromeProfile (exact existing path preserved)
   * - Profile N (N >= 2): <AppData>/FlowBotChromeProfile-profile-N
   */
  getProfileDir(profileNumber = 1) {
    let baseAppData;
    try {
      if (electronApp && typeof electronApp.getPath === 'function') {
        baseAppData = electronApp.getPath('appData');
      }
    } catch (_) {
      baseAppData = null;
    }

    if (!baseAppData) {
      baseAppData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    }

    const baseProfilePath = path.join(baseAppData, 'FlowBotChromeProfile');
    const slotNum = Math.max(1, parseInt(profileNumber, 10) || 1);
    const profilePath =
      slotNum === 1 ? baseProfilePath : `${baseProfilePath}-profile-${slotNum}`;

    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }
    return profilePath;
  }

  /**
   * Returns the Chrome --user-data-dir for the given profile slot number.
   * Profile 1 uses the exact existing <AppData>/FlowBotChromeProfile directory.
   */
  getChromeUserDataDir(profileNumber = 1) {
    return this.getProfileDir(profileNumber);
  }

  /**
   * Checks whether a Chrome profile directory has the ZeeFlow extension configured
   * inside Default/Preferences or Default/Secure Preferences.
   */
  _profileHasZeeFlowConfigured(profileDir) {
    if (!profileDir || !fs.existsSync(profileDir)) return false;
    const defaultDir = path.join(profileDir, 'Default');
    if (!fs.existsSync(defaultDir)) return false;

    for (const prefName of ['Secure Preferences', 'Preferences']) {
      const prefPath = path.join(defaultDir, prefName);
      if (!fs.existsSync(prefPath)) continue;
      try {
        const content = fs.readFileSync(prefPath, 'utf8');
        if (/zeeflow|zee\s*flow/i.test(content)) {
          return true;
        }
      } catch (_) {
        // Ignore read error
      }
    }
    return false;
  }

  /**
   * Resilient recursive file/directory copy that skips heavy caches and active lock files
   * and never throws if an individual file is locked by a running Chrome process.
   */
  _copyResilient(srcPath, destPath) {
    const SKIP_NAMES = new Set([
      'cache',
      'code cache',
      'gpucache',
      'dawncache',
      'grshadercache',
      'shadercache',
      'service worker',
      'crashpad',
      'browsermetrics',
      'safe browsing',
      'singletonlock',
      'singletoncookie',
      'singletonsocket',
      'lock',
      'devtoolsactiveport'
    ]);

    try {
      if (!fs.existsSync(srcPath)) return;
      const baseName = path.basename(srcPath).toLowerCase();
      if (SKIP_NAMES.has(baseName)) return;

      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        const entries = fs.readdirSync(srcPath);
        for (const entry of entries) {
          if (SKIP_NAMES.has(entry.toLowerCase())) continue;
          this._copyResilient(path.join(srcPath, entry), path.join(destPath, entry));
        }
      } else if (stat.isFile()) {
        const parentDir = path.dirname(destPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        try {
          fs.copyFileSync(srcPath, destPath);
        } catch (_) {
          try {
            const buf = fs.readFileSync(srcPath);
            fs.writeFileSync(destPath, buf);
          } catch (__) {
            // Skip file if exclusively locked by OS
          }
        }
      }
    } catch (_) {
      // Ignore individual entry copy errors
    }
  }

  /**
   * Automatically clones Profile 1's installed extensions, extension settings (ZeeFlow auth),
   * cookies, storage, and Windows DPAPI Local State into Profile N (N >= 2) if Profile N
   * has not been seeded with ZeeFlow yet. Never modifies Profile 1.
   */
  seedProfileFromPrimaryIfNeeded(profileNumber, targetUserDataDir, onLog = () => {}) {
    const slotNum = Math.max(1, parseInt(profileNumber, 10) || 1);
    if (slotNum <= 1) return false;

    const primaryDir = this.getChromeUserDataDir(1);
    if (!primaryDir || !fs.existsSync(primaryDir)) return false;

    const primaryDefaultDir = path.join(primaryDir, 'Default');
    if (!fs.existsSync(primaryDefaultDir)) return false;

    const targetDefaultDir = path.join(targetUserDataDir, 'Default');
    const targetPrefsExists =
      fs.existsSync(path.join(targetDefaultDir, 'Preferences')) ||
      fs.existsSync(path.join(targetDefaultDir, 'Secure Preferences'));
    const primaryHasZeeFlow = this._profileHasZeeFlowConfigured(primaryDir);
    const targetHasZeeFlow = this._profileHasZeeFlowConfigured(targetUserDataDir);
    const targetHasLocalExtSettings = fs.existsSync(
      path.join(targetDefaultDir, 'Local Extension Settings')
    );

    const needsSeeding =
      !fs.existsSync(targetUserDataDir) ||
      !targetPrefsExists ||
      (primaryHasZeeFlow && (!targetHasZeeFlow || !targetHasLocalExtSettings));

    if (!needsSeeding) {
      return false;
    }

    onLog(`📋 Cloning Profile 1 extensions & login session into Profile ${slotNum}...`);

    if (!fs.existsSync(targetDefaultDir)) {
      fs.mkdirSync(targetDefaultDir, { recursive: true });
    }

    // 1. Copy root Local State (contains Windows DPAPI master encryption key for Cookies & Login Data)
    this._copyResilient(
      path.join(primaryDir, 'Local State'),
      path.join(targetUserDataDir, 'Local State')
    );

    // 2. Copy extension & session state directories/files inside Default/
    const defaultItemsToClone = [
      'Extensions',
      'UnpackedExtensions',
      'Local Extension Settings',
      'Sync Extension Settings',
      'Managed Extension Settings',
      'IndexedDB',
      'Local Storage',
      'Session Storage',
      'Network',
      'Cookies',
      'Login Data',
      'Login Data For Account',
      'Web Data',
      'Preferences',
      'Secure Preferences',
      'Extension Rules',
      'Extension State',
      'Extension Scripts'
    ];

    for (const itemName of defaultItemsToClone) {
      const srcItem = path.join(primaryDefaultDir, itemName);
      const destItem = path.join(targetDefaultDir, itemName);
      if (fs.existsSync(srcItem)) {
        this._copyResilient(srcItem, destItem);
      }
    }

    onLog(`✅ Profile ${slotNum} ready with ZeeFlow extension & login cloned.`);
    return true;
  }

  /**
   * Detects the local Windows Google Chrome executable path.
   */
  findChromeExecutable() {
    const config = configManager.getConfig();
    if (config.chromeExecutablePath && fs.existsSync(config.chromeExecutablePath)) {
      return config.chromeExecutablePath;
    }

    const candidatePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.PROGRAMFILES
        ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
      process.env['PROGRAMFILES(X86)']
        ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);

    for (const candidate of candidatePaths) {
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch (_) {
        // Continue checking candidates
      }
    }

    return null;
  }

  /**
   * Pings http://127.0.0.1:<port>/json/version to check if Chrome CDP is active.
   */
  pingCDP(port = 9222, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: Number(port) || 9222,
          path: '/json/version',
          timeout: timeoutMs
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return resolve({ active: false, error: `HTTP status ${res.statusCode}` });
          }

          let rawData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            try {
              const info = JSON.parse(rawData);
              resolve({
                active: true,
                browser: info.Browser || 'Google Chrome',
                webSocketDebuggerUrl: info.webSocketDebuggerUrl,
                userAgent: info['User-Agent'] || '',
                info
              });
            } catch (err) {
              resolve({ active: false, error: 'Invalid JSON from CDP /json/version' });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ active: false, error: 'Connection timed out' });
      });

      req.on('error', (err) => {
        resolve({ active: false, error: err.message });
      });
    });
  }

  /**
   * Lists open tabs from http://127.0.0.1:<port>/json/list
   */
  listDebugTabs(port = 9222) {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: Number(port) || 9222,
          path: '/json/list',
          timeout: 2500
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return resolve([]);
          }
          let rawData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            try {
              const list = JSON.parse(rawData);
              resolve(Array.isArray(list) ? list : []);
            } catch (_) {
              resolve([]);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve([]);
      });

      req.on('error', () => {
        resolve([]);
      });
    });
  }

  /**
   * Launches Google Chrome with --remote-debugging-port=<debugPort>, isolated per-profile
   * user-data-dir, and clean stealth flags. Checks /json/version on <debugPort> first.
   */
  async launchDebugChrome(optionsOrOnLog = {}, maybeOnLog = () => {}) {
    let options = {};
    let onLog = maybeOnLog;
    if (typeof optionsOrOnLog === 'function') {
      onLog = optionsOrOnLog;
    } else if (optionsOrOnLog && typeof optionsOrOnLog === 'object') {
      options = optionsOrOnLog;
      if (typeof options.onLog === 'function') {
        onLog = options.onLog;
      }
    }

    const config = configManager.getConfig();
    const profileNumber = Math.max(1, parseInt(options.profileNumber, 10) || 1);
    const defaultPortForProfile = 9222 + (profileNumber - 1);
    const port =
      Number(options.debugPort) ||
      (profileNumber === 1 ? Number(config.cdpPort) || 9222 : defaultPortForProfile);
    const userDataDir = this.getChromeUserDataDir(profileNumber);

    // First check if Chrome debug port for this profile slot is already listening
    const existingPing = await this.pingCDP(port);
    if (existingPing.active) {
      onLog(
        `Chrome Debug Mode (Profile ${profileNumber}) is already active on 127.0.0.1:${port} (${existingPing.browser}).`
      );
      return {
        success: true,
        alreadyRunning: true,
        port,
        debugPort: port,
        profileNumber,
        profileDir: userDataDir,
        userDataDir,
        browser: existingPing.browser
      };
    }

    const chromePath = this.findChromeExecutable();
    if (!chromePath) {
      const errorMsg =
        'Google Chrome executable not found in standard Windows directories. Please verify Chrome is installed.';
      onLog(`ERROR: ${errorMsg}`);
      return {
        success: false,
        port,
        debugPort: port,
        profileNumber,
        userDataDir,
        error: errorMsg
      };
    }

    // Seed Profile 2+ from Profile 1 (extensions, ZeeFlow login, cookies, Local State) if needed
    if (profileNumber >= 2) {
      this.seedProfileFromPrimaryIfNeeded(profileNumber, userDataDir, onLog);
    }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--disable-blink-features=AutomationControlled',
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ];

    onLog(`Launching Chrome (Profile ${profileNumber}, Port ${port}) from: ${chromePath}`);
    onLog(`Using profile directory: ${userDataDir}`);

    try {
      this.chromeProcess = spawn(chromePath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });

      this.chromeProcess.unref();
    } catch (spawnErr) {
      const errorMsg = `Failed to spawn Chrome process: ${spawnErr.message}`;
      onLog(`ERROR: ${errorMsg}`);
      return {
        success: false,
        port,
        debugPort: port,
        profileNumber,
        userDataDir,
        error: errorMsg
      };
    }

    // Poll until debugPort responds (up to 15 seconds)
    const maxAttempts = 30;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      const status = await this.pingCDP(port);
      if (status.active) {
        onLog(
          `Chrome (Profile ${profileNumber}) started and listening on 127.0.0.1:${port} (${status.browser}).`
        );
        return {
          success: true,
          alreadyRunning: false,
          port,
          debugPort: port,
          profileNumber,
          chromePath,
          profileDir: userDataDir,
          userDataDir,
          browser: status.browser
        };
      }
    }

    const timeoutMsg = `Chrome process launched, but port ${port} did not respond within 15 seconds. Ensure no conflicting Chrome instance locks ${userDataDir}.`;
    onLog(`WARNING: ${timeoutMsg}`);
    return {
      success: false,
      port,
      debugPort: port,
      profileNumber,
      userDataDir,
      error: timeoutMsg
    };
  }

  /**
   * Alias for launchDebugChrome().
   */
  async launchChrome(optionsOrOnLog = {}, maybeOnLog = () => {}) {
    return this.launchDebugChrome(optionsOrOnLog, maybeOnLog);
  }
}

module.exports = new ChromeLauncher();
