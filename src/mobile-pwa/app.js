(() => {
  const STORAGE_PIN_KEY = 'flow_remote_pin_v1';
  const STORAGE_ALERT_KEY = 'flow_remote_alerts_v1';

  let savedPin = localStorage.getItem(STORAGE_PIN_KEY) || '';
  let alertsEnabled = localStorage.getItem(STORAGE_ALERT_KEY) !== 'false';
  let selectedProfile = 1;
  let pollTimer = null;
  let screenTimer = null;
  let lastSeenAlertId = null;
  let initialPollDone = false;
  let latestLogsCache = [];
  let currentObjectUrl = null;
  let audioCtx = null;

  const els = {
    pinScreen: document.getElementById('pinScreen'),
    pinForm: document.getElementById('pinForm'),
    pinInput: document.getElementById('pinInput'),
    pinErrorMsg: document.getElementById('pinErrorMsg'),
    btnUnlockPin: document.getElementById('btnUnlockPin'),

    appShell: document.getElementById('appShell'),
    liveNetBadge: document.getElementById('liveNetBadge'),
    liveNetText: document.getElementById('liveNetText'),
    btnToggleAlerts: document.getElementById('btnToggleAlerts'),
    btnLogoutPin: document.getElementById('btnLogoutPin'),
    profilePillsContainer: document.getElementById('profilePillsContainer'),
    btnSpawnWindow: document.getElementById('btnSpawnWindow'),
    toastBanner: document.getElementById('toastBanner'),

    // Tab 1: Control
    heroProfileTitle: document.getElementById('heroProfileTitle'),
    heroConnDot: document.getElementById('heroConnDot'),
    heroConnText: document.getElementById('heroConnText'),
    heroStateBadge: document.getElementById('heroStateBadge'),
    heroProgressLabel: document.getElementById('heroProgressLabel'),
    heroProgressPct: document.getElementById('heroProgressPct'),
    heroProgressFill: document.getElementById('heroProgressFill'),
    heroVppLabel: document.getElementById('heroVppLabel'),
    heroOutputLabel: document.getElementById('heroOutputLabel'),

    tilePending: document.getElementById('tilePending'),
    tileGenerating: document.getElementById('tileGenerating'),
    tileCompleted: document.getElementById('tileCompleted'),
    tileFailed: document.getElementById('tileFailed'),

    btnRemoteLaunchChrome: document.getElementById('btnRemoteLaunchChrome'),
    btnRemoteStart: document.getElementById('btnRemoteStart'),
    btnRemotePause: document.getElementById('btnRemotePause'),
    btnRemoteResume: document.getElementById('btnRemoteResume'),
    btnRemoteStop: document.getElementById('btnRemoteStop'),
    btnRemoteConnect: document.getElementById('btnRemoteConnect'),
    btnRemoteChatgptToggle: document.getElementById('btnRemoteChatgptToggle'),
    btnRemoteChatgptLabel: document.getElementById('btnRemoteChatgptLabel'),
    chatgptQuickDrawer: document.getElementById('chatgptQuickDrawer'),
    remoteChatgptTopic: document.getElementById('remoteChatgptTopic'),
    btnRemoteChatgptStart: document.getElementById('btnRemoteChatgptStart'),
    btnRemoteChatgptStop: document.getElementById('btnRemoteChatgptStop'),

    // Tab 2: Prompts
    mobileSplitMode: document.getElementById('mobileSplitMode'),
    mobilePromptInput: document.getElementById('mobilePromptInput'),
    btnRemoteAddPrompts: document.getElementById('btnRemoteAddPrompts'),
    mobileQueueCountBadge: document.getElementById('mobileQueueCountBadge'),
    btnRemoteRetryFailed: document.getElementById('btnRemoteRetryFailed'),
    btnRemoteClearDone: document.getElementById('btnRemoteClearDone'),
    mobileQueueList: document.getElementById('mobileQueueList'),

    // Tab 3: Live Logs
    chkMobileLogAutoScroll: document.getElementById('chkMobileLogAutoScroll'),
    btnRemoteRefreshLogs: document.getElementById('btnRemoteRefreshLogs'),
    btnRemoteCopyLogs: document.getElementById('btnRemoteCopyLogs'),
    mobileLogsTerminal: document.getElementById('mobileLogsTerminal'),

    // Tab 4: Live Screen
    chkScreenAutoRefresh: document.getElementById('chkScreenAutoRefresh'),
    btnRemoteRefreshScreen: document.getElementById('btnRemoteRefreshScreen'),
    screenPlaceholder: document.getElementById('screenPlaceholder'),
    liveScreenshotImg: document.getElementById('liveScreenshotImg'),
    screenTimestamp: document.getElementById('screenTimestamp')
  };

  // =========================================================================
  // SERVICE WORKER REGISTRATION
  // =========================================================================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // =========================================================================
  // AUDIO & VIBRATION ALERTS
  // =========================================================================
  function playAlertChime(type = 'info') {
    if (!alertsEnabled) return;

    try {
      if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
      }
    } catch (_) {}

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioCtx) {
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'warn' || type === 'error') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.setValueAtTime(390, now + 0.16);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880, now + 0.14);
      }

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);

      osc.start(now);
      osc.stop(now + 0.37);
    } catch (_) {}
  }

  let toastTimeout = null;
  function showToast(msg) {
    if (!els.toastBanner) return;
    els.toastBanner.textContent = msg;
    els.toastBanner.classList.remove('hidden');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      els.toastBanner.classList.add('hidden');
    }, 3400);
  }

  function syncAlertButtonUI() {
    if (!els.btnToggleAlerts) return;
    els.btnToggleAlerts.classList.toggle('alert-active', alertsEnabled);
  }

  // =========================================================================
  // NETWORK API HELPERS
  // =========================================================================
  async function apiFetch(pathUrl, options = {}) {
    const headers = {
      ...(options.headers || {}),
      'x-remote-pin': savedPin
    };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(pathUrl, {
      ...options,
      headers
    });

    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('Unauthorized PIN');
    }
    return res;
  }

  function setNetworkLive(isLive) {
    if (!els.liveNetBadge || !els.liveNetText) return;
    if (isLive) {
      els.liveNetBadge.className = 'net-badge net-live';
      els.liveNetText.textContent = 'Live';
    } else {
      els.liveNetBadge.className = 'net-badge net-offline';
      els.liveNetText.textContent = 'Reconnecting';
    }
  }

  // =========================================================================
  // PIN AUTHENTICATION
  // =========================================================================
  function showPinScreen(errorText = '') {
    stopPolling();
    els.appShell.classList.add('hidden');
    els.pinScreen.classList.remove('hidden');
    if (errorText) {
      els.pinErrorMsg.textContent = errorText;
      els.pinErrorMsg.classList.remove('hidden');
    } else {
      els.pinErrorMsg.classList.add('hidden');
    }
  }

  function showAppShell() {
    els.pinScreen.classList.add('hidden');
    els.appShell.classList.remove('hidden');
    startPolling();
  }

  function handleUnauthorized() {
    localStorage.removeItem(STORAGE_PIN_KEY);
    savedPin = '';
    showPinScreen('Session locked or PIN changed. Enter current 6-digit PIN.');
  }

  async function verifyAndUnlockPin(candidatePin) {
    const cleanPin = String(candidatePin || '').trim();
    if (!cleanPin) return false;

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: cleanPin })
      });

      if (!res.ok) {
        showPinScreen('Invalid 6-digit PIN. Check 📱 Phone Remote on your PC.');
        return false;
      }

      savedPin = cleanPin;
      localStorage.setItem(STORAGE_PIN_KEY, savedPin);
      els.pinInput.value = '';
      showAppShell();
      await fetchAndRenderState();
      return true;
    } catch (err) {
      showPinScreen('Could not reach PC server. Check Wi-Fi or Tailscale.');
      return false;
    }
  }

  // =========================================================================
  // STATE POLLING & UI RENDERING
  // =========================================================================
  async function fetchAndRenderState() {
    if (!savedPin) return;
    try {
      const res = await apiFetch(`/api/state?profile=${selectedProfile}`);
      const data = await res.json();
      if (!data || !data.ok) {
        setNetworkLive(false);
        return;
      }

      setNetworkLive(true);
      renderAppState(data);
    } catch (err) {
      if (err && err.message !== 'Unauthorized PIN') {
        setNetworkLive(false);
      }
    }
  }

  function renderProfilePills(profiles, activeProfileNum) {
    if (!els.profilePillsContainer) return;
    const fragment = document.createDocumentFragment();

    (profiles || []).forEach((prof) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `profile-pill${prof.profileNumber === activeProfileNum ? ' active' : ''}`;

      const dot = document.createElement('span');
      const dotStateClass = prof.isRunning
        ? ' dot-running'
        : prof.isPaused
        ? ' dot-paused'
        : '';
      dot.className = `profile-pill-dot${dotStateClass}`;

      const label = document.createElement('span');
      const done = (prof.counts && prof.counts.completed) || 0;
      const total = (prof.counts && prof.counts.total) || 0;
      label.textContent = `Profile ${prof.profileNumber} (${done}/${total})`;

      btn.appendChild(dot);
      btn.appendChild(label);

      btn.addEventListener('click', () => {
        if (selectedProfile !== prof.profileNumber) {
          selectedProfile = prof.profileNumber;
          fetchAndRenderState();
          if (isScreenTabActive()) {
            refreshLiveScreenshot();
          }
        }
      });

      fragment.appendChild(btn);
    });

    els.profilePillsContainer.replaceChildren(fragment);
  }

  function renderQueueItems(queue) {
    if (!els.mobileQueueList) return;
    const list = Array.isArray(queue) ? queue : [];
    els.mobileQueueCountBadge.textContent = String(list.length);

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'screen-placeholder';
      empty.textContent = 'Queue is empty. Paste prompts above to add them.';
      els.mobileQueueList.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'queue-item';

      const top = document.createElement('div');
      top.className = 'queue-item-top';

      const idxSpan = document.createElement('span');
      idxSpan.className = 'queue-item-idx';
      idxSpan.textContent = `#${String(item.index).padStart(3, '0')}`;

      const badge = document.createElement('span');
      const st = String(item.status || 'Pending');
      const stClass =
        st === 'Generating'
          ? 'q-generating'
          : st === 'Completed'
          ? 'q-completed'
          : st === 'Failed'
          ? 'q-failed'
          : 'q-pending';
      badge.className = `queue-item-badge ${stClass}`;
      badge.textContent = item.progressText || st;

      top.appendChild(idxSpan);
      top.appendChild(badge);

      const textDiv = document.createElement('div');
      textDiv.className = 'queue-item-text';
      textDiv.textContent = item.title || item.text || '';

      row.appendChild(top);
      row.appendChild(textDiv);

      if (item.error) {
        const sub = document.createElement('div');
        sub.className = 'queue-item-sub';
        sub.textContent = `⚠️ ${item.error}`;
        row.appendChild(sub);
      } else if (item.outputFile) {
        const sub = document.createElement('div');
        sub.className = 'queue-item-sub';
        sub.textContent = `✅ ${item.outputFile}`;
        row.appendChild(sub);
      }

      fragment.appendChild(row);
    });

    els.mobileQueueList.replaceChildren(fragment);
  }

  function classifyLogLine(text) {
    const lower = String(text || '').toLowerCase();
    if (text.includes('❌') || /\b(error|failed|fatal)\b/.test(lower)) {
      return 'm-log-error';
    }
    if (
      text.includes('⚠️') ||
      text.includes('⏳') ||
      text.includes('🔄') ||
      /\b(waiting|retry|retrying|paused|unusual activity|cooldown)\b/.test(lower)
    ) {
      return 'm-log-warn';
    }
    if (text.includes('✅') || text.includes('🚀') || /\b(saved|completed|connected)\b/.test(lower)) {
      return 'm-log-success';
    }
    return 'm-log-info';
  }

  function renderLogs(logs) {
    if (!els.mobileLogsTerminal) return;
    const arr = Array.isArray(logs) ? logs : [];
    latestLogsCache = arr;

    if (arr.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'm-log-line m-log-info';
      empty.textContent = 'No activity logs yet for this profile.';
      els.mobileLogsTerminal.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    arr.forEach((lineObj) => {
      const text = typeof lineObj === 'string' ? lineObj : lineObj.formatted || lineObj.message || '';
      const div = document.createElement('div');
      div.className = `m-log-line ${classifyLogLine(text)}`;
      div.textContent = text;
      fragment.appendChild(div);
    });

    els.mobileLogsTerminal.replaceChildren(fragment);
    if (els.chkMobileLogAutoScroll && els.chkMobileLogAutoScroll.checked) {
      els.mobileLogsTerminal.scrollTop = els.mobileLogsTerminal.scrollHeight;
    }
  }

  function renderAppState(data) {
    if (data.profileNumber) {
      selectedProfile = data.profileNumber;
    }

    renderProfilePills(data.profiles || [], selectedProfile);

    // Hero Card
    const debugPort = data.debugPort || 9222;
    els.heroProfileTitle.textContent = `Profile ${selectedProfile} • Port ${debugPort}`;

    if (data.isConnected) {
      els.heroConnDot.className = 'conn-dot conn-on';
      els.heroConnText.textContent = `Connected :${debugPort}`;
    } else {
      els.heroConnDot.className = 'conn-dot conn-off';
      els.heroConnText.textContent = `Disconnected (:${debugPort})`;
    }

    const rawState = data.state || (data.isRunning ? 'RUNNING' : data.isPaused ? 'PAUSED' : 'IDLE');
    els.heroStateBadge.textContent = rawState;
    els.heroStateBadge.className =
      rawState === 'RUNNING'
        ? 'state-badge state-running'
        : rawState === 'PAUSED'
        ? 'state-badge state-paused'
        : 'state-badge state-idle';

    const counts = data.counts || { total: 0, pending: 0, generating: 0, completed: 0, failed: 0 };
    const pct = counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0;
    els.heroProgressLabel.textContent = `Progress: ${counts.completed} / ${counts.total} completed`;
    els.heroProgressPct.textContent = `${pct}%`;
    els.heroProgressFill.style.width = `${pct}%`;

    els.heroVppLabel.textContent = `Videos/Prompt: ${data.videosPerPrompt || 1}`;
    const folderParts = String(data.effectiveOutputDir || '').split(/[\\/]/).filter(Boolean);
    const shortFolder = folderParts.slice(-2).join('\\') || 'GoogleFlowVideos';
    els.heroOutputLabel.textContent = shortFolder;

    // 4 Stat Tiles
    els.tilePending.textContent = String(counts.pending || 0);
    els.tileGenerating.textContent = String(counts.generating || 0);
    els.tileCompleted.textContent = String(counts.completed || 0);
    els.tileFailed.textContent = String(counts.failed || 0);

    // Control Button Enable/Disable States
    const isRunning = Boolean(data.isRunning);
    const isPaused = Boolean(data.isPaused);
    els.btnRemoteStart.disabled = isRunning || isPaused;
    els.btnRemotePause.disabled = !isRunning;
    els.btnRemoteResume.disabled = !isPaused;
    els.btnRemoteStop.disabled = !isRunning && !isPaused;

    if (els.btnRemoteChatgptLabel) {
      els.btnRemoteChatgptLabel.textContent = data.chatgptRunning
        ? 'ChatGPT: Running...'
        : 'ChatGPT Auto';
    }

    // Queue & Logs
    renderQueueItems(data.queue || []);
    renderLogs(data.logs || []);

    // Check for new critical alerts (batch complete or unusual-activity safety pause)
    if (data.lastAlert && data.lastAlert.id) {
      if (initialPollDone && lastSeenAlertId && lastSeenAlertId !== data.lastAlert.id) {
        playAlertChime(data.lastAlert.type || 'info');
        showToast(data.lastAlert.message || 'Bot status alert');
      }
      lastSeenAlertId = data.lastAlert.id;
    }
    initialPollDone = true;
  }

  // =========================================================================
  // REMOTE ACTION DISPATCHER
  // =========================================================================
  async function sendRemoteAction(action, payload = {}, buttonEl = null) {
    if (buttonEl) buttonEl.disabled = true;
    try {
      const res = await apiFetch('/api/action', {
        method: 'POST',
        body: JSON.stringify({
          profileNumber: selectedProfile,
          action,
          payload
        })
      });
      const data = await res.json();
      if (data && data.message) {
        showToast(data.message);
      } else if (data && data.error) {
        showToast(`⚠️ ${data.error}`);
      }
      if (data && data.newProfileNumber) {
        selectedProfile = data.newProfileNumber;
      }
      await fetchAndRenderState();
      return data;
    } catch (err) {
      if (err && err.message !== 'Unauthorized PIN') {
        showToast('⚠️ Failed to send action to PC.');
      }
      return null;
    } finally {
      if (buttonEl) buttonEl.disabled = false;
    }
  }

  // =========================================================================
  // LIVE SCREENSHOT CAPTURE
  // =========================================================================
  function isScreenTabActive() {
    const pane = document.getElementById('tab-screen');
    return Boolean(pane && pane.classList.contains('active'));
  }

  async function refreshLiveScreenshot() {
    if (!savedPin) return;
    try {
      els.screenTimestamp.textContent = 'Capturing live Google Flow tab...';
      const res = await apiFetch(`/api/screenshot?profile=${selectedProfile}&t=${Date.now()}`);
      if (!res.ok) {
        let errMsg = 'Chrome is not connected to Google Flow on this profile yet.';
        try {
          const errJson = await res.json();
          if (errJson && errJson.error) errMsg = errJson.error;
        } catch (_) {}
        els.liveScreenshotImg.classList.add('hidden');
        els.screenPlaceholder.textContent = errMsg;
        els.screenPlaceholder.classList.remove('hidden');
        els.screenTimestamp.textContent = 'Not connected';
        return;
      }

      const blob = await res.blob();
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
      }
      currentObjectUrl = URL.createObjectURL(blob);
      els.liveScreenshotImg.src = currentObjectUrl;
      els.liveScreenshotImg.classList.remove('hidden');
      els.screenPlaceholder.classList.add('hidden');
      els.screenTimestamp.textContent = `Captured Profile ${selectedProfile} at ${new Date().toLocaleTimeString()}`;
    } catch (_) {
      els.screenTimestamp.textContent = 'Failed to capture screenshot';
    }
  }

  function syncScreenAutoRefreshTimer() {
    if (screenTimer) {
      clearInterval(screenTimer);
      screenTimer = null;
    }
    if (els.chkScreenAutoRefresh && els.chkScreenAutoRefresh.checked && isScreenTabActive()) {
      screenTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && isScreenTabActive()) {
          refreshLiveScreenshot();
        }
      }, 5000);
    }
  }

  // =========================================================================
  // POLLING LIFECYCLE
  // =========================================================================
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchAndRenderState();
      }
    }, 2500);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // =========================================================================
  // EVENT LISTENERS
  // =========================================================================
  function bindEvents() {
    // PIN Unlock Form
    els.pinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      els.btnUnlockPin.disabled = true;
      await verifyAndUnlockPin(els.pinInput.value);
      els.btnUnlockPin.disabled = false;
    });

    // Top Header Actions
    syncAlertButtonUI();
    els.btnToggleAlerts.addEventListener('click', () => {
      alertsEnabled = !alertsEnabled;
      localStorage.setItem(STORAGE_ALERT_KEY, String(alertsEnabled));
      syncAlertButtonUI();
      if (alertsEnabled) {
        playAlertChime('info');
        showToast('🔔 Audio & Vibration alerts enabled');
      } else {
        showToast('🔕 Alerts muted');
      }
    });

    els.btnLogoutPin.addEventListener('click', () => {
      handleUnauthorized();
    });

    els.btnSpawnWindow.addEventListener('click', () => {
      sendRemoteAction('new-window', {}, els.btnSpawnWindow);
    });

    // Bottom Navigation Tabs
    const navButtons = document.querySelectorAll('.nav-tab');
    const tabPanes = document.querySelectorAll('.tab-pane');
    navButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-tab');
        navButtons.forEach((b) => b.classList.toggle('active', b === btn));
        tabPanes.forEach((pane) => pane.classList.toggle('active', pane.id === targetId));

        if (targetId === 'tab-screen') {
          refreshLiveScreenshot();
        }
        syncScreenAutoRefreshTimer();
      });
    });

    // Tab 1: Control Buttons
    els.btnRemoteLaunchChrome.addEventListener('click', () => {
      showToast('🚀 Launching Chrome & ZeeFlow setup on PC...');
      sendRemoteAction('launch-chrome', {}, els.btnRemoteLaunchChrome);
    });

    els.btnRemoteStart.addEventListener('click', () => {
      sendRemoteAction('start', {}, els.btnRemoteStart);
    });

    els.btnRemotePause.addEventListener('click', () => {
      sendRemoteAction('pause', {}, els.btnRemotePause);
    });

    els.btnRemoteResume.addEventListener('click', () => {
      sendRemoteAction('resume', {}, els.btnRemoteResume);
    });

    els.btnRemoteStop.addEventListener('click', () => {
      sendRemoteAction('stop', {}, els.btnRemoteStop);
    });

    els.btnRemoteConnect.addEventListener('click', () => {
      sendRemoteAction('connect', {}, els.btnRemoteConnect);
    });

    els.btnRemoteChatgptToggle.addEventListener('click', () => {
      els.chatgptQuickDrawer.classList.toggle('hidden');
    });

    els.btnRemoteChatgptStart.addEventListener('click', () => {
      const topic = (els.remoteChatgptTopic.value || '').trim();
      sendRemoteAction('chatgpt-auto', { topic }, els.btnRemoteChatgptStart);
    });

    els.btnRemoteChatgptStop.addEventListener('click', () => {
      sendRemoteAction('chatgpt-stop', {}, els.btnRemoteChatgptStop);
    });

    // Tab 2: Prompts & Queue Actions
    els.btnRemoteAddPrompts.addEventListener('click', async () => {
      const text = (els.mobilePromptInput.value || '').trim();
      if (!text) {
        showToast('Paste at least 1 prompt first.');
        return;
      }
      const splitMode = els.mobileSplitMode ? els.mobileSplitMode.value : 'smart';
      const res = await sendRemoteAction(
        'add-prompts',
        { text, splitMode },
        els.btnRemoteAddPrompts
      );
      if (res && res.ok) {
        els.mobilePromptInput.value = '';
      }
    });

    els.btnRemoteRetryFailed.addEventListener('click', () => {
      sendRemoteAction('retry-failed', {}, els.btnRemoteRetryFailed);
    });

    els.btnRemoteClearDone.addEventListener('click', () => {
      sendRemoteAction('clear-done', {}, els.btnRemoteClearDone);
    });

    // Tab 3: Live Logs
    els.btnRemoteRefreshLogs.addEventListener('click', () => {
      fetchAndRenderState();
      showToast('Logs refreshed');
    });

    els.btnRemoteCopyLogs.addEventListener('click', async () => {
      const text = latestLogsCache
        .map((l) => (typeof l === 'string' ? l : l.formatted || l.message || ''))
        .join('\n');
      try {
        await navigator.clipboard.writeText(text || '');
        showToast('📋 Logs copied to clipboard');
      } catch (_) {
        showToast('Could not copy logs');
      }
    });

    // Tab 4: Live Screen
    els.btnRemoteRefreshScreen.addEventListener('click', () => {
      refreshLiveScreenshot();
    });

    els.chkScreenAutoRefresh.addEventListener('change', () => {
      syncScreenAutoRefreshTimer();
      if (els.chkScreenAutoRefresh.checked) {
        refreshLiveScreenshot();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && savedPin) {
        fetchAndRenderState();
      }
    });
  }

  // =========================================================================
  // BOOTSTRAP
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    if (savedPin) {
      verifyAndUnlockPin(savedPin);
    } else {
      showPinScreen();
    }
  });
})();
