const { contextBridge, ipcRenderer } = require('electron');

const chatgptBridge = {
  chatgptLoadConfig: () => ipcRenderer.invoke('chatgpt:load-config'),
  chatgptSaveConfig: (config) => ipcRenderer.invoke('chatgpt:save-config', config),
  chatgptStart: (options) => ipcRenderer.invoke('chatgpt:start', options),
  chatgptStop: () => ipcRenderer.invoke('chatgpt:stop'),
  onChatgptLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('chatgpt:log', listener);
    return () => ipcRenderer.removeListener('chatgpt:log', listener);
  },
  onChatgptStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('chatgpt:status', listener);
    return () => ipcRenderer.removeListener('chatgpt:status', listener);
  },
  onChatgptPromptExtracted: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chatgpt:prompt-extracted', listener);
    return () => ipcRenderer.removeListener('chatgpt:prompt-extracted', listener);
  },
  onChatgptComplete: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chatgpt:complete', listener);
    return () => ipcRenderer.removeListener('chatgpt:complete', listener);
  },
  onChatgptError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chatgpt:error', listener);
    return () => ipcRenderer.removeListener('chatgpt:error', listener);
  }
};

const instanceBridge = {
  getInstanceInfo: () => ipcRenderer.invoke('instance:get-info'),
  openNewWindow: () => ipcRenderer.invoke('app:open-new-window')
};

contextBridge.exposeInMainWorld('electronAPI', {
  ...chatgptBridge,
  ...instanceBridge
});

contextBridge.exposeInMainWorld('flowBotAPI', {
  // Multi-Instance / Multi-Window
  ...instanceBridge,

  // Mobile PWA Remote Control
  getRemoteInfo: () => ipcRenderer.invoke('remote:get-info'),
  regenerateRemotePin: () => ipcRenderer.invoke('remote:regenerate-pin'),

  // Chrome & Connection
  launchChrome: () => ipcRenderer.invoke('chrome:launch'),
  connectChrome: () => ipcRenderer.invoke('chrome:connect'),
  getChromeStatus: () => ipcRenderer.invoke('chrome:status'),

  // Queue Management
  getQueue: () => ipcRenderer.invoke('queue:get'),
  addPrompts: (promptsArray) => ipcRenderer.invoke('queue:add', promptsArray),
  removePrompt: (id) => ipcRenderer.invoke('queue:remove', id),
  retryPrompt: (id) => ipcRenderer.invoke('queue:retry', id),
  retryAllFailed: () => ipcRenderer.invoke('queue:retry-all-failed'),
  clearQueue: (onlyCompleted = false) => ipcRenderer.invoke('queue:clear', onlyCompleted),
  importPromptsFile: (splitMode = 'smart') => ipcRenderer.invoke('queue:import-file', splitMode),

  // Bot Execution Controls
  startBot: () => ipcRenderer.invoke('bot:start'),
  pauseBot: () => ipcRenderer.invoke('bot:pause'),
  resumeBot: () => ipcRenderer.invoke('bot:resume'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),

  // Configuration & Selectors
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (settings) => ipcRenderer.invoke('config:update', settings),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  // Output Directory Dialogs
  selectOutputFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  openOutputFolder: () => ipcRenderer.invoke('shell:open-folder'),

  // Real-Time Event Subscriptions
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('bot:log', listener);
    return () => ipcRenderer.removeListener('bot:log', listener);
  },

  onStateChange: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('bot:state-change', listener);
    return () => ipcRenderer.removeListener('bot:state-change', listener);
  },

  onQueueUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('bot:queue-update', listener);
    return () => ipcRenderer.removeListener('bot:queue-update', listener);
  },

  onConnectionChange: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('bot:connection-change', listener);
    return () => ipcRenderer.removeListener('bot:connection-change', listener);
  },

  // Auto-Updater (GitHub Releases)
  getAppVersion: () => ipcRenderer.invoke('updater:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },

  // ChatGPT Auto (also exposed on window.electronAPI)
  ...chatgptBridge
});
