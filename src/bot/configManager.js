const fs = require('fs');
const path = require('path');
const os = require('os');

let electronApp = null;
try {
  const electron = require('electron');
  electronApp = electron.app || (electron.remote && electron.remote.app);
} catch (_) {
  electronApp = null;
}

const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'GoogleFlowVideos');

function generateRandomPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function sanitizeRemotePort(rawPort, fallback = 3847) {
  const num = parseInt(rawPort, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1024, Math.min(65535, num));
}

function sanitizeRemotePin(rawPin) {
  const str = String(rawPin === undefined || rawPin === null ? '' : rawPin).trim();
  if (str.length >= 4 && str.length <= 12) {
    return str;
  }
  return generateRandomPin();
}

function sanitizeFlowAgentMode(rawAgentMode) {
  if (rawAgentMode === true) return 'force-on';
  const normalized = String(rawAgentMode || 'off').trim().toLowerCase();
  if (normalized === 'force-on' || normalized === 'on' || normalized === 'true') {
    return 'force-on';
  }
  if (normalized === 'force-off') {
    return 'force-off';
  }
  return 'off';
}

function sanitizeFlowViewMode(rawViewMode) {
  const normalized = String(rawViewMode || 'off').trim().toLowerCase();
  if (normalized === 'grid') return 'grid';
  if (normalized === 'batch') return 'batch';
  return 'off';
}

const DEFAULT_CONFIG = {
  targetUrlKeyword: 'flow.google.com, labs.google',
  flowDefaultUrl: 'https://labs.google/fx/tools/flow',
  cdpPort: 9222,
  promptInputSelector: "textarea, [contenteditable='true'], [role='textbox']",
  generateButtonSelector: "button[aria-label*='Generate'], button[aria-label*='Create'], button[type='submit']",
  videoElementSelector: 'video',
  downloadButtonSelector: "button[aria-label*='Download'], a[download]",
  generationTimeoutSec: 180,
  delayBetweenPromptsSec: 10,
  maxRetries: 2,
  infiniteRefreshOnError: true,
  keystrokeDelayMs: 15,
  videosPerPrompt: 1,
  downloadPath: DEFAULT_DOWNLOAD_DIR,
  autoClickDownloadBtn: true,
  chromeExecutablePath: '',
  newProjectDelayMinSec: 2,
  newProjectDelayMaxSec: 6,
  prePasteDelayMinSec: 2,
  prePasteDelayMaxSec: 6,
  preSubmitDelayMinSec: 1,
  preSubmitDelayMaxSec: 4,
  submitMethod: 'random',
  cardRetryDelayMinSec: 2,
  cardRetryDelayMaxSec: 6,
  cardRetryClicksMin: 5,
  cardRetryClicksMax: 8,
  autoSwitchServerOnFailure: true,
  autoStartAfterLaunch: true,
  flowAgentMode: 'off',
  flowViewMode: 'off',
  remoteControlEnabled: true,
  remoteControlPort: 3847,
  remoteControlPin: generateRandomPin()
};

const VALID_SUBMIT_METHODS = ['random', 'click', 'enter'];

function sanitizeDelayRange(rawMin, rawMax, fallbackMin = 2, fallbackMax = 6) {
  const parseDelay = (val, fallback) => {
    if (val === undefined || val === null || val === '') return fallback;
    const num = Number(val);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.min(120, num));
  };

  let minSec = parseDelay(rawMin, fallbackMin);
  let maxSec = parseDelay(rawMax, fallbackMax);
  if (minSec > maxSec) {
    const tmp = minSec;
    minSec = maxSec;
    maxSec = tmp;
  }
  return { minSec, maxSec };
}

function sanitizeRetryClicksRange(rawMin, rawMax, fallbackMin = 5, fallbackMax = 8) {
  const parseClicks = (val, fallback) => {
    if (val === undefined || val === null || val === '') return fallback;
    const num = parseInt(val, 10);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(1, Math.min(15, num));
  };

  let minClicks = parseClicks(rawMin, fallbackMin);
  let maxClicks = parseClicks(rawMax, fallbackMax);
  if (minClicks > maxClicks) {
    const tmp = minClicks;
    minClicks = maxClicks;
    maxClicks = tmp;
  }
  return { minClicks, maxClicks };
}

function sanitizeSubmitMethod(rawMethod, fallback = 'random') {
  const normalized = String(rawMethod || '').trim().toLowerCase();
  return VALID_SUBMIT_METHODS.includes(normalized) ? normalized : fallback;
}

class ConfigManager {
  constructor() {
    this.storageDir = this._resolveStorageDir();
    this.configFilePath = path.join(this.storageDir, 'flow-bot-config.json');
    this.queueFilePath = path.join(this.storageDir, 'flow-bot-queue.json');
    this.config = { ...DEFAULT_CONFIG };
    this._init();
  }

  _resolveStorageDir() {
    try {
      if (electronApp && typeof electronApp.getPath === 'function') {
        return electronApp.getPath('userData');
      }
    } catch (_) {
      // Fallback if accessed before app ready or outside Electron
    }
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'google-flow-bot');
  }

  _init() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      if (fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
        let needsSave = false;
        if (this.config.targetUrlKeyword === 'labs.google') {
          this.config.targetUrlKeyword = DEFAULT_CONFIG.targetUrlKeyword;
          needsSave = true;
        }
        if (!this.config.generationTimeoutSec || Number(this.config.generationTimeoutSec) < 180) {
          this.config.generationTimeoutSec = 180;
          needsSave = true;
        }
        const newProjPair = sanitizeDelayRange(
          this.config.newProjectDelayMinSec,
          this.config.newProjectDelayMaxSec,
          DEFAULT_CONFIG.newProjectDelayMinSec,
          DEFAULT_CONFIG.newProjectDelayMaxSec
        );
        if (
          this.config.newProjectDelayMinSec !== newProjPair.minSec ||
          this.config.newProjectDelayMaxSec !== newProjPair.maxSec
        ) {
          this.config.newProjectDelayMinSec = newProjPair.minSec;
          this.config.newProjectDelayMaxSec = newProjPair.maxSec;
          needsSave = true;
        }

        const prePastePair = sanitizeDelayRange(
          this.config.prePasteDelayMinSec,
          this.config.prePasteDelayMaxSec,
          DEFAULT_CONFIG.prePasteDelayMinSec,
          DEFAULT_CONFIG.prePasteDelayMaxSec
        );
        if (
          this.config.prePasteDelayMinSec !== prePastePair.minSec ||
          this.config.prePasteDelayMaxSec !== prePastePair.maxSec
        ) {
          this.config.prePasteDelayMinSec = prePastePair.minSec;
          this.config.prePasteDelayMaxSec = prePastePair.maxSec;
          needsSave = true;
        }

        const preSubmitPair = sanitizeDelayRange(
          this.config.preSubmitDelayMinSec,
          this.config.preSubmitDelayMaxSec,
          DEFAULT_CONFIG.preSubmitDelayMinSec,
          DEFAULT_CONFIG.preSubmitDelayMaxSec
        );
        if (
          this.config.preSubmitDelayMinSec !== preSubmitPair.minSec ||
          this.config.preSubmitDelayMaxSec !== preSubmitPair.maxSec
        ) {
          this.config.preSubmitDelayMinSec = preSubmitPair.minSec;
          this.config.preSubmitDelayMaxSec = preSubmitPair.maxSec;
          needsSave = true;
        }

        const cleanSubmitMethod = sanitizeSubmitMethod(
          this.config.submitMethod,
          DEFAULT_CONFIG.submitMethod
        );
        if (this.config.submitMethod !== cleanSubmitMethod) {
          this.config.submitMethod = cleanSubmitMethod;
          needsSave = true;
        }

        const cardRetryDelayPair = sanitizeDelayRange(
          this.config.cardRetryDelayMinSec,
          this.config.cardRetryDelayMaxSec,
          DEFAULT_CONFIG.cardRetryDelayMinSec,
          DEFAULT_CONFIG.cardRetryDelayMaxSec
        );
        if (
          this.config.cardRetryDelayMinSec !== cardRetryDelayPair.minSec ||
          this.config.cardRetryDelayMaxSec !== cardRetryDelayPair.maxSec
        ) {
          this.config.cardRetryDelayMinSec = cardRetryDelayPair.minSec;
          this.config.cardRetryDelayMaxSec = cardRetryDelayPair.maxSec;
          needsSave = true;
        }

        const cardRetryClicksPair = sanitizeRetryClicksRange(
          this.config.cardRetryClicksMin,
          this.config.cardRetryClicksMax,
          DEFAULT_CONFIG.cardRetryClicksMin,
          DEFAULT_CONFIG.cardRetryClicksMax
        );
        if (
          this.config.cardRetryClicksMin !== cardRetryClicksPair.minClicks ||
          this.config.cardRetryClicksMax !== cardRetryClicksPair.maxClicks
        ) {
          this.config.cardRetryClicksMin = cardRetryClicksPair.minClicks;
          this.config.cardRetryClicksMax = cardRetryClicksPair.maxClicks;
          needsSave = true;
        }

        const cleanAutoSwitch =
          this.config.autoSwitchServerOnFailure !== undefined
            ? Boolean(this.config.autoSwitchServerOnFailure)
            : DEFAULT_CONFIG.autoSwitchServerOnFailure;
        if (this.config.autoSwitchServerOnFailure !== cleanAutoSwitch) {
          this.config.autoSwitchServerOnFailure = cleanAutoSwitch;
          needsSave = true;
        }

        const cleanAutoStartAfterLaunch =
          typeof this.config.autoStartAfterLaunch === 'boolean'
            ? this.config.autoStartAfterLaunch
            : DEFAULT_CONFIG.autoStartAfterLaunch;
        if (this.config.autoStartAfterLaunch !== cleanAutoStartAfterLaunch) {
          this.config.autoStartAfterLaunch = cleanAutoStartAfterLaunch;
          needsSave = true;
        }

        const cleanRemoteEnabled =
          this.config.remoteControlEnabled !== undefined
            ? Boolean(this.config.remoteControlEnabled)
            : DEFAULT_CONFIG.remoteControlEnabled;
        if (this.config.remoteControlEnabled !== cleanRemoteEnabled) {
          this.config.remoteControlEnabled = cleanRemoteEnabled;
          needsSave = true;
        }

        const cleanRemotePort = sanitizeRemotePort(
          this.config.remoteControlPort,
          DEFAULT_CONFIG.remoteControlPort
        );
        if (this.config.remoteControlPort !== cleanRemotePort) {
          this.config.remoteControlPort = cleanRemotePort;
          needsSave = true;
        }

        const cleanRemotePin = sanitizeRemotePin(this.config.remoteControlPin);
        if (this.config.remoteControlPin !== cleanRemotePin) {
          this.config.remoteControlPin = cleanRemotePin;
          needsSave = true;
        }

        const cleanFlowAgentMode = sanitizeFlowAgentMode(this.config.flowAgentMode);
        if (this.config.flowAgentMode !== cleanFlowAgentMode) {
          this.config.flowAgentMode = cleanFlowAgentMode;
          needsSave = true;
        }

        const cleanFlowViewMode = sanitizeFlowViewMode(this.config.flowViewMode);
        if (this.config.flowViewMode !== cleanFlowViewMode) {
          this.config.flowViewMode = cleanFlowViewMode;
          needsSave = true;
        }

        if (needsSave) {
          this._saveToDisk();
        }
      } else {
        this._saveToDisk();
      }

      if (!this.config.downloadPath) {
        this.config.downloadPath = DEFAULT_DOWNLOAD_DIR;
      }
      if (!fs.existsSync(this.config.downloadPath)) {
        fs.mkdirSync(this.config.downloadPath, { recursive: true });
      }
    } catch (err) {
      console.error('Failed to initialize ConfigManager:', err);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  _saveToDisk() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write config file:', err);
    }
  }

  getConfig() {
    try {
      if (fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.config = { ...DEFAULT_CONFIG, ...this.config, ...parsed };
        }
      }
    } catch (_) {
      // Ignore transient disk read errors
    }
    return { ...this.config };
  }

  /**
   * Computes the isolated output directory for the given profile slot:
   * - Profile 1: config.downloadPath (exact existing behavior)
   * - Profile N (N >= 2): <config.downloadPath>\Profile-N
   */
  getEffectiveOutputDir(profileNumber = 1, baseDirOverride = null) {
    const slotNum = Math.max(1, parseInt(profileNumber, 10) || 1);
    const baseDir =
      (baseDirOverride && String(baseDirOverride).trim()) ||
      this.config.downloadPath ||
      DEFAULT_DOWNLOAD_DIR;

    let targetDir = baseDir;
    if (slotNum >= 2) {
      const folderSuffix = `Profile-${slotNum}`;
      const baseName = path.basename(path.resolve(baseDir));
      if (baseName.toLowerCase() !== folderSuffix.toLowerCase()) {
        targetDir = path.join(baseDir, folderSuffix);
      }
    }

    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    } catch (_) {
      // Ignore directory creation errors until used
    }
    return targetDir;
  }

  getDefaults() {
    return { ...DEFAULT_CONFIG };
  }

  updateConfig(partialConfig = {}) {
    const sanitized = { ...partialConfig };

    if (sanitized.generationTimeoutSec !== undefined) {
      sanitized.generationTimeoutSec = Math.max(180, Number(sanitized.generationTimeoutSec) || DEFAULT_CONFIG.generationTimeoutSec);
    }
    if (sanitized.delayBetweenPromptsSec !== undefined) {
      sanitized.delayBetweenPromptsSec = Math.max(1, Number(sanitized.delayBetweenPromptsSec) || DEFAULT_CONFIG.delayBetweenPromptsSec);
    }
    if (sanitized.maxRetries !== undefined) {
      sanitized.maxRetries = Math.min(5, Math.max(0, Number(sanitized.maxRetries) ?? DEFAULT_CONFIG.maxRetries));
    }
    if (sanitized.cdpPort !== undefined) {
      sanitized.cdpPort = Number(sanitized.cdpPort) || 9222;
    }
    if (sanitized.keystrokeDelayMs !== undefined) {
      sanitized.keystrokeDelayMs = Math.max(0, Number(sanitized.keystrokeDelayMs) ?? 15);
    }
    if (sanitized.videosPerPrompt !== undefined) {
      sanitized.videosPerPrompt = Math.min(20, Math.max(1, parseInt(sanitized.videosPerPrompt, 10) || 1));
    }
    if (sanitized.infiniteRefreshOnError !== undefined) {
      sanitized.infiniteRefreshOnError = Boolean(sanitized.infiniteRefreshOnError);
    }
    if (
      sanitized.newProjectDelayMinSec !== undefined ||
      sanitized.newProjectDelayMaxSec !== undefined
    ) {
      const nextMin =
        sanitized.newProjectDelayMinSec !== undefined
          ? sanitized.newProjectDelayMinSec
          : this.config.newProjectDelayMinSec;
      const nextMax =
        sanitized.newProjectDelayMaxSec !== undefined
          ? sanitized.newProjectDelayMaxSec
          : this.config.newProjectDelayMaxSec;
      const delayPair = sanitizeDelayRange(
        nextMin,
        nextMax,
        this.config.newProjectDelayMinSec ?? DEFAULT_CONFIG.newProjectDelayMinSec,
        this.config.newProjectDelayMaxSec ?? DEFAULT_CONFIG.newProjectDelayMaxSec
      );
      sanitized.newProjectDelayMinSec = delayPair.minSec;
      sanitized.newProjectDelayMaxSec = delayPair.maxSec;
    }

    if (
      sanitized.prePasteDelayMinSec !== undefined ||
      sanitized.prePasteDelayMaxSec !== undefined
    ) {
      const nextMin =
        sanitized.prePasteDelayMinSec !== undefined
          ? sanitized.prePasteDelayMinSec
          : this.config.prePasteDelayMinSec;
      const nextMax =
        sanitized.prePasteDelayMaxSec !== undefined
          ? sanitized.prePasteDelayMaxSec
          : this.config.prePasteDelayMaxSec;
      const delayPair = sanitizeDelayRange(
        nextMin,
        nextMax,
        this.config.prePasteDelayMinSec ?? DEFAULT_CONFIG.prePasteDelayMinSec,
        this.config.prePasteDelayMaxSec ?? DEFAULT_CONFIG.prePasteDelayMaxSec
      );
      sanitized.prePasteDelayMinSec = delayPair.minSec;
      sanitized.prePasteDelayMaxSec = delayPair.maxSec;
    }

    if (
      sanitized.preSubmitDelayMinSec !== undefined ||
      sanitized.preSubmitDelayMaxSec !== undefined
    ) {
      const nextMin =
        sanitized.preSubmitDelayMinSec !== undefined
          ? sanitized.preSubmitDelayMinSec
          : this.config.preSubmitDelayMinSec;
      const nextMax =
        sanitized.preSubmitDelayMaxSec !== undefined
          ? sanitized.preSubmitDelayMaxSec
          : this.config.preSubmitDelayMaxSec;
      const delayPair = sanitizeDelayRange(
        nextMin,
        nextMax,
        this.config.preSubmitDelayMinSec ?? DEFAULT_CONFIG.preSubmitDelayMinSec,
        this.config.preSubmitDelayMaxSec ?? DEFAULT_CONFIG.preSubmitDelayMaxSec
      );
      sanitized.preSubmitDelayMinSec = delayPair.minSec;
      sanitized.preSubmitDelayMaxSec = delayPair.maxSec;
    }

    if (sanitized.submitMethod !== undefined) {
      sanitized.submitMethod = sanitizeSubmitMethod(
        sanitized.submitMethod,
        this.config.submitMethod || DEFAULT_CONFIG.submitMethod
      );
    }

    if (
      sanitized.cardRetryDelayMinSec !== undefined ||
      sanitized.cardRetryDelayMaxSec !== undefined
    ) {
      const nextMin =
        sanitized.cardRetryDelayMinSec !== undefined
          ? sanitized.cardRetryDelayMinSec
          : this.config.cardRetryDelayMinSec;
      const nextMax =
        sanitized.cardRetryDelayMaxSec !== undefined
          ? sanitized.cardRetryDelayMaxSec
          : this.config.cardRetryDelayMaxSec;
      const delayPair = sanitizeDelayRange(
        nextMin,
        nextMax,
        this.config.cardRetryDelayMinSec ?? DEFAULT_CONFIG.cardRetryDelayMinSec,
        this.config.cardRetryDelayMaxSec ?? DEFAULT_CONFIG.cardRetryDelayMaxSec
      );
      sanitized.cardRetryDelayMinSec = delayPair.minSec;
      sanitized.cardRetryDelayMaxSec = delayPair.maxSec;
    }

    if (
      sanitized.cardRetryClicksMin !== undefined ||
      sanitized.cardRetryClicksMax !== undefined
    ) {
      const nextMin =
        sanitized.cardRetryClicksMin !== undefined
          ? sanitized.cardRetryClicksMin
          : this.config.cardRetryClicksMin;
      const nextMax =
        sanitized.cardRetryClicksMax !== undefined
          ? sanitized.cardRetryClicksMax
          : this.config.cardRetryClicksMax;
      const clicksPair = sanitizeRetryClicksRange(
        nextMin,
        nextMax,
        this.config.cardRetryClicksMin ?? DEFAULT_CONFIG.cardRetryClicksMin,
        this.config.cardRetryClicksMax ?? DEFAULT_CONFIG.cardRetryClicksMax
      );
      sanitized.cardRetryClicksMin = clicksPair.minClicks;
      sanitized.cardRetryClicksMax = clicksPair.maxClicks;
    }

    if (sanitized.autoSwitchServerOnFailure !== undefined) {
      sanitized.autoSwitchServerOnFailure = Boolean(sanitized.autoSwitchServerOnFailure);
    }

    if (sanitized.autoStartAfterLaunch !== undefined) {
      sanitized.autoStartAfterLaunch = Boolean(sanitized.autoStartAfterLaunch);
    }

    if (sanitized.remoteControlEnabled !== undefined) {
      sanitized.remoteControlEnabled = Boolean(sanitized.remoteControlEnabled);
    }

    if (sanitized.remoteControlPort !== undefined) {
      sanitized.remoteControlPort = sanitizeRemotePort(
        sanitized.remoteControlPort,
        this.config.remoteControlPort || DEFAULT_CONFIG.remoteControlPort
      );
    }

    if (sanitized.remoteControlPin !== undefined) {
      sanitized.remoteControlPin = sanitizeRemotePin(sanitized.remoteControlPin);
    }

    if (sanitized.flowAgentMode !== undefined) {
      sanitized.flowAgentMode = sanitizeFlowAgentMode(sanitized.flowAgentMode);
    }

    if (sanitized.flowViewMode !== undefined) {
      sanitized.flowViewMode = sanitizeFlowViewMode(sanitized.flowViewMode);
    }

    this.config = {
      ...this.config,
      ...sanitized
    };

    if (this.config.downloadPath && !fs.existsSync(this.config.downloadPath)) {
      try {
        fs.mkdirSync(this.config.downloadPath, { recursive: true });
      } catch (_) {
        // Ignore directory creation failure until used
      }
    }

    this._saveToDisk();
    return this.getConfig();
  }

  regenerateRemotePin() {
    const newPin = generateRandomPin();
    return this.updateConfig({ remoteControlPin: newPin });
  }

  resetConfig() {
    const currentDownloadPath = this.config.downloadPath || DEFAULT_DOWNLOAD_DIR;
    this.config = {
      ...DEFAULT_CONFIG,
      downloadPath: currentDownloadPath
    };
    this._saveToDisk();
    return this.getConfig();
  }

  _getQueueFilePath(profileNumber = 1) {
    const slotNum = Math.max(1, parseInt(profileNumber, 10) || 1);
    if (slotNum === 1) {
      return this.queueFilePath;
    }
    return path.join(this.storageDir, `flow-bot-queue-profile-${slotNum}.json`);
  }

  getQueue(profileNumber = 1) {
    const targetQueueFile = this._getQueueFilePath(profileNumber);
    try {
      if (fs.existsSync(targetQueueFile)) {
        const raw = fs.readFileSync(targetQueueFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch (err) {
      console.error('Failed to read saved queue:', err);
    }
    return [];
  }

  saveQueue(queue, profileNumber = 1) {
    const targetQueueFile = this._getQueueFilePath(profileNumber);
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      if (Array.isArray(queue)) {
        fs.writeFileSync(targetQueueFile, JSON.stringify(queue, null, 2), 'utf-8');
      }
      return true;
    } catch (err) {
      console.error('Failed to save queue:', err);
      return false;
    }
  }
}

module.exports = new ConfigManager();
