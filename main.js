const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const chromeLauncher = require('./src/bot/chromeLauncher');
const configManager = require('./src/bot/configManager');
const { FlowController } = require('./src/bot/flowController');
const { ChatGPTController } = require('./src/bot/chatgptController');
const { ZeeFlowController } = require('./src/bot/zeeflowController');
const { MobileRemoteServer } = require('./src/bot/mobileRemoteServer');
const updater = require('./src/updater');

// Per-window isolated context registry: webContents.id -> windowContext
const windowContexts = new Map();
let updaterInitialized = false;
let mobileRemoteServer = null;

/**
 * Path to active-instances.json inside the shared storage directory.
 */
function getActiveInstancesFilePath() {
  const dir = configManager.storageDir || app.getPath('userData');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'active-instances.json');
}

/**
 * Checks if an OS process PID is currently alive.
 */
function isPidAlive(pid) {
  const numPid = Number(pid);
  if (!Number.isFinite(numPid) || numPid <= 0) return false;
  if (numPid === process.pid) return true;
  try {
    process.kill(numPid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists on Windows/POSIX even if owned by another privilege token
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * Reads and prunes stale entries from active-instances.json.
 */
function readAndPruneActiveInstances() {
  const filePath = getActiveInstancesFilePath();
  let rawMap = {};
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        rawMap = parsed;
      }
    }
  } catch (_) {
    rawMap = {};
  }

  const activeWindowIdsInThisProcess = new Set();
  for (const ctx of windowContexts.values()) {
    if (ctx && ctx.win && !ctx.win.isDestroyed()) {
      activeWindowIdsInThisProcess.add(ctx.windowId);
    }
  }

  const cleaned = {};
  let pruned = false;

  for (const [slotKey, info] of Object.entries(rawMap)) {
    const slotNum = parseInt(slotKey, 10);
    if (!Number.isFinite(slotNum) || slotNum < 1 || !info || typeof info !== 'object') {
      pruned = true;
      continue;
    }

    if (!isPidAlive(info.pid)) {
      pruned = true;
      continue;
    }

    if (
      Number(info.pid) === process.pid &&
      info.windowId !== undefined &&
      info.windowId !== null &&
      !activeWindowIdsInThisProcess.has(info.windowId)
    ) {
      pruned = true;
      continue;
    }

    cleaned[String(slotNum)] = info;
  }

  if (pruned) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2), 'utf-8');
    } catch (_) {
      // Ignore write error
    }
  }

  return cleaned;
}

/**
 * Allocates the lowest unused Profile Slot (1, 2, 3, ...) and dynamic Debug Port (9222, 9223, 9224, ...),
 * persisting the claim in active-instances.json.
 */
function allocateInstanceSlot(requestedProfileNum = null, windowId = null) {
  const activeMap = readAndPruneActiveInstances();
  const usedSlots = new Set(Object.keys(activeMap).map((k) => parseInt(k, 10)));
  for (const ctx of windowContexts.values()) {
    if (ctx && ctx.profileNumber) {
      usedSlots.add(ctx.profileNumber);
    }
  }

  let profileNumber =
    requestedProfileNum &&
    Number.isFinite(Number(requestedProfileNum)) &&
    Number(requestedProfileNum) >= 1 &&
    !usedSlots.has(Number(requestedProfileNum))
      ? Math.round(Number(requestedProfileNum))
      : 1;

  while (usedSlots.has(profileNumber)) {
    profileNumber++;
  }

  const basePort = Number(configManager.getConfig().cdpPort) || 9222;
  const debugPort = basePort + (profileNumber - 1);

  activeMap[String(profileNumber)] = {
    profileNumber,
    pid: process.pid,
    windowId,
    port: debugPort,
    startedAt: new Date().toISOString()
  };

  try {
    fs.writeFileSync(getActiveInstancesFilePath(), JSON.stringify(activeMap, null, 2), 'utf-8');
  } catch (_) {
    // Ignore write error
  }

  return { profileNumber, debugPort };
}

/**
 * Releases a claimed Profile Slot from active-instances.json when a window closes.
 */
function releaseInstanceSlot(profileNumber, windowId = null) {
  const filePath = getActiveInstancesFilePath();
  try {
    if (!fs.existsSync(filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return;

    const key = String(profileNumber);
    const entry = parsed[key];
    if (
      entry &&
      Number(entry.pid) === process.pid &&
      (windowId === null || entry.windowId === windowId)
    ) {
      delete parsed[key];
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    }
  } catch (_) {
    // Ignore release errors
  }
}

/**
 * Safely sends an IPC event to a specific BrowserWindow if it is still active.
 */
function sendToWindow(win, channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/**
 * Broadcasts an IPC event to all open bot windows in this process.
 */
function broadcastToAllWindows(channel, payload) {
  for (const ctx of windowContexts.values()) {
    if (ctx && ctx.win) {
      sendToWindow(ctx.win, channel, payload);
    }
  }
}

/**
 * Appends a log entry to a window context's 150-line ring buffer and records critical alerts
 * for the Mobile PWA Remote Control.
 */
function recordLogInContextRingBuffer(ctx, entry) {
  if (!ctx || !entry) return;
  if (!Array.isArray(ctx.logBuffer)) {
    ctx.logBuffer = [];
  }

  const formatted =
    entry.formatted ||
    `[${entry.timestamp || new Date().toLocaleTimeString('en-GB')}] ${entry.message || ''}`;

  ctx.logBuffer.push({
    timestamp: entry.timestamp || new Date().toLocaleTimeString('en-GB'),
    level: entry.level || 'info',
    message: entry.message || formatted,
    formatted
  });

  if (ctx.logBuffer.length > 150) {
    ctx.logBuffer.splice(0, ctx.logBuffer.length - 150);
  }

  const msg = String(entry.message || formatted || '');
  const lower = msg.toLowerCase();
  if (
    /all prompts in the queue have been processed|queue finished|completed all prompts/i.test(lower)
  ) {
    ctx.lastAlert = {
      id: `${Date.now()}-done`,
      timestamp: new Date().toISOString(),
      type: 'success',
      message: `✅ Profile ${ctx.profileNumber}: Queue batch completed!`
    };
  } else if (
    /unusual activity.*paus|auto-paus|3 consecutive|stopping queue to protect/i.test(lower)
  ) {
    ctx.lastAlert = {
      id: `${Date.now()}-warn`,
      timestamp: new Date().toISOString(),
      type: 'warn',
      message: `⚠️ Profile ${ctx.profileNumber}: ${msg}`
    };
  }
}

/**
 * Wires real-time events from a window's isolated controllers strictly to that window's webContents.
 */
function bindWindowContextEvents(ctx) {
  const { win, flowController, zeeflowController, chatgptController } = ctx;

  flowController.on('log', (entry) => {
    recordLogInContextRingBuffer(ctx, entry);
    sendToWindow(win, 'bot:log', entry);
  });

  flowController.on('state-change', (data) => {
    sendToWindow(win, 'bot:state-change', data);
  });

  flowController.on('queue-update', (snapshot) => {
    sendToWindow(win, 'bot:queue-update', snapshot);
  });

  flowController.on('item-status-changed', (itemChange) => {
    sendToWindow(win, 'bot:item-status-changed', itemChange);
  });

  flowController.on('connection-change', (info) => {
    sendToWindow(win, 'bot:connection-change', info);
  });

  // ZeeFlow startup & server-switch logs -> this window's live activity log
  zeeflowController.on('log', (entry) => {
    recordLogInContextRingBuffer(ctx, entry);
    sendToWindow(win, 'bot:log', entry);
  });

  // ChatGPT Auto controller events -> strictly this window
  chatgptController.on('log', (entry) => {
    recordLogInContextRingBuffer(ctx, entry);
    sendToWindow(win, 'chatgpt:log', entry);
  });

  chatgptController.on('status', (data) => {
    sendToWindow(win, 'chatgpt:status', data);
  });

  chatgptController.on('prompt-extracted', (payload) => {
    sendToWindow(win, 'chatgpt:prompt-extracted', payload);
  });

  chatgptController.on('complete', (payload) => {
    sendToWindow(win, 'chatgpt:complete', payload);
  });

  chatgptController.on('error', (payload) => {
    sendToWindow(win, 'chatgpt:error', payload);
  });
}

/**
 * Creates a new independent Bot BrowserWindow with its own Profile Slot, dynamic Debug Port,
 * isolated Chrome profile directory, isolated output subfolder, and isolated controllers.
 */
function createBotWindow(requestedProfileNum = null) {
  // Offset position slightly when multiple windows are open so they don't stack identically
  const openCount = windowContexts.size;
  const offset = (openCount % 6) * 28;

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    x: openCount > 0 ? 60 + offset : undefined,
    y: openCount > 0 ? 40 + offset : undefined,
    title: 'Google Flow Automation Bot',
    backgroundColor: '#0b0f19',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const windowId = win.id;
  const webContentsId = win.webContents.id;
  const { profileNumber, debugPort } = allocateInstanceSlot(requestedProfileNum, windowId);
  const windowTitle = `Google Flow Automation Bot — Profile ${profileNumber} (Port ${debugPort})`;
  win.setTitle(windowTitle);

  // prevent <title> in index.html from overriding our Profile/Port window title
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    if (!win.isDestroyed()) {
      win.setTitle(
        `Google Flow Automation Bot — Profile ${profileNumber} (Port ${flowController.getDebugPort()})`
      );
    }
  });

  const flowController = new FlowController({
    profileNumber,
    debugPort
  });

  const zeeflowController = new ZeeFlowController({
    profileNumber,
    debugPort
  });

  const chatgptController = new ChatGPTController({
    profileNumber,
    debugPort,
    getBrowser: () => flowController.browser,
    getConfigDir: () => configManager.storageDir || app.getPath('userData'),
    getCdpPort: () => flowController.getDebugPort()
  });

  flowController.setServerSwitchHandler(async ({ targetProjectUrl } = {}) => {
    return await zeeflowController.switchToNextServerAndReopenFlow({
      userDataDir: chromeLauncher.getChromeUserDataDir(profileNumber),
      debugPort: flowController.getDebugPort(),
      cdpPort: flowController.getDebugPort(),
      targetProjectUrl
    });
  });

  const ctx = {
    win,
    windowId,
    webContentsId,
    profileNumber,
    debugPort,
    flowController,
    zeeflowController,
    chatgptController,
    logBuffer: [],
    lastAlert: null,
    isLaunchingChrome: false
  };

  windowContexts.set(webContentsId, ctx);
  bindWindowContextEvents(ctx);

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.setTitle(windowTitle);
    }
    if (!updaterInitialized) {
      updaterInitialized = true;
      updater.initUpdater({
        getWindow: () => {
          for (const c of windowContexts.values()) {
            if (c.win && !c.win.isDestroyed()) return c.win;
          }
          return null;
        },
        onLog: (msg, level) => {
          for (const c of windowContexts.values()) {
            c.flowController.log(msg, level);
          }
        }
      });
      updater.scheduleStartupCheck();
    }
  });

  win.on('closed', () => {
    try {
      chatgptController.stop();
    } catch (_) {}
    try {
      flowController.stopQueue();
    } catch (_) {}
    try {
      if (flowController.browser) {
        flowController.browser.disconnect();
      }
    } catch (_) {}

    windowContexts.delete(webContentsId);
    releaseInstanceSlot(profileNumber, windowId);
  });

  return ctx;
}

/**
 * Resolves a window context by Profile Number (defaulting to the lowest active profileNumber).
 */
function getContextByProfile(requestedProfileNum = null) {
  const contexts = Array.from(windowContexts.values()).sort(
    (a, b) => a.profileNumber - b.profileNumber
  );
  if (contexts.length === 0) return null;
  if (requestedProfileNum && Number.isFinite(Number(requestedProfileNum))) {
    const targetNum = Number(requestedProfileNum);
    const match = contexts.find((c) => c.profileNumber === targetNum);
    if (match) return match;
  }
  return contexts[0];
}

/**
 * Runs the full Launch Chrome + ZeeFlow Server 1 + New Project + Auto-Connect (+ Auto-Start)
 * startup pipeline for a given window context.
 */
async function runLaunchChromeForContext(ctx) {
  if (!ctx) return { success: false, error: 'Window context not found' };
  if (ctx.isLaunchingChrome) {
    return { success: false, error: 'Chrome launch is already in progress on this profile.' };
  }

  ctx.isLaunchingChrome = true;
  try {
    const { profileNumber, flowController, zeeflowController } = ctx;
    const port = flowController.getDebugPort();
    const userDataDir = chromeLauncher.getChromeUserDataDir(profileNumber);

    const result = await chromeLauncher.launchDebugChrome(
      {
        profileNumber,
        debugPort: port
      },
      (msg) => {
        flowController.log(msg);
      }
    );

    if (result.success) {
      const cfg = configManager.getConfig();
      await zeeflowController.runFullStartupSequence({
        userDataDir,
        debugPort: port,
        cdpPort: port,
        serverNumber: 1,
        newProjectDelayMinSec: cfg.newProjectDelayMinSec,
        newProjectDelayMaxSec: cfg.newProjectDelayMaxSec
      });

      const connectResult = await flowController.connectToChrome();
      let autoStarted = false;

      if (connectResult && connectResult.success) {
        const latestCfg = configManager.getConfig();
        if (latestCfg.autoStartAfterLaunch !== false) {
          if (flowController.state !== 'RUNNING' && !flowController.isProcessingLoopActive) {
            const pendingCount = Array.isArray(flowController.queue)
              ? flowController.queue.filter(
                  (item) => item && (item.status === 'Pending' || item.status === 'Generating')
                ).length
              : 0;

            if (pendingCount > 0) {
              flowController.log(
                `🚀 Auto-Start enabled: Google Flow is ready (${pendingCount} pending prompt(s)) — starting bot automatically...`,
                'success'
              );
              const startRes = await flowController.startQueue();
              autoStarted = Boolean(startRes && startRes.success);
            } else {
              flowController.log(
                'ℹ️ Auto-Start is ON, but queue has no pending prompts. Add prompts to start automatically.'
              );
            }
          }
        }
      }

      const snapshot = flowController.getStatusSnapshot();
      sendToWindow(ctx.win, 'bot:queue-update', snapshot);

      return {
        ...result,
        connected: connectResult.success,
        tabUrl: connectResult.tabUrl || null,
        autoStarted,
        snapshot
      };
    }
    return result;
  } finally {
    ctx.isLaunchingChrome = false;
  }
}

/**
 * Resolves the window context corresponding to an incoming IPC event.
 */
function getContextForEvent(event) {
  if (event && event.sender) {
    const ctx = windowContexts.get(event.sender.id);
    if (ctx) return ctx;
  }
  const first = windowContexts.values().next().value;
  return first || null;
}

/**
 * Helper to parse imported .txt or .csv prompt files into an array of clean prompt strings.
 */
function parsePromptsFromFileContent(rawContent, ext, splitMode = 'smart') {
  if (ext !== '.csv' && splitMode === 'smart') {
    const normalized = String(rawContent || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    const majorChunks = normalized
      .split(/\n\s*(?:---+|=+)\s*\n|\n\s*\n\s*\n+/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    const headerRegex = /^(?:Prompt\s*#?\d+|Scene\s*#?\d+|\d+[\.\)]\s+Prompt)\b/i;
    const prompts = [];

    for (const chunk of majorChunks) {
      const lines = chunk.split('\n');
      let currentBlock = [];

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (headerRegex.test(line) && currentBlock.length > 0) {
          const joined = currentBlock.join(' ').replace(/\s+/g, ' ').trim();
          if (joined) prompts.push(joined);
          currentBlock = [line];
        } else {
          currentBlock.push(line);
        }
      }

      if (currentBlock.length > 0) {
        const joined = currentBlock.join(' ').replace(/\s+/g, ' ').trim();
        if (joined) prompts.push(joined);
      }
    }

    return prompts;
  }

  const lines = rawContent.split(/\r?\n/);
  const extracted = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    if (ext === '.csv') {
      if (i === 0 && /^(id\s*,|prompt\s*$|prompt\s*,|#,)/i.test(line)) {
        continue;
      }
      const quotedMatch = line.match(/^(?:\d+\s*,\s*)?"((?:[^"]|"")*)"/);
      if (quotedMatch) {
        line = quotedMatch[1].replace(/""/g, '"').trim();
      } else {
        line = line.replace(/^\d+\s*,\s*/, '').trim();
      }
    }

    if (line.length > 0) {
      extracted.push(line);
    }
  }

  return extracted;
}

/**
 * Register all IPC handlers for Renderer requests (routed to each caller window's isolated context).
 */
function registerIpcHandlers() {
  // --- Multi-Instance / Multi-Window Management ---
  ipcMain.handle('instance:get-info', async (event) => {
    const ctx = getContextForEvent(event);
    const profileNumber = ctx ? ctx.profileNumber : 1;
    const debugPort = ctx ? ctx.flowController.getDebugPort() : 9222;
    const chromeUserDataDir = chromeLauncher.getChromeUserDataDir(profileNumber);
    const effectiveOutputDir = ctx
      ? ctx.flowController.getEffectiveOutputDir()
      : configManager.getEffectiveOutputDir(profileNumber);

    return {
      profileNumber,
      debugPort,
      chromeUserDataDir,
      effectiveOutputDir
    };
  });

  ipcMain.handle('app:open-new-window', async () => {
    const newCtx = createBotWindow();
    return {
      success: true,
      profileNumber: newCtx.profileNumber,
      debugPort: newCtx.debugPort,
      chromeUserDataDir: chromeLauncher.getChromeUserDataDir(newCtx.profileNumber),
      effectiveOutputDir: newCtx.flowController.getEffectiveOutputDir()
    };
  });

  // --- Chrome Connection & Launcher ---
  ipcMain.handle('chrome:launch', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false, error: 'Window context not found' };
    return await runLaunchChromeForContext(ctx);
  });

  ipcMain.handle('chrome:connect', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false, error: 'Window context not found' };
    return await ctx.flowController.connectToChrome();
  });

  ipcMain.handle('chrome:status', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { state: 'IDLE', connected: false, queue: [] };
    return ctx.flowController.getStatusSnapshot();
  });

  // --- Queue Management ---
  ipcMain.handle('queue:get', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { state: 'IDLE', connected: false, queue: [] };
    return ctx.flowController.getStatusSnapshot();
  });

  ipcMain.handle('queue:add', async (event, promptsArray) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { state: 'IDLE', connected: false, queue: [] };
    if (Array.isArray(promptsArray)) {
      ctx.flowController.addPrompts(promptsArray);
    }
    return ctx.flowController.getStatusSnapshot();
  });

  ipcMain.handle('queue:remove', async (event, promptId) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { state: 'IDLE', connected: false, queue: [] };
    ctx.flowController.removePrompt(promptId);
    return ctx.flowController.getStatusSnapshot();
  });

  ipcMain.handle('queue:retry', async (event, promptId) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { state: 'IDLE', connected: false, queue: [] };
    ctx.flowController.retryPrompt(promptId);
    return ctx.flowController.getStatusSnapshot();
  });

  ipcMain.handle('queue:retry-all-failed', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { state: 'IDLE', connected: false, queue: [] };
    ctx.flowController.resetAllFailedToPending();
    return ctx.flowController.getStatusSnapshot();
  });

  ipcMain.handle('queue:clear', async (event, onlyCompleted = false) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { state: 'IDLE', connected: false, queue: [] };
    ctx.flowController.clearQueue(Boolean(onlyCompleted));
    return ctx.flowController.getStatusSnapshot();
  });

  ipcMain.handle('queue:import-file', async (event, splitMode = 'smart') => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { canceled: true };

    const result = await dialog.showOpenDialog(ctx.win, {
      title: 'Import Prompts from TXT or CSV',
      filters: [
        { name: 'Prompt Files (*.txt, *.csv)', extensions: ['txt', 'csv'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const prompts = parsePromptsFromFileContent(content, ext, splitMode);
      ctx.flowController.log(
        `Imported ${prompts.length} prompt(s) from ${path.basename(filePath)}.`,
        'success'
      );
      ctx.flowController.addPrompts(prompts);
      return {
        canceled: false,
        filePath,
        addedCount: prompts.length,
        snapshot: ctx.flowController.getStatusSnapshot()
      };
    } catch (err) {
      ctx.flowController.log(`Failed to import file: ${err.message}`, 'error');
      return {
        canceled: false,
        error: err.message
      };
    }
  });

  // --- Bot Execution Controls ---
  ipcMain.handle('bot:start', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false, error: 'Window context not found' };
    return await ctx.flowController.startQueue();
  });

  ipcMain.handle('bot:pause', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false, error: 'Window context not found' };
    return ctx.flowController.pauseQueue();
  });

  ipcMain.handle('bot:resume', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false, error: 'Window context not found' };
    return ctx.flowController.resumeQueue();
  });

  ipcMain.handle('bot:stop', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false, error: 'Window context not found' };
    return ctx.flowController.stopQueue();
  });

  // --- Settings & Configuration ---
  ipcMain.handle('config:get', async (event) => {
    const ctx = getContextForEvent(event);
    const cfg = configManager.getConfig();
    const profileNumber = ctx ? ctx.profileNumber : 1;
    return {
      ...cfg,
      effectiveOutputDir: configManager.getEffectiveOutputDir(profileNumber, cfg.downloadPath)
    };
  });

  ipcMain.handle('config:update', async (event, newSettings) => {
    const ctx = getContextForEvent(event);
    const updated = configManager.updateConfig(newSettings);

    for (const wCtx of windowContexts.values()) {
      if (typeof wCtx.flowController.updateConfig === 'function') {
        wCtx.flowController.updateConfig(updated);
      }
      if (newSettings && newSettings.downloadPath && wCtx.flowController.isConnected()) {
        await wCtx.flowController
          ._configureDownloadBehavior(wCtx.flowController.getEffectiveOutputDir(updated.downloadPath))
          .catch(() => {});
      }
      if (newSettings && newSettings.videosPerPrompt !== undefined) {
        wCtx.flowController.updatePendingVideosPerPrompt(updated.videosPerPrompt);
      }
      if (
        wCtx.flowController.isConnected() &&
        wCtx.flowController.state !== 'RUNNING' &&
        newSettings &&
        (newSettings.flowAgentMode !== undefined || newSettings.flowViewMode !== undefined)
      ) {
        if (
          newSettings.flowAgentMode !== undefined &&
          (updated.flowAgentMode === 'force-off' || updated.flowAgentMode === 'force-on')
        ) {
          wCtx.flowController.syncFlowAgentMode(wCtx.flowController.page).catch(() => {});
        }
        if (
          newSettings.flowViewMode !== undefined &&
          (updated.flowViewMode === 'grid' || updated.flowViewMode === 'batch')
        ) {
          wCtx.flowController
            .syncFlowViewMode(wCtx.flowController.page, { forceCheck: true })
            .catch(() => {});
        }
      }
    }

    if (ctx) {
      ctx.flowController.log('Configuration saved.', 'success');
    }
    const profileNumber = ctx ? ctx.profileNumber : 1;
    return {
      ...updated,
      effectiveOutputDir: configManager.getEffectiveOutputDir(profileNumber, updated.downloadPath)
    };
  });

  ipcMain.handle('config:reset', async (event) => {
    const ctx = getContextForEvent(event);
    const reset = configManager.resetConfig();
    for (const wCtx of windowContexts.values()) {
      if (typeof wCtx.flowController.updateConfig === 'function') {
        wCtx.flowController.updateConfig(reset);
      }
      wCtx.flowController.updatePendingVideosPerPrompt(reset.videosPerPrompt);
    }
    if (ctx) {
      ctx.flowController.log('Configuration reset to factory defaults.', 'warn');
    }
    const profileNumber = ctx ? ctx.profileNumber : 1;
    return {
      ...reset,
      effectiveOutputDir: configManager.getEffectiveOutputDir(profileNumber, reset.downloadPath)
    };
  });

  // --- Folder Selection & OS Integration ---
  ipcMain.handle('dialog:select-folder', async (event) => {
    const ctx = getContextForEvent(event);
    const profileNumber = ctx ? ctx.profileNumber : 1;
    const currentConfig = configManager.getConfig();
    const result = await dialog.showOpenDialog(ctx ? ctx.win : null, {
      title: 'Select Video Output Directory',
      defaultPath: currentConfig.downloadPath || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return {
        canceled: true,
        path: configManager.getEffectiveOutputDir(profileNumber, currentConfig.downloadPath)
      };
    }

    const chosenPath = result.filePaths[0];
    configManager.updateConfig({ downloadPath: chosenPath });

    for (const wCtx of windowContexts.values()) {
      if (wCtx.flowController.isConnected()) {
        await wCtx.flowController
          ._configureDownloadBehavior(wCtx.flowController.getEffectiveOutputDir(chosenPath))
          .catch(() => {});
      }
    }

    const effectiveDir = configManager.getEffectiveOutputDir(profileNumber, chosenPath);
    if (ctx) {
      ctx.flowController.log(`Output folder updated to: ${effectiveDir}`);
    }
    return { canceled: false, path: effectiveDir, baseDownloadPath: chosenPath };
  });

  ipcMain.handle('shell:open-folder', async (event) => {
    const ctx = getContextForEvent(event);
    const profileNumber = ctx ? ctx.profileNumber : 1;
    const targetDir = ctx
      ? ctx.flowController.getEffectiveOutputDir()
      : configManager.getEffectiveOutputDir(profileNumber);

    if (targetDir) {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      await shell.openPath(targetDir);
      return { success: true, path: targetDir };
    }
    return { success: false };
  });

  // --- Auto-Updater (GitHub Releases via electron-updater) ---
  ipcMain.handle('updater:get-version', async () => {
    return updater.getAppVersion();
  });

  ipcMain.handle('updater:check', async () => {
    return await updater.checkForUpdates({ manual: true });
  });

  ipcMain.handle('updater:install', async () => {
    return updater.installUpdate();
  });

  // --- ChatGPT Auto (13-Phase Prompt Generator Pipeline) ---
  ipcMain.handle('chatgpt:load-config', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return {};
    return ctx.chatgptController.loadConfig();
  });

  ipcMain.handle('chatgpt:save-config', async (event, partialConfig) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return {};
    return ctx.chatgptController.saveConfig(partialConfig || {});
  });

  ipcMain.handle('chatgpt:start', async (event, options) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false, error: 'Window context not found' };

    const { chatgptController, flowController } = ctx;
    if (chatgptController.isRunning) {
      return { success: false, error: 'ChatGPT Auto is already running in this window.' };
    }
    const opts = options || {};
    const master = String(opts.masterPrompt || '').trim();
    const topic = String(opts.topicMessage || '').trim();
    if (!master && !topic) {
      return {
        success: false,
        error: 'Please enter a Master Prompt or Topic/Message before starting ChatGPT Auto.'
      };
    }

    chatgptController.saveConfig({
      masterPrompt: opts.masterPrompt,
      totalPhases: opts.totalPhases,
      promptsPerPhase: opts.promptsPerPhase,
      phase6Prompts: opts.phase6Prompts,
      continueTemplate: opts.continueTemplate,
      autoStartBot: opts.autoStartBot,
      autoScroll: opts.autoScroll
    });

    chatgptController
      .start({
        ...opts,
        debugPort: flowController.getDebugPort()
      })
      .catch(() => {});
    return { success: true };
  });

  ipcMain.handle('chatgpt:stop', async (event) => {
    const ctx = getContextForEvent(event);
    if (!ctx) return { success: false };
    return ctx.chatgptController.stop();
  });

  // --- Built-In Mobile PWA Remote Control ---
  ipcMain.handle('remote:get-info', async () => {
    if (!mobileRemoteServer) {
      initMobileRemoteServer();
    }
    return mobileRemoteServer.getConnectionDetails();
  });

  ipcMain.handle('remote:regenerate-pin', async (event) => {
    const ctx = getContextForEvent(event);
    configManager.regenerateRemotePin();
    if (ctx) {
      ctx.flowController.log('📱 Generated a new 6-digit Mobile Remote Access PIN.', 'success');
    }
    if (!mobileRemoteServer) {
      initMobileRemoteServer();
    }
    return mobileRemoteServer.getConnectionDetails();
  });
}

/**
 * Initializes and starts the built-in PIN-protected Mobile PWA Remote Control HTTP server.
 */
function initMobileRemoteServer() {
  if (mobileRemoteServer) return mobileRemoteServer;

  mobileRemoteServer = new MobileRemoteServer({
    configManager,
    onLog: (msg) => {
      for (const c of windowContexts.values()) {
        c.flowController.log(msg);
      }
    },
    getState: async (requestedProfileNum) => {
      const sortedContexts = Array.from(windowContexts.values()).sort(
        (a, b) => a.profileNumber - b.profileNumber
      );

      const profiles = sortedContexts.map((c) => {
        const snap = c.flowController.getStatusSnapshot();
        const q = Array.isArray(snap.queue) ? snap.queue : [];
        return {
          profileNumber: c.profileNumber,
          debugPort: c.flowController.getDebugPort(),
          state: snap.state || 'IDLE',
          isRunning: snap.state === 'RUNNING',
          isPaused: snap.state === 'PAUSED',
          isConnected: Boolean(snap.connected),
          counts: {
            total: q.length,
            pending: q.filter((i) => i.status === 'Pending').length,
            generating: q.filter((i) => i.status === 'Generating').length,
            completed: q.filter((i) => i.status === 'Completed').length,
            failed: q.filter((i) => i.status === 'Failed').length
          }
        };
      });

      const ctx = getContextByProfile(requestedProfileNum);
      if (!ctx) {
        return {
          profiles: [],
          profileNumber: 1,
          state: 'IDLE',
          isRunning: false,
          isPaused: false,
          isConnected: false,
          debugPort: 9222,
          effectiveOutputDir: configManager.getEffectiveOutputDir(1),
          videosPerPrompt: configManager.getConfig().videosPerPrompt || 1,
          chatgptRunning: false,
          counts: { total: 0, pending: 0, generating: 0, completed: 0, failed: 0 },
          queue: [],
          logs: [],
          lastAlert: null
        };
      }

      const snap = ctx.flowController.getStatusSnapshot();
      const rawQueue = Array.isArray(snap.queue) ? snap.queue : [];
      const cfg = configManager.getConfig();
      const counts = {
        total: rawQueue.length,
        pending: rawQueue.filter((i) => i.status === 'Pending').length,
        generating: rawQueue.filter((i) => i.status === 'Generating').length,
        completed: rawQueue.filter((i) => i.status === 'Completed').length,
        failed: rawQueue.filter((i) => i.status === 'Failed').length
      };

      const compactQueue = rawQueue.map((item, idx) => {
        const vpp = Math.max(1, parseInt(item.videosPerPrompt || cfg.videosPerPrompt || 1, 10));
        const doneVids = item.videosCompleted || 0;
        let progressText = item.statusText || item.status || 'Pending';
        if (!item.statusText && vpp > 1) {
          progressText = `${item.status} (${doneVids}/${vpp})`;
        }
        return {
          id: item.id,
          index: idx + 1,
          title: String(item.text || '').slice(0, 180),
          text: item.text,
          status: item.status,
          progressText,
          error: item.error || null,
          outputFile: item.outputFile ? path.basename(String(item.outputFile)) : null
        };
      });

      return {
        profiles,
        profileNumber: ctx.profileNumber,
        state: snap.state || 'IDLE',
        isRunning: snap.state === 'RUNNING',
        isPaused: snap.state === 'PAUSED',
        isConnected: Boolean(snap.connected),
        tabUrl: snap.tabUrl || null,
        debugPort: ctx.flowController.getDebugPort(),
        effectiveOutputDir: ctx.flowController.getEffectiveOutputDir(),
        videosPerPrompt: cfg.videosPerPrompt || 1,
        chatgptRunning: Boolean(ctx.chatgptController && ctx.chatgptController.isRunning),
        counts,
        queue: compactQueue,
        logs: Array.isArray(ctx.logBuffer) ? ctx.logBuffer.slice(-80) : [],
        lastAlert: ctx.lastAlert || null
      };
    },
    handleAction: async ({ profileNumber, action, payload }) => {
      if (action === 'new-window') {
        const newCtx = createBotWindow();
        return {
          success: true,
          newProfileNumber: newCtx.profileNumber,
          message: `🪟 Opened Profile ${newCtx.profileNumber} (Port ${newCtx.debugPort})`
        };
      }

      const ctx = getContextByProfile(profileNumber);
      if (!ctx) {
        return { success: false, error: 'No active bot window found.' };
      }

      const { flowController, chatgptController } = ctx;

      switch (action) {
        case 'launch-chrome': {
          if (ctx.isLaunchingChrome) {
            return {
              success: false,
              error: `Chrome launch is already running on Profile ${ctx.profileNumber}.`
            };
          }
          flowController.log('📱 Remote command: Launch Chrome triggered from Mobile PWA.');
          runLaunchChromeForContext(ctx).catch((err) => {
            flowController.log(`❌ Remote Launch Chrome error: ${err.message}`, 'error');
          });
          return {
            success: true,
            message: `🚀 Launching Chrome & ZeeFlow setup on Profile ${ctx.profileNumber}...`
          };
        }

        case 'connect': {
          flowController.log('📱 Remote command: Connect Chrome triggered from Mobile PWA.');
          const res = await flowController.connectToChrome();
          return {
            success: Boolean(res && res.success),
            message:
              res && res.success
                ? `✅ Connected Profile ${ctx.profileNumber} to Google Flow`
                : (res && res.error) || 'Failed to connect to Chrome'
          };
        }

        case 'start': {
          flowController.log('📱 Remote command: Start Bot triggered from Mobile PWA.');
          const res = await flowController.startQueue();
          return {
            success: Boolean(res && res.success),
            message:
              res && res.success
                ? `▶️ Started Bot on Profile ${ctx.profileNumber}`
                : (res && res.error) || 'Could not start queue'
          };
        }

        case 'pause': {
          flowController.log('📱 Remote command: Pause Bot triggered from Mobile PWA.');
          const res = flowController.pauseQueue();
          return {
            success: Boolean(res && res.success),
            message: `⏸️ Paused Profile ${ctx.profileNumber}`
          };
        }

        case 'resume': {
          flowController.log('📱 Remote command: Resume Bot triggered from Mobile PWA.');
          const res = flowController.resumeQueue();
          return {
            success: Boolean(res && res.success),
            message: `▶️ Resumed Profile ${ctx.profileNumber}`
          };
        }

        case 'stop': {
          flowController.log('📱 Remote command: Stop Bot triggered from Mobile PWA.');
          const res = flowController.stopQueue();
          return {
            success: Boolean(res && res.success),
            message: `⏹️ Stopped Profile ${ctx.profileNumber}`
          };
        }

        case 'retry-failed': {
          flowController.resetAllFailedToPending();
          sendToWindow(ctx.win, 'bot:queue-update', flowController.getStatusSnapshot());
          return {
            success: true,
            message: `🔄 Reset failed prompts to Pending on Profile ${ctx.profileNumber}`
          };
        }

        case 'clear-done': {
          flowController.clearQueue(true);
          sendToWindow(ctx.win, 'bot:queue-update', flowController.getStatusSnapshot());
          return {
            success: true,
            message: `🧹 Cleared completed prompts on Profile ${ctx.profileNumber}`
          };
        }

        case 'clear-all': {
          flowController.clearQueue(false);
          sendToWindow(ctx.win, 'bot:queue-update', flowController.getStatusSnapshot());
          return {
            success: true,
            message: `🗑️ Cleared queue on Profile ${ctx.profileNumber}`
          };
        }

        case 'add-prompts': {
          const rawText = String((payload && payload.text) || '').trim();
          const splitMode = (payload && payload.splitMode) === 'line' ? 'line' : 'smart';
          const prompts = parsePromptsFromFileContent(rawText, '.txt', splitMode);
          if (prompts.length === 0) {
            return { success: false, error: 'No valid prompts found in text.' };
          }
          flowController.addPrompts(prompts);
          flowController.log(
            `📱 Added ${prompts.length} prompt(s) from Mobile Remote.`,
            'success'
          );
          sendToWindow(ctx.win, 'bot:queue-update', flowController.getStatusSnapshot());
          return {
            success: true,
            addedCount: prompts.length,
            message: `➕ Added ${prompts.length} prompt(s) to Profile ${ctx.profileNumber}`
          };
        }

        case 'chatgpt-auto': {
          if (chatgptController.isRunning) {
            return {
              success: false,
              error: `ChatGPT Auto is already running on Profile ${ctx.profileNumber}.`
            };
          }
          const savedCfg = chatgptController.loadConfig() || {};
          const topicMessage = String(
            (payload && payload.topic) || savedCfg.topicMessage || ''
          ).trim();
          const masterPrompt = String(savedCfg.masterPrompt || '').trim();
          if (!masterPrompt && !topicMessage) {
            return {
              success: false,
              error: 'Save a Master Prompt in ChatGPT Auto on PC or enter a Topic on your phone first.'
            };
          }

          flowController.log('📱 Remote command: Starting ChatGPT Auto from Mobile PWA.', 'success');
          chatgptController
            .start({
              ...savedCfg,
              topicMessage,
              debugPort: flowController.getDebugPort()
            })
            .catch(() => {});

          return {
            success: true,
            message: `✨ Started ChatGPT Auto on Profile ${ctx.profileNumber}`
          };
        }

        case 'chatgpt-stop': {
          chatgptController.stop();
          return {
            success: true,
            message: `⏹️ Stopped ChatGPT Auto on Profile ${ctx.profileNumber}`
          };
        }

        default:
          return { success: false, error: `Unknown remote action: ${action}` };
      }
    },
    getScreenshot: async (requestedProfileNum) => {
      const ctx = getContextByProfile(requestedProfileNum);
      if (!ctx || !ctx.flowController) {
        return { success: false, error: 'Bot window not found.' };
      }
      const fc = ctx.flowController;
      if (!fc.isConnected() || !fc.page) {
        return {
          success: false,
          error: `Profile ${ctx.profileNumber} is not connected to a Google Flow Chrome tab yet.`
        };
      }
      try {
        if (typeof fc.page.isClosed === 'function' && fc.page.isClosed()) {
          return { success: false, error: 'Google Flow tab is closed.' };
        }
        const buffer = await fc.page.screenshot({
          type: 'jpeg',
          quality: 65
        });
        return { success: true, buffer };
      } catch (err) {
        return {
          success: false,
          error: `Could not capture tab screenshot: ${err.message}`
        };
      }
    }
  });

  mobileRemoteServer.start().catch(() => {});
  return mobileRemoteServer;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createBotWindow();
  initMobileRemoteServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createBotWindow();
    }
  });
});

app.on('before-quit', () => {
  if (mobileRemoteServer) {
    mobileRemoteServer.stop().catch(() => {});
  }
  for (const ctx of windowContexts.values()) {
    releaseInstanceSlot(ctx.profileNumber, ctx.windowId);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
