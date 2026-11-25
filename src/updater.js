const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let getMainWindow = () => null;
let onLogCallback = null;
let isInitialized = false;
let isManualCheck = false;
let checkInFlight = false;
let latestAvailableVersion = null;
let downloadedVersion = null;
let startupTimer = null;

function sendUpdaterStatus(payload) {
  try {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('updater:status', payload);
    }
  } catch (_) {
    // Ignore IPC errors when window is closing
  }
}

function logUpdater(message, level = 'info') {
  if (typeof onLogCallback === 'function') {
    try {
      onLogCallback(message, level);
    } catch (_) {
      // Ignore logging errors
    }
  }
}

/**
 * Initializes electron-updater configuration and event forwarding.
 * Safe to call once during app startup.
 */
function initUpdater({ getWindow, onLog } = {}) {
  if (typeof getWindow === 'function') {
    getMainWindow = getWindow;
  }
  if (typeof onLog === 'function') {
    onLogCallback = onLog;
  }

  if (isInitialized) return;
  isInitialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterStatus({
      state: 'checking',
      manual: isManualCheck,
      message: 'Checking for updates...'
    });
  });

  autoUpdater.on('update-available', (info) => {
    const version = (info && info.version) || '';
    latestAvailableVersion = version;
    const msg = `Update v${version} found. Downloading...`;
    logUpdater(msg, 'info');
    sendUpdaterStatus({
      state: 'available',
      version,
      manual: isManualCheck,
      message: msg
    });
  });

  autoUpdater.on('update-not-available', () => {
    const currentVersion = app.getVersion();
    const wasManual = isManualCheck;
    checkInFlight = false;
    isManualCheck = false;
    sendUpdaterStatus({
      state: 'up-to-date',
      version: currentVersion,
      manual: wasManual,
      message: `You are on the latest version (v${currentVersion}).`
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterStatus({
      state: 'downloading',
      version: latestAvailableVersion || '',
      percent: Math.round((progress && progress.percent) || 0),
      transferred: (progress && progress.transferred) || 0,
      total: (progress && progress.total) || 0
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || latestAvailableVersion || '';
    downloadedVersion = version;
    checkInFlight = false;
    isManualCheck = false;
    const msg = `Update v${version} is ready to install!`;
    logUpdater(`${msg} Click "Restart & Install" when ready.`, 'success');
    sendUpdaterStatus({
      state: 'downloaded',
      version,
      message: msg
    });
  });

  autoUpdater.on('error', (err) => {
    const errMsg = err ? err.message || String(err) : 'Update check failed';
    const wasManual = isManualCheck;
    checkInFlight = false;
    isManualCheck = false;

    // Never crash the app on GitHub/network errors; only surface banner errors on manual checks
    if (wasManual) {
      logUpdater(`Update check notice: ${errMsg}`, 'warn');
      sendUpdaterStatus({
        state: 'error',
        manual: true,
        message: errMsg
      });
    } else {
      console.warn('[AutoUpdater] Background update check failed:', errMsg);
    }
  });
}

/**
 * Schedules a non-blocking background update check 4 seconds after the window finishes loading.
 * Runs ONLY in packaged builds (`app.isPackaged === true`).
 */
function scheduleStartupCheck() {
  if (!app.isPackaged) return;

  if (startupTimer) {
    clearTimeout(startupTimer);
  }
  startupTimer = setTimeout(() => {
    startupTimer = null;
    checkForUpdates({ manual: false });
  }, 4000);
}

/**
 * Returns the current application version from package.json.
 */
function getAppVersion() {
  return app.getVersion();
}

/**
 * Triggers a GitHub Releases update check.
 * In unpackaged dev mode, reports gracefully instead of throwing.
 */
async function checkForUpdates({ manual = true } = {}) {
  if (!app.isPackaged) {
    const devMessage = 'Dev mode: build installer to test updates';
    if (manual) {
      sendUpdaterStatus({
        state: 'dev-mode',
        version: app.getVersion(),
        manual: true,
        message: devMessage
      });
    }
    return {
      ok: false,
      devMode: true,
      version: app.getVersion(),
      message: devMessage
    };
  }

  if (downloadedVersion) {
    const readyMsg = `Update v${downloadedVersion} is ready to install!`;
    sendUpdaterStatus({
      state: 'downloaded',
      version: downloadedVersion,
      manual: Boolean(manual),
      message: readyMsg
    });
    return {
      ok: true,
      state: 'downloaded',
      version: downloadedVersion,
      message: readyMsg
    };
  }

  if (checkInFlight) {
    if (manual) {
      isManualCheck = true;
    }
    return { ok: true, state: 'checking' };
  }

  isManualCheck = Boolean(manual);
  checkInFlight = true;

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    const errMsg = err ? err.message || String(err) : 'Update check failed';
    const wasManual = isManualCheck;
    checkInFlight = false;
    isManualCheck = false;

    if (wasManual) {
      sendUpdaterStatus({
        state: 'error',
        manual: true,
        message: errMsg
      });
    } else {
      console.warn('[AutoUpdater] Startup check exception:', errMsg);
    }
    return { ok: false, error: errMsg };
  }
}

/**
 * Installs a downloaded update immediately (ONLY called when user explicitly clicks "Restart & Install").
 */
function installUpdate() {
  if (!app.isPackaged) {
    return { ok: false, error: 'Dev mode: build installer to test updates' };
  }
  if (!downloadedVersion) {
    return { ok: false, error: 'No downloaded update is ready to install yet.' };
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
  return { ok: true };
}

module.exports = {
  initUpdater,
  scheduleStartupCheck,
  getAppVersion,
  checkForUpdates,
  installUpdate
};
