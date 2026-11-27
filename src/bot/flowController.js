const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const EventEmitter = require('events');
const puppeteer = require('puppeteer-core');
const chromeLauncher = require('./chromeLauncher');
const configManager = require('./configManager');

const BOT_STATES = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED'
};

const PROMPT_STATUS = {
  PENDING: 'Pending',
  GENERATING: 'Generating',
  COMPLETED: 'Completed',
  FAILED: 'Failed'
};

class FlowController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.profileNumber = Math.max(1, parseInt(options.profileNumber, 10) || 1);
    this.debugPort =
      Number(options.debugPort) || 9222 + (this.profileNumber - 1);
    this.browser = null;
    this.page = null;
    this.cdpSession = null;
    this.state = BOT_STATES.IDLE;
    this.queue = configManager.getQueue(this.profileNumber) || [];
    this.completedPromptIds = new Set(
      this.queue.filter((item) => item && item.status === PROMPT_STATUS.COMPLETED).map((item) => item.id)
    );
    this.currentPromptIndex = -1;
    this.isProcessingLoopActive = false;
    this.pausePromiseResolve = null;
    this.abortCurrentWait = null;
    this.capturedVideoUrls = new Set();
    this.capturedNetworkVideos = [];
    this.previouslyCapturedNetworkUrls = new Set();
    this.downloadedHashes = new Set();
    this.downloadedNormalizedUrls = new Set();
    this.serverSwitchHandler = null;
    this.unusualActivityStreak = 0;
    this.config = configManager.getConfig();
    this._boundResponseListener = this._onPageResponse.bind(this);
  }

  /**
   * Updates the live configuration snapshot on this controller instance immediately when Settings are saved.
   */
  updateConfig(newConfig = {}) {
    this.config = {
      ...(this.config || {}),
      ...configManager.getConfig(),
      ...(newConfig || {})
    };
    return this.config;
  }

  _getLiveConfig() {
    this.config = {
      ...(this.config || {}),
      ...configManager.getConfig()
    };
    return this.config;
  }

  /**
   * Returns the dynamic Chrome Remote Debugging Port for this window/profile instance.
   */
  getDebugPort() {
    if (this.profileNumber === 1 && !this.debugPort) {
      return Number(configManager.getConfig().cdpPort) || 9222;
    }
    return Number(this.debugPort) || 9222 + (this.profileNumber - 1);
  }

  /**
   * Resolves the effective output directory for this profile instance
   * (<outputDir> for Profile 1; <outputDir>\Profile-N for Profile 2+).
   */
  getEffectiveOutputDir(baseDirOverride = null) {
    return configManager.getEffectiveOutputDir(this.profileNumber, baseDirOverride);
  }

  /**
   * Registers the ZeeFlow server-switch handler callback from main.js for Stage 3 recovery.
   */
  setServerSwitchHandler(handlerFn) {
    this.serverSwitchHandler = typeof handlerFn === 'function' ? handlerFn : null;
  }

  /**
   * Normalizes an https:// video URL by stripping volatile signed/auth query strings
   * while preserving identifying path/query parts for secondary URL deduplication.
   */
  normalizeVideoUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const parsed = new URL(raw);
        const volatileParams = [
          'expires',
          'signature',
          'googleaccessid',
          'x-goog-algorithm',
          'x-goog-credential',
          'x-goog-date',
          'x-goog-expires',
          'x-goog-signedheaders',
          'x-goog-signature',
          'token',
          'authuser',
          'policy',
          'key-pair-id'
        ];
        for (const key of Array.from(parsed.searchParams.keys())) {
          if (volatileParams.includes(key.toLowerCase())) {
            parsed.searchParams.delete(key);
          }
        }
        const remainingQuery = parsed.searchParams.toString();
        return remainingQuery
          ? `${parsed.origin}${parsed.pathname}?${remainingQuery}`
          : `${parsed.origin}${parsed.pathname}`;
      } catch (_) {
        return raw.split('?')[0];
      }
    }
    return raw;
  }

  /**
   * Strict binary container validator: verifies that a downloaded file is a real playable
   * MP4/MOV (`ftyp` within first 32 bytes AND `moov` atom present) or WebM/Matroska
   * (0x1A 0x45 0xDF 0xA3), rejecting HTML/XML/JSON error pages, truncated streams, or tiny files.
   */
  validatePlayableVideoFile(filePath) {
    if (!fs.existsSync(filePath)) return { valid: false, reason: 'File does not exist' };
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < 50000) {
      return { valid: false, reason: `File too small (${stats.size} bytes)` };
    }

    const buf = fs.readFileSync(filePath);
    const headAscii = buf.subarray(0, 64).toString('latin1').trim().toLowerCase();

    // Reject HTML / XML / JSON / plain text responses
    if (
      headAscii.startsWith('<!doc') ||
      headAscii.startsWith('<html') ||
      headAscii.startsWith('<?xml') ||
      headAscii.startsWith('{') ||
      headAscii.startsWith('[')
    ) {
      return { valid: false, reason: 'Downloaded file is HTML/JSON text, not a video' };
    }

    // Check for valid MP4 / MOV container (`ftyp` box within first 32 bytes AND `moov` atom present anywhere in file)
    const hasFtyp = buf.subarray(0, 32).includes(Buffer.from('ftyp'));
    const hasMoov = buf.includes(Buffer.from('moov'));
    if (hasFtyp && hasMoov) {
      return { valid: true, format: 'mp4', size: stats.size };
    }
    if (hasFtyp && !hasMoov) {
      return { valid: false, reason: 'Truncated/partial MP4 stream (missing moov atom)' };
    }

    // Check for valid WebM / Matroska header (0x1A 0x45 0xDF 0xA3)
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return { valid: true, format: 'webm', size: stats.size };
    }

    return {
      valid: false,
      reason: `Unrecognized binary header: ${buf.subarray(0, 16).toString('hex')}`
    };
  }

  /**
   * Scans existing playable .mp4 / .webm files inside outputDir and loads their SHA-256 hashes
   * into this.downloadedHashes for strict session + folder duplicate protection.
   */
  scanExistingOutputHashes(outputDir) {
    if (!outputDir || !fs.existsSync(outputDir)) return 0;

    let hashedCount = 0;
    let skippedInvalid = 0;
    try {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        const lower = file.toLowerCase();
        if (!lower.endsWith('.mp4') && !lower.endsWith('.webm')) continue;
        const fullPath = path.join(outputDir, file);
        try {
          const check = this.validatePlayableVideoFile(fullPath);
          if (!check.valid) {
            skippedInvalid++;
            continue;
          }
          const fileBuffer = fs.readFileSync(fullPath);
          const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          this.downloadedHashes.add(fileHash);
          hashedCount++;
        } catch (_) {
          // Skip unreadable files
        }
      }
      const skipNote = skippedInvalid > 0 ? ` (skipped ${skippedInvalid} invalid/non-video file(s))` : '';
      this.log(
        `Indexed ${hashedCount} existing playable video file(s) in output folder${skipNote} (SHA-256 duplicate guard active).`
      );
    } catch (err) {
      this.log(`Warning scanning existing output hashes: ${err.message}`, 'warn');
    }
    return hashedCount;
  }

  /**
   * Emits a timestamped log message to the renderer process.
   */
  log(message, level = 'info') {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${hh}:${mm}:${ss}`;
    const entry = {
      timestamp,
      level,
      message,
      formatted: `[${timestamp}] ${message}`
    };
    this.emit('log', entry);
  }

  /**
   * Updates internal state and notifies listeners.
   */
  _setState(newState) {
    this.state = newState;
    this.emit('state-change', {
      state: this.state,
      connected: this.isConnected(),
      tabUrl: this.getConnectedTabUrl()
    });
  }

  /**
   * Checks whether Puppeteer is currently attached to an active page.
   */
  isConnected() {
    try {
      return Boolean(
        this.browser &&
          this.browser.connected &&
          this.page &&
          !this.page.isClosed()
      );
    } catch (_) {
      return false;
    }
  }

  getConnectedTabUrl() {
    try {
      if (this.isConnected()) {
        return this.page.url();
      }
    } catch (_) {
      // Ignore
    }
    return null;
  }

  /**
   * Returns full current status snapshot for the UI.
   */
  getStatusSnapshot() {
    const completedCount = this.queue.filter((item) => item.status === PROMPT_STATUS.COMPLETED).length;
    const failedCount = this.queue.filter((item) => item.status === PROMPT_STATUS.FAILED).length;
    return {
      state: this.state,
      connected: this.isConnected(),
      tabUrl: this.getConnectedTabUrl(),
      queue: this.queue,
      totalPrompts: this.queue.length,
      completedPrompts: completedCount,
      failedPrompts: failedCount,
      currentPromptIndex: this.currentPromptIndex
    };
  }

  /**
   * Connects to an existing Chrome instance on this profile's debugPort and locks onto the Google Flow tab.
   */
  async connectToChrome() {
    const config = configManager.getConfig();
    const port = this.getDebugPort();
    const rawKeywords = (config.targetUrlKeyword || 'flow.google.com, labs.google')
      .toLowerCase()
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const keywords = Array.from(new Set([...rawKeywords, 'flow.google.com', 'labs.google']));
    const browserURL = `http://127.0.0.1:${port}`;

    this.log(`Checking Chrome DevTools Protocol endpoint at ${browserURL}/json/version...`);
    const ping = await chromeLauncher.pingCDP(port);

    if (!ping.active) {
      const errMsg = `Debug Chrome is not running on port ${port}. Click "Launch Chrome" first, then click "Connect".`;
      this.log(errMsg, 'error');
      this.emit('connection-change', { connected: false, error: errMsg });
      return { success: false, error: errMsg };
    }

    try {
      if (this.browser) {
        try {
          this.browser.disconnect();
        } catch (_) {
          // Ignore disconnect errors
        }
      }

      this.log(`Connecting via puppeteer-core to ${browserURL}...`);
      this.browser = await puppeteer.connect({
        browserURL,
        defaultViewport: null
      });

      this.browser.on('disconnected', () => {
        this.log('Disconnected from Chrome browser session.', 'warn');
        this.page = null;
        this.cdpSession = null;
        if (this.state === BOT_STATES.RUNNING || this.state === BOT_STATES.PAUSED) {
          this._setState(BOT_STATES.STOPPED);
        }
        this.emit('connection-change', { connected: false, tabUrl: null });
      });

      const pages = await this.browser.pages();
      this.log(`Scanning ${pages.length} open browser tab(s) for Google Flow...`);

      // Priority tab matching: active project URL -> flow.google.com -> labs.google/fx/tools/flow -> configured keywords
      const priorityMatchers = [
        'flow.google.com/project/',
        'flow.google.com',
        'labs.google/fx/tools/flow',
        ...keywords
      ];

      let matchedPage = null;
      for (const matcher of priorityMatchers) {
        const hit = pages.find((candidatePage) =>
          (candidatePage.url() || '').toLowerCase().includes(matcher)
        );
        if (hit) {
          matchedPage = hit;
          break;
        }
      }

      // Secondary check: check page title if URL didn't match directly
      if (!matchedPage) {
        for (const candidatePage of pages) {
          try {
            const title = (await candidatePage.title()).toLowerCase();
            if (title.includes('flow') || keywords.some((kw) => title.includes(kw))) {
              matchedPage = candidatePage;
              break;
            }
          } catch (_) {
            // Ignore
          }
        }
      }

      // If still no matching tab, check if there's a blank tab we can navigate or open a new tab to Google Flow
      if (!matchedPage) {
        const defaultFlowUrl =
          config.flowDefaultUrl && config.flowDefaultUrl !== 'https://labs.google/fx/tools/flow'
            ? config.flowDefaultUrl
            : 'https://flow.google.com/';
        this.log(
          `No open Google Flow tab found. Opening ${defaultFlowUrl} in Chrome...`,
          'warn'
        );
        const blankPage = pages.find((p) => {
          const u = p.url();
          return u === 'about:blank' || u.startsWith('chrome://newtab');
        });
        matchedPage = blankPage || (await this.browser.newPage());
        await matchedPage.goto(defaultFlowUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
          this.log(`Navigation notice: ${err.message}`, 'warn');
        });
      }

      this.page = matchedPage;
      await this.page.bringToFront();

      // Attach response listener for video network capture
      this.page.off('response', this._boundResponseListener);
      this.page.on('response', this._boundResponseListener);

      // Configure CDP download behavior using this profile's isolated effective output directory
      await this._configureDownloadBehavior(this.getEffectiveOutputDir(config.downloadPath));

      // Checkpoint 1: Ensure "Flow agent" toggle is OFF and View mode is set to Grid right after attaching to Google Flow
      await this.ensureFlowAgentOff(this.page).catch(() => {});
      await this.ensureGridViewMode(this.page, { forceCheck: true }).catch(() => {});

      const finalUrl = this.page.url();
      const finalTitle = await this.page.title().catch(() => 'Google Flow');
      this.log(`Connected to Google Flow tab: "${finalTitle}" (${finalUrl})`, 'success');

      this.emit('connection-change', {
        connected: true,
        tabUrl: finalUrl,
        tabTitle: finalTitle,
        browserVersion: ping.browser
      });

      return {
        success: true,
        tabUrl: finalUrl,
        tabTitle: finalTitle,
        browserVersion: ping.browser
      };
    } catch (err) {
      const errMsg = `Failed to connect to Chrome: ${err.message}`;
      this.log(errMsg, 'error');
      this.emit('connection-change', { connected: false, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Configures CDP Page.setDownloadBehavior / Browser.setDownloadBehavior to save files to downloadPath.
   */
  async _configureDownloadBehavior(downloadPath) {
    if (!this.page || !downloadPath) return;

    try {
      if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
      }
      if (this.cdpSession) {
        try {
          await this.cdpSession.detach();
        } catch (_) {
          // Ignore
        }
      }
      const resolvedDir = path.resolve(downloadPath);
      this.cdpSession = await this.page.target().createCDPSession();
      await this.cdpSession
        .send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: resolvedDir,
          eventsEnabled: true
        })
        .catch(() => {});
      await this.cdpSession
        .send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: resolvedDir
        })
        .catch(() => {});
      this.log(`Configured CDP auto-download directory: ${resolvedDir}`);
    } catch (err) {
      this.log(`CDP setDownloadBehavior warning: ${err.message}`, 'warn');
    }
  }

  /**
   * Captures network responses that carry video/mp4 streams or URLs.
   */
  _onPageResponse(response) {
    try {
      const status = response.status();
      if (status < 200 || status >= 300) return;

      const url = response.url();
      if (!url || url.startsWith('data:')) return;

      const headers = response.headers() || {};
      const contentType = (headers['content-type'] || '').toLowerCase();
      const contentLength = Number(headers['content-length'] || 0);

      // Strictly reject HTML / JSON / script / text responses so login/error pages are never captured
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/json') ||
        contentType.includes('text/plain') ||
        contentType.includes('javascript')
      ) {
        return;
      }

      // Exclude tiny icon/UI assets
      if (contentLength > 0 && contentLength < 10000 && !contentType.includes('video/')) {
        return;
      }

      const isVideoStream =
        contentType.includes('video/') ||
        /\.mp4(\?|$)|mime=video/i.test(url) ||
        (contentType.includes('application/octet-stream') &&
          (url.includes('video') ||
            (contentLength > 150000 &&
              (url.includes('googleusercontent.com') || url.includes('storage.googleapis.com')))));

      if (isVideoStream) {
        this.capturedNetworkVideos.push({
          url,
          timestamp: Date.now(),
          contentType
        });
        if (this.capturedNetworkVideos.length > 50) {
          this.capturedNetworkVideos.shift();
        }
        if (!this.previouslyCapturedNetworkUrls.has(url)) {
          this.capturedVideoUrls.add(url);
        }
      }
    } catch (_) {
      // Ignore response inspection errors
    }
  }

  // ===========================================================================
  // QUEUE MANAGEMENT
  // ===========================================================================

  getQueue() {
    return this.queue;
  }

  addPrompts(promptStrings = []) {
    const validLines = promptStrings
      .map((line) => String(line).trim())
      .filter((line) => line.length > 0);

    if (validLines.length === 0) {
      return this.queue;
    }

    const defaultVpp = Math.max(1, parseInt(configManager.getConfig().videosPerPrompt || 1, 10));
    const timestamp = Date.now();
    validLines.forEach((text, idx) => {
      this.queue.push({
        id: `prompt_${timestamp}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
        text,
        status: PROMPT_STATUS.PENDING,
        retries: 0,
        videosPerPrompt: defaultVpp,
        videosCompleted: 0,
        currentVariation: 0,
        outputFile: null,
        outputFiles: [],
        error: null,
        addedAt: new Date().toISOString()
      });
    });

    this._persistAndEmitQueue();
    this.log(`Added ${validLines.length} prompt(s) to the queue (${defaultVpp} video(s) per prompt). Total in queue: ${this.queue.length}`);
    return this.queue;
  }

  updatePendingVideosPerPrompt(newCount) {
    const vpp = Math.min(20, Math.max(1, parseInt(newCount, 10) || 1));
    this.queue.forEach((item) => {
      if (item.status === PROMPT_STATUS.PENDING) {
        item.videosPerPrompt = vpp;
      }
    });
    this._persistAndEmitQueue();
    return this.queue;
  }

  removePrompt(id) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index === -1) return this.queue;

    const removed = this.queue[index];
    if (removed.status === PROMPT_STATUS.GENERATING && this.state === BOT_STATES.RUNNING) {
      this.log('Cannot delete a prompt while it is actively generating. Pause or stop first.', 'warn');
      return this.queue;
    }

    this.completedPromptIds.delete(id);
    this.queue.splice(index, 1);
    this._persistAndEmitQueue();
    this.log(`Removed prompt from queue: "${removed.text.slice(0, 50)}..."`);
    return this.queue;
  }

  retryPrompt(id) {
    const item = this.queue.find((p) => p.id === id);
    if (!item) return this.queue;

    this.completedPromptIds.delete(id);
    item.status = PROMPT_STATUS.PENDING;
    item.statusText = null;
    item.error = null;
    item.retries = 0;
    item.retryCount = 0;
    item.videosCompleted = 0;
    item.currentVariation = 0;
    item.videosPerPrompt = Math.max(1, parseInt(configManager.getConfig().videosPerPrompt || item.videosPerPrompt || 1, 10));
    this._persistAndEmitQueue(item);
    this.log(`Reset prompt status to Pending: "${item.text.slice(0, 50)}..."`);
    return this.queue;
  }

  clearQueue(onlyCompleted = false) {
    if (this.state === BOT_STATES.RUNNING) {
      this.log('Cannot clear the queue while bot is running. Stop the bot first.', 'warn');
      return this.queue;
    }

    if (onlyCompleted) {
      this.queue = this.queue.filter((item) => item.status !== PROMPT_STATUS.COMPLETED);
      this.completedPromptIds.clear();
      this.log('Cleared completed prompts from the queue.');
    } else {
      this.queue = [];
      this.completedPromptIds.clear();
      this.log('Cleared all prompts from the queue.');
    }

    this._persistAndEmitQueue();
    return this.queue;
  }

  resetAllFailedToPending() {
    let count = 0;
    const defaultVpp = Math.max(1, parseInt(configManager.getConfig().videosPerPrompt || 1, 10));
    this.queue.forEach((item) => {
      if (item.status === PROMPT_STATUS.FAILED || item.status === PROMPT_STATUS.GENERATING) {
        this.completedPromptIds.delete(item.id);
        item.status = PROMPT_STATUS.PENDING;
        item.statusText = null;
        item.error = null;
        item.retries = 0;
        item.retryCount = 0;
        item.videosCompleted = 0;
        item.currentVariation = 0;
        item.videosPerPrompt = defaultVpp;
        count++;
      }
    });
    if (count > 0) {
      this._persistAndEmitQueue();
      this.log(`Reset ${count} failed/interrupted prompt(s) back to Pending.`);
    }
    return this.queue;
  }

  _persistAndEmitQueue(changedItem = null) {
    configManager.saveQueue(this.queue, this.profileNumber);
    const snapshot = this.getStatusSnapshot();
    this.emit('queue-update', snapshot);
    this.emit('queue-updated', snapshot);
    if (changedItem) {
      this.emit('item-status-changed', {
        id: changedItem.id,
        status: changedItem.status,
        statusText: changedItem.statusText || null,
        videosCompleted: changedItem.videosCompleted || 0,
        videosPerPrompt: changedItem.videosPerPrompt || 1,
        outputFile: changedItem.outputFile || null
      });
    }
  }

  // ===========================================================================
  // BOT CONTROLS: START, PAUSE, RESUME, STOP
  // ===========================================================================

  async startQueue() {
    if (this.state === BOT_STATES.RUNNING) {
      this.log('Queue engine is already running.', 'warn');
      return { success: false, error: 'Already running' };
    }

    if (this.state === BOT_STATES.PAUSED) {
      return this.resumeQueue();
    }

    if (!this.isConnected()) {
      const connectResult = await this.connectToChrome();
      if (!connectResult.success) {
        return connectResult;
      }
    }

    // Reset any stuck 'Generating' prompts from a prior interrupted run back to 'Pending'
    this.queue.forEach((item) => {
      if (item.status === PROMPT_STATUS.GENERATING) {
        item.status = PROMPT_STATUS.PENDING;
      }
    });

    const pendingCount = this.queue.filter((item) => item.status === PROMPT_STATUS.PENDING).length;
    if (pendingCount === 0) {
      const msg = 'No Pending prompts in the queue to process.';
      this.log(msg, 'warn');
      return { success: false, error: msg };
    }

    // Index existing .mp4 files in this profile's effective output folder for SHA-256 duplicate protection
    const liveCfg = configManager.getConfig();
    this.scanExistingOutputHashes(this.getEffectiveOutputDir(liveCfg.downloadPath));

    this._setState(BOT_STATES.RUNNING);
    this.log(`Starting automation queue (${pendingCount} pending prompt(s))...`, 'success');

    if (!this.isProcessingLoopActive) {
      this._runQueueLoop();
    }

    return { success: true };
  }

  pauseQueue() {
    if (this.state !== BOT_STATES.RUNNING) {
      return { success: false, error: 'Bot is not currently running.' };
    }

    this._setState(BOT_STATES.PAUSED);
    this.log('Queue paused. Will hold after the current step completes...', 'warn');
    return { success: true };
  }

  resumeQueue() {
    if (this.state !== BOT_STATES.PAUSED) {
      return { success: false, error: 'Bot is not paused.' };
    }

    this._setState(BOT_STATES.RUNNING);
    this.log('Queue resumed.', 'success');

    if (this.pausePromiseResolve) {
      const resolve = this.pausePromiseResolve;
      this.pausePromiseResolve = null;
      resolve();
    }

    if (!this.isProcessingLoopActive) {
      this._runQueueLoop();
    }

    return { success: true };
  }

  stopQueue() {
    if (this.state === BOT_STATES.IDLE || this.state === BOT_STATES.STOPPED) {
      this._setState(BOT_STATES.STOPPED);
      return { success: true };
    }

    this._setState(BOT_STATES.STOPPED);
    this.log('Stopping automation queue...', 'warn');

    if (this.pausePromiseResolve) {
      const resolve = this.pausePromiseResolve;
      this.pausePromiseResolve = null;
      resolve();
    }

    if (this.abortCurrentWait) {
      this.abortCurrentWait();
      this.abortCurrentWait = null;
    }

    // Revert any currently generating prompt back to Pending so it can be re-run later
    this.queue.forEach((item) => {
      if (item.status === PROMPT_STATUS.GENERATING) {
        item.status = PROMPT_STATUS.PENDING;
      }
    });
    this._persistAndEmitQueue();

    return { success: true };
  }

  /**
   * Helper that pauses execution while state === PAUSED, or throws/returns false if STOPPED.
   */
  async _waitIfPausedOrStopped() {
    if (this.state === BOT_STATES.STOPPED) {
      return false;
    }
    while (this.state === BOT_STATES.PAUSED) {
      await new Promise((resolve) => {
        this.pausePromiseResolve = resolve;
      });
      if (this.state === BOT_STATES.STOPPED) {
        return false;
      }
    }
    return this.state === BOT_STATES.RUNNING;
  }

  /**
   * Interruptible sleep helper (resolves early if stopped).
   */
  async _interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.abortCurrentWait = null;
        resolve();
      }, ms);

      this.abortCurrentWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Computes a fresh random delay in milliseconds between minSec and maxSec (clamped 0-120s).
   */
  getRandomDelayMs(minSec, maxSec, defaultMin = 2, defaultMax = 6) {
    const parseVal = (v, fb) =>
      v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))
        ? Math.max(0, Math.min(120, Number(v)))
        : fb;
    let min = parseVal(minSec, defaultMin);
    let max = parseVal(maxSec, defaultMax);
    if (min > max) [min, max] = [max, min];
    const minMs = Math.round(min * 1000);
    const maxMs = Math.round(max * 1000);
    if (maxMs <= minMs) return minMs;
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }

  /**
   * Sleeps in small 250ms increments while checking for Stop or Pause so the UI responds immediately.
   */
  async sleepInterruptible(ms) {
    const totalMs = Math.max(0, Math.round(Number(ms) || 0));
    let remaining = totalMs;
    while (remaining > 0) {
      if (this.state === BOT_STATES.STOPPED) return false;
      const canProceed = await this._waitIfPausedOrStopped();
      if (!canProceed || this.state === BOT_STATES.STOPPED) return false;
      const step = Math.min(250, remaining);
      await this._interruptibleSleep(step);
      remaining -= step;
    }
    if (this.state === BOT_STATES.STOPPED) return false;
    const canProceed = await this._waitIfPausedOrStopped();
    return Boolean(canProceed && this.state !== BOT_STATES.STOPPED);
  }

  /**
   * Moves the mouse smoothly to (x, y) and performs a single human-like click.
   */
  async humanMoveAndClick(x, y) {
    await this.page.mouse.move(x, y, { steps: 8 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 80 + Math.floor(Math.random() * 60)));
    await this.page.mouse.click(x, y, { delay: 55 + Math.floor(Math.random() * 35) });
  }

  /**
   * Inspects Google Flow's bottom composer bar to detect if "Flow agent" mode is active
   * and locates the exact Flow agent pill toggle switch coordinates.
   */
  async _detectFlowAgentState(page = this.page) {
    const targetPage = page || this.page;
    if (!targetPage || !this.isConnected()) {
      return { isOn: false, hasAgentErrorBanner: false, toggleFound: false };
    }

    return targetPage
      .evaluate(() => {
        const queryAllDeep = (root, selector) => {
          const matched = [];
          try {
            root.querySelectorAll(selector).forEach((el) => matched.push(el));
          } catch (_) {}
          let all = [];
          try {
            all = root.querySelectorAll('*');
          } catch (_) {}
          for (const node of all) {
            if (node.shadowRoot) {
              matched.push(...queryAllDeep(node.shadowRoot, selector));
            }
          }
          return matched;
        };

        for (const old of queryAllDeep(document, '[data-bot-flow-agent-toggle]')) {
          old.removeAttribute('data-bot-flow-agent-toggle');
        }

        const isVisible = (el) => {
          if (!el) return false;
          try {
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              parseFloat(style.opacity || '1') <= 0.05
            ) {
              return false;
            }
            const r = el.getBoundingClientRect();
            return r.width > 8 && r.height > 8;
          } catch (_) {
            return false;
          }
        };

        const getAttrsText = (el) => {
          if (!el) return '';
          return [
            el.getAttribute('aria-label') || '',
            el.getAttribute('title') || '',
            el.getAttribute('data-tooltip') || '',
            el.getAttribute('mattooltip') || '',
            el.getAttribute('placeholder') || '',
            el.getAttribute('data-placeholder') || ''
          ]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        };

        // 1. Locate the bottom prompt composer input and its enclosing composer bar container
        const allInputs = queryAllDeep(
          document,
          "textarea, [contenteditable='true'], [role='textbox'], input[type='text']"
        ).filter((el) => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 140 && r.height > 14 && r.top > window.innerHeight * 0.45;
        });

        allInputs.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
        const promptInput = allInputs[0] || null;

        let composerContainer = promptInput ? promptInput.parentElement : null;
        for (let i = 0; i < 8 && composerContainer && composerContainer !== document.body; i++) {
          const btns = queryAllDeep(
            composerContainer,
            'button, [role="switch"], [role="button"]'
          ).filter(isVisible);
          const r = composerContainer.getBoundingClientRect();
          if (btns.length >= 2 && r.width > 240 && r.height >= 48 && r.height <= 320) {
            break;
          }
          composerContainer = composerContainer.parentElement;
        }

        const composerRect = composerContainer
          ? composerContainer.getBoundingClientRect()
          : {
              left: 0,
              top: window.innerHeight * 0.55,
              right: window.innerWidth,
              bottom: window.innerHeight,
              width: window.innerWidth,
              height: window.innerHeight * 0.45
            };

        // 2. Check Signal B: Composer placeholder "What's next?" or bottom composer Flow agent error banner
        let isWhatsNextPlaceholder = false;
        for (const inp of allInputs) {
          const attrs = getAttrsText(inp).toLowerCase();
          const txt = (inp.innerText || inp.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (/what['’]s next\??/i.test(attrs) || /^what['’]s next\??$/i.test(txt)) {
            isWhatsNextPlaceholder = true;
            break;
          }
        }

        if (!isWhatsNextPlaceholder && composerContainer) {
          const placeholderNodes = queryAllDeep(
            composerContainer,
            '[placeholder], [data-placeholder], span, div, p, label'
          ).filter(isVisible);
          for (const node of placeholderNodes) {
            if (node.children.length > 2) continue;
            const pText = (
              (node.innerText || node.textContent || '') +
              ' ' +
              getAttrsText(node)
            )
              .replace(/\s+/g, ' ')
              .trim();
            if (/^what['’]s next\??$/i.test(pText) || /what['’]s next\?/i.test(pText)) {
              isWhatsNextPlaceholder = true;
              break;
            }
          }
        }

        // Check for the bottom composer Flow agent error banner ("Something went wrong. Please try again." + "Try again")
        let hasAgentErrorBanner = false;
        const bottomNodes = queryAllDeep(document, 'div, span, p, section').filter((el) => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return (
            r.top >= Math.max(window.innerHeight * 0.5, composerRect.top - 130) &&
            r.bottom <= window.innerHeight + 20 &&
            r.height <= 130 &&
            r.width >= 200
          );
        });

        for (const node of bottomNodes) {
          const txt = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            /something went wrong\.?\s*please try again/i.test(txt) &&
            (isWhatsNextPlaceholder || /\btry again\b/i.test(txt))
          ) {
            hasAgentErrorBanner = true;
            break;
          }
        }

        // 3. Locate the Flow agent toggle control and check Signal A
        const bottomControls = queryAllDeep(
          document,
          'button, [role="switch"], [role="button"], input[type="checkbox"]'
        ).filter((el) => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.top > window.innerHeight * 0.5 && r.width >= 20 && r.height >= 16;
        });

        let toggleEl = null;
        let explicitTurnOffLabel = false;
        let explicitTurnOnLabel = false;

        // Priority 1: Control explicitly mentioning "Flow agent" in aria-label / title / tooltip
        for (const ctrl of bottomControls) {
          const combined = (
            getAttrsText(ctrl) +
            ' ' +
            (ctrl.innerText || ctrl.textContent || '')
          )
            .replace(/\s+/g, ' ')
            .trim();
          if (/turn off flow agent/i.test(combined)) {
            toggleEl = ctrl;
            explicitTurnOffLabel = true;
            break;
          }
          if (/turn on flow agent/i.test(combined)) {
            toggleEl = ctrl;
            explicitTurnOnLabel = true;
            break;
          }
          if (/flow\s*agent/i.test(combined)) {
            toggleEl = ctrl;
          }
        }

        // Also check any visible tooltip overlay currently in the DOM saying "Turn off Flow agent"
        if (!explicitTurnOffLabel) {
          const tooltips = queryAllDeep(
            document,
            '[role="tooltip"], .mat-mdc-tooltip, .cdk-overlay-pane, [class*="tooltip" i]'
          ).filter(isVisible);
          for (const tip of tooltips) {
            const tipTxt = (tip.innerText || tip.textContent || '').replace(/\s+/g, ' ').trim();
            if (/turn off flow agent/i.test(tipTxt)) {
              explicitTurnOffLabel = true;
              break;
            }
          }
        }

        // Priority 2: [role="switch"] inside the bottom composer bar
        if (!toggleEl) {
          const roleSwitches = bottomControls.filter(
            (el) =>
              (el.getAttribute('role') || '').toLowerCase() === 'switch' ||
              el.tagName === 'INPUT'
          );
          if (roleSwitches.length > 0) {
            roleSwitches.sort(
              (a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left
            );
            toggleEl = roleSwitches[0];
          }
        }

        // Priority 3: Pill switch located between the settings gear (⚙️) and Send (→) button in the bottom-right composer toolbar
        if (!toggleEl) {
          const toolbarControls = bottomControls.filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.top >= composerRect.top - 10 &&
              r.bottom <= composerRect.bottom + 15 &&
              r.left >= composerRect.left + composerRect.width * 0.45 &&
              r.width <= 110 &&
              r.height <= 56
            );
          });

          toolbarControls.sort(
            (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
          );

          // Look for a pill-shaped button (width > height * 1.18) that is NOT the rightmost Send arrow button
          // and NOT a resolution/duration chip (720p, 1080p, 8s, 5s, Video, x1, x2)
          for (let i = 0; i < toolbarControls.length; i++) {
            const ctrl = toolbarControls[i];
            const r = ctrl.getBoundingClientRect();
            const txt = (ctrl.innerText || ctrl.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const attrs = getAttrsText(ctrl).toLowerCase();
            const combined = `${attrs} ${txt}`;

            if (
              /720p|1080p|\b8s\b|\b5s\b|\bvideo\b|\bimage\b|arrow_forward|arrow_upward|\bsend\b|\bgenerate\b|\bcreate\b|\bsubmit\b|settings|tune|clear|close|add|attach/i.test(
                combined
              )
            ) {
              continue;
            }

            const isRightmost = i === toolbarControls.length - 1 && toolbarControls.length >= 2;
            if (isRightmost && Math.abs(r.width - r.height) <= 10) {
              // Rightmost square/circle button is Send (→)
              continue;
            }

            const isPillShape = r.width >= 36 && r.width <= 96 && r.width > r.height * 1.18;
            const hasSparkleOrThumb =
              /auto_awesome|spark|magic|agent|✦|✧/i.test(combined) ||
              ctrl.querySelectorAll('div, span, svg').length >= 1;

            if (isPillShape && hasSparkleOrThumb) {
              toggleEl = ctrl;
              break;
            }
          }
        }

        // Inspect toggleEl state (aria-checked, aria-pressed, data-state, or thumb circle on right half of pill track)
        let toggleSwitchChecked = false;
        let toggleCoords = null;

        if (toggleEl) {
          const tRect = toggleEl.getBoundingClientRect();
          toggleEl.setAttribute('data-bot-flow-agent-toggle', 'true');
          toggleCoords = {
            x: Math.round(tRect.left + tRect.width / 2),
            y: Math.round(tRect.top + tRect.height / 2),
            width: Math.round(tRect.width),
            height: Math.round(tRect.height)
          };

          const ariaChecked = (toggleEl.getAttribute('aria-checked') || '').toLowerCase();
          const ariaPressed = (toggleEl.getAttribute('aria-pressed') || '').toLowerCase();
          const dataState = (toggleEl.getAttribute('data-state') || '').toLowerCase();

          if (
            ariaChecked === 'true' ||
            ariaPressed === 'true' ||
            dataState === 'checked' ||
            dataState === 'on' ||
            toggleEl.checked === true
          ) {
            toggleSwitchChecked = true;
          } else if (
            ariaChecked === 'false' ||
            ariaPressed === 'false' ||
            dataState === 'unchecked' ||
            dataState === 'off'
          ) {
            toggleSwitchChecked = false;
          } else if (!explicitTurnOnLabel) {
            // Geometric thumb-position check: see if the inner circular thumb is on the right half of the pill track
            const trackCenterX = tRect.left + tRect.width / 2;
            const children = queryAllDeep(toggleEl, 'div, span').filter((c) => {
              if (!isVisible(c)) return false;
              const cr = c.getBoundingClientRect();
              return (
                cr.width >= 12 &&
                cr.height >= 12 &&
                cr.width <= tRect.width * 0.72 &&
                Math.abs(cr.width - cr.height) <= 10
              );
            });

            for (const thumb of children) {
              const cr = thumb.getBoundingClientRect();
              const thumbCenterX = cr.left + cr.width / 2;
              if (thumbCenterX > trackCenterX + 2.5) {
                toggleSwitchChecked = true;
                break;
              }
            }
          }
        }

        const isOn =
          explicitTurnOffLabel ||
          toggleSwitchChecked ||
          isWhatsNextPlaceholder ||
          (hasAgentErrorBanner && !explicitTurnOnLabel);

        const reasons = [];
        if (explicitTurnOffLabel) reasons.push('label="Turn off Flow agent"');
        if (toggleSwitchChecked) reasons.push('switch=ON');
        if (isWhatsNextPlaceholder) reasons.push('placeholder="What\'s next?"');
        if (hasAgentErrorBanner) reasons.push('agentErrorBanner="Something went wrong"');

        return {
          isOn,
          reason: reasons.join(', ') || 'OFF',
          hasAgentErrorBanner,
          isWhatsNextPlaceholder,
          toggleFound: Boolean(toggleCoords),
          ...(toggleCoords || {})
        };
      })
      .catch(() => ({
        isOn: false,
        hasAgentErrorBanner: false,
        toggleFound: false
      }));
  }

  /**
   * Bidirectional Google Flow Agent Mode synchronizer ('off' default, 'force-off', or 'force-on' based on Settings -> flowAgentMode).
   * - When flowAgentMode is 'off' (default): immediately returns false without touching the DOM or Flow agent toggle.
   * - When flowAgentMode is 'force-off': turns Flow agent OFF if detected ON.
   * - When flowAgentMode is 'force-on': turns Flow agent ON if detected OFF.
   * Returns true if the toggle was clicked to change state; returns false if disabled or already in the desired state.
   */
  async syncFlowAgentMode(page = this.page) {
    const liveCfg = this._getLiveConfig();
    const rawMode =
      liveCfg && liveCfg.flowAgentMode !== undefined
        ? liveCfg.flowAgentMode
        : this.config?.flowAgentMode;
    const agentMode =
      rawMode === true || rawMode === 'on' || rawMode === 'force-on'
        ? 'force-on'
        : rawMode === 'force-off'
          ? 'force-off'
          : 'off';

    if (agentMode === 'off') {
      return false;
    }

    const targetPage = page || this.page;
    if (!targetPage || !this.isConnected()) return false;

    const initialState = await this._detectFlowAgentState(targetPage);
    if (!initialState) return false;

    const clickToggleOnce = async (stateSnap, useDomFallback = false) => {
      if (
        !useDomFallback &&
        stateSnap &&
        stateSnap.toggleFound &&
        Number.isFinite(stateSnap.x) &&
        Number.isFinite(stateSnap.y)
      ) {
        await this.humanMoveAndClick(stateSnap.x, stateSnap.y);
        return true;
      }

      return targetPage
        .evaluate(() => {
          const el = document.querySelector('[data-bot-flow-agent-toggle="true"]');
          if (el && typeof el.click === 'function') {
            el.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
    };

    const cleanupToggleAttr = async () => {
      await targetPage
        .evaluate(() => {
          document
            .querySelectorAll('[data-bot-flow-agent-toggle]')
            .forEach((el) => el.removeAttribute('data-bot-flow-agent-toggle'));
        })
        .catch(() => {});
    };

    if (agentMode === 'force-off') {
      // Desired: Force OFF (Standard Video Mode)
      if (!initialState.isOn) {
        await cleanupToggleAttr();
        return false;
      }

      this.log(
        `⚠️ Flow agent mode detected ON (${initialState.reason}) while Settings is Force OFF — turning OFF Flow agent...`,
        'warn'
      );

      await clickToggleOnce(initialState, false);
      await this._interruptibleSleep(800);
      await targetPage.mouse.move(20, 20, { steps: 3 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));

      let afterState = await this._detectFlowAgentState(targetPage);
      if (afterState && afterState.isOn) {
        await clickToggleOnce(afterState, true);
        await this._interruptibleSleep(800);
        await targetPage.mouse.move(20, 20, { steps: 3 }).catch(() => {});
        afterState = await this._detectFlowAgentState(targetPage);
      }

      await cleanupToggleAttr();

      if (!afterState || !afterState.isOn) {
        this.log('✅ Google Flow Agent Mode (Force OFF) — turned Flow agent OFF.', 'success');
      } else {
        this.log(
          `⚠️ Flow agent toggle clicked to turn OFF, but state check still reported (${afterState.reason}). Proceeding...`,
          'warn'
        );
      }
      return true;
    }

    // Desired: Force ON (Flow Agent Mode)
    const isCurrentlyOn = Boolean(
      (initialState.isOn && !initialState.hasAgentErrorBanner) ||
        initialState.isWhatsNextPlaceholder
    );
    if (isCurrentlyOn) {
      await cleanupToggleAttr();
      return false;
    }

    this.log(
      '🔄 Google Flow Agent Mode is set to Force ON in Settings — enabling Flow agent (✦) toggle...',
      'info'
    );

    await clickToggleOnce(initialState, false);
    await this._interruptibleSleep(800);
    await targetPage.mouse.move(20, 20, { steps: 3 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));

    let afterOnState = await this._detectFlowAgentState(targetPage);
    const confirmedOn = Boolean(
      afterOnState && (afterOnState.isOn || afterOnState.isWhatsNextPlaceholder)
    );
    if (!confirmedOn) {
      await clickToggleOnce(afterOnState || initialState, true);
      await this._interruptibleSleep(800);
      await targetPage.mouse.move(20, 20, { steps: 3 }).catch(() => {});
    }

    await cleanupToggleAttr();
    this.log('✅ Google Flow Agent Mode (Force ON) — turned Flow agent ON.', 'success');
    return true;
  }

  /**
   * Backwards-compatible alias that enforces the configured Google Flow Agent Mode ('off' default, 'force-off', or 'force-on').
   */
  async ensureFlowAgentOff(page = this.page) {
    const liveCfg = this._getLiveConfig();
    const rawMode =
      liveCfg && liveCfg.flowAgentMode !== undefined
        ? liveCfg.flowAgentMode
        : this.config?.flowAgentMode;
    const agentMode =
      rawMode === true || rawMode === 'on' || rawMode === 'force-on'
        ? 'force-on'
        : rawMode === 'force-off'
          ? 'force-off'
          : 'off';

    if (agentMode === 'off') {
      return false;
    }
    return this.syncFlowAgentMode(page);
  }

  /**
   * Detects the current workspace view mode in Google Flow:
   * - 'batch' if Batch list rows are visible ("Created on DD Mon YYYY" metadata or wide horizontal rows with left thumbnail + right text)
   * - 'grid' if Grid cards are visible without Batch row metadata
   * - 'unknown' if the project workspace currently has 0 cards
   */
  async detectCurrentViewMode(page = this.page) {
    const targetPage = page || this.page;
    if (!targetPage || !this.isConnected()) return 'unknown';

    return targetPage
      .evaluate(() => {
        const queryAllDeep = (root, selector) => {
          const matched = [];
          try {
            root.querySelectorAll(selector).forEach((el) => matched.push(el));
          } catch (_) {}
          let all = [];
          try {
            all = root.querySelectorAll('*');
          } catch (_) {}
          for (const node of all) {
            if (node.shadowRoot) {
              matched.push(...queryAllDeep(node.shadowRoot, selector));
            }
          }
          return matched;
        };

        const isVisible = (el) => {
          if (!el) return false;
          try {
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              parseFloat(style.opacity || '1') <= 0.05
            ) {
              return false;
            }
            const r = el.getBoundingClientRect();
            return r.width > 10 && r.height > 10;
          } catch (_) {
            return false;
          }
        };

        const workspaceMinTop = 70;
        const workspaceMaxBottom = window.innerHeight - 65;

        // Signal A for Batch view: "Created on 24 Nov 2026 • 720p • 8s" beside each horizontal row
        const createdOnRegex =
          /\bCreated on\s+(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/i;

        const textNodes = queryAllDeep(document, 'div, span, p, time, small');
        for (const el of textNodes) {
          if (!isVisible(el)) continue;
          if (el.children.length > 3) continue;
          const r = el.getBoundingClientRect();
          if (r.top < workspaceMinTop || r.bottom > workspaceMaxBottom) continue;
          const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt.length >= 12 && txt.length <= 160 && createdOnRegex.test(txt)) {
            return 'batch';
          }
        }

        // Signal B for Batch view: Horizontal row card (width > window.innerWidth * 0.56) containing a small left-aligned
        // thumbnail (width < 280 && height < 200) with full prompt description text rendered to its right
        const rowContainers = queryAllDeep(document, 'div, article, section, li');
        for (const row of rowContainers) {
          if (!isVisible(row)) continue;
          const r = row.getBoundingClientRect();
          if (
            r.top < workspaceMinTop ||
            r.bottom > workspaceMaxBottom ||
            r.width <= window.innerWidth * 0.56 ||
            r.height < 68 ||
            r.height > 260
          ) {
            continue;
          }

          const medias = queryAllDeep(row, 'img, video').filter((m) => {
            if (!isVisible(m)) return false;
            const mr = m.getBoundingClientRect();
            return (
              mr.width >= 55 &&
              mr.width < 280 &&
              mr.height >= 45 &&
              mr.height < 200 &&
              mr.left >= r.left - 5 &&
              mr.left <= r.left + 260
            );
          });

          if (medias.length !== 1) continue;
          const thumbRect = medias[0].getBoundingClientRect();

          const rightTextBlocks = queryAllDeep(row, 'div, span, p').filter((t) => {
            if (!isVisible(t) || t.children.length > 2) return false;
            const tr = t.getBoundingClientRect();
            if (tr.left <= thumbRect.right + 10 || tr.width < 120) return false;
            const content = (t.innerText || t.textContent || '').replace(/\s+/g, ' ').trim();
            return content.length >= 20;
          });

          if (rightTextBlocks.length > 0) {
            return 'batch';
          }
        }

        // Check if Grid cards exist on the canvas
        const gridMedia = queryAllDeep(document, 'img, video').filter((m) => {
          if (!isVisible(m)) return false;
          const mr = m.getBoundingClientRect();
          return (
            mr.top >= workspaceMinTop &&
            mr.bottom <= workspaceMaxBottom &&
            mr.width >= 130 &&
            mr.width <= window.innerWidth * 0.55 &&
            mr.height >= 80
          );
        });
        if (gridMedia.length > 0) {
          return 'grid';
        }

        return 'unknown';
      })
      .catch(() => 'unknown');
  }

  /**
   * Returns true if Google Flow is currently in Batch list view.
   */
  async detectBatchViewMode(page = this.page) {
    const mode = await this.detectCurrentViewMode(page);
    return mode === 'batch';
  }

  /**
   * Bidirectional Google Flow View Mode synchronizer ('grid' or 'batch', or disabled when 'off').
   * When flowViewMode === 'off' (default), immediately returns false without touching the DOM or navbar Settings.
   * When 'grid' or 'batch', opens Google Flow's top navbar Settings (⚙️) popover, clicks either "Grid" or "Batch"
   * under View mode, and closes the Settings popover cleanly.
   */
  async syncFlowViewMode(page = this.page, { forceCheck = false } = {}) {
    const liveCfg = this._getLiveConfig();
    const targetView = String(
      liveCfg?.flowViewMode || this.config?.flowViewMode || 'off'
    ).toLowerCase();
    if (targetView !== 'grid' && targetView !== 'batch') {
      return false;
    }

    const targetPage = page || this.page;
    if (!targetPage || !this.isConnected()) return false;

    const currentView = await this.detectCurrentViewMode(targetPage);

    if (currentView === targetView && !forceCheck) {
      return false;
    }

    if (!forceCheck && currentView === 'unknown') {
      return false;
    }

    this.log(
      `🔄 Ensuring Google Flow View mode is set to ${targetView.toUpperCase()} via top navbar Settings...`
    );

    // Helper to check if the "View mode" Settings popover is currently open and locate the target ("Grid" or "Batch") button
    const inspectViewModePopover = async (desiredMode) => {
      return targetPage
        .evaluate((modeWanted) => {
          const queryAllDeep = (root, selector) => {
            const matched = [];
            try {
              root.querySelectorAll(selector).forEach((el) => matched.push(el));
            } catch (_) {}
            let all = [];
            try {
              all = root.querySelectorAll('*');
            } catch (_) {}
            for (const node of all) {
              if (node.shadowRoot) {
                matched.push(...queryAllDeep(node.shadowRoot, selector));
              }
            }
            return matched;
          };

          for (const old of queryAllDeep(document, '[data-bot-grid-mode-btn]')) {
            old.removeAttribute('data-bot-grid-mode-btn');
          }

          const isVisible = (el) => {
            if (!el) return false;
            try {
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                parseFloat(style.opacity || '1') <= 0.05
              ) {
                return false;
              }
              const r = el.getBoundingClientRect();
              return r.width > 8 && r.height > 8;
            } catch (_) {
              return false;
            }
          };

          // Find any visible popover / menu container containing "View mode"
          const containers = queryAllDeep(
            document,
            '[role="dialog"], [role="menu"], .cdk-overlay-pane, [data-radix-popper-content-wrapper], div, section'
          ).filter((el) => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 140 || r.width > 540 || r.height < 60 || r.height > 620) return false;
            if (r.top < 25 || r.top > 260) return false;
            const txt = el.innerText || el.textContent || '';
            return /view\s*mode/i.test(txt) && /\bgrid\b/i.test(txt) && /\bbatch\b/i.test(txt);
          });

          if (containers.length === 0) {
            return { open: false, targetFound: false };
          }

          containers.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return ra.width * ra.height - rb.width * rb.height;
          });
          const popover = containers[0];

          const isWantBatch = modeWanted === 'batch';
          const exactRegex = isWantBatch ? /^batch$/i : /^grid$/i;
          const tailRegex = isWantBatch ? /\bbatch$/i : /\bgrid$/i;

          const clickables = queryAllDeep(
            popover,
            'button, [role="button"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"]'
          ).filter(isVisible);

          let targetBtn = null;
          for (const btn of clickables) {
            const rawTxt = (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim();
            const aria = (btn.getAttribute('aria-label') || '').trim();
            if (
              !/grid\s*size/i.test(rawTxt) &&
              !/grid\s*size/i.test(aria) &&
              (exactRegex.test(rawTxt) || tailRegex.test(rawTxt) || exactRegex.test(aria))
            ) {
              targetBtn = btn;
              break;
            }
          }

          if (!targetBtn) {
            const textLeaves = queryAllDeep(popover, 'span, div, label').filter((el) => {
              if (!isVisible(el) || el.children.length > 1) return false;
              const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
              return exactRegex.test(t);
            });
            if (textLeaves.length > 0) {
              let curr = textLeaves[0];
              for (let d = 0; d < 4 && curr && curr !== popover; d++) {
                const tag = (curr.tagName || '').toUpperCase();
                const role = (curr.getAttribute('role') || '').toLowerCase();
                if (
                  tag === 'BUTTON' ||
                  role === 'button' ||
                  role === 'radio' ||
                  role === 'tab'
                ) {
                  targetBtn = curr;
                  break;
                }
                curr = curr.parentElement;
              }
              if (!targetBtn) targetBtn = textLeaves[0];
            }
          }

          if (!targetBtn) {
            return { open: true, targetFound: false };
          }

          targetBtn.setAttribute('data-bot-grid-mode-btn', 'true');
          const gr = targetBtn.getBoundingClientRect();
          return {
            open: true,
            targetFound: true,
            x: Math.round(gr.left + gr.width / 2),
            y: Math.round(gr.top + gr.height / 2)
          };
        }, desiredMode)
        .catch(() => ({ open: false, targetFound: false }));
    };

    // 1. Locate the Top Navbar Settings (⚙️) button (strictly in top navbar rect.top >= 0 && rect.bottom <= 95)
    let popoverState = await inspectViewModePopover(targetView);

    if (!popoverState.open) {
      const navSettingsBtn = await targetPage
        .evaluate(() => {
          const queryAllDeep = (root, selector) => {
            const matched = [];
            try {
              root.querySelectorAll(selector).forEach((el) => matched.push(el));
            } catch (_) {}
            let all = [];
            try {
              all = root.querySelectorAll('*');
            } catch (_) {}
            for (const node of all) {
              if (node.shadowRoot) {
                matched.push(...queryAllDeep(node.shadowRoot, selector));
              }
            }
            return matched;
          };

          for (const old of queryAllDeep(document, '[data-bot-navbar-settings]')) {
            old.removeAttribute('data-bot-navbar-settings');
          }

          const isVisible = (el) => {
            if (!el) return false;
            try {
              if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                parseFloat(style.opacity || '1') <= 0.05
              ) {
                return false;
              }
              const r = el.getBoundingClientRect();
              return (
                r.top >= 0 &&
                r.bottom <= 95 &&
                r.width >= 20 &&
                r.width <= 64 &&
                r.height >= 20 &&
                r.height <= 64
              );
            } catch (_) {
              return false;
            }
          };

          const navBtns = queryAllDeep(document, 'button, [role="button"]').filter(isVisible);
          if (navBtns.length === 0) return { found: false };

          const getBtnMeta = (btn) => {
            const attrs = [
              btn.getAttribute('aria-label') || '',
              btn.getAttribute('title') || '',
              btn.getAttribute('data-tooltip') || '',
              btn.getAttribute('mattooltip') || ''
            ]
              .join(' ')
              .toLowerCase();
            const txt = (btn.innerText || btn.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
            const iconTxt = Array.from(
              btn.querySelectorAll('i, span, mat-icon, google-symbols, svg')
            )
              .map(
                (n) =>
                  (n.textContent || '') +
                  ' ' +
                  (n.getAttribute('data-icon') || '') +
                  ' ' +
                  (n.getAttribute('aria-label') || '')
              )
              .join(' ')
              .toLowerCase();
            return { attrs, txt, iconTxt, combined: `${attrs} ${txt} ${iconTxt}` };
          };

          let chosen = null;

          // Priority 1: Explicit top-navbar Settings / Preferences / View button
          for (const btn of navBtns) {
            const { combined } = getBtnMeta(btn);
            if (
              /project|profile|account|ultra|help|search|filter|add|new|create|home|back|close|more_vert|more options/i.test(
                combined
              )
            ) {
              continue;
            }
            if (/settings|preferences|\bview\b|tune|gear|cog/i.test(combined)) {
              chosen = btn;
              break;
            }
          }

          // Priority 2: Exact Top-Right Navbar Icon Sequence ([ + ], [ ? ], [ ⚙️ ], [ ⋮ ])
          if (!chosen) {
            const rightIconBtns = navBtns
              .filter((btn) => {
                const r = btn.getBoundingClientRect();
                if (r.left <= window.innerWidth * 0.45) return false;
                if (Math.abs(r.width - r.height) > 14 || r.width > 54) return false;
                if (btn.querySelector('img')) return false;
                const { txt } = getBtnMeta(btn);
                if (/ultra/i.test(txt)) return false;
                return true;
              })
              .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

            const helpIdx = rightIconBtns.findIndex((b) => {
              const { combined, txt } = getBtnMeta(b);
              return txt === '?' || /\bhelp\b|question/i.test(combined);
            });
            const moreIdx = rightIconBtns.findIndex((b) => {
              const { combined } = getBtnMeta(b);
              return /more_vert|more options|more_horiz|\bmore\b/i.test(combined);
            });

            if (helpIdx !== -1 && helpIdx + 1 < rightIconBtns.length) {
              chosen = rightIconBtns[helpIdx + 1];
            } else if (moreIdx > 0) {
              chosen = rightIconBtns[moreIdx - 1];
            } else if (rightIconBtns.length >= 3) {
              const cluster = [];
              for (const b of rightIconBtns) {
                const br = b.getBoundingClientRect();
                if (
                  cluster.length === 0 ||
                  br.left - cluster[cluster.length - 1].getBoundingClientRect().right <= 36
                ) {
                  cluster.push(b);
                }
              }
              const activeCluster = cluster.length >= 3 ? cluster : rightIconBtns;
              if (activeCluster.length >= 4) {
                chosen = activeCluster[2];
              } else if (activeCluster.length === 3) {
                chosen = activeCluster[1];
              }
            }
          }

          if (!chosen) return { found: false };

          chosen.setAttribute('data-bot-navbar-settings', 'true');
          const r = chosen.getBoundingClientRect();
          return {
            found: true,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2)
          };
        })
        .catch(() => ({ found: false }));

      if (!navSettingsBtn || !navSettingsBtn.found) {
        return false;
      }

      await this.humanMoveAndClick(navSettingsBtn.x, navSettingsBtn.y);
      await this._interruptibleSleep(600);

      popoverState = await inspectViewModePopover(targetView);
      if (!popoverState.open) {
        await targetPage
          .evaluate(() => {
            const btn = document.querySelector('[data-bot-navbar-settings="true"]');
            if (btn && typeof btn.click === 'function') btn.click();
          })
          .catch(() => {});
        await this._interruptibleSleep(600);
        popoverState = await inspectViewModePopover(targetView);
      }
    }

    // 2. Click the target ("Grid" or "Batch") button inside the View mode popover
    if (popoverState && popoverState.open && popoverState.targetFound) {
      await this.humanMoveAndClick(popoverState.x, popoverState.y);
      await this._interruptibleSleep(600);

      const postClickMode = await this.detectCurrentViewMode(targetPage);
      if (postClickMode !== 'unknown' && postClickMode !== targetView) {
        await targetPage
          .evaluate(() => {
            const gBtn = document.querySelector('[data-bot-grid-mode-btn="true"]');
            if (gBtn && typeof gBtn.click === 'function') gBtn.click();
          })
          .catch(() => {});
        await this._interruptibleSleep(600);
      }
    }

    // 3. Close the Settings popover cleanly
    const afterClickPopover = await inspectViewModePopover(targetView);
    if (afterClickPopover && afterClickPopover.open) {
      await targetPage.keyboard.press('Escape').catch(() => {});
      await this._interruptibleSleep(350);

      const stillOpenAfterEsc = await inspectViewModePopover(targetView);
      if (stillOpenAfterEsc && stillOpenAfterEsc.open) {
        await targetPage
          .evaluate(() => {
            const navBtn = document.querySelector('[data-bot-navbar-settings="true"]');
            if (navBtn && typeof navBtn.click === 'function') {
              navBtn.click();
            }
          })
          .catch(() => {});
        await this._interruptibleSleep(350);
      }
    }

    // Cleanup temporary attributes and park mouse away from navbar
    await targetPage
      .evaluate(() => {
        document
          .querySelectorAll('[data-bot-navbar-settings], [data-bot-grid-mode-btn]')
          .forEach((el) => {
            el.removeAttribute('data-bot-navbar-settings');
            el.removeAttribute('data-bot-grid-mode-btn');
          });
      })
      .catch(() => {});
    await targetPage.mouse.move(20, 20, { steps: 3 }).catch(() => {});

    this.log(
      `✅ Google Flow View mode set to ${targetView.toUpperCase()} and Settings closed.`,
      'success'
    );
    return true;
  }

  /**
   * Backwards-compatible alias that enforces the configured Google Flow View Mode ('off' by default, or 'grid'/'batch' if selected in Settings).
   */
  async ensureGridViewMode(page = this.page, options = {}) {
    const liveCfg = this._getLiveConfig();
    const targetView = String(
      liveCfg?.flowViewMode || this.config?.flowViewMode || 'off'
    ).toLowerCase();
    if (targetView !== 'grid' && targetView !== 'batch') {
      return false;
    }
    return this.syncFlowViewMode(page, options);
  }

  // ===========================================================================
  // CORE AUTOMATION LOOP & DOM INTERACTION
  // ===========================================================================

  async _runQueueLoop() {
    this.isProcessingLoopActive = true;

    try {
      const config = configManager.getConfig();
      await this._configureDownloadBehavior(this.getEffectiveOutputDir(config.downloadPath));

      for (let currentIndex = 0; currentIndex < this.queue.length; currentIndex++) {
        const shouldContinue = await this._waitIfPausedOrStopped();
        if (!shouldContinue) break;

        const item = this.queue[currentIndex];
        // Strict guard: never re-run a Completed prompt or an ID already in completedPromptIds
        if (
          !item ||
          item.status === PROMPT_STATUS.COMPLETED ||
          this.completedPromptIds.has(item.id) ||
          item.status !== PROMPT_STATUS.PENDING
        ) {
          continue;
        }

        this.currentPromptIndex = currentIndex;
        const promptNumber = currentIndex + 1;
        const liveConfig = configManager.getConfig();
        // Strict 1-Prompt = 1-Video rule unless videosPerPrompt is explicitly set higher in live config
        const totalVideos = Math.max(1, parseInt(liveConfig.videosPerPrompt || 1, 10));

        item.videosPerPrompt = totalVideos;
        item.videosCompleted = 0;
        item.currentVariation = 0;
        item.retryCount = 0;
        item.retries = 0;
        item.outputFiles = [];
        let allVariationsSucceeded = true;

        for (let v = 1; v <= totalVideos; v++) {
          const canStartVariation = await this._waitIfPausedOrStopped();
          if (!canStartVariation) {
            allVariationsSucceeded = false;
            break;
          }

          item.currentVariation = v;
          item.status = PROMPT_STATUS.GENERATING;
          item.statusText = null;
          this._persistAndEmitQueue(item);

          this.log(`Prompt #${promptNumber}: Generating video ${v} of ${totalVideos}...`);

          let variationSuccess = false;
          let generationSucceeded = false;
          let attemptCount = 0;

          while (!variationSuccess) {
            const canProceed = await this._waitIfPausedOrStopped();
            if (!canProceed) {
              allVariationsSucceeded = false;
              break;
            }

            const currentCfg = configManager.getConfig();
            const infiniteRetry = Boolean(currentCfg.infiniteRefreshOnError ?? true);
            const currentMaxRetries = Number(currentCfg.maxRetries ?? 2);

            if (!this.isConnected()) {
              this.log('Chrome connection lost. Attempting to reconnect...', 'warn');
              const reconnected = await this.connectToChrome();
              if (!reconnected.success) {
                if (attemptCount >= currentMaxRetries) {
                  item.status = PROMPT_STATUS.FAILED;
                  item.statusText = null;
                  item.error = 'Lost connection to Chrome';
                  this._persistAndEmitQueue(item);
                  this._setState(BOT_STATES.STOPPED);
                  return;
                }
                attemptCount++;
                await this._interruptibleSleep(3000);
                continue;
              }
            }

            item.status = PROMPT_STATUS.GENERATING;
            item.statusText = null;
            item.retryCount = attemptCount;
            item.retries = attemptCount;
            item.error = null;
            this._persistAndEmitQueue(item);

            const attemptLabel =
              attemptCount > 0
                ? infiniteRetry
                  ? ` (Attempt #${attemptCount + 1})`
                  : ` (Retry ${attemptCount}/${currentMaxRetries})`
                : '';
            const varLabel = totalVideos > 1 ? ` [Video ${v}/${totalVideos}]` : '';
            this.log(
              `Processing Prompt #${promptNumber}/${this.queue.length}${varLabel}${attemptLabel}: "${item.text}"`
            );

            try {
              const outputFilePath = await this._processSinglePrompt(
                item,
                promptNumber,
                currentCfg,
                v,
                totalVideos
              );
              if (this.state === BOT_STATES.STOPPED) {
                item.status = PROMPT_STATUS.PENDING;
                item.statusText = null;
                allVariationsSucceeded = false;
                this._persistAndEmitQueue(item);
                break;
              }

              // THE MOMENT the video is generated & saved: mark completed and break out of retry loop immediately
              this.unusualActivityStreak = 0;
              generationSucceeded = true;
              variationSuccess = true;
              item.videosCompleted = v;
              item.statusText = null;
              item.outputFile = outputFilePath;
              item.outputFiles.push(outputFilePath);
              item.error = null;
              if (v >= totalVideos) {
                item.status = PROMPT_STATUS.COMPLETED;
                this.completedPromptIds.add(item.id);
              }
              this._persistAndEmitQueue(item);
              this.log(
                `Completed Prompt #${promptNumber} (Video ${v}/${totalVideos}) -> Saved to: ${outputFilePath}`,
                'success'
              );
              break;
            } catch (err) {
              const handleStuck99Skip = () => {
                // DO NOT reload Chrome, DO NOT close Chrome, and DO NOT retry this prompt!
                item.status = PROMPT_STATUS.FAILED;
                item.statusText = null;
                item.error = 'Skipped: Video stuck at 99% (> 1 min)';
                allVariationsSucceeded = false;
                variationSuccess = false;
                this._persistAndEmitQueue(item);
                this.log(
                  `⏭️ Prompt #${promptNumber} (Video ${v}/${totalVideos}) marked as Failed (Skipped: stuck at 99% > 1 min). Advancing to next prompt WITHOUT refreshing Chrome...`,
                  'warn'
                );
              };

              if (err && (err.isStuck99Skip || err.code === 'STUCK_99_SKIP')) {
                handleStuck99Skip();
                break;
              }

              if (generationSucceeded) {
                variationSuccess = true;
                break;
              }

              if (this.state === BOT_STATES.STOPPED) {
                item.status = PROMPT_STATUS.PENDING;
                item.statusText = null;
                allVariationsSucceeded = false;
                this._persistAndEmitQueue(item);
                break;
              }

              attemptCount++;
              item.retryCount = attemptCount;
              item.retries = attemptCount;
              const errMsg = err.message || String(err);

              this.log(
                `❌ Error detected on Prompt #${promptNumber} (Video ${v}/${totalVideos}): ${errMsg}`,
                'error'
              );

              // Route ALL Card Errors (including "We noticed some unusual activity...", "High demand", "Failed", etc.)
              // directly into the 3-Stage Card Retry (↻) Recovery Pipeline without auto-pausing:
              // (Stage 1: 5-8 In-Card Retry Clicks -> Stage 2: Chrome Refresh + 5-8 Card Retries -> Stage 3: ZeeFlow Auto Server Switch)
              try {
                const recoveryRes = await this._runCardErrorThreeStageRecovery(
                  item,
                  promptNumber,
                  v,
                  totalVideos,
                  errMsg
                );

                if (this.state === BOT_STATES.STOPPED) {
                  item.status = PROMPT_STATUS.PENDING;
                  item.statusText = null;
                  allVariationsSucceeded = false;
                  this._persistAndEmitQueue(item);
                  break;
                }

                if (recoveryRes && recoveryRes.success && recoveryRes.filePath) {
                  this.unusualActivityStreak = 0;
                  generationSucceeded = true;
                  variationSuccess = true;
                  item.videosCompleted = v;
                  item.statusText = null;
                  item.outputFile = recoveryRes.filePath;
                  item.outputFiles.push(recoveryRes.filePath);
                  item.error = null;
                  if (v >= totalVideos) {
                    item.status = PROMPT_STATUS.COMPLETED;
                    this.completedPromptIds.add(item.id);
                  }
                  this._persistAndEmitQueue(item);
                  this.log(
                    `Completed Prompt #${promptNumber} (Video ${v}/${totalVideos}) after recovery -> Saved to: ${recoveryRes.filePath}`,
                    'success'
                  );
                  break;
                }

                // All 3 recovery stages exhausted -> mark prompt Failed cleanly and advance to next prompt
                const finalFailReason =
                  (recoveryRes && recoveryRes.error) ||
                  `${errMsg} (All recovery stages exhausted)`;
                item.status = PROMPT_STATUS.FAILED;
                item.statusText = null;
                item.error = finalFailReason;
                allVariationsSucceeded = false;
                variationSuccess = false;
                this._persistAndEmitQueue(item);
                this.log(
                  `❌ Prompt #${promptNumber} (Video ${v}/${totalVideos}) marked as Failed after 3-stage recovery exhausted. Advancing to next prompt...`,
                  'error'
                );
                break;
              } catch (nestedErr) {
                if (nestedErr && (nestedErr.isStuck99Skip || nestedErr.code === 'STUCK_99_SKIP')) {
                  handleStuck99Skip();
                  break;
                }
                if (this.state === BOT_STATES.STOPPED) {
                  item.status = PROMPT_STATUS.PENDING;
                  item.statusText = null;
                  allVariationsSucceeded = false;
                  this._persistAndEmitQueue(item);
                  break;
                }

                item.status = PROMPT_STATUS.FAILED;
                item.statusText = null;
                item.error = nestedErr.message || errMsg;
                allVariationsSucceeded = false;
                variationSuccess = false;
                this._persistAndEmitQueue(item);
                break;
              }
            }
          }

          if (!variationSuccess || this.state === BOT_STATES.STOPPED) {
            allVariationsSucceeded = false;
            break;
          }

          // Cooldown between variations of the same prompt (only if totalVideos > 1)
          if (v < totalVideos) {
            const delaySec = Math.max(
              1,
              Number(configManager.getConfig().delayBetweenPromptsSec) || 10
            );
            this.log(
              `Cooldown timer: waiting ${delaySec}s before generating video ${v + 1} of ${totalVideos} for Prompt #${promptNumber}...`
            );
            for (let sec = delaySec; sec > 0; sec--) {
              const stillRunning = await this._waitIfPausedOrStopped();
              if (!stillRunning) break;
              await this._interruptibleSleep(1000);
            }
          }
        }

        if (this.state === BOT_STATES.STOPPED) {
          break;
        }

        if (allVariationsSucceeded) {
          item.status = PROMPT_STATUS.COMPLETED;
          item.statusText = null;
          item.currentVariation = totalVideos;
          item.videosCompleted = totalVideos;
          this.completedPromptIds.add(item.id);
          this._persistAndEmitQueue(item);
          this.log(
            `Prompt #${promptNumber} marked as Completed. Advancing to next prompt in queue...`,
            'success'
          );
        }

        // Check if there are more pending prompts before applying cooldown delay
        const hasMorePending = this.queue
          .slice(currentIndex + 1)
          .some((p) => p.status === PROMPT_STATUS.PENDING && !this.completedPromptIds.has(p.id));
        if (hasMorePending) {
          const delaySec = Math.max(1, Number(configManager.getConfig().delayBetweenPromptsSec) || 10);
          this.log(`Cooldown timer: waiting ${delaySec}s before next prompt...`);
          for (let sec = delaySec; sec > 0; sec--) {
            const stillRunning = await this._waitIfPausedOrStopped();
            if (!stillRunning) break;
            await this._interruptibleSleep(1000);
          }
        }
      }

      if (this.state !== BOT_STATES.STOPPED) {
        this._setState(BOT_STATES.IDLE);
        this.log('Queue processing finished! All pending prompts have been handled.', 'success');
      }
    } catch (fatalErr) {
      this.log(`Unexpected queue loop error: ${fatalErr.message}`, 'error');
      this._setState(BOT_STATES.STOPPED);
    } finally {
      this.currentPromptIndex = -1;
      this.isProcessingLoopActive = false;
      this._persistAndEmitQueue();
    }
  }

  /**
   * 3-Stage High-Demand / Card-Failure Recovery Pipeline:
   *  - STAGE 1: 5-8 Random-Delayed In-Card Retry (↻) Clicks (NO Chrome Refresh)
   *  - STAGE 2: Chrome Tab Refresh + Re-submit + Second 5-8 In-Card Retry (↻) Loop
   *  - STAGE 3: ZeeFlow Auto Server Switch (Server 1 -> 2 -> 3) + Open Flow + Final Retry
   */
  async _runCardErrorThreeStageRecovery(
    item,
    promptNumber,
    v,
    totalVideos,
    initialErrMsg = 'Card failed to generate'
  ) {
    let lastError = initialErrMsg;

    // Checkpoint 4A: If Flow agent was accidentally enabled or caused "Something went wrong. Please try again.",
    // turn Flow agent OFF immediately and re-submit the prompt cleanly in normal video generation mode first.
    const wasAgentOnAtError = await this.ensureFlowAgentOff(this.page).catch(() => false);
    if (wasAgentOnAtError && this.state !== BOT_STATES.STOPPED) {
      this.log(
        `🔄 Flow agent was ON when error occurred — re-pasting and re-submitting Prompt #${promptNumber} in normal video mode...`,
        'warn'
      );
      try {
        const directRecoverPath = await this._processSinglePrompt(
          item,
          promptNumber,
          configManager.getConfig(),
          v,
          totalVideos
        );
        if (directRecoverPath) {
          return { success: true, filePath: directRecoverPath };
        }
      } catch (agentRecoverErr) {
        if (
          agentRecoverErr &&
          (agentRecoverErr.isStuck99Skip || agentRecoverErr.code === 'STUCK_99_SKIP')
        ) {
          throw agentRecoverErr;
        }
        lastError = agentRecoverErr.message || String(agentRecoverErr);
      }
    }

    const getPickRetryBudget = () => {
      const cfg = configManager.getConfig();
      let minClicks = Number.isFinite(Number(cfg.cardRetryClicksMin))
        ? Math.max(1, Math.min(15, Math.round(Number(cfg.cardRetryClicksMin))))
        : 5;
      let maxClicks = Number.isFinite(Number(cfg.cardRetryClicksMax))
        ? Math.max(1, Math.min(15, Math.round(Number(cfg.cardRetryClicksMax))))
        : 8;
      if (minClicks > maxClicks) [minClicks, maxClicks] = [maxClicks, minClicks];
      return minClicks + Math.floor(Math.random() * (maxClicks - minClicks + 1));
    };

    const rethrowIfSpecialError = (err) => {
      if (!err) return;
      if (err.isStuck99Skip || err.code === 'STUCK_99_SKIP') {
        throw err;
      }
      if (this.state === BOT_STATES.STOPPED) {
        throw err;
      }
    };

    const runInCardRetryLoop = async (stageLabel, targetClicks, isStage1 = false) => {
      let consecutiveMissingButton = 0;

      for (let attempt = 1; attempt <= targetClicks; attempt++) {
        if (this.state === BOT_STATES.STOPPED) {
          return { success: false, aborted: true };
        }
        const canProceed = await this._waitIfPausedOrStopped();
        if (!canProceed || this.state === BOT_STATES.STOPPED) {
          return { success: false, aborted: true };
        }

        const cfg = configManager.getConfig();
        const waitMs = this.getRandomDelayMs(
          cfg.cardRetryDelayMinSec,
          cfg.cardRetryDelayMaxSec,
          2,
          6
        );

        item.status = PROMPT_STATUS.GENERATING;
        item.statusText = `${stageLabel} (${attempt}/${targetClicks})`;
        this._persistAndEmitQueue(item);

        const shortError = String(lastError || 'Card failed')
          .replace(/^Google Flow Error:\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 95);

        if (isStage1) {
          this.log(
            `🔁 Card error ("${shortError}") — Stage 1 Retry (${attempt}/${targetClicks}): Waiting ${(
              waitMs / 1000
            ).toFixed(2)}s before clicking card Retry (↻) button...`,
            'warn'
          );
        } else {
          this.log(
            `🔁 Card error ("${shortError}") — ${stageLabel} (${attempt}/${targetClicks}): Waiting ${(
              waitMs / 1000
            ).toFixed(2)}s before clicking card Retry (↻) button...`,
            'warn'
          );
        }

        const okWait = await this.sleepInterruptible(waitMs);
        if (!okWait || this.state === BOT_STATES.STOPPED) {
          return { success: false, aborted: true };
        }

        // Ensure Flow agent is OFF before clicking card Retry (↻)
        await this.ensureFlowAgentOff(this.page).catch(() => {});

        this.log(
          `🖱️ ${stageLabel} (${attempt}/${targetClicks}): Clicking Retry (↻) button on failed card...`
        );

        let clicked = false;
        try {
          clicked = await this.clickTopLeftCardRetryButton(this.page);
        } catch (clickErr) {
          this.log(
            `⚠️ ${stageLabel} (${attempt}/${targetClicks}) click warning: ${clickErr.message}`,
            'warn'
          );
          clicked = false;
        }

        if (!clicked) {
          // Check if the card already entered generating state on its own
          const checkCard = await this.inspectTopLeftCard().catch(() => null);
          if (checkCard && checkCard.found && checkCard.isGenerating) {
            this.log(
              `ℹ️ Top-Left Card (#0) is already regenerating; monitoring ${stageLabel} (${attempt}/${targetClicks})...`
            );
            clicked = true;
          }
        }

        if (!clicked) {
          consecutiveMissingButton++;
          this.log(
            `⚠️ Card Retry (↻) button not located on attempt ${attempt}/${targetClicks} (miss #${consecutiveMissingButton}).`,
            'warn'
          );
          if (consecutiveMissingButton >= 2) {
            this.log(
              `⚠️ Card Retry (↻) button unavailable after ${consecutiveMissingButton} checks during ${stageLabel}; advancing to next recovery stage...`,
              'warn'
            );
            return { success: false, buttonNotFound: true };
          }
          continue;
        }

        consecutiveMissingButton = 0;

        try {
          const filePath = await this._monitorInCardRetryAttempt(
            item,
            promptNumber,
            cfg,
            v,
            totalVideos
          );
          if (filePath) {
            return { success: true, filePath };
          }
        } catch (retryErr) {
          rethrowIfSpecialError(retryErr);
          lastError = retryErr.message || String(retryErr);
          this.log(
            `⚠️ ${stageLabel} (${attempt}/${targetClicks}) failed: ${lastError}`,
            'warn'
          );
        }
      }
      return { success: false };
    };

    // =========================================================================
    // STAGE 1: In-Card Retry (↻) Click Loop (5-8 Attempts, NO Chrome Refresh)
    // =========================================================================
    const stage1Target = getPickRetryBudget();
    const stage1Res = await runInCardRetryLoop('Stage 1 Retry', stage1Target, true);
    if (stage1Res.success && stage1Res.filePath) {
      return { success: true, filePath: stage1Res.filePath };
    }
    if (stage1Res.aborted || this.state === BOT_STATES.STOPPED) {
      return { success: false, aborted: true };
    }

    // =========================================================================
    // STAGE 2: Chrome Tab Refresh + Second 5-8 In-Card Retry (↻) Loop
    // =========================================================================
    this.log(
      `🔄 Stage 1 (${stage1Target}/${stage1Target} card retries) still failed. Stage 2: Refreshing Chrome tab and retrying...`,
      'warn'
    );
    item.status = PROMPT_STATUS.GENERATING;
    item.statusText = 'Stage 2: Refreshing Chrome...';
    this._persistAndEmitQueue(item);

    const recovered = await this.reloadChromeAndRecover(
      'Stage 1 card retries exhausted',
      promptNumber,
      v,
      totalVideos
    );
    if (this.state === BOT_STATES.STOPPED) {
      return { success: false, aborted: true };
    }
    if (!recovered) {
      await this.sleepInterruptible(3000);
    }

    const stage2SettleMs = 3500 + Math.floor(Math.random() * 2501);
    const okStage2Settle = await this.sleepInterruptible(stage2SettleMs);
    if (!okStage2Settle || this.state === BOT_STATES.STOPPED) {
      return { success: false, aborted: true };
    }

    try {
      const stage2SubmitPath = await this._processSinglePrompt(
        item,
        promptNumber,
        configManager.getConfig(),
        v,
        totalVideos
      );
      if (stage2SubmitPath) {
        return { success: true, filePath: stage2SubmitPath };
      }
    } catch (stage2Err) {
      rethrowIfSpecialError(stage2Err);
      lastError = stage2Err.message || String(stage2Err);
      this.log(`⚠️ Stage 2 post-refresh submission failed: ${lastError}`, 'warn');

      const stage2Target = getPickRetryBudget();
      const stage2RetryRes = await runInCardRetryLoop(
        'Stage 2 Post-Refresh Retry',
        stage2Target,
        false
      );
      if (stage2RetryRes.success && stage2RetryRes.filePath) {
        return { success: true, filePath: stage2RetryRes.filePath };
      }
      if (stage2RetryRes.aborted || this.state === BOT_STATES.STOPPED) {
        return { success: false, aborted: true };
      }
    }

    // =========================================================================
    // STAGE 3: ZeeFlow Auto Server Switch (Server 1 -> 2 -> 3) + Open Flow + Final Retry
    // =========================================================================
    const currentCfg = configManager.getConfig();
    if (
      currentCfg.autoSwitchServerOnFailure !== false &&
      typeof this.serverSwitchHandler === 'function' &&
      this.state !== BOT_STATES.STOPPED
    ) {
      const currentProjectUrl =
        this.page && !this.page.isClosed() ? this.page.url() : '';

      this.log(
        '🌐 Stage 2 exhausted. Stage 3: Switching server via ZeeFlow extension and reopening Google Flow...',
        'warn'
      );
      item.status = PROMPT_STATUS.GENERATING;
      item.statusText = 'Stage 3: Switching ZeeFlow Server...';
      this._persistAndEmitQueue(item);

      const switchRes = await this.serverSwitchHandler({
        targetProjectUrl: currentProjectUrl
      });

      if (this.state === BOT_STATES.STOPPED) {
        return { success: false, aborted: true };
      }

      // Re-attach Puppeteer handle to the single active Google Flow tab and reapply download behavior
      await this.connectToChrome();
      await this._configureDownloadBehavior(
        this.getEffectiveOutputDir(configManager.getConfig().downloadPath)
      ).catch(() => {});

      const stage3SettleMs = 3000 + Math.floor(Math.random() * 2001);
      const okStage3Settle = await this.sleepInterruptible(stage3SettleMs);
      if (!okStage3Settle || this.state === BOT_STATES.STOPPED) {
        return { success: false, aborted: true };
      }

      if (switchRes && switchRes.success) {
        try {
          const stage3SubmitPath = await this._processSinglePrompt(
            item,
            promptNumber,
            configManager.getConfig(),
            v,
            totalVideos
          );
          if (stage3SubmitPath) {
            return { success: true, filePath: stage3SubmitPath };
          }
        } catch (stage3Err) {
          rethrowIfSpecialError(stage3Err);
          lastError = stage3Err.message || String(stage3Err);
          this.log(`⚠️ Stage 3 post-server-switch submission failed: ${lastError}`, 'warn');

          const stage3Target = getPickRetryBudget();
          const stage3RetryRes = await runInCardRetryLoop(
            'Stage 3 Post-Switch Retry',
            stage3Target,
            false
          );
          if (stage3RetryRes.success && stage3RetryRes.filePath) {
            return { success: true, filePath: stage3RetryRes.filePath };
          }
        }
      }
    }

    return {
      success: false,
      error: lastError
    };
  }

  /**
   * Executes a single prompt variation:
   * 1. Snapshots existing videos & files
   * 2. Locates prompt input, clears it, inserts prompt text
   * 3. Clicks Send button strictly ONCE
   * 4. Polls for new video completion and downloads as 001_sanitized_prompt.mp4 or 001_v1_sanitized_prompt.mp4
   */
  async _processSinglePrompt(promptItem, promptNumber, config, variationIndex = 1, totalVideos = 1) {
    await this.page.bringToFront();

    // Always read the latest saved settings at the start of every prompt/variation
    const liveCfg = configManager.getConfig();
    const downloadDir = this.getEffectiveOutputDir(liveCfg.downloadPath || config.downloadPath);
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    const osDownloadsDir = path.join(os.homedir(), 'Downloads');

    const targetFileName = this._buildSequentialFilename(
      promptNumber,
      promptItem.text,
      variationIndex,
      totalVideos
    );
    const targetFilePath = path.join(downloadDir, targetFileName);

    const existingFiles = new Set(fs.readdirSync(downloadDir));
    const existingOsDownloads = fs.existsSync(osDownloadsDir)
      ? new Set(fs.readdirSync(osDownloadsDir))
      : new Set();

    // 1. Pre-Paste Random Delay BEFORE focusing input and pasting prompt
    let prePasteMin = Number.isFinite(Number(liveCfg.prePasteDelayMinSec))
      ? Math.max(0, Math.min(120, Number(liveCfg.prePasteDelayMinSec)))
      : 2;
    let prePasteMax = Number.isFinite(Number(liveCfg.prePasteDelayMaxSec))
      ? Math.max(0, Math.min(120, Number(liveCfg.prePasteDelayMaxSec)))
      : 6;
    if (prePasteMin > prePasteMax) [prePasteMin, prePasteMax] = [prePasteMax, prePasteMin];

    const prePasteMs = this.getRandomDelayMs(prePasteMin, prePasteMax, 2, 6);
    if (prePasteMs > 0) {
      this.log(
        `⏳ Pre-paste random delay: Waiting ${(prePasteMs / 1000).toFixed(2)}s (range ${prePasteMin}s–${prePasteMax}s) before pasting prompt...`
      );
      const canContinueAfterPrePaste = await this.sleepInterruptible(prePasteMs);
      if (!canContinueAfterPrePaste || this.state === BOT_STATES.STOPPED) {
        throw new Error('Generation aborted by user');
      }
    }

    // Checkpoint 2: Ensure "Flow agent" toggle is OFF and workspace is in Grid view right BEFORE focusing and pasting every prompt
    await this.ensureFlowAgentOff(this.page);
    await this.ensureGridViewMode(this.page, { forceCheck: false }).catch(() => {});

    // 2. Locate prompt input using multi-fallback selectors
    this.log(`Locating prompt input field...`);
    let promptElement = await this._focusAndClearPromptInput(liveCfg.promptInputSelector);
    if (!promptElement) {
      throw new Error(
        `Could not locate a visible prompt input matching "${liveCfg.promptInputSelector}". Verify you are logged into Google Flow and check DOM Selectors in Settings.`
      );
    }

    let baseline = null;
    let baselineTopCard = null;
    let triggerMethod = 'Send button click';
    try {
      // 3. Type/insert prompt using TrustedHTML-safe Puppeteer methods
      this.log(
        `Typing Prompt #${promptNumber} (Video ${variationIndex}/${totalVideos}, ${promptItem.text.length} chars)...`
      );
      await this._typePromptText(promptElement, promptItem.text);

      // 4. Pre-Submit Random Delay AFTER pasting prompt (before submitting)
      let preSubmitMin = Number.isFinite(Number(liveCfg.preSubmitDelayMinSec))
        ? Math.max(0, Math.min(120, Number(liveCfg.preSubmitDelayMinSec)))
        : 1;
      let preSubmitMax = Number.isFinite(Number(liveCfg.preSubmitDelayMaxSec))
        ? Math.max(0, Math.min(120, Number(liveCfg.preSubmitDelayMaxSec)))
        : 4;
      if (preSubmitMin > preSubmitMax) [preSubmitMin, preSubmitMax] = [preSubmitMax, preSubmitMin];

      const preSubmitMs = this.getRandomDelayMs(preSubmitMin, preSubmitMax, 1, 4);
      if (preSubmitMs > 0) {
        this.log(
          `⏳ Pre-submit random delay: Waiting ${(preSubmitMs / 1000).toFixed(2)}s (range ${preSubmitMin}s–${preSubmitMax}s) before submitting...`
        );
        const canContinueAfterPreSubmit = await this.sleepInterruptible(preSubmitMs);
        if (!canContinueAfterPreSubmit || this.state === BOT_STATES.STOPPED) {
          throw new Error('Generation aborted by user');
        }
      }

      // Checkpoint 3: Ensure "Flow agent" toggle is OFF right BEFORE submitting every prompt.
      // If Flow agent was turned off or composer mode switched, verify prompt text is still intact and re-paste if cleared.
      const switchedOffBeforeSubmit = await this.ensureFlowAgentOff(this.page);
      const currentInputLen = await this.page
        .evaluate((el) => {
          if (!el || !el.isConnected) return 0;
          return String(el.value || el.textContent || '').trim().length;
        }, promptElement)
        .catch(() => 0);

      if (switchedOffBeforeSubmit || currentInputLen < Math.min(5, promptItem.text.trim().length)) {
        if (switchedOffBeforeSubmit) {
          this.log('🔄 Re-verifying and re-pasting prompt after turning OFF Flow agent...');
        }
        await promptElement.dispose().catch(() => {});
        promptElement = await this._focusAndClearPromptInput(liveCfg.promptInputSelector);
        if (!promptElement) {
          throw new Error('Could not re-locate prompt input after turning off Flow agent.');
        }
        await this._typePromptText(promptElement, promptItem.text);
      }

      // 5. Snapshot strict baseline state AND Top-Left Card (#0) right BEFORE submitting
      baseline = await this.capturePageBaseline();
      baselineTopCard = await this.inspectTopLeftCard();
      const baselineCardCount = (baselineTopCard && baselineTopCard.cardCount) || 0;

      // Move any network video URLs captured prior to Send into previouslyCapturedNetworkUrls
      for (const oldUrl of this.capturedVideoUrls) {
        this.previouslyCapturedNetworkUrls.add(oldUrl);
      }
      this.capturedVideoUrls.clear();

      // 6. Submit prompt using configured Submit Method ('random' | 'click' | 'enter')
      const submitMethod = liveCfg.submitMethod || 'random';
      triggerMethod = await this.submitPromptSmart(
        promptElement,
        submitMethod,
        baselineCardCount,
        liveCfg.generateButtonSelector
      );
    } finally {
      await promptElement.dispose().catch(() => {});
    }

    this.log(`Monitoring top-left card (#0) for completion or errors...`);

    // 5. Wait for Top-Left Card (#0) completion, extract its video, and verify unique SHA-256 download
    // (Enforce minimum 180 seconds / 3 minutes timeout)
    const timeoutSec = Math.max(180, Number(config.generationTimeoutSec) || 180);
    const savedFilePath = await this._waitForNewVideo(
      baseline,
      baselineTopCard,
      existingFiles,
      existingOsDownloads,
      downloadDir,
      targetFilePath,
      config,
      timeoutSec,
      promptItem.text
    );

    // Record any newly captured network URLs as seen so subsequent prompts never reuse them
    for (const seenUrl of this.capturedVideoUrls) {
      this.previouslyCapturedNetworkUrls.add(seenUrl);
    }

    return savedFilePath;
  }

  /**
   * Captures a strict baseline snapshot of existing <video> URLs, top-left video URL,
   * network video URLs, completed grid card signatures, standalone "Failed" grid card count,
   * and error phrase occurrences right BEFORE clicking Send.
   */
  async capturePageBaseline() {
    const existingNetworkUrls = this.capturedNetworkVideos.map((item) => item.url);

    const pageSnap = await this.page.evaluate(() => {
      const queryAllDeep = (root, selector) => {
        const matched = [];
        try {
          root.querySelectorAll(selector).forEach((el) => matched.push(el));
        } catch (_) {}
        const all = root.querySelectorAll('*');
        for (const node of all) {
          if (node.shadowRoot) {
            matched.push(...queryAllDeep(node.shadowRoot, selector));
          }
        }
        return matched;
      };

      const videoUrls = new Set();
      const allVideos = queryAllDeep(document, 'video');
      allVideos.forEach((v) => {
        if (v.src) videoUrls.add(v.src);
        if (v.currentSrc) videoUrls.add(v.currentSrc);
        const attrSrc = v.getAttribute('src') || v.getAttribute('data-src') || '';
        if (attrSrc) videoUrls.add(attrSrc);
        v.querySelectorAll('source').forEach((s) => {
          if (s.src) videoUrls.add(s.src);
        });
      });

      // Count how many "Failed" / error cards ALREADY exist on the page BEFORE we click Send
      const errorPhrases = [
        'we noticed some unusual activity',
        'please wait a few moments before retrying',
        'something went wrong',
        "couldn't generate",
        'could not generate',
        'failed to generate',
        'generation failed',
        'unable to generate',
        'unable to create',
        'violates our policies',
        'too many requests',
        'request failed',
        'server error'
      ];

      const rawBodyText = document.body.innerText || '';
      const cleanBodyText = rawBodyText
        .toLowerCase()
        .replace(/google flow can make mistakes,?\s*so double-check it\.?/g, '');

      const countMatches = (text, phrase) => {
        let count = 0;
        let pos = 0;
        while ((pos = text.indexOf(phrase, pos)) !== -1) {
          count++;
          pos += phrase.length;
        }
        return count;
      };

      // Count standalone "Failed" headings/lines visible on the page
      const failedLines = rawBodyText
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l === 'failed').length;

      let errorPhraseTotal = 0;
      for (const p of errorPhrases) {
        errorPhraseTotal += countMatches(cleanBodyText, p);
      }

      // Record the top-most video element's URL (if any) so we know when a brand-new card replaces position 0
      const visibleVideos = allVideos
        .map((v) => ({
          url: v.currentSrc || v.src || (v.querySelector('source')?.src || ''),
          rect: v.getBoundingClientRect()
        }))
        .filter((v) => v.rect.width > 50 && v.rect.height > 50 && v.url);

      visibleVideos.sort(
        (a, b) => (Math.abs(a.rect.top - b.rect.top) > 50 ? a.rect.top - b.rect.top : a.rect.left - b.rect.left)
      );

      // Identify prompt input top coordinate so we only scan grid cards above the prompt bar
      let promptInputTop = window.innerHeight - 90;
      const inputs = queryAllDeep(document, "textarea, [contenteditable='true'], [role='textbox']");
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        if (r.width > 180 && r.height > 15 && r.top > 150) {
          promptInputTop = Math.min(promptInputTop, r.top);
        }
      }

      // Scan completed media cards in the grid above the prompt bar
      const mediaSeeds = queryAllDeep(document, 'img, video');
      const cardTiles = [];

      for (const seed of mediaSeeds) {
        const seedRect = seed.getBoundingClientRect();
        if (seedRect.width < 80 || seedRect.height < 60) continue;
        if (seedRect.top < 35 || seedRect.bottom > promptInputTop + 30) continue;

        let card = seed;
        let curr = seed.parentElement;
        for (let depth = 0; depth < 6 && curr && curr !== document.body; depth++) {
          const r = curr.getBoundingClientRect();
          if (
            r.width >= 140 &&
            r.height >= 90 &&
            r.width <= 720 &&
            r.height <= 600 &&
            r.top >= 35 &&
            r.bottom <= promptInputTop + 40
          ) {
            card = curr;
          } else if (r.width > 750 || r.height > 620) {
            break;
          }
          curr = curr.parentElement;
        }

        const cRect = card.getBoundingClientRect();
        if (cRect.width < 120 || cRect.height < 80) continue;

        const centerX = Math.round(cRect.left + cRect.width / 2);
        const centerY = Math.round(cRect.top + cRect.height / 2);

        // Deduplicate overlapping card wrappers for the same tile
        if (
          cardTiles.some(
            (existing) =>
              Math.abs(existing.centerX - centerX) < 55 && Math.abs(existing.centerY - centerY) < 55
          )
        ) {
          continue;
        }

        const cardTextRaw = (card.innerText || card.textContent || '').trim();
        const cardLines = cardTextRaw.split(/\r?\n/).map((l) => l.trim());
        const lowerText = cardTextRaw.toLowerCase();

        // Exclude loading cards or failed cards
        const hasSpinner = Boolean(
          card.querySelector('[role="progressbar"], mat-progress-bar, mat-spinner')
        );
        const hasPercentProgress = cardLines.some((l) => /^\d{1,3}%$/.test(l));
        const hasGeneratingWord = /\bgenerating\b/i.test(lowerText);
        const hasFailedLine =
          cardLines.some((l) => l.toLowerCase() === 'failed') ||
          lowerText.includes('unusual activity') ||
          lowerText.includes('something went wrong') ||
          lowerText.includes("couldn't generate");

        if (hasSpinner || hasPercentProgress || hasGeneratingWord || hasFailedLine) {
          continue;
        }

        const imgEl = card.tagName === 'IMG' ? card : card.querySelector('img');
        const vidEl = card.tagName === 'VIDEO' ? card : card.querySelector('video');
        const hasLoadedImg = Boolean(imgEl && (imgEl.naturalWidth > 80 || imgEl.width > 80));
        const hasVid = Boolean(vidEl);

        if (!hasLoadedImg && !hasVid) continue;

        const imgSrc = imgEl ? imgEl.currentSrc || imgEl.src || '' : '';
        const vidSrc = vidEl
          ? vidEl.currentSrc || vidEl.src || (vidEl.querySelector('source')?.src || '')
          : '';
        const caption = cardLines.join(' ').replace(/\s+/g, ' ').slice(0, 120);
        const signature = `${imgSrc.slice(0, 120)}||${caption}||${vidSrc.slice(0, 120)}`;

        cardTiles.push({
          signature,
          top: Math.round(cRect.top),
          left: Math.round(cRect.left),
          centerX,
          centerY
        });
      }

      cardTiles.sort((a, b) => (Math.abs(a.top - b.top) > 50 ? a.top - b.top : a.left - b.left));

      // Capture any global non-card alert/modal/toast signatures already visible BEFORE clicking Send
      const globalBlockerPhrases = [
        'unusual activity',
        "verify it's you",
        'verify it\u2019s you',
        'too many requests',
        'rate limit',
        'quota exceeded',
        'session expired'
      ];
      const gridCardNodes = [];
      for (const seed of mediaSeeds) {
        const sr = seed.getBoundingClientRect();
        if (sr.width < 80 || sr.height < 60) continue;
        if (sr.top < 35 || sr.bottom > promptInputTop + 30) continue;
        let card = seed;
        let curr = seed.parentElement;
        for (let depth = 0; depth < 6 && curr && curr !== document.body; depth++) {
          const r = curr.getBoundingClientRect();
          if (
            r.width >= 140 &&
            r.height >= 90 &&
            r.width <= 720 &&
            r.height <= 600 &&
            r.top >= 35 &&
            r.bottom <= promptInputTop + 40
          ) {
            card = curr;
          } else if (r.width > 750 || r.height > 620) {
            break;
          }
          curr = curr.parentElement;
        }
        gridCardNodes.push(card);
      }

      const isInsideAnyGridCard = (el) => {
        if (!el) return false;
        if (gridCardNodes.some((card) => card === el || card.contains(el))) return true;
        const r = el.getBoundingClientRect();
        const isOverlay = Boolean(
          el.closest(
            '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane, .mat-mdc-snack-bar-container, [class*="toast" i], [class*="snackbar" i]'
          )
        );
        if (
          !isOverlay &&
          r.width >= 140 &&
          r.width <= 720 &&
          r.height >= 100 &&
          r.height <= 680 &&
          r.top >= 40 &&
          r.bottom <= promptInputTop + 30
        ) {
          return true;
        }
        return false;
      };

      const globalAlertSignatures = [];
      const overlayAlerts = queryAllDeep(
        document,
        '[role="alert"], [role="dialog"], [aria-modal="true"], .mat-mdc-snack-bar-container, [class*="snackbar" i], [class*="toast" i], [class*="banner" i]'
      );
      for (const el of overlayAlerts) {
        const r = el.getBoundingClientRect();
        if (r.width <= 10 || r.height <= 10) continue;
        if (isInsideAnyGridCard(el)) continue;
        const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const low = txt.toLowerCase();
        if (!txt || low.includes('can make mistakes')) continue;
        if (globalBlockerPhrases.some((p) => low.includes(p))) {
          globalAlertSignatures.push(low.slice(0, 160));
        }
      }

      return {
        videoUrls: Array.from(videoUrls),
        topVideoUrl: visibleVideos[0]?.url || '',
        failedLineCount: failedLines,
        errorPhraseTotal: errorPhraseTotal,
        globalAlertSignatures: Array.from(new Set(globalAlertSignatures)),
        completedCardSignatures: cardTiles.map((c) => c.signature),
        topCardSignature: cardTiles[0]?.signature || '',
        timestamp: Date.now()
      };
    });

    return {
      ...pageSnap,
      networkVideoUrls: existingNetworkUrls
    };
  }

  /**
   * Inspects ONLY the top-left grid card (Position #0) above the prompt bar.
   * Never scans top-right Card #1 or older cards.
   * Returns { found, isFailed, failReason, isUnusualActivity, isGenerating, progressPct, hasMedia, videoUrl, imgSrc, caption, signature, centerX, centerY, top, left, width, height }.
   */
  async inspectTopLeftCard() {
    if (!this.isConnected()) {
      return {
        found: false,
        cardCount: 0,
        isFailed: false,
        failReason: '',
        isUnusualActivity: false,
        isGenerating: false,
        progressPct: '',
        hasMedia: false,
        hasVideo: false,
        videoUrl: '',
        imgSrc: '',
        caption: '',
        cardPromptText: '',
        signature: '',
        centerX: 0,
        centerY: 0,
        top: 0,
        left: 0,
        width: 0,
        height: 0
      };
    }

    return this.page.evaluate(() => {
      const emptyResult = {
        found: false,
        cardCount: 0,
        isFailed: false,
        failReason: '',
        isUnusualActivity: false,
        isGenerating: false,
        progressPct: '',
        hasMedia: false,
        hasVideo: false,
        videoUrl: '',
        imgSrc: '',
        caption: '',
        cardPromptText: '',
        signature: '',
        centerX: 0,
        centerY: 0,
        top: 0,
        left: 0,
        width: 0,
        height: 0
      };

      const queryAllDeep = (root, selector) => {
        const matched = [];
        try {
          root.querySelectorAll(selector).forEach((el) => matched.push(el));
        } catch (_) {}
        let all = [];
        try {
          all = root.querySelectorAll('*');
        } catch (_) {}
        for (const node of all) {
          if (node.shadowRoot) {
            matched.push(...queryAllDeep(node.shadowRoot, selector));
          }
        }
        return matched;
      };

      const isVisible = (el) => {
        if (!el) return false;
        try {
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
        } catch (_) {
          return false;
        }
        return true;
      };

      // Locate top edge of the prompt bar so we ONLY inspect grid cards above it
      let promptTop = window.innerHeight - 90;
      const promptInputElements = [];
      const inputs = queryAllDeep(document, "textarea, [contenteditable='true'], [role='textbox']");
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        if (r.width > 180 && r.height > 15 && r.top > 150) {
          promptTop = Math.min(promptTop, r.top);
          promptInputElements.push(inp);
        }
      }

      const maxCardWidth = Math.min(860, Math.max(680, window.innerWidth * 0.92));

      const containsPromptInput = (el) => {
        if (!el) return false;
        return promptInputElements.some((inp) => el === inp || el.contains(inp));
      };

      // Checks if a container holds 2+ spatially separated card tiles (media cards, generating cards, or failed cards)
      const containsMultipleCards = (el) => {
        if (!el) return false;
        const medias = queryAllDeep(el, 'img, video')
          .map((m) => m.getBoundingClientRect())
          .filter((r) => r.width >= 90 && r.height >= 60);
        if (medias.length >= 2) {
          for (let i = 0; i < medias.length; i++) {
            const cx1 = medias[i].left + medias[i].width / 2;
            const cy1 = medias[i].top + medias[i].height / 2;
            for (let j = i + 1; j < medias.length; j++) {
              const cx2 = medias[j].left + medias[j].width / 2;
              const cy2 = medias[j].top + medias[j].height / 2;
              if (Math.abs(cx1 - cx2) > 85 || Math.abs(cy1 - cy2) > 85) {
                return true;
              }
            }
          }
        }

        // Also check direct child blocks so a row containing 1 failed card (no img/video) + 1 video card
        // or 2 failed cards is never mistaken for a single card
        const directChildren = Array.from(el.children || []).filter((c) => {
          if (!isVisible(c)) return false;
          const cr = c.getBoundingClientRect();
          return cr.width >= 150 && cr.height >= 90 && cr.top >= 35;
        });
        if (directChildren.length >= 2) {
          for (let i = 0; i < directChildren.length; i++) {
            const r1 = directChildren[i].getBoundingClientRect();
            const cx1 = r1.left + r1.width / 2;
            const cy1 = r1.top + r1.height / 2;
            for (let j = i + 1; j < directChildren.length; j++) {
              const r2 = directChildren[j].getBoundingClientRect();
              const cx2 = r2.left + r2.width / 2;
              const cy2 = r2.top + r2.height / 2;
              if (Math.abs(cx1 - cx2) > 110 || Math.abs(cy1 - cy2) > 100) {
                return true;
              }
            }
          }
        }

        return false;
      };

      const analyzeCardElement = (el) => {
        const rawText = (el.innerText || el.textContent || '').trim();
        const lines = rawText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const lowerText = rawText.toLowerCase();

        // Media inside this single card ONLY
        const videos = el.tagName === 'VIDEO' ? [el] : queryAllDeep(el, 'video');
        let videoUrl = '';
        let hasVisibleVideo = false;
        for (const v of videos) {
          const vr = v.getBoundingClientRect();
          const candidate =
            v.currentSrc ||
            v.src ||
            v.getAttribute('src') ||
            v.getAttribute('data-src') ||
            (v.querySelector('source') ? v.querySelector('source').src : '') ||
            '';
          const hasValidSrc =
            candidate &&
            (candidate.startsWith('http://') ||
              candidate.startsWith('https://') ||
              candidate.startsWith('blob:'));
          if (vr.width >= 60 && vr.height >= 50 && (hasValidSrc || v.readyState > 0)) {
            hasVisibleVideo = true;
          }
          if (hasValidSrc) {
            videoUrl = candidate;
            break;
          }
        }

        const imgs = el.tagName === 'IMG' ? [el] : queryAllDeep(el, 'img');
        let imgSrc = '';
        let hasVisibleImg = false;
        let largestImgArea = 0;
        for (const img of imgs) {
          const ir = img.getBoundingClientRect();
          if (ir.width >= 80 && ir.height >= 60) {
            hasVisibleImg = true;
            const area = ir.width * ir.height;
            const src = img.currentSrc || img.src || '';
            if (area >= largestImgArea && src) {
              largestImgArea = area;
              imgSrc = src;
            }
          }
        }

        const hasMedia = Boolean(videoUrl || hasVisibleVideo || hasVisibleImg);
        const hasVideo = Boolean(videoUrl || hasVisibleVideo);

        // Progress / Generating indicators inside Card #0 ONLY
        const pctLine = lines.find(
          (l) => /^\d{1,3}%$/.test(l) || /^(?:generating\s*)?\d{1,3}%(?:\s*[-•·].*)?$/i.test(l)
        );
        const pctMatch = pctLine ? pctLine.match(/(\d{1,3}%)/) : null;
        const hasProgressBar = Boolean(
          el.querySelector('[role="progressbar"], mat-progress-bar, mat-spinner, progress')
        );
        const hasGeneratingStatusLine = lines.some((l) =>
          /^(generating|creating|queued|pending|rendering|processing)\b/i.test(l)
        );
        const fallbackPctMatch = !hasMedia ? rawText.match(/\b(\d{1,3}%)\b/) : null;
        const hasActiveProgressIndicator =
          Boolean(pctLine) ||
          hasProgressBar ||
          hasGeneratingStatusLine ||
          Boolean(fallbackPctMatch);

        // 1. Universal Error Text Detection (catches ANY Google Flow card error wording, including "unusual activity" / "browser extensions")
        const hasStandaloneFailed = lines.some(
          (l) => /^failed\b/i.test(l) || /^error\b/i.test(l)
        );
        const isUnusualActivity = false;

        const strongErrorPhraseMatch =
          lowerText.includes('unusual activity') ||
          lowerText.includes('browser extensions') ||
          lowerText.includes('wait a few moments') ||
          lowerText.includes('too many requests') ||
          lowerText.includes("verify it's you") ||
          lowerText.includes('verify it\u2019s you') ||
          lowerText.includes('high demand') ||
          lowerText.includes('try again later') ||
          lowerText.includes('please try again') ||
          lowerText.includes('something went wrong') ||
          lowerText.includes("couldn't generate") ||
          lowerText.includes('could not generate') ||
          lowerText.includes("couldn't create") ||
          lowerText.includes('could not create') ||
          lowerText.includes('failed to generate') ||
          lowerText.includes('generation failed') ||
          lowerText.includes('unable to generate') ||
          lowerText.includes('unable to create') ||
          lowerText.includes('unable to process') ||
          lowerText.includes('violates our policies') ||
          lowerText.includes('policy violation') ||
          lowerText.includes('community guidelines') ||
          lowerText.includes('unsafe content') ||
          lowerText.includes('timed out') ||
          lowerText.includes('timeout') ||
          lowerText.includes('service unavailable') ||
          lowerText.includes('server error') ||
          lowerText.includes('generation interrupted') ||
          lowerText.includes('quota exceeded') ||
          lowerText.includes('rate limit');

        // Broad error regex applied when the card has no playable video and no active % progress
        const universalErrorLineRegex =
          /\b(failed|unusual\s*activity|browser\s*extensions|error|high\s*demand|something\s*went\s*wrong|couldn['’]t|could\s*not|unable\s*to|try\s*again|violat\w*|polic(?:y|ies)|unsafe|blocked|guideline\w*|timeout|timed\s*out|unavailable|busy|limit|quota|interrupted|issue|problem)\b/i;

        const hasBroadErrorText =
          !hasVideo &&
          !hasActiveProgressIndicator &&
          lines.some((l) => universalErrorLineRegex.test(l));

        // 2. Structural Failed-Card Detection (even if error wording varies or is icon-only):
        //    No <video>, NOT actively showing % progress/spinner, AND contains either a warning/alert icon
        //    OR the failed-card bottom-right action button cluster ([Retry ↻], [Reuse ↩], [Delete 🗑️]).
        let hasStructuralFailedState = false;
        if (!hasVideo && !hasVisibleImg && !hasActiveProgressIndicator) {
          const hasAlertRoleOrIcon = Boolean(
            el.querySelector(
              '[role="alert"], [aria-label*="error" i], [aria-label*="failed" i], [aria-label*="warning" i]'
            )
          );
          const cardBtns = queryAllDeep(el, 'button, [role="button"]').filter(isVisible);
          let hasRetryActionBtn = false;
          let hasFailedActionCluster = false;

          for (const btn of cardBtns) {
            const bCombined = (
              (btn.getAttribute('aria-label') || '') +
              ' ' +
              (btn.getAttribute('title') || '') +
              ' ' +
              (btn.getAttribute('data-tooltip') || '') +
              ' ' +
              (btn.getAttribute('mattooltip') || '') +
              ' ' +
              (btn.innerText || btn.textContent || '')
            )
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();

            if (/retry|regenerate|try\s*again|redo|autorenew|replay/i.test(bCombined)) {
              hasRetryActionBtn = true;
              break;
            }
          }

          if (!hasRetryActionBtn && cardBtns.length >= 2 && cardBtns.length <= 5) {
            // Check if 2-4 buttons form a horizontal action cluster in the bottom half of the card
            const cardRect = el.getBoundingClientRect();
            const lowerBtns = cardBtns.filter((b) => {
              const br = b.getBoundingClientRect();
              return (
                br.width >= 18 &&
                br.width <= 68 &&
                br.height >= 18 &&
                br.height <= 68 &&
                br.top >= cardRect.top + cardRect.height * 0.4
              );
            });
            if (lowerBtns.length >= 2) {
              const firstTop = lowerBtns[0].getBoundingClientRect().top;
              const sameRowCount = lowerBtns.filter(
                (b) => Math.abs(b.getBoundingClientRect().top - firstTop) <= 18
              ).length;
              if (sameRowCount >= 2) {
                hasFailedActionCluster = true;
              }
            }
          }

          hasStructuralFailedState =
            hasAlertRoleOrIcon || hasRetryActionBtn || hasFailedActionCluster;
        }

        const isFailed =
          hasStandaloneFailed ||
          isUnusualActivity ||
          strongErrorPhraseMatch ||
          hasBroadErrorText ||
          hasStructuralFailedState;

        const failReason = isFailed
          ? (lines.join(' — ').slice(0, 180) || 'Card failed to generate (structural failure state)')
          : '';

        const isGenerating = !isFailed && hasActiveProgressIndicator;

        const progressPct = pctMatch
          ? pctMatch[1]
          : fallbackPctMatch
          ? fallbackPctMatch[1]
          : isGenerating
          ? 'Generating...'
          : '';

        const statusNoiseLineRegex =
          /^(?:\d{1,3}%|generating|creating|queued|pending|rendering|processing|failed|timeout|timed out|retry|try again|reuse prompt|delete|remove|download|more_vert|play_arrow|error|error_outline|warning|refresh|close|open_in_new|video|720p|1080p|\d+s|x\d+|▶)$/i;
        const errorNoiseSubstrings = [
          'we noticed some unusual activity',
          'please wait a few moments before retrying',
          'something went wrong',
          "couldn't generate",
          'could not generate',
          'failed to generate',
          'generation failed',
          'unable to generate',
          'unable to create',
          'violates our policies',
          'too many requests',
          'timed out',
          'generation timed out',
          'request timed out'
        ];
        const cleanPromptLines = lines.filter((line) => {
          const trimmed = line.replace(/^[▶►•·\s]+/, '').trim();
          if (!trimmed || trimmed.length < 3) return false;
          if (statusNoiseLineRegex.test(trimmed)) return false;
          if (/^(?:generating\s*)?\d{1,3}%(?:\s*[-•·].*)?$/i.test(trimmed)) return false;
          const low = trimmed.toLowerCase();
          if (errorNoiseSubstrings.some((phrase) => low.includes(phrase))) return false;
          return true;
        });
        const cardPromptText = cleanPromptLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);

        const caption = lines.join(' ').replace(/\s+/g, ' ').slice(0, 160);
        const signature = `${imgSrc}||${caption}||${videoUrl}`;
        const unifiedStatus = isFailed
          ? 'card-error'
          : isGenerating
          ? 'generating'
          : hasMedia
          ? 'completed'
          : 'idle';

        return {
          status: unifiedStatus,
          retryable: Boolean(isFailed),
          errorMessage: failReason,
          isFailed,
          failReason,
          isUnusualActivity: false,
          isGenerating,
          progressPct,
          hasMedia,
          hasVideo,
          videoUrl,
          imgSrc,
          caption,
          cardPromptText,
          signature
        };
      };

      const rawContainers = queryAllDeep(document, 'div, article, section, figure, li');
      const candidates = [];

      for (const el of rawContainers) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 140 || rect.width > maxCardWidth) continue;
        if (rect.height < 85 || rect.height > 720) continue;
        if (rect.top < 38 || rect.top >= promptTop - 30) continue;
        if (rect.bottom > window.innerHeight + 160) continue;
        if (rect.left < -10 || rect.right > window.innerWidth + 20) continue;

        if (containsPromptInput(el)) continue;
        if (containsMultipleCards(el)) continue;

        const info = analyzeCardElement(el);
        if (!info.hasMedia && !info.isGenerating && !info.isFailed) continue;

        // Exclude the bottom composer "Flow agent" error banner ("Something went wrong. Please try again.")
        // docked directly above the prompt composer so it is never mistaken for a top-left video card
        if (
          !info.hasMedia &&
          !info.isGenerating &&
          rect.top >= Math.max(window.innerHeight * 0.5, promptTop - 135) &&
          rect.height <= 125 &&
          /something went wrong/i.test(info.failReason || '')
        ) {
          continue;
        }

        candidates.push({
          el,
          rect,
          area: rect.width * rect.height
        });
      }

      if (candidates.length === 0) {
        return emptyResult;
      }

      // Count distinct physical media/generation cards currently rendered in the grid
      const distinctCardCenters = [];
      for (const cand of candidates) {
        const cx = Math.round(cand.rect.left + cand.rect.width / 2);
        const cy = Math.round(cand.rect.top + cand.rect.height / 2);
        const alreadyCounted = distinctCardCenters.some(
          (pt) => Math.abs(pt.cx - cx) < 60 && Math.abs(pt.cy - cy) < 60
        );
        if (!alreadyCounted) {
          distinctCardCenters.push({ cx, cy });
        }
      }
      const cardCount = distinctCardCenters.length;

      // Strictly select Top-Left Grid Card (Position #0):
      // 1) Top-most row (bucketed by 50px)
      // 2) Left-most column
      // 3) Tightest single-card bounding area
      candidates.sort((a, b) => {
        const rowDiff = Math.round(a.rect.top / 50) - Math.round(b.rect.top / 50);
        if (rowDiff !== 0) return rowDiff;
        if (Math.abs(a.rect.left - b.rect.left) > 25) return a.rect.left - b.rect.left;
        return a.area - b.area;
      });

      let cardEl = candidates[0].el;
      let cardRect = candidates[0].rect;

      // Walk up up to 5 parent levels if parent wraps THIS single card (captures full card tile + bottom-right action buttons)
      for (let depth = 0; depth < 5; depth++) {
        const parent = cardEl.parentElement;
        if (!parent || parent === document.body) break;
        if (!isVisible(parent)) break;
        if (containsPromptInput(parent)) break;
        if (containsMultipleCards(parent)) break;
        const pr = parent.getBoundingClientRect();
        if (
          pr.width >= 150 &&
          pr.width <= maxCardWidth &&
          pr.height <= 720 &&
          pr.width <= cardRect.width * 1.35 &&
          pr.height <= cardRect.height * 1.45 &&
          pr.top >= 35 &&
          pr.top < promptTop - 30 &&
          Math.abs(pr.left - cardRect.left) <= 48 &&
          Math.abs(pr.top - cardRect.top) <= 65
        ) {
          cardEl = parent;
          cardRect = pr;
        } else {
          break;
        }
      }

      const finalInfo = analyzeCardElement(cardEl);
      const finalRect = cardEl.getBoundingClientRect();

      return {
        found: true,
        cardCount,
        ...finalInfo,
        centerX: Math.round(finalRect.left + finalRect.width / 2),
        centerY: Math.round(finalRect.top + finalRect.height / 2),
        top: Math.round(finalRect.top),
        left: Math.round(finalRect.left),
        width: Math.round(finalRect.width),
        height: Math.round(finalRect.height)
      };
    });
  }

  /**
   * Checks ONLY global non-card banners / modals / toasts / alert dialogs / full-page blockers
   * outside the media grid for session/account-level blockers not present in baseline.
   *
   * STRICTLY excludes all media grid cards (Card #1, Card #2, etc.) so a delayed Timeout/Failed
   * state on an older or previously skipped card can NEVER blame the active prompt.
   * Card-specific errors on the active prompt are evaluated strictly on Card #0 via inspectTopLeftCard().
   */
  async checkForFlowError(baseline = null) {
    if (!this.isConnected()) {
      return { hasError: true, reason: 'Chrome tab disconnected', isUnusualActivity: false };
    }

    const base = baseline || {
      globalAlertSignatures: []
    };

    return this.page
      .evaluate((baseSnap) => {
        const globalBlockerPhrases = [
          'unusual activity',
          "verify it's you",
          'verify it\u2019s you',
          'too many requests',
          'rate limit',
          'quota exceeded',
          'session expired'
        ];

        const baseAlerts = new Set(baseSnap.globalAlertSignatures || []);

        const queryAllDeep = (root, selector) => {
          const matched = [];
          try {
            root.querySelectorAll(selector).forEach((el) => matched.push(el));
          } catch (_) {}
          let all = [];
          try {
            all = root.querySelectorAll('*');
          } catch (_) {}
          for (const node of all) {
            if (node.shadowRoot) {
              matched.push(...queryAllDeep(node.shadowRoot, selector));
            }
          }
          return matched;
        };

        const isVisible = (el) => {
          if (!el) return false;
          try {
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              Number(style.opacity) === 0
            ) {
              return false;
            }
            const r = el.getBoundingClientRect();
            return r.width > 10 && r.height > 10;
          } catch (_) {
            return false;
          }
        };

        const checkIsUnusual = (txt) => {
          const low = (txt || '').toLowerCase();
          return (
            low.includes('unusual activity') ||
            low.includes('wait a few moments') ||
            low.includes('too many requests') ||
            low.includes('rate limit')
          );
        };

        // Locate prompt input bar to identify the media grid region above it
        let promptInputTop = window.innerHeight - 90;
        let hasPromptInput = false;
        const inputs = queryAllDeep(document, "textarea, [contenteditable='true'], [role='textbox']");
        for (const inp of inputs) {
          const r = inp.getBoundingClientRect();
          if (r.width > 180 && r.height > 15 && r.top > 150) {
            hasPromptInput = true;
            promptInputTop = Math.min(promptInputTop, r.top);
          }
        }

        // Collect all media grid card elements so we NEVER inspect error/timeout text inside grid cards
        const gridCardNodes = [];
        const mediaSeeds = queryAllDeep(document, 'img, video');
        for (const seed of mediaSeeds) {
          const sr = seed.getBoundingClientRect();
          if (sr.width < 80 || sr.height < 60) continue;
          if (sr.top < 35 || sr.bottom > promptInputTop + 30) continue;
          let card = seed;
          let curr = seed.parentElement;
          for (let depth = 0; depth < 6 && curr && curr !== document.body; depth++) {
            const r = curr.getBoundingClientRect();
            if (
              r.width >= 140 &&
              r.height >= 90 &&
              r.width <= 720 &&
              r.height <= 600 &&
              r.top >= 35 &&
              r.bottom <= promptInputTop + 40
            ) {
              card = curr;
            } else if (r.width > 750 || r.height > 620) {
              break;
            }
            curr = curr.parentElement;
          }
          gridCardNodes.push(card);
        }

        const isInsideMediaGridCard = (el) => {
          if (!el) return false;
          if (gridCardNodes.some((card) => card === el || card.contains(el))) {
            return true;
          }
          // Also exclude non-overlay elements located inside card-sized tiles above the prompt bar
          const isTrueOverlay = Boolean(
            el.closest(
              '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane, .mat-mdc-snack-bar-container, [class*="toast" i], [class*="snackbar" i]'
            )
          );
          if (!isTrueOverlay) {
            const r = el.getBoundingClientRect();
            if (
              r.width >= 140 &&
              r.width <= 720 &&
              r.height >= 90 &&
              r.height <= 680 &&
              r.top >= 40 &&
              r.bottom <= promptInputTop + 30
            ) {
              return true;
            }
            // Check immediate ancestor card tile (e.g. a role="alert" placed inside an error-only card with no img/video)
            let p = el.parentElement;
            for (let d = 0; d < 5 && p && p !== document.body; d++) {
              const pr = p.getBoundingClientRect();
              if (
                pr.width >= 150 &&
                pr.width <= 720 &&
                pr.height >= 120 &&
                pr.height <= 680 &&
                pr.top >= 40 &&
                pr.bottom <= promptInputTop + 30
              ) {
                return true;
              }
              p = p.parentElement;
            }
          }
          return false;
        };

        // 1. Scan ONLY global banners, modals, toasts, and ARIA alerts OUTSIDE media grid cards
        const globalCandidates = queryAllDeep(
          document,
          '[role="alert"], [role="dialog"], [aria-modal="true"], .mat-mdc-snack-bar-container, [class*="snackbar" i], [class*="toast" i], [class*="banner" i]'
        );

        for (const el of globalCandidates) {
          if (!isVisible(el)) continue;
          if (isInsideMediaGridCard(el)) continue;

          const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          const low = txt.toLowerCase();
          if (!txt || low.includes('can make mistakes')) continue;

          const matchedBlocker = globalBlockerPhrases.find((p) => low.includes(p));
          if (matchedBlocker) {
            const sig = low.slice(0, 160);
            if (!baseAlerts.has(sig)) {
              return {
                hasError: true,
                reason: txt.slice(0, 160),
                isUnusualActivity: checkIsUnusual(txt)
              };
            }
          }
        }

        // 2. Full-page blocker fallback ONLY if Google Flow itself navigated/replaced the UI
        // (i.e., NO prompt input box AND NO media grid cards exist on the page at all)
        if (!hasPromptInput && gridCardNodes.length === 0) {
          const pageText = (document.body.innerText || '')
            .replace(/google flow can make mistakes,?\s*so double-check it\.?/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          const lowPage = pageText.toLowerCase();
          const matchedPageBlocker = globalBlockerPhrases.find((p) => lowPage.includes(p));
          if (matchedPageBlocker) {
            return {
              hasError: true,
              reason: `Global page blocker: ${matchedPageBlocker}`,
              isUnusualActivity: checkIsUnusual(pageText)
            };
          }
        }

        return { hasError: false, isUnusualActivity: false };
      }, base)
      .catch(() => ({
        hasError: false,
        isUnusualActivity: false
      }));
  }

  /**
   * Bulletproof locator & clicker for the Retry (↻) button on a failed Google Flow card
   * (e.g. "Failed — Flow is experiencing high demand. Please try again later.").
   *
   * Works in both full-screen and narrow half-screen windows by:
   *  1. Locating the full Failed Card Container bounding box (walking up from the failed/high-demand text
   *     to the card tile that encloses the bottom-right action bar, with fallback to Top-Left Card #0).
   *  2. Hovering smoothly over the failed card to reveal any hover-activated action buttons.
   *  3. Matching the Retry (↻) button via Priority 1 (explicit retry/regenerate/try-again attribute or icon)
   *     or Priority 2 (leftmost button of the horizontal 3-button [Retry ↻] [Reuse ↩] [Delete 🗑️] cluster),
   *     tagging it with data-bot-retry-target="true".
   *  4. Clicking with humanMoveAndClick + 1200ms verification + direct DOM .click() fallback if needed.
   */
  async clickTopLeftCardRetryButton(page = this.page) {
    if (!page || !this.isConnected()) return false;

    const fallbackTopCard = await this.inspectTopLeftCard().catch(() => null);

    // 1. Locate the Failed Card Container Bounding Box
    const cardRect = await page
      .evaluate((fallbackBox) => {
        const queryAllDeep = (root, selector) => {
          const matched = [];
          try {
            root.querySelectorAll(selector).forEach((el) => matched.push(el));
          } catch (_) {}
          let all = [];
          try {
            all = root.querySelectorAll('*');
          } catch (_) {}
          for (const node of all) {
            if (node.shadowRoot) {
              matched.push(...queryAllDeep(node.shadowRoot, selector));
            }
          }
          return matched;
        };

        // Clean any stale retry target attributes
        for (const old of queryAllDeep(document, '[data-bot-retry-target]')) {
          old.removeAttribute('data-bot-retry-target');
        }

        const isVisible = (el) => {
          if (!el) return false;
          try {
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              parseFloat(style.opacity || '1') <= 0.05
            ) {
              return false;
            }
            const r = el.getBoundingClientRect();
            return r.width > 10 && r.height > 10;
          } catch (_) {
            return false;
          }
        };

        // Identify the bottom prompt composer bar so we exclude it from card search
        let promptTop = window.innerHeight - 85;
        const promptInputs = [];
        for (const inp of queryAllDeep(document, "textarea, [contenteditable='true'], [role='textbox']")) {
          const r = inp.getBoundingClientRect();
          if (r.width > 180 && r.height > 15 && r.top > 150) {
            promptTop = Math.min(promptTop, r.top);
            promptInputs.push(inp);
          }
        }

        const containsPromptInput = (el) =>
          Boolean(el && promptInputs.some((inp) => el === inp || el.contains(inp)));

        const containsMultipleCards = (el) => {
          if (!el) return false;
          const medias = queryAllDeep(el, 'img, video')
            .map((m) => m.getBoundingClientRect())
            .filter((r) => r.width >= 90 && r.height >= 60);
          if (medias.length >= 2) {
            for (let i = 0; i < medias.length; i++) {
              const cx1 = medias[i].left + medias[i].width / 2;
              const cy1 = medias[i].top + medias[i].height / 2;
              for (let j = i + 1; j < medias.length; j++) {
                const cx2 = medias[j].left + medias[j].width / 2;
                const cy2 = medias[j].top + medias[j].height / 2;
                if (Math.abs(cx1 - cx2) > 85 || Math.abs(cy1 - cy2) > 85) return true;
              }
            }
          }
          const directChildren = Array.from(el.children || []).filter((c) => {
            if (!isVisible(c)) return false;
            const cr = c.getBoundingClientRect();
            return cr.width >= 150 && cr.height >= 90 && cr.top >= 35;
          });
          if (directChildren.length >= 2) {
            for (let i = 0; i < directChildren.length; i++) {
              const r1 = directChildren[i].getBoundingClientRect();
              const cx1 = r1.left + r1.width / 2;
              const cy1 = r1.top + r1.height / 2;
              for (let j = i + 1; j < directChildren.length; j++) {
                const r2 = directChildren[j].getBoundingClientRect();
                const cx2 = r2.left + r2.width / 2;
                const cy2 = r2.top + r2.height / 2;
                if (Math.abs(cx1 - cx2) > 110 || Math.abs(cy1 - cy2) > 100) return true;
              }
            }
          }
          return false;
        };

        const maxCardW = Math.min(860, Math.max(680, window.innerWidth * 0.94));

        // Find visible elements containing ANY failed / error text or alert role inside the workspace
        const failRegex =
          /failed|unusual activity|browser extensions|error|high demand|something went wrong|couldn['’]t|could not|unable to|try again|violat|policy|policies|unsafe|blocked|guideline|timeout|timed out|unavailable|busy|limit|quota|interrupted|issue|problem/i;

        const allNodes = queryAllDeep(
          document,
          'div, span, p, h1, h2, h3, h4, article, section, [role="alert"]'
        );
        const failedSeeds = [];

        for (const el of allNodes) {
          if (!isVisible(el)) continue;
          if (el.children.length > 4) continue;
          if (containsPromptInput(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.top < 38 || r.top >= promptTop - 20) continue;

          // Exclude the bottom composer Flow agent error banner
          if (r.top >= Math.max(window.innerHeight * 0.5, promptTop - 135) && r.height <= 125) {
            const t = (el.innerText || el.textContent || '').trim();
            if (/something went wrong\.?\s*please try again/i.test(t)) continue;
          }

          const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          const isAlertNode =
            el.getAttribute('role') === 'alert' ||
            /error|failed|warning/i.test(el.getAttribute('aria-label') || '');

          if ((txt && txt.length <= 240 && failRegex.test(txt)) || isAlertNode) {
            failedSeeds.push({ el, rect: r });
          }
        }

        // Sort top-left first so we always target Card #0
        failedSeeds.sort((a, b) => {
          const rowDiff = Math.round(a.rect.top / 55) - Math.round(b.rect.top / 55);
          if (rowDiff !== 0) return rowDiff;
          return a.rect.left - b.rect.left;
        });

        for (const seed of failedSeeds) {
          let curr = seed.el;
          let bestCard = null;
          let firstCardRect = null;

          for (let depth = 0; depth < 10 && curr && curr !== document.body; depth++) {
            if (containsPromptInput(curr)) break;
            if (containsMultipleCards(curr)) break;
            const r = curr.getBoundingClientRect();
            if (r.width > maxCardW || r.height > 740 || r.top < 32) {
              break;
            }
            if (r.width >= 170 && r.height >= 105 && r.top >= 38) {
              if (!firstCardRect) {
                firstCardRect = r;
                bestCard = curr;
              } else if (
                r.width <= firstCardRect.width * 1.35 &&
                r.height <= firstCardRect.height * 1.45 &&
                Math.abs(r.left - firstCardRect.left) <= 48 &&
                Math.abs(r.top - firstCardRect.top) <= 65
              ) {
                bestCard = curr;
              } else {
                break;
              }
            }
            curr = curr.parentElement;
          }

          if (bestCard) {
            const br = bestCard.getBoundingClientRect();
            return {
              found: true,
              left: Math.round(br.left),
              top: Math.round(br.top),
              right: Math.round(br.right),
              bottom: Math.round(br.bottom),
              width: Math.round(br.width),
              height: Math.round(br.height)
            };
          }
        }

        if (fallbackBox && fallbackBox.found && fallbackBox.width >= 140) {
          return {
            found: true,
            left: Math.round(fallbackBox.left),
            top: Math.round(fallbackBox.top),
            right: Math.round(fallbackBox.left + fallbackBox.width),
            bottom: Math.round(fallbackBox.top + fallbackBox.height),
            width: Math.round(fallbackBox.width),
            height: Math.round(fallbackBox.height)
          };
        }

        // Direct fallback: locate the first visible card container at the top-left of the workspace grid
        const gridCards = queryAllDeep(document, 'div, article, section, figure, li')
          .filter((el) => {
            if (!isVisible(el) || containsPromptInput(el) || containsMultipleCards(el)) return false;
            const r = el.getBoundingClientRect();
            return (
              r.width >= 175 &&
              r.width <= maxCardW &&
              r.height >= 105 &&
              r.height <= 680 &&
              r.top >= 38 &&
              r.top < promptTop - 25
            );
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            const rowDiff = Math.round(ra.top / 55) - Math.round(rb.top / 55);
            if (rowDiff !== 0) return rowDiff;
            if (Math.abs(ra.left - rb.left) > 25) return ra.left - rb.left;
            return ra.width * ra.height - rb.width * rb.height;
          });

        if (gridCards.length > 0) {
          const gr = gridCards[0].getBoundingClientRect();
          return {
            found: true,
            left: Math.round(gr.left),
            top: Math.round(gr.top),
            right: Math.round(gr.right),
            bottom: Math.round(gr.bottom),
            width: Math.round(gr.width),
            height: Math.round(gr.height)
          };
        }

        return { found: false };
      }, fallbackTopCard)
      .catch(() => ({ found: false }));

    if (!cardRect || !cardRect.found) {
      return false;
    }

    // 2. Hover over the failed card first so any hover-activated action buttons become visible and interactive
    const hoverX = Math.round(cardRect.left + cardRect.width * 0.5);
    const hoverY = Math.round(cardRect.top + cardRect.height * 0.45);
    await page.mouse.move(hoverX, hoverY, { steps: 8 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    // Also glide toward the bottom-right action area of the card
    const actionAreaX = Math.round(cardRect.left + cardRect.width * 0.78);
    const actionAreaY = Math.round(cardRect.top + cardRect.height * 0.8);
    await page.mouse.move(actionAreaX, actionAreaY, { steps: 5 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));

    // 3. Find the Retry (↻) button via geometric overlap + attribute/cluster detection
    const btnInfo = await page
      .evaluate((cRect) => {
        const queryAllDeep = (root, selector) => {
          const matched = [];
          try {
            root.querySelectorAll(selector).forEach((el) => matched.push(el));
          } catch (_) {}
          let all = [];
          try {
            all = root.querySelectorAll('*');
          } catch (_) {}
          for (const node of all) {
            if (node.shadowRoot) {
              matched.push(...queryAllDeep(node.shadowRoot, selector));
            }
          }
          return matched;
        };

        const isVisibleButton = (el) => {
          if (!el) return false;
          try {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              parseFloat(style.opacity || '1') <= 0.05
            ) {
              return false;
            }
            const r = el.getBoundingClientRect();
            return r.width >= 18 && r.height >= 18 && r.width <= 68 && r.height <= 68;
          } catch (_) {
            return false;
          }
        };

        // Locate the prompt composer container so we never pick buttons inside the prompt bar
        let promptContainer = null;
        for (const inp of queryAllDeep(document, "textarea, [contenteditable='true'], [role='textbox']")) {
          const r = inp.getBoundingClientRect();
          if (r.width > 180 && r.height > 15 && r.top > 150) {
            let p = inp.parentElement;
            for (let i = 0; i < 6 && p && p !== document.body; i++) {
              const pr = p.getBoundingClientRect();
              if (pr.width > 240 && pr.height >= 65 && pr.height <= 260) {
                promptContainer = p;
              }
              p = p.parentElement;
            }
            break;
          }
        }

        const allButtons = queryAllDeep(document, 'button, [role="button"]').filter((el) => {
          if (!isVisibleButton(el)) return false;
          if (promptContainer && (promptContainer === el || promptContainer.contains(el))) {
            return false;
          }
          return true;
        });

        const searchButtonsInWindow = (bottomTolerancePx, minTopRatio) => {
          const minTop = cRect.top + cRect.height * minTopRatio;
          const maxBottom = cRect.bottom + bottomTolerancePx;
          const minLeft = cRect.left - 18;
          const maxRight = cRect.right + 28;

          const candidates = [];
          for (const btn of allButtons) {
            const rect = btn.getBoundingClientRect();
            if (
              rect.left >= minLeft &&
              rect.right <= maxRight &&
              rect.top >= minTop &&
              rect.bottom <= maxBottom
            ) {
              candidates.push({
                btn,
                rect,
                cx: rect.left + rect.width / 2,
                cy: rect.top + rect.height / 2
              });
            }
          }

          if (candidates.length === 0) return null;

          // Priority 1: Any candidate matching /retry|regenerate|try again|redo/i
          for (const item of candidates) {
            const { btn, rect, cx, cy } = item;
            const attrs = [
              btn.getAttribute('aria-label') || '',
              btn.getAttribute('title') || '',
              btn.getAttribute('data-tooltip') || '',
              btn.getAttribute('mattooltip') || ''
            ]
              .join(' ')
              .toLowerCase();
            const text = (btn.innerText || btn.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
            const combined = `${attrs} ${text}`;

            if (/reuse|edit|delete|remove|trash|download|copy|more_vert|close/i.test(combined)) {
              continue;
            }

            if (
              /retry|regenerate|try\s*again|redo|refresh|replay|autorenew/i.test(combined) ||
              text === '↻'
            ) {
              btn.setAttribute('data-bot-retry-target', 'true');
              return {
                found: true,
                x: Math.round(cx),
                y: Math.round(cy),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                method: `Priority 1 (attribute/text: "${(attrs || text || 'retry').trim()}")`
              };
            }
          }

          // Priority 2: Exact 3-Button Action Cluster ([Retry ↻], [Reuse ↩], [Delete 🗑️])
          // Group candidates that share a horizontal row (Math.abs(a.top - b.top) <= 18)
          const clusters = [];
          for (const cand of candidates) {
            const rowGroup = candidates
              .filter((other) => Math.abs(other.rect.top - cand.rect.top) <= 18)
              .sort((a, b) => a.rect.left - b.rect.left);
            if (rowGroup.length >= 2 && rowGroup.length <= 4) {
              clusters.push(rowGroup);
            }
          }

          if (clusters.length > 0) {
            // Pick largest horizontal cluster (tie-breaking by closest to bottom-right of card)
            clusters.sort((a, b) => {
              if (b.length !== a.length) return b.length - a.length;
              const aRight = a[a.length - 1].rect.right + a[0].rect.bottom;
              const bRight = b[b.length - 1].rect.right + b[0].rect.bottom;
              return bRight - aRight;
            });

            const bestCluster = clusters[0];
            const retryTarget = bestCluster[0]; // Leftmost button is ALWAYS Retry (↻)!
            retryTarget.btn.setAttribute('data-bot-retry-target', 'true');
            return {
              found: true,
              x: Math.round(retryTarget.cx),
              y: Math.round(retryTarget.cy),
              width: Math.round(retryTarget.rect.width),
              height: Math.round(retryTarget.rect.height),
              method: `Priority 2 (leftmost button 1/${bestCluster.length} in bottom-right action cluster)`
            };
          }

          if (candidates.length === 1) {
            const only = candidates[0];
            only.btn.setAttribute('data-bot-retry-target', 'true');
            return {
              found: true,
              x: Math.round(only.cx),
              y: Math.round(only.cy),
              width: Math.round(only.rect.width),
              height: Math.round(only.rect.height),
              method: 'Priority 2 (single action button in lower card region)'
            };
          }

          return null;
        };

        // First search strictly inside the lower half of cardRect (+15px tolerance)
        let match = searchButtonsInWindow(15, 0.42);
        if (match) return match;

        // Second pass: if cardRect wrapped only the upper text area, search down to +135px below cardRect
        match = searchButtonsInWindow(135, 0.2);
        if (match) return match;

        return { found: false };
      }, cardRect)
      .catch(() => ({ found: false }));

    if (
      !btnInfo ||
      !btnInfo.found ||
      !Number.isFinite(btnInfo.x) ||
      !Number.isFinite(btnInfo.y)
    ) {
      return false;
    }

    this.log(
      `🖱️ Clicking Card #0 Retry (↻) button at (${btnInfo.x}, ${btnInfo.y}) via ${btnInfo.method}...`
    );
    await this.humanMoveAndClick(btnInfo.x, btnInfo.y);

    // 4. Wait 1200ms and verify if the card started regenerating; if the failed banner is untouched,
    // trigger a direct DOM click on [data-bot-retry-target="true"] as a fallback.
    await this.sleepInterruptible(1200);

    const usedDomFallback = await page
      .evaluate(() => {
        const target = document.querySelector('[data-bot-retry-target="true"]');
        if (!target) return false;

        // Check if the card still shows "Failed" / "high demand" without any progress bar or percentage
        let card = target.parentElement;
        for (let i = 0; i < 6 && card && card !== document.body; i++) {
          const r = card.getBoundingClientRect();
          if (r.width >= 170 && r.height >= 105) break;
          card = card.parentElement;
        }
        const cardText = card ? (card.innerText || card.textContent || '') : '';
        const hasProgress =
          Boolean(
            card &&
              card.querySelector('[role="progressbar"], mat-progress-bar, mat-spinner, progress')
          ) || /\b\d{1,3}%\b/.test(cardText);
        const hasPlayableVideo = Boolean(
          card && card.querySelector('video[src], video source[src]')
        );
        const stillFailed =
          !hasProgress &&
          !hasPlayableVideo &&
          (/failed|unusual activity|browser extensions|error|high demand|something went wrong|couldn['’]t|could not|unable to|try again|violat|policy|policies|unsafe|blocked|guideline|timeout|timed out|unavailable|busy|limit|quota|interrupted|issue|problem/i.test(
            cardText
          ) ||
            !card);

        let clickedDom = false;
        if (stillFailed && typeof target.click === 'function') {
          target.click();
          clickedDom = true;
        }
        target.removeAttribute('data-bot-retry-target');
        return clickedDom;
      })
      .catch(() => false);

    if (usedDomFallback) {
      this.log('ℹ️ Triggered direct DOM click fallback on Card #0 Retry (↻) button.');
    }

    // Wait 2000ms more for the retry generation state (% progress or new generating card) to begin
    await this.sleepInterruptible(2000);
    return true;
  }

  /**
   * Monitors Top-Left Card (#0) after an in-card Retry (↻) click and downloads the video if generation succeeds.
   */
  async _monitorInCardRetryAttempt(
    promptItem,
    promptNumber,
    config,
    variationIndex = 1,
    totalVideos = 1
  ) {
    const liveCfg = configManager.getConfig();
    const downloadDir = this.getEffectiveOutputDir(liveCfg.downloadPath || config.downloadPath);
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    const osDownloadsDir = path.join(os.homedir(), 'Downloads');

    const targetFileName = this._buildSequentialFilename(
      promptNumber,
      promptItem.text,
      variationIndex,
      totalVideos
    );
    const targetFilePath = path.join(downloadDir, targetFileName);

    const existingFiles = new Set(fs.readdirSync(downloadDir));
    const existingOsDownloads = fs.existsSync(osDownloadsDir)
      ? new Set(fs.readdirSync(osDownloadsDir))
      : new Set();

    // Move any prior network video URLs into previouslyCapturedNetworkUrls
    for (const oldUrl of this.capturedVideoUrls) {
      this.previouslyCapturedNetworkUrls.add(oldUrl);
    }
    this.capturedVideoUrls.clear();

    // Wait up to 3 seconds for Card #0 to enter generating state after clicking Retry (↻)
    const transitionStart = Date.now();
    while (Date.now() - transitionStart < 3000) {
      const card = await this.inspectTopLeftCard();
      if (card && card.found && card.isGenerating) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    const baseline = await this.capturePageBaseline();
    const currentTopCard = await this.inspectTopLeftCard();
    // Mark baselineTopCard.isFailed = false so if the retry click also fails with "Failed / high demand",
    // _waitForNewVideo immediately detects the failure on the very next poll instead of waiting 180s.
    const retryBaselineTopCard = currentTopCard
      ? {
          ...currentTopCard,
          isFailed: false,
          signature: '__IN_CARD_RETRY_BASELINE__'
        }
      : null;

    const timeoutSec = Math.max(180, Number(liveCfg.generationTimeoutSec) || 180);
    const savedFilePath = await this._waitForNewVideo(
      baseline,
      retryBaselineTopCard,
      existingFiles,
      existingOsDownloads,
      downloadDir,
      targetFilePath,
      liveCfg,
      timeoutSec,
      promptItem.text
    );

    for (const seenUrl of this.capturedVideoUrls) {
      this.previouslyCapturedNetworkUrls.add(seenUrl);
    }

    return savedFilePath;
  }

  /**
   * Force refreshes the Chrome tab, waits 5 seconds, polls up to 30 seconds until the Google Flow
   * prompt input box is visible and ready, and logs recovery status.
   */
  async reloadChromeAndRecover(
    reason = 'Error detected',
    promptNumber = 1,
    variationIndex = 1,
    totalVideos = 1
  ) {
    if (this.state !== BOT_STATES.RUNNING && this.state !== BOT_STATES.PAUSED) return false;
    const canProceed = await this._waitIfPausedOrStopped();
    if (!canProceed) return false;

    this.log(`🔄 Refreshing Chrome tab now... (${reason})`, 'warn');

    try {
      const currentUrl = this.page.url();
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async () => {
        // Fallback if reload throws
        await this.page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      });
    } catch (err) {
      this.log(`Reload warning: ${err.message}. Attempting to re-attach to tab...`, 'warn');
      await this.connectToChrome().catch(() => {});
    }

    const liveConfig = configManager.getConfig();
    await this._configureDownloadBehavior(
      this.getEffectiveOutputDir(liveConfig.downloadPath)
    ).catch(() => {});

    // Wait 5 seconds, then poll up to 30 seconds until the Google Flow prompt input box is visible and ready
    await this._interruptibleSleep(5000);

    for (let i = 0; i < 30; i++) {
      const stillRunning = await this._waitIfPausedOrStopped();
      if (!stillRunning) return false;
      const inputEl = await this.findPromptInput(liveConfig.promptInputSelector).catch(() => null);
      if (inputEl) {
        await inputEl.dispose().catch(() => {});
        await this.ensureFlowAgentOff(this.page).catch(() => {});
        await this.ensureGridViewMode(this.page, { forceCheck: true }).catch(() => {});
        this.log(
          `✅ Chrome refreshed! Re-trying Prompt #${promptNumber} (Video ${variationIndex}/${totalVideos})...`,
          'success'
        );
        await this._interruptibleSleep(1000);
        return true;
      }
      await this._interruptibleSleep(1000);
    }

    return false;
  }

  /**
   * Locates and returns the visible prompt input ElementHandle (or null if not present).
   */
  async findPromptInput(customSelector) {
    const userSelector = customSelector || configManager.getConfig().promptInputSelector;
    const handle = await this.page.evaluateHandle((selChainInput) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 20 && rect.height > 15;
      };

      const queryAllDeep = (root, selector) => {
        const matched = [];
        try {
          root.querySelectorAll(selector).forEach((el) => matched.push(el));
        } catch (_) {}
        const all = root.querySelectorAll('*');
        for (const node of all) {
          if (node.shadowRoot) {
            matched.push(...queryAllDeep(node.shadowRoot, selector));
          }
        }
        return matched;
      };

      const selectorChain = [
        selChainInput,
        'textarea[aria-label*="prompt" i]',
        'textarea[placeholder*="prompt" i]',
        'textarea[placeholder*="describe" i]',
        'textarea[placeholder*="video" i]',
        'textarea',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        'input[type="text"][placeholder*="prompt" i]'
      ].filter(Boolean);

      let target = null;
      for (const sel of selectorChain) {
        const candidates = queryAllDeep(document, sel).filter(isVisible);
        if (candidates.length > 0) {
          candidates.sort(
            (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width
          );
          target = candidates[0];
          break;
        }
      }

      if (!target) return null;

      target.scrollIntoView({ block: 'center', inline: 'center' });
      return target;
    }, userSelector);

    const promptElement = handle.asElement();
    if (!promptElement) {
      await handle.dispose().catch(() => {});
      return null;
    }
    return promptElement;
  }

  /**
   * Clicks safely inside the left-center of the prompt input box (rect.left + Math.min(120, rect.width * 0.3)),
   * NEVER near the right edge where the settings gear (⚙️), Flow agent switch (✦), and Send (→) buttons sit.
   */
  async _clickPromptInputLeftCenter(promptElement) {
    if (!promptElement || !this.page) return;
    const coords = await this.page
      .evaluate((el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const offsetX = Math.min(120, Math.max(20, r.width * 0.3));
        return {
          x: Math.round(r.left + offsetX),
          y: Math.round(r.top + r.height * 0.5)
        };
      }, promptElement)
      .catch(() => null);

    if (coords && Number.isFinite(coords.x) && Number.isFinite(coords.y)) {
      await this.humanMoveAndClick(coords.x, coords.y);
    } else {
      await this.page
        .evaluate((el) => {
          if (el && typeof el.focus === 'function') el.focus();
        }, promptElement)
        .catch(() => {});
    }
  }

  /**
   * Finds the prompt input element using configured selectors and smart fallbacks,
   * clicks safely in its left-center and focuses it, and clears existing text using Trusted-Types-safe methods
   * (native keyboard shortcuts + textContent / native value setter).
   */
  async _focusAndClearPromptInput(customSelector) {
    const promptElement = await this.findPromptInput(customSelector);
    if (!promptElement) {
      return null;
    }

    await this._clickPromptInputLeftCenter(promptElement);
    await new Promise((r) => setTimeout(r, 150));

    // Select all and delete via keyboard
    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('KeyA');
    await this.page.keyboard.up('Control');
    await this.page.keyboard.press('Backspace');
    await new Promise((r) => setTimeout(r, 100));

    // Fallback DOM clear (TrustedHTML safe)
    await this.page.evaluate((el) => {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const setter =
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, '');
        else el.value = '';
      } else if (el.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, promptElement);

    return promptElement;
  }

  /**
   * Inserts the prompt text using TrustedHTML-safe document.execCommand('insertText'),
   * CDP Input.insertText, and Puppeteer keyboard.type() fallback, without premature Enter submission.
   */
  async _typePromptText(promptElement, promptText) {
    const cleanPromptText = String(promptText || '')
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    await promptElement.focus();

    // Method A: Use document.execCommand('insertText') which is TrustedHTML-safe and triggers React/Lit state
    const insertedViaExec = await this.page.evaluate(
      (el, text) => {
        el.focus();
        return document.execCommand('insertText', false, text);
      },
      promptElement,
      cleanPromptText
    );

    // Verify text was inserted; if not, try CDP Input.insertText or Puppeteer native keyboard.type()
    let currentVal = await this.page.evaluate(
      (el) => (el.value || el.textContent || '').trim(),
      promptElement
    );

    if ((!insertedViaExec || currentVal.length < 3) && this.cdpSession) {
      try {
        await this._clickPromptInputLeftCenter(promptElement);
        await this.cdpSession.send('Input.insertText', { text: cleanPromptText });
        currentVal = await this.page.evaluate(
          (el) => (el.value || el.textContent || '').trim(),
          promptElement
        );
      } catch (_) {
        // Fallback to keyboard.type below
      }
    }

    if (!insertedViaExec || currentVal.length < 3) {
      await this._clickPromptInputLeftCenter(promptElement);
      await this.page.keyboard.type(cleanPromptText, { delay: 5 });
    }

    // Fire input/change events and type a trailing space + backspace to wake up reactive frameworks
    await this.page.keyboard.press('Space');
    await this.page.keyboard.press('Backspace');
    await this.page.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, promptElement);
    await new Promise((r) => setTimeout(r, 500));
  }

  /**
   * Locates the enabled bottom-right Send/Arrow button inside the prompt card and returns its exact center coordinates.
   * Explicitly excludes the Flow agent toggle switch (✦), settings gear (⚙️), and all non-submit buttons.
   */
  async _locateSendButtonCoords(promptElement, customSelector) {
    return this.page
      .evaluate(
        (inputEl, userSelector) => {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0'
            );
          };

          // Walk up from the prompt input element to find the prompt card container
          let container = inputEl ? inputEl.parentElement : null;
          for (let i = 0; i < 7 && container && container !== document.body; i++) {
            const btns = container.querySelectorAll('button, [role="button"]');
            if (btns.length >= 2) {
              const rect = container.getBoundingClientRect();
              if (rect.height > 80 && rect.width > 250) break;
            }
            container = container.parentElement;
          }
          const searchRoot = container || document;
          const inputRect = inputEl
            ? inputEl.getBoundingClientRect()
            : { top: 0, left: 0, width: 400, height: 60 };

          // Find all visible buttons (both enabled and disabled) so we can identify the rightmost toolbar position
          const allToolbarBtns = Array.from(
            searchRoot.querySelectorAll('button, [role="button"], [role="switch"]')
          ).filter((el) => isVisible(el));

          // Identify the rightmost X coordinate among all bottom-right composer controls
          let maxToolbarRight = 0;
          for (const b of allToolbarBtns) {
            const r = b.getBoundingClientRect();
            if (r.top >= inputRect.top - 10 && r.right > maxToolbarRight) {
              maxToolbarRight = r.right;
            }
          }

          const candidates = Array.from(
            searchRoot.querySelectorAll('button, [role="button"]')
          ).filter(
            (el) => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
          );

          let bestBtn = null;
          let bestScore = -999;

          for (const btn of candidates) {
            const rect = btn.getBoundingClientRect();
            const role = (btn.getAttribute('role') || '').toLowerCase();
            const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            const aria = (
              (btn.getAttribute('aria-label') || '') +
              ' ' +
              (btn.getAttribute('title') || '') +
              ' ' +
              (btn.getAttribute('data-tooltip') || '') +
              ' ' +
              (btn.getAttribute('mattooltip') || '')
            ).toLowerCase();
            const iconText = Array.from(
              btn.querySelectorAll('i, span, mat-icon, google-symbols, svg, path, [class*="icon"]')
            )
              .map(
                (n) =>
                  (n.textContent || '') +
                  ' ' +
                  (n.getAttribute('data-icon') || '') +
                  ' ' +
                  (n.getAttribute('aria-label') || '') +
                  ' ' +
                  (n.getAttribute('class') || '')
              )
              .join(' ')
              .toLowerCase();
            const combined = `${role} ${aria} ${text} ${iconText}`;

            // STRICT EXCLUSION: Never match Flow agent switch, settings gear, Try again banner button, or mode chips
            if (
              role === 'switch' ||
              btn.hasAttribute('aria-checked') ||
              btn.hasAttribute('aria-pressed') ||
              btn.hasAttribute('data-bot-flow-agent-toggle') ||
              Boolean(btn.querySelector('[role="switch"]')) ||
              /flow\s*agent|turn\s*on|turn\s*off|\bswitch\b|settings|tune|sliders|gear|auto_awesome|sparkle|✦|✧|try\s*again|dismiss|cancel/i.test(
                combined
              )
            ) {
              continue;
            }

            // Exclude pill-shaped toggle switches (width > height * 1.25 with no explicit send/generate label)
            const hasExplicitSendKeyword =
              text.includes('arrow_forward') ||
              text.includes('arrow_upward') ||
              text.includes('east') ||
              text.includes('send') ||
              text.includes('generate') ||
              text.includes('create') ||
              text === '→' ||
              aria.includes('generate') ||
              aria.includes('send') ||
              aria.includes('submit') ||
              aria.includes('create') ||
              iconText.includes('arrow_forward') ||
              iconText.includes('arrow_upward') ||
              iconText.includes('arrow_right') ||
              iconText.includes('east') ||
              iconText.includes('send') ||
              (btn.getAttribute('type') || '').toLowerCase() === 'submit';

            if (!hasExplicitSendKeyword && rect.width > rect.height * 1.25) {
              continue;
            }

            if (
              text === 'close' ||
              text === 'clear' ||
              text === '×' ||
              text === 'x' ||
              aria.includes('clear') ||
              aria.includes('close')
            ) {
              continue;
            }
            if (
              text === '+' ||
              text === 'add' ||
              aria.includes('add') ||
              aria.includes('attach')
            ) {
              continue;
            }
            if (
              text.includes('720p') ||
              text.includes('1080p') ||
              text.includes('video') ||
              text.includes('8s') ||
              text.includes('5s')
            ) {
              continue;
            }

            // Check if this button is the far-rightmost circular/square button in the composer toolbar
            const isRightmostCircularBtn =
              maxToolbarRight > 0 &&
              Math.abs(rect.right - maxToolbarRight) <= 8 &&
              rect.width >= 24 &&
              rect.width <= 62 &&
              Math.abs(rect.width - rect.height) <= 10 &&
              rect.left > inputRect.left + inputRect.width * 0.6;

            // Require either an explicit Send/Arrow keyword OR verified rightmost circular button position
            if (!hasExplicitSendKeyword && !isRightmostCircularBtn) {
              continue;
            }

            const style = window.getComputedStyle(btn);
            const bg = style.backgroundColor || '';
            let score = 0;

            if (hasExplicitSendKeyword) {
              score += 70;
            }
            if (isRightmostCircularBtn) {
              score += 45;
            }

            if (rect.top >= inputRect.top) score += 20;
            if (rect.left > inputRect.left + inputRect.width * 0.5) score += 30;

            score += Math.round((rect.right - inputRect.left) / 20);
            score += Math.round((rect.bottom - inputRect.top) / 20);

            if (rect.width >= 24 && rect.width <= 65 && Math.abs(rect.width - rect.height) <= 12) {
              score += 25;
            }

            if (
              bg.includes('255, 255, 255') ||
              bg.includes('248, 249, 250') ||
              bg.includes('241, 243, 244')
            ) {
              score += 40;
            }

            if (score > bestScore) {
              bestScore = score;
              bestBtn = btn;
            }
          }

          if (bestBtn && bestScore >= 60) {
            bestBtn.scrollIntoView({ block: 'center', inline: 'center' });
            const r = bestBtn.getBoundingClientRect();
            return {
              found: true,
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              label: (
                bestBtn.getAttribute('aria-label') ||
                bestBtn.innerText ||
                'Bottom-Right Arrow Button'
              ).trim()
            };
          }

          return { found: false };
        },
        promptElement,
        customSelector
      )
      .catch(() => ({ found: false }));
  }

  /**
   * Smart prompt submission supporting:
   * - 'click': Mouse Click on Send (→) button via humanMoveAndClick
   * - 'enter': Keyboard Enter key with 1800ms single-submit verification & safe click fallback
   * - 'random': 50/50 random choice per prompt between Mouse Click and Keyboard Enter
   */
  async submitPromptSmart(
    promptElement,
    submitMethod = 'random',
    baselineCardCount = 0,
    customSelector = ''
  ) {
    const normalizedMode = ['random', 'click', 'enter'].includes(
      String(submitMethod || '').trim().toLowerCase()
    )
      ? String(submitMethod).trim().toLowerCase()
      : 'random';

    const chosenMethod =
      normalizedMode === 'click'
        ? 'click'
        : normalizedMode === 'enter'
        ? 'enter'
        : Math.random() < 0.5
        ? 'click'
        : 'enter';

    // Wait up to 2000ms for the Send (→) button to be enabled (confirms Flow registered the pasted prompt)
    let sendBtn = { found: false };
    const waitSendStart = Date.now();
    while (Date.now() - waitSendStart < 2000) {
      sendBtn = await this._locateSendButtonCoords(promptElement, customSelector);
      if (sendBtn && sendBtn.found) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    if (chosenMethod === 'click') {
      if (sendBtn && sendBtn.found) {
        await this.humanMoveAndClick(sendBtn.x, sendBtn.y);
        this.log(`🖱️ Submitted prompt via Mouse Click (Send button) [mode: ${normalizedMode}].`);
        await new Promise((r) => setTimeout(r, 1500));
        return `Mouse Click (Send button) [mode: ${normalizedMode}]`;
      }

      // Fallback if Send button could not be found in DOM
      this.log(
        '⚠️ Send button not found for Mouse Click; pressing Keyboard Enter as fallback...',
        'warn'
      );
      await this.page
        .evaluate((el) => {
          if (el && typeof el.focus === 'function') el.focus();
        }, promptElement)
        .catch(() => {});
      await this.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1500));
      return `Keyboard Enter fallback [mode: ${normalizedMode}]`;
    }

    // chosenMethod === 'enter'
    const preEnterLen = await this.page
      .evaluate((el) => {
        if (!el) return 0;
        if (typeof el.focus === 'function') el.focus();
        return String(el.value || el.textContent || '').trim().length;
      }, promptElement)
      .catch(() => 0);

    await this.page.keyboard.press('Enter');
    this.log(`⌨️ Submitted prompt via Keyboard Enter [mode: ${normalizedMode}].`);

    // Single-Submit Safety Check (1800ms verification)
    const stillActive = await this.sleepInterruptible(1800);
    if (!stillActive || this.state === BOT_STATES.STOPPED) {
      throw new Error('Generation aborted by user');
    }

    const postEnterLen = await this.page
      .evaluate((el) => {
        if (!el) return 0;
        return String(el.value || el.textContent || '').trim().length;
      }, promptElement)
      .catch(() => 0);

    const postSendBtn = await this._locateSendButtonCoords(promptElement, customSelector);
    const postTopCard = await this.inspectTopLeftCard();

    const inputClearedOrShortened =
      postEnterLen === 0 || (preEnterLen > 5 && postEnterLen < preEnterLen * 0.4);
    const sendButtonDisabledOrGone = !postSendBtn || !postSendBtn.found;
    const cardStartedOrCountIncreased = Boolean(
      postTopCard &&
        postTopCard.found &&
        ((postTopCard.cardCount || 0) > baselineCardCount || postTopCard.isGenerating)
    );

    if (inputClearedOrShortened || sendButtonDisabledOrGone || cardStartedOrCountIncreased) {
      return `Keyboard Enter [mode: ${normalizedMode}]`;
    }

    // ONLY if ALL checks are false (prompt still unsubmitted AND Send button still enabled AND no new card started)
    this.log(
      '⚠️ Keyboard Enter was not accepted by Google Flow — falling back to single Mouse Click on Send button...',
      'warn'
    );
    if (postSendBtn && postSendBtn.found) {
      await this.humanMoveAndClick(postSendBtn.x, postSendBtn.y);
      await new Promise((r) => setTimeout(r, 1500));
    }
    return `Mouse Click fallback after Enter [mode: ${normalizedMode}]`;
  }

  /**
   * Precision Send/Arrow button detection & hardware CDP mouse click for Google Flow.
   */
  async triggerGenerateButton(promptElement, customSelector) {
    return this.submitPromptSmart(promptElement, 'click', 0, customSelector);
  }

  /**
   * Polls strictly the Top-Left Grid Card (Position #0) every 2 seconds until:
   * 1) A Google Flow error / Failed card appears -> throws immediately for Chrome reload & retry
   * 2) Card #0 finishes generating (% progress / progressbar gone), is verified genuinely NEW,
   *    its video source is extracted strictly from Card #0, AND SHA-256 verifies the downloaded
   *    .mp4 is 100% unique (not matching any previous video in this session or output folder).
   */
  async _waitForNewVideo(
    baseline,
    baselineTopCard,
    existingFiles,
    existingOsDownloads,
    downloadDir,
    targetFilePath,
    config,
    timeoutSec,
    currentPromptText = ''
  ) {
    const startTime = Date.now();
    const timeoutMs = Math.max(180, Number(timeoutSec) || 180) * 1000;
    const baseSnap = baseline || {
      videoUrls: [],
      networkVideoUrls: [],
      topVideoUrl: '',
      failedLineCount: 0,
      errorPhraseTotal: 0,
      globalAlertSignatures: [],
      completedCardSignatures: [],
      topCardSignature: '',
      timestamp: startTime
    };

    const baselineCardCount = (baselineTopCard && baselineTopCard.cardCount) || 0;
    const baselinePctMatch = String((baselineTopCard && baselineTopCard.progressPct) || '').match(
      /(\d{1,3})/
    );
    const baselineWasStuck99 = Boolean(
      baselineTopCard &&
        baselineTopCard.found &&
        baselineTopCard.isGenerating &&
        baselinePctMatch &&
        parseInt(baselinePctMatch[1], 10) >= 98
    );

    const knownBaselineUrls = new Set(baseSnap.videoUrls || []);
    if (baseSnap.topVideoUrl) knownBaselineUrls.add(baseSnap.topVideoUrl);
    if (baselineTopCard && baselineTopCard.videoUrl) {
      knownBaselineUrls.add(baselineTopCard.videoUrl);
    }

    const knownBaselineNormalizedUrls = new Set();
    for (const u of knownBaselineUrls) {
      const norm = this.normalizeVideoUrl(u);
      if (norm) knownBaselineNormalizedUrls.add(norm);
    }

    const rejectedUrlsThisAttempt = new Set();
    const rejectedNormalizedUrlsThisAttempt = new Set();

    const osDownloadsDir = path.join(os.homedir(), 'Downloads');
    let sawCardGenerating = false;
    let lastGeneratingLogTime = 0;
    let lastWaitingLogTime = startTime;
    let lastHoverAttemptTime = 0;
    let newCardConfirmed = !baselineWasStuck99;
    let loggedStale99Grace = false;
    let stuckAt99Since = null;
    let lastStuck99LogAt = 0;
    let lastObservedTopCardPct = null;
    const STALE_99_GRACE_MS = 15 * 1000; // HARD MAX 15 seconds — NEVER trap the loop for 180s!
    const STUCK_99_LIMIT_MS = 60 * 1000; // 60,000 ms (1 minute)

    const isFreshCandidateUrl = (url) => {
      if (
        !url ||
        (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('blob:'))
      ) {
        return false;
      }
      if (knownBaselineUrls.has(url) || rejectedUrlsThisAttempt.has(url)) {
        return false;
      }
      const norm = this.normalizeVideoUrl(url);
      if (
        norm &&
        (knownBaselineNormalizedUrls.has(norm) ||
          rejectedNormalizedUrlsThisAttempt.has(norm) ||
          this.downloadedNormalizedUrls.has(norm))
      ) {
        return false;
      }
      return true;
    };

    const findNetworkVideoSince = (sinceTimestamp) => {
      for (let i = this.capturedNetworkVideos.length - 1; i >= 0; i--) {
        const entry = this.capturedNetworkVideos[i];
        if (entry && entry.url && entry.timestamp >= sinceTimestamp && isFreshCandidateUrl(entry.url)) {
          return entry.url;
        }
      }
      return null;
    };

    const extractPreviewModalVideoUrl = async () => {
      return this.page.evaluate(() => {
        const queryAllDeep = (root, selector) => {
          const matched = [];
          try {
            root.querySelectorAll(selector).forEach((el) => matched.push(el));
          } catch (_) {}
          let all = [];
          try {
            all = root.querySelectorAll('*');
          } catch (_) {}
          for (const node of all) {
            if (node.shadowRoot) {
              matched.push(...queryAllDeep(node.shadowRoot, selector));
            }
          }
          return matched;
        };

        const collectVideos = (root) =>
          queryAllDeep(root, 'video')
            .map((v) => {
              const r = v.getBoundingClientRect();
              const url =
                v.currentSrc ||
                v.src ||
                v.getAttribute('src') ||
                v.getAttribute('data-src') ||
                (v.querySelector('source') ? v.querySelector('source').src : '') ||
                '';
              return { url, area: r.width * r.height, width: r.width, height: r.height };
            })
            .filter(
              (item) =>
                item.width > 120 &&
                item.height > 100 &&
                item.url &&
                (item.url.startsWith('http://') ||
                  item.url.startsWith('https://') ||
                  item.url.startsWith('blob:'))
            )
            .sort((a, b) => b.area - a.area);

        // Prefer a <video> inside a modal/dialog overlay first
        const modalRoots = queryAllDeep(
          document,
          '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane, dialog'
        );
        for (const mRoot of modalRoots) {
          const modalVids = collectVideos(mRoot);
          if (modalVids.length > 0) return modalVids[0].url;
        }

        // Fallback to largest visible <video> (the open preview player)
        const allVids = collectVideos(document);
        return allVids.length > 0 ? allVids[0].url : '';
      });
    };

    const checkIsNewTopCardFailure = (card, currentElapsedMs = 0) =>
      Boolean(
        card &&
          card.found &&
          card.isFailed &&
          (sawCardGenerating ||
            !baselineTopCard ||
            !baselineTopCard.found ||
            !baselineTopCard.isFailed ||
            (card.cardCount || 0) > baselineCardCount ||
            card.signature !== baselineTopCard.signature ||
            currentElapsedMs >= 4500)
      );

    while (Date.now() - startTime < timeoutMs || stuckAt99Since !== null) {
      await this._interruptibleSleep(2000);

      if (this.state === BOT_STATES.STOPPED) {
        throw new Error('Generation aborted by user');
      }

      await this._waitIfPausedOrStopped();
      if (this.state === BOT_STATES.STOPPED) {
        throw new Error('Generation aborted by user');
      }

      const elapsedMs = Date.now() - startTime;
      const elapsedSec = Math.round(elapsedMs / 1000);

      // Checkpoint 4B: If Flow agent mode or its bottom composer banner ("Something went wrong. Please try again.")
      // is detected during polling, turn OFF Flow agent immediately, re-paste the prompt, and re-submit in normal video mode
      const wasAgentTurnedOffInLoop = await this.ensureFlowAgentOff(this.page);
      if (wasAgentTurnedOffInLoop && currentPromptText) {
        this.log(
          '🔄 Flow agent was turned OFF during monitoring — clearing input, re-pasting prompt, and re-submitting in normal video mode...',
          'warn'
        );
        const liveCfgNow = configManager.getConfig();
        const freshInputEl = await this._focusAndClearPromptInput(liveCfgNow.promptInputSelector);
        if (freshInputEl) {
          try {
            await this._typePromptText(freshInputEl, currentPromptText);
            const curCardSnap = await this.inspectTopLeftCard();
            const curCardCount = (curCardSnap && curCardSnap.cardCount) || 0;
            await this.submitPromptSmart(
              freshInputEl,
              liveCfgNow.submitMethod || 'random',
              curCardCount,
              liveCfgNow.generateButtonSelector
            );
          } finally {
            await freshInputEl.dispose().catch(() => {});
          }
        }
        continue;
      }

      // 1. Run Global Non-Card Error Check AND Top-Left Card (#0) Inspector immediately on every poll
      const errCheck = await this.checkForFlowError(baseSnap);
      if (errCheck.hasError) {
        const flowErr = new Error('Google Flow Error: ' + errCheck.reason);
        flowErr.isUnusualActivity = Boolean(errCheck.isUnusualActivity);
        throw flowErr;
      }

      const topCard = await this.inspectTopLeftCard();
      const pctMatch = String((topCard && topCard.progressPct) || '').match(/(\d{1,3})/);
      const pctNum = pctMatch ? parseInt(pctMatch[1], 10) : null;

      // One-way latch: if previous card was stuck at >=98% before Send, wait briefly (HARD MAX 15s)
      // for the new prompt card to replace slot #0. Once latched true, NEVER treat Card #0 as stale again!
      if (!newCardConfirmed) {
        const countIncreased = Boolean(
          topCard && topCard.found && (topCard.cardCount || 0) > baselineCardCount
        );
        const freshLowPct = Boolean(
          topCard && topCard.found && topCard.isGenerating && pctNum !== null && pctNum < 95
        );
        const freshVideoArrived = Boolean(
          topCard &&
            topCard.found &&
            (topCard.hasVideo || topCard.videoUrl) &&
            topCard.signature !== (baselineTopCard && baselineTopCard.signature)
        );
        const graceExpired = elapsedMs >= STALE_99_GRACE_MS;

        if (countIncreased || freshLowPct || freshVideoArrived || graceExpired) {
          newCardConfirmed = true;
        } else {
          if (!loggedStale99Grace) {
            this.log(
              'ℹ️ Waiting briefly for new prompt card to replace previous 99% card at slot #0...'
            );
            loggedStale99Grace = true;
          }
          stuckAt99Since = null;
          continue;
        }
      }

      // Track last observed percentage on the active Card #0 (for 180s timeout safety net)
      if (topCard && topCard.found && topCard.isGenerating && pctNum !== null) {
        lastObservedTopCardPct = pctNum;
      } else if (topCard && topCard.found && !topCard.isGenerating) {
        lastObservedTopCardPct = null;
      }

      // Genuine error on active Card #0 -> throw for 3-stage card retry recovery
      if (checkIsNewTopCardFailure(topCard, elapsedMs)) {
        const flowErr = new Error(
          'Google Flow Error: ' + (topCard.failReason || 'Top-left card failed to generate')
        );
        flowErr.isUnusualActivity = Boolean(topCard.isUnusualActivity);
        throw flowErr;
      }

      // 2. STRICT % / Generating Guard on Top-Left Card (#0) + 1-Minute 99% Stuck Watchdog:
      // While Card #0 is still generating, DO NOT inspect any other card, DO NOT hover/click,
      // and DO NOT pull from capturedNetworkVideos!
      if (topCard && topCard.found && topCard.isGenerating) {
        sawCardGenerating = true;
        const pctLabel = topCard.progressPct || 'in progress';

        if (pctNum === 99) {
          if (stuckAt99Since === null) {
            stuckAt99Since = Date.now();
            lastStuck99LogAt = Date.now();
            this.log('⏳ Top-left card (#0) reached 99%. Starting 1-minute stuck watchdog...', 'warn');
          }

          const stuckElapsedMs = Date.now() - stuckAt99Since;

          if (stuckElapsedMs >= STUCK_99_LIMIT_MS) {
            this.log(
              `⏭️ Video stuck at 99% for over 1 minute (${Math.floor(
                stuckElapsedMs / 1000
              )}s). Skipping WITHOUT refreshing Chrome and moving to next prompt...`,
              'warn'
            );
            const skipErr = new Error('Skipped: Video stuck at 99% (> 1 min)');
            skipErr.code = 'STUCK_99_SKIP';
            skipErr.isStuck99Skip = true;
            throw skipErr;
          }

          if (Date.now() - lastStuck99LogAt >= 15000) {
            this.log(
              `⏳ Still stuck at 99% (${Math.floor(stuckElapsedMs / 1000)}s / 60s)...`,
              'warn'
            );
            lastStuck99LogAt = Date.now();
            lastGeneratingLogTime = Date.now();
            lastWaitingLogTime = Date.now();
          }
        } else {
          stuckAt99Since = null;
          if (Date.now() - lastGeneratingLogTime >= 10000) {
            this.log(
              `⏳ Top-left card is still generating (${pctLabel})... Waiting until 100% complete.`
            );
            lastGeneratingLogTime = Date.now();
            lastWaitingLogTime = Date.now();
          }
        }
        continue;
      }

      // Reset 99% stuck watchdog whenever Card #0 is no longer generating
      stuckAt99Since = null;

      // 3. Minimum Render Guard (12 Seconds):
      // Never extract or download any video during the first 12 seconds after clicking Send.
      if (elapsedMs < 12000) {
        continue;
      }

      // 4. Require Top-Left Card (#0) to exist, contain rendered media, NOT be generating, and NOT be failed
      if (!topCard || !topCard.found || topCard.isGenerating || topCard.isFailed || !topCard.hasMedia) {
        if (Date.now() - lastWaitingLogTime >= 15000) {
          this.log(`Still waiting for top-left card (#0) video generation... (${elapsedSec}s / ${timeoutSec}s)`);
          lastWaitingLogTime = Date.now();
        }
        continue;
      }

      // 5. Verify Card #0 is genuinely NEW compared to baselineTopCard captured right before Send
      const baselineHasMedia = Boolean(
        baselineTopCard &&
          baselineTopCard.found &&
          (baselineTopCard.imgSrc || baselineTopCard.videoUrl)
      );
      const isSameAsBaselineCard =
        baselineHasMedia && topCard.signature === baselineTopCard.signature;
      const signatureChanged =
        !baselineTopCard || !baselineTopCard.found || topCard.signature !== baselineTopCard.signature;
      const topVideoNotBaseline =
        !topCard.videoUrl ||
        (!knownBaselineUrls.has(topCard.videoUrl) &&
          !knownBaselineNormalizedUrls.has(this.normalizeVideoUrl(topCard.videoUrl)));

      const isGenuinelyNewCard =
        !isSameAsBaselineCard && (sawCardGenerating || (signatureChanged && topVideoNotBaseline));

      if (!isGenuinelyNewCard) {
        if (Date.now() - lastWaitingLogTime >= 15000) {
          this.log(
            `Waiting for new card to replace top-left slot (#0)... (${elapsedSec}s / ${timeoutSec}s)`
          );
          lastWaitingLogTime = Date.now();
        }
        continue;
      }

      // 6A. Check if a new video file was already downloaded into downloadDir / OS Downloads
      const checkNewFolderFile = (dir, knownSet) => {
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir);
        const match = files.find((f) => {
          if (
            knownSet.has(f) ||
            f.endsWith('.crdownload') ||
            f.endsWith('.tmp') ||
            (!f.endsWith('.mp4') && !f.endsWith('.webm'))
          ) {
            return false;
          }
          try {
            const stat = fs.statSync(path.join(dir, f));
            return stat.mtimeMs >= startTime + 10000 && stat.size > 50000;
          } catch (_) {
            return false;
          }
        });
        return match ? { fileName: match, fullPath: path.join(dir, match) } : null;
      };

      const folderMatch =
        checkNewFolderFile(downloadDir, existingFiles) ||
        (path.resolve(osDownloadsDir) !== path.resolve(downloadDir)
          ? checkNewFolderFile(osDownloadsDir, existingOsDownloads)
          : null);

      if (folderMatch) {
        const recheckErr = await this.checkForFlowError(baseSnap);
        if (recheckErr.hasError) {
          const flowErr = new Error('Google Flow Error: ' + recheckErr.reason);
          flowErr.isUnusualActivity = Boolean(recheckErr.isUnusualActivity);
          throw flowErr;
        }
        const fileDlResult = await this._saveGeneratedVideo(
          { type: 'downloaded_file', filePath: folderMatch.fullPath },
          existingFiles,
          downloadDir,
          targetFilePath,
          config
        );
        if (fileDlResult.success) {
          return fileDlResult.filePath;
        }
        if (fileDlResult.duplicate) {
          existingFiles.add(folderMatch.fileName);
          existingOsDownloads.add(folderMatch.fileName);
          await this._interruptibleSleep(3000);
          continue;
        }
      }

      // 6B. Extract Candidate Video URL STRICTLY from Top-Left Card (#0) ONLY
      const liveCfgForDl = this._getLiveConfig();
      const rawConfiguredQuality = String(
        liveCfgForDl?.downloadQuality ||
          this.config?.downloadQuality ||
          config?.downloadQuality ||
          '720p'
      )
        .trim()
        .toLowerCase();
      const targetDownloadQuality = ['720p', '1080p', '2k', '4k'].includes(rawConfiguredQuality)
        ? rawConfiguredQuality
        : '720p';

      let candidateUrl = isFreshCandidateUrl(topCard.videoUrl) ? topCard.videoUrl : null;

      // Tier 2: Auto-hover strictly over Card #0 (topCard.centerX, topCard.centerY)
      if (!candidateUrl && Date.now() - lastHoverAttemptTime >= 4000) {
        lastHoverAttemptTime = Date.now();
        const beforeHoverTime = Date.now();

        this.log(
          `🎬 Top-left card (#0) finished generating! Hovering over Card #0 to load its video source...`
        );
        await this.page.mouse.move(topCard.centerX, topCard.centerY, { steps: 6 });
        await this._interruptibleSleep(1800);

        const postHoverErr = await this.checkForFlowError(baseSnap);
        if (postHoverErr.hasError) {
          const flowErr = new Error('Google Flow Error: ' + postHoverErr.reason);
          flowErr.isUnusualActivity = Boolean(postHoverErr.isUnusualActivity);
          throw flowErr;
        }

        const hoveredCard = await this.inspectTopLeftCard();
        if (checkIsNewTopCardFailure(hoveredCard, elapsedMs)) {
          const flowErr = new Error(
            'Google Flow Error: ' + (hoveredCard.failReason || 'Top-left card failed to generate')
          );
          flowErr.isUnusualActivity = Boolean(hoveredCard.isUnusualActivity);
          throw flowErr;
        }
        if (hoveredCard && hoveredCard.found && hoveredCard.isGenerating) {
          sawCardGenerating = true;
          continue;
        }

        if (hoveredCard && isFreshCandidateUrl(hoveredCard.videoUrl)) {
          candidateUrl = hoveredCard.videoUrl;
          this.log(`Extracted Card #0 video source via hover (${candidateUrl.slice(0, 65)}...)`);
        } else {
          const hoverNetUrl = findNetworkVideoSince(beforeHoverTime);
          if (hoverNetUrl) {
            candidateUrl = hoverNetUrl;
            this.log(
              `Extracted Card #0 network video stream via hover (${candidateUrl.slice(0, 65)}...)`
            );
          }
        }

        // Tier 3: Click strictly on Card #0 to open its preview modal if hover did not expose <video src>
        // (Skipped when targetDownloadQuality !== '720p' so Method 3 opens the detail view once and selects 1080p/2K/4K directly)
        if (!candidateUrl && targetDownloadQuality === '720p') {
          const beforeClickTime = Date.now();
          this.log(`Opening top-left card (#0) preview to extract video stream...`);
          await this.page.mouse.click(topCard.centerX, topCard.centerY);
          await this._interruptibleSleep(2500);

          const postClickErr = await this.checkForFlowError(baseSnap);
          if (postClickErr.hasError) {
            await this.page.keyboard.press('Escape').catch(() => {});
            const flowErr = new Error('Google Flow Error: ' + postClickErr.reason);
            flowErr.isUnusualActivity = Boolean(postClickErr.isUnusualActivity);
            throw flowErr;
          }

          const modalVideoUrl = await extractPreviewModalVideoUrl();
          if (isFreshCandidateUrl(modalVideoUrl)) {
            candidateUrl = modalVideoUrl;
            this.log(
              `Extracted Card #0 video source via preview modal (${candidateUrl.slice(0, 65)}...)`
            );
          } else {
            const clickNetUrl = findNetworkVideoSince(beforeClickTime);
            if (clickNetUrl) {
              candidateUrl = clickNetUrl;
              this.log(
                `Extracted Card #0 network video stream via preview modal (${candidateUrl.slice(
                  0,
                  65
                )}...)`
              );
            }
          }

          // Always close preview modal with Escape and move mouse away from the grid
          await this.page.keyboard.press('Escape').catch(() => {});
          await this._interruptibleSleep(800);
          await this.page.mouse.move(10, 10).catch(() => {});
        }
      }

      // 7. Download, Binary-Validate (ftyp+moov / WebM) & SHA-256 Verify Inside the Polling Loop
      if (candidateUrl) {
        const preDownloadErr = await this.checkForFlowError(baseSnap);
        if (preDownloadErr.hasError) {
          const flowErr = new Error('Google Flow Error: ' + preDownloadErr.reason);
          flowErr.isUnusualActivity = Boolean(preDownloadErr.isUnusualActivity);
          throw flowErr;
        }

        const dlResult = await this._saveGeneratedVideo(
          { type: 'video_url', url: candidateUrl, topCard },
          existingFiles,
          downloadDir,
          targetFilePath,
          config
        );

        if (dlResult.duplicate) {
          rejectedUrlsThisAttempt.add(candidateUrl);
          const normRejected = this.normalizeVideoUrl(candidateUrl);
          if (normRejected) {
            rejectedNormalizedUrlsThisAttempt.add(normRejected);
            this.downloadedNormalizedUrls.add(normRejected);
          }
          await this._interruptibleSleep(3000);
          continue;
        }

        if (dlResult.success && dlResult.filePath) {
          this.previouslyCapturedNetworkUrls.add(candidateUrl);
          return dlResult.filePath;
        }

        this.log(
          `Candidate video from Card #0 did not produce a valid playable file yet; continuing to poll...`,
          'warn'
        );
        await this._interruptibleSleep(2000);
        continue;
      } else if (Date.now() - lastHoverAttemptTime < 3500 && elapsedMs >= 16000) {
        // Card #0 is genuinely new & finished, but hover+preview exposed no direct URL -> try Method C (Native Chrome Download Button)
        const preNativeErr = await this.checkForFlowError(baseSnap);
        if (preNativeErr.hasError) {
          const flowErr = new Error('Google Flow Error: ' + preNativeErr.reason);
          flowErr.isUnusualActivity = Boolean(preNativeErr.isUnusualActivity);
          throw flowErr;
        }

        const nativeDlResult = await this._saveGeneratedVideo(
          { type: 'native_download', topCard },
          existingFiles,
          downloadDir,
          targetFilePath,
          config
        );

        if (nativeDlResult.duplicate) {
          await this._interruptibleSleep(3000);
          continue;
        }

        if (nativeDlResult.success && nativeDlResult.filePath) {
          return nativeDlResult.filePath;
        }
      }

      if (Date.now() - lastWaitingLogTime >= 15000) {
        this.log(`Still waiting for Card #0 video extraction... (${elapsedSec}s / ${timeoutSec}s)`);
        lastWaitingLogTime = Date.now();
      }
    }

    // 180-Second Timeout Safety Net: a 99%-stuck video must NEVER trigger Chrome refresh or retries
    if (lastObservedTopCardPct === 99 || stuckAt99Since !== null) {
      this.log(
        '⏭️ Video remained stuck at 99% at timeout boundary. Skipping WITHOUT refreshing Chrome and moving to next prompt...',
        'warn'
      );
      const skipErr = new Error('Skipped: Video stuck at 99% (> 1 min)');
      skipErr.code = 'STUCK_99_SKIP';
      skipErr.isStuck99Skip = true;
      throw skipErr;
    }

    throw new Error(`Video generation timed out after ${timeoutSec} seconds.`);
  }

  /**
   * Strips any `range=` query parameter from an http(s) URL so Google servers return the full HTTP 200 file.
   */
  _stripRangeQueryParam(rawUrl) {
    const urlStr = String(rawUrl || '').trim();
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      return urlStr;
    }
    try {
      const parsed = new URL(urlStr);
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (key.toLowerCase() === 'range') {
          parsed.searchParams.delete(key);
        }
      }
      return parsed.toString();
    } catch (_) {
      return urlStr;
    }
  }

  /**
   * Fetches all active cookies from Chrome via CDP Network.getAllCookies so cross-subdomain
   * Google auth cookies (.google.com, flow.google.com, labs.google, googleusercontent.com) are preserved.
   */
  async _getAllChromeCookies() {
    let tempClient = null;
    try {
      tempClient = await this.page.target().createCDPSession();
      const { cookies } = await tempClient.send('Network.getAllCookies');
      return Array.isArray(cookies) ? cookies : [];
    } catch (err) {
      this.log(`CDP Network.getAllCookies notice: ${err.message}`, 'warn');
      try {
        return await this.page.cookies();
      } catch (_) {
        return [];
      }
    } finally {
      if (tempClient) {
        await tempClient.detach().catch(() => {});
      }
    }
  }

  /**
   * Formats the matching Cookie header for a specific target URL using Chrome's full cookie jar.
   */
  _buildCookieHeaderForUrl(allCookies, targetUrl) {
    if (!Array.isArray(allCookies) || allCookies.length === 0) return '';
    try {
      const parsed = new URL(targetUrl);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname || '/';
      const isHttps = parsed.protocol === 'https:';
      const nowSec = Date.now() / 1000;

      const matched = [];
      for (const c of allCookies) {
        if (!c || !c.name) continue;
        if (c.secure && !isHttps) continue;
        if (typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec) continue;

        const cookieDomain = String(c.domain || '')
          .replace(/^\./, '')
          .toLowerCase();
        if (!cookieDomain) continue;
        if (host !== cookieDomain && !host.endsWith('.' + cookieDomain)) continue;

        const cookiePath = c.path || '/';
        if (!pathname.startsWith(cookiePath)) continue;

        matched.push(`${c.name}=${c.value}`);
      }
      return matched.join('; ');
    } catch (_) {
      return '';
    }
  }

  /**
   * Saves a verified playable video using a strict 3-tier binary-safe fallback chain:
   * - Method A: Full Un-Ranged Node HTTPS Stream with Chrome CDP Cookies & Redirect Following
   * - Method B: In-Browser Authenticated fetch() -> Blob -> FileReader Base64
   * - Method C: Native Chrome Download Button Fallback (staging folder `.bot_tmp_dl`)
   *
   * Every candidate `.tmp` file MUST pass `validatePlayableVideoFile` (real MP4 `ftyp`+`moov` or WebM)
   * AND SHA-256 deduplication before being renamed to its final `.mp4` (or `.webm`) path.
   */
  async _saveGeneratedVideo(generationResult, existingFiles, downloadDir, targetFilePath, config) {
    const tempPath = `${targetFilePath}.tmp`;

    const cleanupTemp = () => {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_) {}
    };

    const resolveFinalPathForFormat = (format) => {
      const ext = format === 'webm' ? '.webm' : '.mp4';
      const parsed = path.parse(targetFilePath);
      const baseWithoutExt =
        parsed.ext.toLowerCase() === '.mp4' || parsed.ext.toLowerCase() === '.webm'
          ? parsed.name
          : parsed.base;
      return path.join(parsed.dir, `${baseWithoutExt}${ext}`);
    };

    const verifyAndCommitTempFile = (sourceUrl = '', methodLabel = '') => {
      const validation = this.validatePlayableVideoFile(tempPath);
      if (!validation.valid) {
        cleanupTemp();
        const tag = methodLabel ? `[${methodLabel}] ` : '';
        this.log(
          `⚠️ ${tag}Rejected invalid/corrupt download (${validation.reason}). Trying next download method...`,
          'warn'
        );
        return { success: false, duplicate: false, invalid: true, reason: validation.reason };
      }

      const fileBuffer = fs.readFileSync(tempPath);
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      if (this.downloadedHashes.has(fileHash)) {
        cleanupTemp();
        this.log(
          '⚠️ Duplicate video content detected (matches a previously downloaded video). Rejecting duplicate and continuing to wait for the new video...',
          'warn'
        );
        return { success: false, duplicate: true };
      }

      const finalOutputPath = resolveFinalPathForFormat(validation.format);
      try {
        if (fs.existsSync(finalOutputPath)) {
          fs.unlinkSync(finalOutputPath);
        }
        fs.renameSync(tempPath, finalOutputPath);
      } catch (_) {
        fs.copyFileSync(tempPath, finalOutputPath);
        cleanupTemp();
      }

      this.downloadedHashes.add(fileHash);
      if (sourceUrl) {
        const normUrl = this.normalizeVideoUrl(sourceUrl);
        if (normUrl) {
          this.downloadedNormalizedUrls.add(normUrl);
        }
      }

      const viaNote = methodLabel ? ` via ${methodLabel}` : '';
      this.log(
        `✅ Verified playable ${validation.format.toUpperCase()} video${viaNote} (${Math.round(
          validation.size / 1024
        )} KB, SHA-256: ${fileHash.slice(0, 12)}...)`,
        'success'
      );
      return { success: true, duplicate: false, filePath: finalOutputPath };
    };

    cleanupTemp();

    // Pre-existing auto-downloaded file verification path
    if (generationResult.type === 'downloaded_file' && fs.existsSync(generationResult.filePath)) {
      try {
        fs.copyFileSync(generationResult.filePath, tempPath);
        const result = verifyAndCommitTempFile('', 'Folder Download');
        if (result.success) {
          if (path.resolve(generationResult.filePath) !== path.resolve(result.filePath)) {
            try {
              fs.unlinkSync(generationResult.filePath);
            } catch (_) {}
          }
          return result;
        }
        if (result.duplicate) {
          if (
            downloadDir &&
            path.resolve(path.dirname(generationResult.filePath)) === path.resolve(downloadDir)
          ) {
            try {
              fs.unlinkSync(generationResult.filePath);
            } catch (_) {}
          }
          return result;
        }
      } catch (err) {
        cleanupTemp();
        this.log(`Downloaded file verification error: ${err.message}`, 'warn');
      }
      return { success: false, duplicate: false };
    }

    const rawVideoUrl = generationResult.url || '';
    const cleanUrl = this._stripRangeQueryParam(rawVideoUrl);

    const liveCfg = this._getLiveConfig();
    const rawTargetQuality = String(
      liveCfg?.downloadQuality ||
        this.config?.downloadQuality ||
        config?.downloadQuality ||
        '720p'
    )
      .trim()
      .toLowerCase();
    const targetQuality = ['720p', '1080p', '2k', '4k'].includes(rawTargetQuality)
      ? rawTargetQuality
      : '720p';

    const runMethod3NativeDownload = async () => {
      try {
        const downloadedStagedFile = await this._downloadViaNativeChromeButton(
          downloadDir,
          config,
          generationResult.topCard || null
        );
        if (downloadedStagedFile && fs.existsSync(downloadedStagedFile)) {
          fs.copyFileSync(downloadedStagedFile, tempPath);
          const resultC = verifyAndCommitTempFile(
            rawVideoUrl,
            `Method 3 (Native Chrome Download — ${targetQuality.toUpperCase()})`
          );
          try {
            fs.unlinkSync(downloadedStagedFile);
          } catch (_) {}
          if (resultC.success || resultC.duplicate) {
            return resultC;
          }
        } else {
          const timeoutLabel = targetQuality !== '720p' ? '150s' : '45s';
          this.log(
            `Method 3 (Native Chrome Download) did not capture a downloaded file within ${timeoutLabel}.`,
            'warn'
          );
        }
      } catch (errC) {
        cleanupTemp();
        this.log(`Method 3 (Native Chrome Download) error: ${errC.message}`, 'warn');
      }
      return null;
    };

    // When an upscaled resolution (1080p / 2K / 4K) is selected, run Method 3 FIRST so Google Flow's
    // download quality menu is used (the inline card preview stream is only 720p).
    if (targetQuality !== '720p') {
      const upscaledResult = await runMethod3NativeDownload();
      if (upscaledResult && (upscaledResult.success || upscaledResult.duplicate)) {
        return upscaledResult;
      }
    }

    // -------------------------------------------------------------------------
    // METHOD A: Full Un-Ranged Node HTTPS Stream with Chrome CDP Cookies & Redirect Following
    // -------------------------------------------------------------------------
    if (cleanUrl && (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://'))) {
      try {
        this.log(`Method A: Downloading full un-ranged binary stream via Node HTTPS + Chrome cookies...`);
        const allCookies = await this._getAllChromeCookies();
        const userAgent = await this.page.evaluate(() => navigator.userAgent);
        await this._downloadUrlViaNode(cleanUrl, tempPath, allCookies, userAgent, 0);
        const resultA = verifyAndCommitTempFile(rawVideoUrl, 'Method A (Node HTTPS)');
        if (resultA.success || resultA.duplicate) {
          return resultA;
        }
      } catch (errA) {
        cleanupTemp();
        this.log(`Method A (Node HTTPS) failed: ${errA.message}. Falling back to Method B...`, 'warn');
      }
    }

    // -------------------------------------------------------------------------
    // METHOD B: In-Browser Authenticated fetch() -> Blob -> FileReader Base64
    // (Handles blob: URLs and strict cookie/TLS-bound endpoints)
    // -------------------------------------------------------------------------
    if (cleanUrl) {
      try {
        this.log(`Method B: Fetching full video Blob in browser via authenticated fetch() + FileReader...`);
        const fetchResult = await this.page.evaluate(async (videoUrl) => {
          try {
            const resp = await fetch(videoUrl, { credentials: 'include', cache: 'no-store' });
            if (!resp.ok) {
              return { ok: false, error: `HTTP ${resp.status}` };
            }
            const ct = (resp.headers.get('content-type') || '').toLowerCase();
            if (ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/xml')) {
              return { ok: false, error: `Got ${ct} instead of video` };
            }
            const blob = await resp.blob();
            if (!blob || blob.size < 50000) {
              return { ok: false, error: `Blob too small (${blob ? blob.size : 0} bytes)` };
            }
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('FileReader readAsDataURL failed'));
              reader.readAsDataURL(blob);
            });
            if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) {
              return { ok: false, error: 'Invalid FileReader data URL output' };
            }
            return { ok: true, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
          } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
          }
        }, cleanUrl);

        if (fetchResult && fetchResult.ok && fetchResult.base64) {
          fs.writeFileSync(tempPath, Buffer.from(fetchResult.base64, 'base64'));
          const resultB = verifyAndCommitTempFile(rawVideoUrl, 'Method B (Browser Fetch)');
          if (resultB.success || resultB.duplicate) {
            return resultB;
          }
        } else {
          this.log(
            `Method B (Browser Fetch) failed: ${
              (fetchResult && fetchResult.error) || 'Empty response'
            }. Falling back to Method 3...`,
            'warn'
          );
        }
      } catch (errB) {
        cleanupTemp();
        this.log(`Method B (Browser Fetch) error: ${errB.message}. Falling back to Method 3...`, 'warn');
      }
    }

    // -------------------------------------------------------------------------
    // METHOD 3 (METHOD C): Native Chrome Download Button + Quality Menu Selection
    // -------------------------------------------------------------------------
    if (targetQuality === '720p') {
      const method3Result = await runMethod3NativeDownload();
      if (method3Result && (method3Result.success || method3Result.duplicate)) {
        return method3Result;
      }
    }

    cleanupTemp();
    return { success: false, duplicate: false };
  }

  /**
   * Method A worker: Downloads a full un-ranged binary stream via Node http/https,
   * matching Chrome cookies dynamically per redirect hop (up to 10 redirects),
   * strictly rejecting non-200 or text/html responses, and piping raw binary bytes to destPath.
   */
  _downloadUrlViaNode(url, destPath, allCookies = [], userAgent = '', redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (redirectCount > 10) {
        return reject(new Error('Too many redirects (>10) while downloading video'));
      }

      const lowerUrl = String(url || '').toLowerCase();
      if (
        lowerUrl.includes('accounts.google.com/v3/signin') ||
        lowerUrl.includes('accounts.google.com/servicelogin') ||
        lowerUrl.includes('accounts.google.com/interactive')
      ) {
        return reject(new Error('Redirected to Google Sign-In page instead of video binary'));
      }

      const cookieHeader = Array.isArray(allCookies)
        ? this._buildCookieHeaderForUrl(allCookies, url)
        : String(allCookies || '');

      const headers = {
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://flow.google.com/',
        Accept: '*/*'
      };
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { headers }, (res) => {
        const status = res.statusCode || 0;
        const redirectStatuses = [301, 302, 303, 307, 308];
        if (redirectStatuses.includes(status) && res.headers.location) {
          res.resume();
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, url).toString();
          } catch (_) {
            return reject(new Error(`Invalid redirect location: ${res.headers.location}`));
          }
          return this._downloadUrlViaNode(nextUrl, destPath, allCookies, userAgent, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        }

        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP status ${status} (expected 200 full video stream)`));
        }

        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        if (
          contentType.startsWith('text/html') ||
          contentType.includes('text/html') ||
          contentType.includes('application/json') ||
          contentType.includes('text/xml')
        ) {
          res.resume();
          return reject(new Error(`Server returned non-video Content-Type: ${contentType}`));
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);

        res.on('error', (err) => {
          fileStream.destroy();
          fs.unlink(destPath, () => {});
          reject(err);
        });

        fileStream.on('finish', () => {
          fileStream.close(() => resolve());
        });

        fileStream.on('error', (err) => {
          res.resume();
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });

      req.setTimeout(60000, () => {
        req.destroy(new Error('Node HTTPS download timed out after 60s'));
      });

      req.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  }

  /**
   * Method 3 (Method C) worker: Configures CDP downloads into `<outputDir>/.bot_tmp_dl`,
   * clicks the completed video card (#0) to open the detail view, clicks the top toolbar Download button,
   * selects the configured resolution ('720p', '1080p', '2k', or '4k') from Google Flow's download quality menu,
   * waits up to 150s (for upscaled 1080p/2K/4K) or 45s (for 720p) polling every 500ms for the completed .mp4 file,
   * and cleanly closes the video detail view.
   */
  async _downloadViaNativeChromeButton(downloadDir, config, cachedTopCard = null) {
    const liveCfg = this._getLiveConfig();
    const rawQuality = String(
      liveCfg?.downloadQuality ||
        this.config?.downloadQuality ||
        config?.downloadQuality ||
        '720p'
    )
      .trim()
      .toLowerCase();
    const targetQuality = ['720p', '1080p', '2k', '4k'].includes(rawQuality)
      ? rawQuality
      : '720p';

    this.log(`📥 Downloading video in ${targetQuality.toUpperCase()} quality (Method 3)...`);

    const stagingDir = path.join(downloadDir, '.bot_tmp_dl');
    const osDownloadsDir = path.join(os.homedir(), 'Downloads');
    fs.mkdirSync(stagingDir, { recursive: true });

    const existingStaged = new Set(fs.readdirSync(stagingDir));
    const existingOsFiles = fs.existsSync(osDownloadsDir)
      ? new Set(fs.readdirSync(osDownloadsDir))
      : new Set();

    const methodStartTime = Date.now();
    let dlCdpSession = null;

    const findDownloadButtonCoords = async (scopeRect = null) => {
      return this.page.evaluate(
        (userSelector, rectFilter) => {
          const isVisible = (el) => {
            if (!el) return false;
            try {
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                Number(style.opacity) === 0
              ) {
                return false;
              }
              const r = el.getBoundingClientRect();
              return (
                r.width >= 16 &&
                r.height >= 16 &&
                r.right > 0 &&
                r.bottom > 0 &&
                r.left < window.innerWidth &&
                r.top < window.innerHeight
              );
            } catch (_) {
              return false;
            }
          };

          const queryAllDeep = (root, selector) => {
            const matched = [];
            try {
              root.querySelectorAll(selector).forEach((el) => matched.push(el));
            } catch (_) {}
            let all = [];
            try {
              all = root.querySelectorAll('*');
            } catch (_) {}
            for (const node of all) {
              if (node.shadowRoot) {
                matched.push(...queryAllDeep(node.shadowRoot, selector));
              }
            }
            return matched;
          };

          for (const old of queryAllDeep(document, '[data-bot-dl-trigger]')) {
            old.removeAttribute('data-bot-dl-trigger');
          }

          const matchesDownload = (el) => {
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            const hasDownloadAttr = el.hasAttribute('download');
            return (
              hasDownloadAttr ||
              aria.includes('download') ||
              title.includes('download') ||
              text === 'download' ||
              text === 'file_download' ||
              text.includes('file_download') ||
              /\bdownload\b/.test(text)
            );
          };

          const inScope = (el) => {
            const r = el.getBoundingClientRect();
            if (!rectFilter) {
              // Exclude bottom composer bar controls when looking for the detail view top toolbar Download button
              return r.top < window.innerHeight - 110;
            }
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            return (
              cx >= rectFilter.left - 25 &&
              cx <= rectFilter.left + rectFilter.width + 25 &&
              cy >= rectFilter.top - 25 &&
              cy <= rectFilter.top + rectFilter.height + 25
            );
          };

          // Prefer buttons inside an active modal/dialog overlay or top detail toolbar when not restricted to a card rect
          const roots = rectFilter
            ? [document]
            : [
                ...queryAllDeep(
                  document,
                  '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane, dialog'
                ),
                document
              ];

          for (const root of roots) {
            const direct = [
              ...queryAllDeep(
                root,
                userSelector || "button[aria-label*='Download'], a[download]"
              ),
              ...queryAllDeep(
                root,
                "button[aria-label*='download' i], a[download], button[title*='download' i]"
              )
            ].filter((el) => isVisible(el) && inScope(el));

            if (direct.length > 0) {
              direct.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
              const chosen = direct[0];
              chosen.setAttribute('data-bot-dl-trigger', 'true');
              const r = chosen.getBoundingClientRect();
              return {
                found: true,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                label:
                  chosen.getAttribute('aria-label') ||
                  (chosen.innerText || '').trim().slice(0, 40) ||
                  'Download'
              };
            }

            const allBtns = queryAllDeep(root, 'button, a, [role="button"]').filter(
              (el) => isVisible(el) && inScope(el) && matchesDownload(el)
            );
            if (allBtns.length > 0) {
              allBtns.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
              const chosen = allBtns[0];
              chosen.setAttribute('data-bot-dl-trigger', 'true');
              const r = chosen.getBoundingClientRect();
              return {
                found: true,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                label:
                  chosen.getAttribute('aria-label') ||
                  (chosen.innerText || '').trim().slice(0, 40) ||
                  'Download'
              };
            }
          }

          return { found: false };
        },
        config.downloadButtonSelector || "button[aria-label*='Download'], a[download]",
        scopeRect
      );
    };

    const inspectQualityPopover = async (desiredQuality) => {
      return this.page
        .evaluate((targetQ) => {
          const queryAllDeep = (root, selector) => {
            const matched = [];
            try {
              root.querySelectorAll(selector).forEach((el) => matched.push(el));
            } catch (_) {}
            let all = [];
            try {
              all = root.querySelectorAll('*');
            } catch (_) {}
            for (const node of all) {
              if (node.shadowRoot) {
                matched.push(...queryAllDeep(node.shadowRoot, selector));
              }
            }
            return matched;
          };

          for (const old of queryAllDeep(document, '[data-bot-dl-quality-option]')) {
            old.removeAttribute('data-bot-dl-quality-option');
          }

          const isVisible = (el) => {
            if (!el) return false;
            try {
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                parseFloat(style.opacity || '1') <= 0.05
              ) {
                return false;
              }
              const r = el.getBoundingClientRect();
              return (
                r.width >= 30 &&
                r.height >= 16 &&
                r.right > 0 &&
                r.bottom > 0 &&
                r.left < window.innerWidth &&
                r.top < window.innerHeight
              );
            } catch (_) {
              return false;
            }
          };

          const isOptionEnabled = (el) => {
            let cur = el;
            for (let d = 0; d < 4 && cur && cur !== document.body; d++) {
              if (
                cur.disabled === true ||
                cur.hasAttribute('disabled') ||
                cur.getAttribute('aria-disabled') === 'true' ||
                cur.getAttribute('data-disabled') !== null
              ) {
                return false;
              }
              const st = window.getComputedStyle(cur);
              if (st.pointerEvents === 'none' || parseFloat(st.opacity || '1') < 0.38) {
                return false;
              }
              cur = cur.parentElement;
            }
            return true;
          };

          const resPatterns = {
            '720p': /720p|original/i,
            '1080p': /1080p/i,
            '2k': /\b2k\b|1440p/i,
            '4k': /\b4k\b|2160p/i
          };

          const getMatchedBuckets = (text) => {
            const matched = [];
            for (const [key, rx] of Object.entries(resPatterns)) {
              if (rx.test(text)) matched.push(key);
            }
            return matched;
          };

          // 1. Locate visible quality dropdown/popover/menu containers
          const standardMenus = queryAllDeep(
            document,
            '[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], .cdk-overlay-pane, .mat-mdc-menu-panel'
          ).filter((el) => {
            if (!isVisible(el)) return false;
            const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            return getMatchedBuckets(txt).length >= 1;
          });

          const floatingLists = queryAllDeep(document, 'div, ul, section').filter((el) => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 60 || r.width > 540 || r.height < 40 || r.height > 560) return false;
            const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            return getMatchedBuckets(txt).length >= 2;
          });

          const menuRoots = [...standardMenus, ...floatingLists];
          if (menuRoots.length === 0) {
            return { menuOpen: false };
          }

          // 2. Scan all visible clickable menu items inside the open menu/popover
          const seenElements = new Set();
          const optionRows = [];

          for (const root of menuRoots) {
            const candidates = queryAllDeep(
              root,
              '[role="menuitem"], [role="option"], [role="menuitemradio"], button, li, a, div[tabindex], div'
            );
            for (const rawEl of candidates) {
              if (!isVisible(rawEl)) continue;
              const rawTxt = (rawEl.innerText || rawEl.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();
              if (!rawTxt || rawTxt.length > 140) continue;

              // Exclude GIF or audio-only download items
              if (/\bgif\b|270p|audio only/i.test(rawTxt)) continue;

              const buckets = getMatchedBuckets(rawTxt);
              // Must match strictly 1 resolution bucket so we never pick a parent container wrapping multiple options
              if (buckets.length !== 1) continue;
              const bucket = buckets[0];

              // Prefer the interactive ancestor ([role="menuitem"], [role="option"], button, li, a, [tabindex]) if it also matches strictly 1 bucket
              let targetEl = rawEl;
              const interactiveParent = rawEl.closest(
                '[role="menuitem"], [role="option"], [role="menuitemradio"], button, li, a, [tabindex]'
              );
              if (interactiveParent && root.contains(interactiveParent) && isVisible(interactiveParent)) {
                const parentTxt = (interactiveParent.innerText || interactiveParent.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim();
                if (
                  getMatchedBuckets(parentTxt).length === 1 &&
                  !/\bgif\b|270p|audio only/i.test(parentTxt)
                ) {
                  targetEl = interactiveParent;
                }
              }

              if (seenElements.has(targetEl)) continue;
              seenElements.add(targetEl);

              const r = targetEl.getBoundingClientRect();
              if (r.width < 30 || r.width > 480 || r.height < 16 || r.height > 110) continue;

              const label = (targetEl.innerText || targetEl.textContent || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 60);
              const isInteractiveTag = Boolean(
                targetEl.matches(
                  '[role="menuitem"], [role="option"], [role="menuitemradio"], button, li, a, [tabindex]'
                )
              );

              optionRows.push({
                el: targetEl,
                bucket,
                enabled: isOptionEnabled(targetEl),
                isInteractiveTag,
                area: r.width * r.height,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                label
              });
            }
          }

          if (optionRows.length === 0) {
            return { menuOpen: false };
          }

          // Sort so true interactive menu item tags and larger row targets come before inner text spans
          optionRows.sort((a, b) => {
            if (a.isInteractiveTag !== b.isInteractiveTag) {
              return a.isInteractiveTag ? -1 : 1;
            }
            return b.area - a.area;
          });

          // Check for the requested targetQuality first
          const exactEnabled = optionRows.find((o) => o.bucket === targetQ && o.enabled);
          if (exactEnabled) {
            exactEnabled.el.setAttribute('data-bot-dl-quality-option', 'true');
            return {
              menuOpen: true,
              matched: true,
              fallbackUsed: false,
              x: exactEnabled.x,
              y: exactEnabled.y,
              label: exactEnabled.label
            };
          }

          // Requested quality is disabled or not listed -> fall back to 720p (Original) or highest available enabled resolution
          const fallbackOrder = ['720p', '2k', '1080p', '4k'];
          for (const fbKey of fallbackOrder) {
            const fbMatch = optionRows.find((o) => o.bucket === fbKey && o.enabled);
            if (fbMatch) {
              fbMatch.el.setAttribute('data-bot-dl-quality-option', 'true');
              return {
                menuOpen: true,
                matched: false,
                fallbackUsed: true,
                x: fbMatch.x,
                y: fbMatch.y,
                label: fbMatch.label
              };
            }
          }

          return { menuOpen: true, matched: false, fallbackUsed: false };
        }, desiredQuality)
        .catch(() => ({ menuOpen: false }));
    };

    const hasAnyDownloadActivity = () => {
      const checkDir = (dir, knownSet) => {
        if (!fs.existsSync(dir)) return false;
        const files = fs.readdirSync(dir);
        return files.some((f) => {
          if (knownSet.has(f)) return false;
          if (f.endsWith('.crdownload')) return true;
          if (f.endsWith('.tmp')) return false;
          try {
            const st = fs.statSync(path.join(dir, f));
            return st.isFile() && st.mtimeMs >= methodStartTime - 2000 && st.size > 50000;
          } catch (_) {
            return false;
          }
        });
      };
      return checkDir(stagingDir, existingStaged) || checkDir(osDownloadsDir, existingOsFiles);
    };

    const clickQualityMenuIfOpened = async () => {
      await this._interruptibleSleep(650);
      let menuRes = await inspectQualityPopover(targetQuality);

      // If no quality popover detected yet and no direct download started, wait briefly / retry trigger click once
      if ((!menuRes || !menuRes.menuOpen) && !hasAnyDownloadActivity()) {
        await this._interruptibleSleep(550);
        menuRes = await inspectQualityPopover(targetQuality);
      }
      if ((!menuRes || !menuRes.menuOpen) && !hasAnyDownloadActivity()) {
        await this.page
          .evaluate(() => {
            const btn = document.querySelector('[data-bot-dl-trigger="true"]');
            if (btn && typeof btn.click === 'function') btn.click();
          })
          .catch(() => {});
        await this._interruptibleSleep(650);
        menuRes = await inspectQualityPopover(targetQuality);
      }

      if (!menuRes || !menuRes.menuOpen) {
        return;
      }

      if (menuRes.fallbackUsed) {
        this.log(
          `⚠️ Quality "${targetQuality.toUpperCase()}" is unavailable/disabled for this video — falling back to 720p (Original)...`,
          'warn'
        );
      }

      if (Number.isFinite(menuRes.x) && Number.isFinite(menuRes.y)) {
        await this.humanMoveAndClick(menuRes.x, menuRes.y);
        await this._interruptibleSleep(450);

        // Direct .click() fallback if the quality menu remained open
        const stillOpenCheck = await inspectQualityPopover(targetQuality);
        if (stillOpenCheck && stillOpenCheck.menuOpen) {
          await this.page
            .evaluate(() => {
              const opt = document.querySelector('[data-bot-dl-quality-option="true"]');
              if (opt && typeof opt.click === 'function') opt.click();
            })
            .catch(() => {});
          await this._interruptibleSleep(350);
        }

        this.log(
          `✅ Selected "${menuRes.label}" from Google Flow download quality menu.`,
          'success'
        );
      }
    };

    const clickSecondaryUpscaleDownloadToastIfPresent = async () => {
      return this.page
        .evaluate(() => {
          const isVisible = (el) => {
            if (!el) return false;
            try {
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                parseFloat(style.opacity || '1') <= 0.05
              ) {
                return false;
              }
              const r = el.getBoundingClientRect();
              return r.width > 16 && r.height > 14;
            } catch (_) {
              return false;
            }
          };

          const toasts = Array.from(
            document.querySelectorAll(
              '[role="alert"], [role="status"], .mat-mdc-snack-bar-container, [class*="toast" i], [class*="snackbar" i], [class*="notification" i]'
            )
          ).filter(isVisible);

          for (const t of toasts) {
            const btns = Array.from(t.querySelectorAll('button, a, [role="button"]')).filter(
              isVisible
            );
            for (const b of btns) {
              const txt = (
                (b.innerText || b.textContent || '') +
                ' ' +
                (b.getAttribute('aria-label') || '')
              )
                .trim()
                .toLowerCase();
              if (txt.includes('download')) {
                b.click();
                return true;
              }
            }
          }
          return false;
        })
        .catch(() => false);
    };

    try {
      dlCdpSession = await this.page.target().createCDPSession();
      const resolvedStaging = path.resolve(stagingDir);
      await dlCdpSession
        .send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: resolvedStaging,
          eventsEnabled: true
        })
        .catch(() => {});
      await dlCdpSession
        .send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: resolvedStaging
        })
        .catch(() => {});

      const card0 =
        cachedTopCard && cachedTopCard.found ? cachedTopCard : await this.inspectTopLeftCard();

      let triggered = false;

      // Primary Method 3 Flow: Click Card #0 to open video detail view and click top toolbar Download button
      if (card0 && card0.found) {
        this.log(`Opening Card #0 detail view to click top toolbar Download button...`);
        await this.page.mouse.click(card0.centerX, card0.centerY);
        await this._interruptibleSleep(2200);

        const modalBtn = await findDownloadButtonCoords(null);
        if (modalBtn && modalBtn.found) {
          this.log(`Clicking top toolbar Download button ("${modalBtn.label}")...`);
          await this.page.mouse.click(modalBtn.x, modalBtn.y, { delay: 50 });
          await clickQualityMenuIfOpened();
          triggered = true;
        }
      }

      // Fallback: Hover Card #0 to reveal its inline Download button if detail view button wasn't found
      if (!triggered && card0 && card0.found) {
        await this.page.mouse.move(card0.centerX, card0.centerY, { steps: 6 });
        await this._interruptibleSleep(1200);

        const hoverBtn = await findDownloadButtonCoords({
          left: card0.left,
          top: card0.top,
          width: card0.width,
          height: card0.height
        });
        if (hoverBtn && hoverBtn.found) {
          this.log(`Clicking native Download button on Card #0 ("${hoverBtn.label}")...`);
          await this.page.mouse.click(hoverBtn.x, hoverBtn.y, { delay: 50 });
          await clickQualityMenuIfOpened();
          triggered = true;
        }
      }

      if (!triggered) {
        return null;
      }

      // Extend wait timeout to 150,000ms (2.5 minutes) for upscaled resolutions (1080p, 2K, 4K),
      // keeping 45,000ms for 720p, and poll every 500ms so it finishes immediately when .mp4 completes
      const isUpscaledResolution = targetQuality !== '720p';
      const waitTimeoutMs = isUpscaledResolution ? 150000 : 45000;
      const waitDeadline = Date.now() + waitTimeoutMs;
      let lastSeenPath = null;
      let lastSeenSize = -1;
      let lastSecondaryToastCheckAt = Date.now();
      let lastUpscaleProgressLogAt = Date.now();

      while (Date.now() < waitDeadline) {
        if (this.state === BOT_STATES.STOPPED) {
          return null;
        }

        const scanDirForCompleted = (dir, knownSet) => {
          if (!fs.existsSync(dir)) return { hasPending: false, file: null };
          const files = fs.readdirSync(dir);
          const hasPending = files.some((f) => !knownSet.has(f) && f.endsWith('.crdownload'));
          if (hasPending) return { hasPending: true, file: null };

          for (const f of files) {
            if (knownSet.has(f) || f.endsWith('.crdownload') || f.endsWith('.tmp')) continue;
            const fullPath = path.join(dir, f);
            try {
              const st = fs.statSync(fullPath);
              if (st.isFile() && st.mtimeMs >= methodStartTime - 2000 && st.size > 50000) {
                return { hasPending: false, file: fullPath, size: st.size };
              }
            } catch (_) {}
          }
          return { hasPending: false, file: null };
        };

        const stagedScan = scanDirForCompleted(stagingDir, existingStaged);
        const osScan =
          !stagedScan.hasPending && !stagedScan.file
            ? scanDirForCompleted(osDownloadsDir, existingOsFiles)
            : { hasPending: false, file: null };

        const found = stagedScan.file ? stagedScan : osScan.file ? osScan : null;
        if (found && found.file) {
          if (lastSeenPath === found.file && lastSeenSize === found.size) {
            return found.file;
          }
          lastSeenPath = found.file;
          lastSeenSize = found.size;
        } else if (!stagedScan.hasPending && !osScan.hasPending) {
          // While waiting for server-side upscaling before .crdownload begins, check for any secondary Download button toast
          if (Date.now() - lastSecondaryToastCheckAt >= 2500) {
            lastSecondaryToastCheckAt = Date.now();
            const clickedToastBtn = await clickSecondaryUpscaleDownloadToastIfPresent();
            if (clickedToastBtn) {
              this.log(
                '📥 Clicked secondary Download button on upscaling completion notification.',
                'info'
              );
            }
          }
          if (isUpscaledResolution && Date.now() - lastUpscaleProgressLogAt >= 15000) {
            lastUpscaleProgressLogAt = Date.now();
            const waitedSec = Math.round((Date.now() - methodStartTime) / 1000);
            this.log(
              `⏳ Waiting for Google Flow ${targetQuality.toUpperCase()} upscaling & download... (${waitedSec}s / ${Math.round(
                waitTimeoutMs / 1000
              )}s)`
            );
          }
        }

        await this._interruptibleSleep(500);
      }

      return null;
    } finally {
      await this.page
        .evaluate(() => {
          document
            .querySelectorAll('[data-bot-dl-trigger], [data-bot-dl-quality-option]')
            .forEach((el) => {
              el.removeAttribute('data-bot-dl-trigger');
              el.removeAttribute('data-bot-dl-quality-option');
            });
        })
        .catch(() => {});
      await this.page.keyboard.press('Escape').catch(() => {});
      await this._interruptibleSleep(600);
      await this.page.mouse.move(10, 10).catch(() => {});

      if (dlCdpSession) {
        await dlCdpSession.detach().catch(() => {});
      }
      await this._configureDownloadBehavior(downloadDir).catch(() => {});
    }
  }

  /**
   * Clicks the newest visible Download button on the page.
   */
  async _clickDownloadButton(downloadSelector) {
    return this.page.evaluate((userSelector) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 10 && rect.height > 10;
      };

      const queryAllDeep = (root, selector) => {
        const matched = [];
        try {
          root.querySelectorAll(selector).forEach((el) => matched.push(el));
        } catch (_) {
          // Ignore invalid selector
        }
        const all = root.querySelectorAll('*');
        for (const node of all) {
          if (node.shadowRoot) {
            matched.push(...queryAllDeep(node.shadowRoot, selector));
          }
        }
        return matched;
      };

      const candidates = [
        ...queryAllDeep(document, userSelector || "button[aria-label*='Download'], a[download]"),
        ...queryAllDeep(
          document,
          "button[aria-label*='download' i], a[download], button[title*='download' i]"
        )
      ].filter(isVisible);

      if (candidates.length > 0) {
        candidates[0].click();
        return true;
      }

      // Check buttons with text or icon "download"
      const allBtns = queryAllDeep(document, 'button, a, [role="button"]').filter(isVisible);
      const dlBtn = allBtns.find((b) => {
        const t = (b.innerText || b.textContent || '').toLowerCase();
        return t.includes('download') || t.includes('file_download');
      });

      if (dlBtn) {
        dlBtn.click();
        return true;
      }

      return false;
    }, downloadSelector);
  }

  /**
   * Waits for a new file to finish downloading inside downloadDir.
   */
  async _waitForFolderDownload(existingFiles, downloadDir, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(downloadDir)) {
        const files = fs.readdirSync(downloadDir);
        const hasCrDownload = files.some((f) => f.endsWith('.crdownload'));
        const newFile = files.find(
          (f) =>
            !existingFiles.has(f) &&
            !f.endsWith('.crdownload') &&
            !f.endsWith('.tmp')
        );
        if (newFile && !hasCrDownload) {
          return path.join(downloadDir, newFile);
        }
      }
      await this._interruptibleSleep(1000);
    }
    return null;
  }

  /**
   * Generates a clean sequential filename, truncating the sanitized base name to max 55 chars
   * BEFORE strictly appending `.mp4`:
   * - If totalVideos === 1: 001_sanitized_prompt_name.mp4
   * - If totalVideos > 1:  001_v1_sanitized_prompt_name.mp4, 001_v2_sanitized_prompt_name.mp4
   */
  _buildSequentialFilename(sequenceNumber, promptText, variationIndex = 1, totalVideos = 1) {
    const prefix = String(sequenceNumber).padStart(3, '0');
    const sanitized = String(promptText || 'video')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '_');

    const safeBase =
      sanitized
        .slice(0, 55)
        .replace(/[._\s-]+$/, '')
        .replace(/^_+/, '') || 'flow_video';

    if (totalVideos > 1) {
      return `${prefix}_v${variationIndex}_${safeBase}.mp4`;
    }
    return `${prefix}_${safeBase}.mp4`;
  }
}

module.exports = {
  FlowController,
  flowController: new FlowController(),
  BOT_STATES,
  PROMPT_STATUS
};
