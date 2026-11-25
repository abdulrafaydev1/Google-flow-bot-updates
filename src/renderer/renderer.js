(() => {
  // =========================================================================
  // DOM ELEMENT REFERENCES
  // =========================================================================
  const els = {
    // Top Status Bar
    botStateBadge: document.getElementById('botStateBadge'),
    instanceProfileBadge: document.getElementById('instanceProfileBadge'),
    headerSubtitleText: document.getElementById('headerSubtitleText'),
    btnNewBotWindow: document.getElementById('btnNewBotWindow'),
    btnCheckUpdates: document.getElementById('btnCheckUpdates'),
    appVersionText: document.getElementById('appVersionText'),
    updateCheckIcon: document.getElementById('updateCheckIcon'),
    connectionBadge: document.getElementById('connectionBadge'),
    connectionDot: document.getElementById('connectionDot'),
    connectionText: document.getElementById('connectionText'),
    connectedUrlText: document.getElementById('connectedUrlText'),
    btnLaunchChrome: document.getElementById('btnLaunchChrome'),
    btnConnectChrome: document.getElementById('btnConnectChrome'),
    btnOpenSettings: document.getElementById('btnOpenSettings'),

    // Auto-Updater Notification Bar
    updateBanner: document.getElementById('updateBanner'),
    updateBannerDot: document.getElementById('updateBannerDot'),
    updateBannerMessage: document.getElementById('updateBannerMessage'),
    updateProgressWrap: document.getElementById('updateProgressWrap'),
    updateProgressFill: document.getElementById('updateProgressFill'),
    btnInstallUpdate: document.getElementById('btnInstallUpdate'),
    btnDismissUpdate: document.getElementById('btnDismissUpdate'),

    // Bulk Prompt Input
    bulkPromptInput: document.getElementById('bulkPromptInput'),
    promptSplitMode: document.getElementById('promptSplitMode'),
    promptLineCount: document.getElementById('promptLineCount'),
    btnImportFile: document.getElementById('btnImportFile'),
    btnAddPrompts: document.getElementById('btnAddPrompts'),

    // Queue Table & Actions
    queueTotalBadge: document.getElementById('queueTotalBadge'),
    btnCopyAllPrompts: document.getElementById('btnCopyAllPrompts'),
    btnRetryFailed: document.getElementById('btnRetryFailed'),
    btnClearCompleted: document.getElementById('btnClearCompleted'),
    btnClearAll: document.getElementById('btnClearAll'),
    queueTableBody: document.getElementById('queueTableBody'),
    queueEmptyState: document.getElementById('queueEmptyState'),

    // Output & Execution Controls
    outputPathInput: document.getElementById('outputPathInput'),
    btnSelectFolder: document.getElementById('btnSelectFolder'),
    btnOpenFolder: document.getElementById('btnOpenFolder'),
    videosPerPromptInput: document.getElementById('videosPerPromptInput'),
    btnStartBot: document.getElementById('btnStartBot'),
    btnPauseBot: document.getElementById('btnPauseBot'),
    btnResumeBot: document.getElementById('btnResumeBot'),
    btnStopBot: document.getElementById('btnStopBot'),

    // Progress & Counters
    progressFractionText: document.getElementById('progressFractionText'),
    progressPercentText: document.getElementById('progressPercentText'),
    progressBarFill: document.getElementById('progressBarFill'),
    statPending: document.getElementById('statPending'),
    statGenerating: document.getElementById('statGenerating'),
    statCompleted: document.getElementById('statCompleted'),
    statFailed: document.getElementById('statFailed'),

    // Terminal Log
    chkAutoScroll: document.getElementById('chkAutoScroll'),
    btnCopyLogs: document.getElementById('btnCopyLogs'),
    btnClearLog: document.getElementById('btnClearLog'),
    terminalLogContainer: document.getElementById('terminalLogContainer'),

    // Settings Modal
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettingsTop: document.getElementById('btnCloseSettingsTop'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    btnResetSettings: document.getElementById('btnResetSettings'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    cfgTargetUrlKeyword: document.getElementById('cfgTargetUrlKeyword'),
    cfgCdpPort: document.getElementById('cfgCdpPort'),
    cfgPromptInputSelector: document.getElementById('cfgPromptInputSelector'),
    cfgGenerateButtonSelector: document.getElementById('cfgGenerateButtonSelector'),
    cfgVideoElementSelector: document.getElementById('cfgVideoElementSelector'),
    cfgDownloadButtonSelector: document.getElementById('cfgDownloadButtonSelector'),
    cfgGenerationTimeoutSec: document.getElementById('cfgGenerationTimeoutSec'),
    cfgDelayBetweenPromptsSec: document.getElementById('cfgDelayBetweenPromptsSec'),
    cfgMaxRetries: document.getElementById('cfgMaxRetries'),
    cfgKeystrokeDelayMs: document.getElementById('cfgKeystrokeDelayMs'),
    cfgInfiniteRefreshOnError: document.getElementById('cfgInfiniteRefreshOnError'),
    settingNewProjectDelayMin: document.getElementById('settingNewProjectDelayMin'),
    settingNewProjectDelayMax: document.getElementById('settingNewProjectDelayMax'),
    settingPrePasteDelayMin: document.getElementById('settingPrePasteDelayMin'),
    settingPrePasteDelayMax: document.getElementById('settingPrePasteDelayMax'),
    settingPreSubmitDelayMin: document.getElementById('settingPreSubmitDelayMin'),
    settingPreSubmitDelayMax: document.getElementById('settingPreSubmitDelayMax'),
    settingSubmitMethod: document.getElementById('settingSubmitMethod'),
    settingCardRetryDelayMin: document.getElementById('settingCardRetryDelayMin'),
    settingCardRetryDelayMax: document.getElementById('settingCardRetryDelayMax'),
    settingCardRetryClicksMin: document.getElementById('settingCardRetryClicksMin'),
    settingCardRetryClicksMax: document.getElementById('settingCardRetryClicksMax'),
    settingAutoSwitchServer: document.getElementById('settingAutoSwitchServer'),
    settingAutoStartAfterLaunch: document.getElementById('settingAutoStartAfterLaunch'),
    settingFlowAgentMode: document.getElementById('settingFlowAgentMode'),
    settingFlowViewMode: document.getElementById('settingFlowViewMode'),

    // ChatGPT Auto Modal & Live Header Pill
    btnOpenChatgptAuto: document.getElementById('btnOpenChatgptAuto'),
    chatgptLivePill: document.getElementById('chatgptLivePill'),
    chatgptLivePillText: document.getElementById('chatgptLivePillText'),
    btnStopChatgptHeader: document.getElementById('btnStopChatgptHeader'),
    chatgptModal: document.getElementById('chatgptModal'),
    btnCloseChatgptTop: document.getElementById('btnCloseChatgptTop'),
    btnCloseChatgptModal: document.getElementById('btnCloseChatgptModal'),
    btnStartChatgptAuto: document.getElementById('btnStartChatgptAuto'),
    btnStopChatgptModal: document.getElementById('btnStopChatgptModal'),
    chatgptMasterPrompt: document.getElementById('chatgptMasterPrompt'),
    chatgptTopicMessage: document.getElementById('chatgptTopicMessage'),
    chatgptTotalPhases: document.getElementById('chatgptTotalPhases'),
    chatgptPromptsPerPhase: document.getElementById('chatgptPromptsPerPhase'),
    chatgptPhase6Prompts: document.getElementById('chatgptPhase6Prompts'),
    chatgptTargetTotalBadge: document.getElementById('chatgptTargetTotalBadge'),
    chatgptContinueTemplate: document.getElementById('chatgptContinueTemplate'),
    chatgptAutoStartBot: document.getElementById('chatgptAutoStartBot'),
    chatgptAutoScroll: document.getElementById('chatgptAutoScroll'),
    chatgptSavedIndicator: document.getElementById('chatgptSavedIndicator'),

    // Phone Remote Modal
    btnOpenPhoneRemote: document.getElementById('btnOpenPhoneRemote'),
    phoneRemoteModal: document.getElementById('phoneRemoteModal'),
    btnClosePhoneRemoteTop: document.getElementById('btnClosePhoneRemoteTop'),
    btnClosePhoneRemote: document.getElementById('btnClosePhoneRemote'),
    btnRefreshRemoteInfo: document.getElementById('btnRefreshRemoteInfo'),
    remoteStatusBadge: document.getElementById('remoteStatusBadge'),
    remotePinDisplay: document.getElementById('remotePinDisplay'),
    btnCopyRemotePin: document.getElementById('btnCopyRemotePin'),
    btnRegenerateRemotePin: document.getElementById('btnRegenerateRemotePin'),
    remoteTailscaleBadge: document.getElementById('remoteTailscaleBadge'),
    remoteAnywhereUrlInput: document.getElementById('remoteAnywhereUrlInput'),
    btnCopyAnywhereUrl: document.getElementById('btnCopyAnywhereUrl'),
    remoteLanUrlInput: document.getElementById('remoteLanUrlInput'),
    btnCopyLanUrl: document.getElementById('btnCopyLanUrl')
  };

  let currentState = 'IDLE';
  let currentQueue = [];
  let currentConfig = {};
  const expandedRows = new Set();

  // =========================================================================
  // TRUSTEDHTML-SAFE SVG ICON HELPER (Lucide Stroke Icons)
  // =========================================================================
  function createLucideIcon(pathDefs, size = 12) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.1');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    for (const d of pathDefs) {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  // =========================================================================
  // LOGGING TERMINAL (AUTO COLOR-CODING + DIMMED TIMESTAMPS)
  // =========================================================================
  function classifyLogLevel(entry, messageText) {
    const rawLevel = entry && entry.level ? String(entry.level).toLowerCase() : '';
    const msg = String(messageText || '');
    const lower = msg.toLowerCase();

    if (
      rawLevel === 'error' ||
      msg.includes('❌') ||
      /\b(error|failed|fatal|aborted)\b/.test(lower)
    ) {
      return 'log-error';
    }

    if (
      rawLevel === 'warn' ||
      msg.includes('⚠️') ||
      msg.includes('⏳') ||
      msg.includes('🔄') ||
      /\b(waiting|refreshing|retry|retrying|cooldown|paused|duplicate|unusual activity|still generating)\b/.test(
        lower
      )
    ) {
      return 'log-warn';
    }

    if (
      rawLevel === 'success' ||
      msg.includes('✅') ||
      /\b(saved|completed|connected|verified playable|finished)\b/.test(lower)
    ) {
      return 'log-success';
    }

    return 'log-info';
  }

  function appendLog(entry) {
    if (!els.terminalLogContainer) return;

    const rawFormatted =
      entry.formatted || `[${new Date().toLocaleTimeString('en-GB')}] ${entry.message || ''}`;
    let tsText = '';
    let bodyText = rawFormatted;

    const tsMatch = rawFormatted.match(/^(\[\d{2}:\d{2}:\d{2}\])\s*(.*)$/);
    if (tsMatch) {
      tsText = tsMatch[1];
      bodyText = tsMatch[2];
    } else if (entry.timestamp) {
      tsText = `[${entry.timestamp}]`;
      bodyText = entry.message || rawFormatted;
    }

    const levelClass = classifyLogLevel(entry, bodyText);
    const line = document.createElement('div');
    line.className = `log-line ${levelClass}`;

    if (tsText) {
      const tsSpan = document.createElement('span');
      tsSpan.className = 'log-ts';
      tsSpan.textContent = tsText;
      line.appendChild(tsSpan);
    }

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';
    msgSpan.textContent = bodyText;
    line.appendChild(msgSpan);

    els.terminalLogContainer.appendChild(line);

    // Keep maximum 500 lines in DOM for smooth performance
    while (els.terminalLogContainer.children.length > 500) {
      els.terminalLogContainer.removeChild(els.terminalLogContainer.firstChild);
    }

    if (els.chkAutoScroll && els.chkAutoScroll.checked) {
      els.terminalLogContainer.scrollTop = els.terminalLogContainer.scrollHeight;
    }
  }

  function logLocal(message, level = 'info') {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    appendLog({
      level,
      message,
      timestamp: `${hh}:${mm}:${ss}`,
      formatted: `[${hh}:${mm}:${ss}] ${message}`
    });
  }

  // =========================================================================
  // UI STATE & CONNECTION RENDERING
  // =========================================================================
  function updateConnectionUI(connected, tabUrl) {
    if (connected) {
      if (els.connectionBadge) els.connectionBadge.classList.add('is-connected');
      els.connectionDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse-dot shrink-0';
      els.connectionText.textContent = 'Connected';
      els.connectionText.className = 'text-[11.5px] font-semibold text-emerald-400 leading-tight truncate';
      els.connectedUrlText.textContent = tabUrl || 'https://flow.google.com';
      els.connectedUrlText.title = tabUrl || '';
    } else {
      if (els.connectionBadge) els.connectionBadge.classList.remove('is-connected');
      els.connectionDot.className = 'w-2 h-2 rounded-full bg-rose-500 shrink-0';
      els.connectionText.textContent = 'Disconnected';
      els.connectionText.className = 'text-[11.5px] font-semibold text-slate-200 leading-tight truncate';
      els.connectedUrlText.textContent = 'No active Chrome tab attached';
      els.connectedUrlText.title = '';
    }
  }

  function updateBotStateUI(state) {
    currentState = state || 'IDLE';

    const stateClassMap = {
      IDLE: 'state-pill state-pill-idle',
      RUNNING: 'state-pill state-pill-running',
      PAUSED: 'state-pill state-pill-paused',
      STOPPED: 'state-pill state-pill-stopped'
    };

    els.botStateBadge.className = stateClassMap[currentState] || stateClassMap.IDLE;
    const dotSpan = document.createElement('span');
    dotSpan.className = 'state-pill-dot';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = currentState;
    els.botStateBadge.replaceChildren(dotSpan, labelSpan);

    // Enable/Disable Execution Control Buttons based on state
    const isRunning = currentState === 'RUNNING';
    const isPaused = currentState === 'PAUSED';

    if (els.progressBarFill) {
      els.progressBarFill.classList.toggle('is-running', isRunning);
    }

    els.btnStartBot.disabled = isRunning || isPaused;
    els.btnPauseBot.disabled = !isRunning;
    els.btnResumeBot.disabled = !isPaused;
    els.btnStopBot.disabled = !isRunning && !isPaused;

    // Prevent destructive queue clear while actively running
    els.btnClearAll.disabled = isRunning;
    els.btnClearCompleted.disabled = isRunning;
  }

  // =========================================================================
  // QUEUE TABLE & PROGRESS BAR RENDERING
  // =========================================================================
  function buildPreviewFilename(index, promptText, totalVideos = 1) {
    const prefix = String(index + 1).padStart(3, '0');
    const slug = String(promptText || 'video')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '_')
      .slice(0, 36)
      .replace(/^_+|_+$/g, '');
    const safeSlug = slug || 'flow_video';
    if (totalVideos > 1) {
      return `${prefix}_v1_${safeSlug}.mp4 (+${totalVideos - 1} more)`;
    }
    return `${prefix}_${safeSlug}.mp4`;
  }

  function extractBasename(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return '';
    const parts = raw.split(/[\\/]/);
    return parts[parts.length - 1] || raw;
  }

  function shouldShowExpandToggle(text) {
    const raw = String(text || '');
    return raw.length > 90 || raw.includes('\n');
  }

  function createVideoProgressBadgeNode(item) {
    const totalVideos = Math.max(
      1,
      parseInt(item.videosPerPrompt || currentConfig.videosPerPrompt || 1, 10)
    );
    let currentNum = 1;
    if (item.status === 'Completed') {
      currentNum = totalVideos;
    } else if (item.status === 'Generating' && item.currentVariation > 0) {
      currentNum = item.currentVariation;
    } else if (item.videosCompleted > 0) {
      currentNum = Math.min(totalVideos, item.videosCompleted + 1);
    }

    const vBadge = document.createElement('span');
    vBadge.className = 'queue-video-badge';
    vBadge.textContent = `Video ${currentNum}/${totalVideos}`;
    return vBadge;
  }

  function createStatusBadgeNode(status, retries, statusText = null) {
    const retryNote = retries > 0 ? ` (Retry #${retries})` : '';
    const badge = document.createElement('span');
    const dot = document.createElement('span');

    if (statusText) {
      badge.className = 'status-badge status-generating';
      badge.title = statusText;
      dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot shrink-0';
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(statusText));
      return badge;
    }

    switch (status) {
      case 'Generating':
        badge.className = 'status-badge status-generating';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse-dot shrink-0';
        badge.appendChild(dot);
        badge.appendChild(document.createTextNode(`Generating${retryNote}`));
        break;
      case 'Completed':
        badge.className = 'status-badge status-completed';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0';
        badge.appendChild(dot);
        badge.appendChild(document.createTextNode('Completed'));
        break;
      case 'Failed':
        badge.className = 'status-badge status-failed';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0';
        badge.appendChild(dot);
        badge.appendChild(document.createTextNode('Failed'));
        break;
      default:
        badge.className = 'status-badge status-pending';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0';
        badge.appendChild(dot);
        badge.appendChild(document.createTextNode('Pending'));
        break;
    }

    return badge;
  }

  function renderQueueSnapshot(snapshot) {
    if (!snapshot) return;

    if (snapshot.state) {
      updateBotStateUI(snapshot.state);
    }
    if (typeof snapshot.connected === 'boolean') {
      updateConnectionUI(snapshot.connected, snapshot.tabUrl);
    }

    currentQueue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const activeIds = new Set(currentQueue.map((item) => item.id));
    for (const expandedId of Array.from(expandedRows)) {
      if (!activeIds.has(expandedId)) {
        expandedRows.delete(expandedId);
      }
    }

    const total = currentQueue.length;
    const pendingCount = currentQueue.filter((i) => i.status === 'Pending').length;
    const generatingCount = currentQueue.filter((i) => i.status === 'Generating').length;
    const completedCount = currentQueue.filter((i) => i.status === 'Completed').length;
    const failedCount = currentQueue.filter((i) => i.status === 'Failed').length;

    // Update Badges & Counters
    els.queueTotalBadge.textContent = `${total} ${total === 1 ? 'item' : 'items'}`;
    els.statPending.textContent = String(pendingCount);
    els.statGenerating.textContent = String(generatingCount);
    els.statCompleted.textContent = String(completedCount);
    els.statFailed.textContent = String(failedCount);

    // Update Progress Bar
    const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
    els.progressFractionText.textContent = `${completedCount} / ${total}`;
    els.progressPercentText.textContent = `${pct}%`;
    els.progressBarFill.style.width = `${pct}%`;

    // Toggle Empty State vs Table Rows
    if (total === 0) {
      els.queueTableBody.replaceChildren();
      els.queueEmptyState.classList.remove('hidden');
      return;
    }

    els.queueEmptyState.classList.add('hidden');

    const fragment = document.createDocumentFragment();

    currentQueue.forEach((item, idx) => {
      const seqNum = String(idx + 1).padStart(3, '0');
      const itemTotalVideos = Math.max(
        1,
        parseInt(item.videosPerPrompt || currentConfig.videosPerPrompt || 1, 10)
      );
      const previewName = buildPreviewFilename(idx, item.text, itemTotalVideos);
      const isGenerating = item.status === 'Generating';
      const isExpanded = expandedRows.has(item.id);
      const showToggle = shouldShowExpandToggle(item.text);

      const statusRowClass =
        item.status === 'Completed'
          ? 'queue-row-completed'
          : isGenerating || item.statusText
          ? 'queue-row-generating'
          : item.status === 'Failed'
          ? 'queue-row-failed'
          : 'queue-row-pending';

      const tr = document.createElement('tr');
      tr.className = `queue-row ${statusRowClass}${isExpanded ? ' queue-row-expanded' : ''}`;
      tr.setAttribute('data-id', item.id);

      // Column 1: Sequence # Badge (fixed narrow column, vertically centered)
      const tdNum = document.createElement('td');
      const indexBadge = document.createElement('span');
      indexBadge.className = 'queue-index-badge';
      indexBadge.textContent = `#${seqNum}`;
      tdNum.appendChild(indexBadge);

      // Column 2: Compact 2-Line Prompt Preview + Single-Line Output/Error Pill & Toggle
      const tdPrompt = document.createElement('td');
      tdPrompt.className = 'overflow-hidden';

      const promptDiv = document.createElement('div');
      promptDiv.className = isExpanded ? 'queue-prompt-text expanded' : 'queue-prompt-text';
      promptDiv.setAttribute('data-action', 'toggle-expand');
      promptDiv.setAttribute('data-id', item.id);
      promptDiv.title = isExpanded ? 'Click to collapse prompt' : 'Click to expand full prompt';
      // Strictly visual clamping only: full unmodified item.text is preserved in DOM & state
      promptDiv.textContent = item.text;

      const metaRow = document.createElement('div');
      metaRow.className = 'queue-meta-row';

      const sublineDiv = document.createElement('div');
      if (item.status === 'Completed' && item.outputFile) {
        sublineDiv.className = 'queue-subline queue-subline-saved';
        const baseFilename = extractBasename(item.outputFile);
        const extraCount =
          Array.isArray(item.outputFiles) && item.outputFiles.length > 1
            ? ` (+${item.outputFiles.length - 1})`
            : '';
        sublineDiv.title =
          Array.isArray(item.outputFiles) && item.outputFiles.length > 0
            ? item.outputFiles.join('\n')
            : item.outputFile;
        sublineDiv.textContent = `✓ ${baseFilename}${extraCount}`;
      } else if ((item.status === 'Failed' || item.statusText) && item.error) {
        sublineDiv.className = 'queue-subline queue-subline-error';
        sublineDiv.title = item.error;
        sublineDiv.textContent = `✕ ${item.error}`;
      } else {
        sublineDiv.className = 'queue-subline queue-subline-target';
        sublineDiv.title = `Target: ${previewName}`;
        sublineDiv.textContent = `Target: ${previewName}`;
      }

      metaRow.appendChild(sublineDiv);

      if (showToggle) {
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'queue-expand-toggle';
        toggleBtn.setAttribute('data-action', 'toggle-expand');
        toggleBtn.setAttribute('data-id', item.id);
        toggleBtn.textContent = isExpanded ? 'Show less ▴' : 'Show more ▾';
        metaRow.appendChild(toggleBtn);
      }

      tdPrompt.appendChild(promptDiv);
      tdPrompt.appendChild(metaRow);

      // Column 3: Compact Status Pill + Video Count Badge
      const tdStatus = document.createElement('td');
      const statusWrap = document.createElement('div');
      statusWrap.className = 'queue-status-wrap';
      statusWrap.appendChild(createStatusBadgeNode(item.status, item.retries, item.statusText));
      statusWrap.appendChild(createVideoProgressBadgeNode(item));
      tdStatus.appendChild(statusWrap);

      // Column 4: Compact Single-Line Actions (Retry / Delete)
      const tdActions = document.createElement('td');
      tdActions.className = 'text-right whitespace-nowrap';

      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'queue-actions-wrap';

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.setAttribute('data-action', 'retry');
      retryBtn.setAttribute('data-id', item.id);
      retryBtn.disabled = isGenerating;
      retryBtn.className = 'queue-action-btn queue-action-retry';
      retryBtn.title = 'Reset prompt status to Pending';
      retryBtn.appendChild(
        createLucideIcon(['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'], 11)
      );
      const retryLabel = document.createElement('span');
      retryLabel.textContent = 'Retry';
      retryBtn.appendChild(retryLabel);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.setAttribute('data-action', 'delete');
      deleteBtn.setAttribute('data-id', item.id);
      deleteBtn.disabled = isGenerating;
      deleteBtn.className = 'queue-action-btn queue-action-delete';
      deleteBtn.title = 'Remove prompt from queue';
      deleteBtn.appendChild(
        createLucideIcon(
          ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
          11
        )
      );
      const deleteLabel = document.createElement('span');
      deleteLabel.textContent = 'Delete';
      deleteBtn.appendChild(deleteLabel);

      actionsWrap.appendChild(retryBtn);
      actionsWrap.appendChild(deleteBtn);
      tdActions.appendChild(actionsWrap);

      tr.appendChild(tdNum);
      tr.appendChild(tdPrompt);
      tr.appendChild(tdStatus);
      tr.appendChild(tdActions);

      fragment.appendChild(tr);
    });

    els.queueTableBody.replaceChildren(fragment);
  }

  // =========================================================================
  // SMART MULTI-LINE PROMPT PARSER
  // =========================================================================
  function parseBulkPrompts(rawText, mode = 'smart') {
    const normalized = String(rawText || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    // Classic 1 Line = 1 Prompt Mode
    if (mode === 'line') {
      return normalized
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    // Smart Block Mode (Default):
    // Groups multi-line structured prompts (e.g., Prompt 4 / - Shot 1 / Camera: / Sound:) into ONE prompt.
    // Splits ONLY on:
    // 1. Horizontal dividers (--- or ===)
    // 2. Double blank lines (\n\s*\n\s*\n)
    // 3. Explicit prompt headers at the start of a line (/^(?:Prompt\s*#?\d+|Scene\s*#?\d+|\d+[\.\)]\s+Prompt)/i)
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

  function updatePromptCountIndicator() {
    const raw = els.bulkPromptInput.value || '';
    const mode = els.promptSplitMode ? els.promptSplitMode.value : 'smart';
    const parsed = parseBulkPrompts(raw, mode);
    const count = parsed.length;
    els.promptLineCount.textContent = `${count} ${count === 1 ? 'prompt' : 'prompts'} ready`;
  }

  // =========================================================================
  // SETTINGS MODAL & VIDEOS PER PROMPT POPULATION
  // =========================================================================
  function syncVideosPerPromptUI(count) {
    const vpp = Math.min(20, Math.max(1, parseInt(count, 10) || 1));
    if (els.videosPerPromptInput) {
      els.videosPerPromptInput.value = String(vpp);
    }
    const quickBtns = document.querySelectorAll('.vpp-quick-btn');
    quickBtns.forEach((btn) => {
      const btnVal = parseInt(btn.getAttribute('data-vpp'), 10);
      btn.classList.toggle('vpp-active', btnVal === vpp);
    });
  }

  function sanitizeDelayRangePair(rawMin, rawMax, fallbackMin = 2, fallbackMax = 6) {
    const parseDelay = (val, fallback) => {
      if (val === undefined || val === null || String(val).trim() === '') return fallback;
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

  function syncNewProjectDelayPresetButtons(minVal, maxVal) {
    const presetBtns = document.querySelectorAll('.delay-preset-btn[data-delay-min]');
    presetBtns.forEach((btn) => {
      const bMin = Number(btn.getAttribute('data-delay-min'));
      const bMax = Number(btn.getAttribute('data-delay-max'));
      const isMatch = bMin === Number(minVal) && bMax === Number(maxVal);
      btn.classList.toggle('delay-preset-active', isMatch);
    });
  }

  function syncPrePasteDelayPresetButtons(minVal, maxVal) {
    const presetBtns = document.querySelectorAll('.prepaste-preset-btn');
    presetBtns.forEach((btn) => {
      const bMin = Number(btn.getAttribute('data-prepaste-min'));
      const bMax = Number(btn.getAttribute('data-prepaste-max'));
      const isMatch = bMin === Number(minVal) && bMax === Number(maxVal);
      btn.classList.toggle('delay-preset-active', isMatch);
    });
  }

  function syncPreSubmitDelayPresetButtons(minVal, maxVal) {
    const presetBtns = document.querySelectorAll('.presubmit-preset-btn');
    presetBtns.forEach((btn) => {
      const bMin = Number(btn.getAttribute('data-presubmit-min'));
      const bMax = Number(btn.getAttribute('data-presubmit-max'));
      const isMatch = bMin === Number(minVal) && bMax === Number(maxVal);
      btn.classList.toggle('delay-preset-active', isMatch);
    });
  }

  function sanitizeRetryClicksPair(rawMin, rawMax, fallbackMin = 5, fallbackMax = 8) {
    const parseClicks = (val, fallback) => {
      if (val === undefined || val === null || String(val).trim() === '') return fallback;
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

  function syncCardRetryDelayPresetButtons(minVal, maxVal) {
    const presetBtns = document.querySelectorAll('.cardretry-delay-preset-btn');
    presetBtns.forEach((btn) => {
      const bMin = Number(btn.getAttribute('data-cardretry-delay-min'));
      const bMax = Number(btn.getAttribute('data-cardretry-delay-max'));
      const isMatch = bMin === Number(minVal) && bMax === Number(maxVal);
      btn.classList.toggle('delay-preset-active', isMatch);
    });
  }

  function syncCardRetryClicksPresetButtons(minVal, maxVal) {
    const presetBtns = document.querySelectorAll('.cardretry-clicks-preset-btn');
    presetBtns.forEach((btn) => {
      const bMin = Number(btn.getAttribute('data-cardretry-clicks-min'));
      const bMax = Number(btn.getAttribute('data-cardretry-clicks-max'));
      const isMatch = bMin === Number(minVal) && bMax === Number(maxVal);
      btn.classList.toggle('delay-preset-active', isMatch);
    });
  }

  function populateSettingsModal(cfg) {
    if (!cfg) return;
    currentConfig = cfg;
    els.outputPathInput.value = cfg.effectiveOutputDir || cfg.downloadPath || '';
    syncVideosPerPromptUI(cfg.videosPerPrompt || 1);
    els.cfgTargetUrlKeyword.value = cfg.targetUrlKeyword || 'flow.google.com, labs.google';
    els.cfgCdpPort.value = cfg.cdpPort || 9222;
    els.cfgPromptInputSelector.value =
      cfg.promptInputSelector || "textarea, [contenteditable='true'], [role='textbox']";
    els.cfgGenerateButtonSelector.value =
      cfg.generateButtonSelector ||
      "button[aria-label*='Generate'], button[aria-label*='Create'], button[type='submit']";
    els.cfgVideoElementSelector.value = cfg.videoElementSelector || 'video';
    els.cfgDownloadButtonSelector.value =
      cfg.downloadButtonSelector || "button[aria-label*='Download'], a[download]";
    els.cfgGenerationTimeoutSec.value = cfg.generationTimeoutSec ?? 180;
    els.cfgDelayBetweenPromptsSec.value = cfg.delayBetweenPromptsSec ?? 10;
    els.cfgMaxRetries.value = cfg.maxRetries ?? 2;
    els.cfgKeystrokeDelayMs.value = cfg.keystrokeDelayMs ?? 15;
    if (els.cfgInfiniteRefreshOnError) {
      els.cfgInfiniteRefreshOnError.checked = Boolean(cfg.infiniteRefreshOnError ?? true);
    }

    const newProjPair = sanitizeDelayRangePair(
      cfg.newProjectDelayMinSec,
      cfg.newProjectDelayMaxSec,
      2,
      6
    );
    if (els.settingNewProjectDelayMin) {
      els.settingNewProjectDelayMin.value = newProjPair.minSec;
    }
    if (els.settingNewProjectDelayMax) {
      els.settingNewProjectDelayMax.value = newProjPair.maxSec;
    }
    syncNewProjectDelayPresetButtons(newProjPair.minSec, newProjPair.maxSec);

    const prePastePair = sanitizeDelayRangePair(
      cfg.prePasteDelayMinSec,
      cfg.prePasteDelayMaxSec,
      2,
      6
    );
    if (els.settingPrePasteDelayMin) {
      els.settingPrePasteDelayMin.value = prePastePair.minSec;
    }
    if (els.settingPrePasteDelayMax) {
      els.settingPrePasteDelayMax.value = prePastePair.maxSec;
    }
    syncPrePasteDelayPresetButtons(prePastePair.minSec, prePastePair.maxSec);

    const preSubmitPair = sanitizeDelayRangePair(
      cfg.preSubmitDelayMinSec,
      cfg.preSubmitDelayMaxSec,
      1,
      4
    );
    if (els.settingPreSubmitDelayMin) {
      els.settingPreSubmitDelayMin.value = preSubmitPair.minSec;
    }
    if (els.settingPreSubmitDelayMax) {
      els.settingPreSubmitDelayMax.value = preSubmitPair.maxSec;
    }
    syncPreSubmitDelayPresetButtons(preSubmitPair.minSec, preSubmitPair.maxSec);

    if (els.settingSubmitMethod) {
      const validMethods = ['random', 'click', 'enter'];
      const methodVal = String(cfg.submitMethod || 'random').toLowerCase();
      els.settingSubmitMethod.value = validMethods.includes(methodVal) ? methodVal : 'random';
    }

    const cardRetryDelayPair = sanitizeDelayRangePair(
      cfg.cardRetryDelayMinSec,
      cfg.cardRetryDelayMaxSec,
      2,
      6
    );
    if (els.settingCardRetryDelayMin) {
      els.settingCardRetryDelayMin.value = cardRetryDelayPair.minSec;
    }
    if (els.settingCardRetryDelayMax) {
      els.settingCardRetryDelayMax.value = cardRetryDelayPair.maxSec;
    }
    syncCardRetryDelayPresetButtons(cardRetryDelayPair.minSec, cardRetryDelayPair.maxSec);

    const cardRetryClicksPair = sanitizeRetryClicksPair(
      cfg.cardRetryClicksMin,
      cfg.cardRetryClicksMax,
      5,
      8
    );
    if (els.settingCardRetryClicksMin) {
      els.settingCardRetryClicksMin.value = cardRetryClicksPair.minClicks;
    }
    if (els.settingCardRetryClicksMax) {
      els.settingCardRetryClicksMax.value = cardRetryClicksPair.maxClicks;
    }
    syncCardRetryClicksPresetButtons(cardRetryClicksPair.minClicks, cardRetryClicksPair.maxClicks);

    if (els.settingAutoSwitchServer) {
      els.settingAutoSwitchServer.checked = Boolean(cfg.autoSwitchServerOnFailure ?? true);
    }

    if (els.settingAutoStartAfterLaunch) {
      els.settingAutoStartAfterLaunch.checked = cfg.autoStartAfterLaunch !== false;
    }

    if (els.settingFlowAgentMode) {
      const rawAgent = cfg.flowAgentMode;
      const normalizedAgent =
        rawAgent === true || rawAgent === 'on' || rawAgent === 'force-on'
          ? 'force-on'
          : rawAgent === 'force-off'
            ? 'force-off'
            : 'off';
      els.settingFlowAgentMode.value = normalizedAgent;
    }

    if (els.settingFlowViewMode) {
      els.settingFlowViewMode.value = ['grid', 'batch', 'off'].includes(cfg.flowViewMode)
        ? cfg.flowViewMode
        : 'off';
    }
  }

  function openSettingsModal() {
    els.settingsModal.classList.remove('hidden');
    els.settingsModal.classList.add('flex');
  }

  function closeSettingsModal() {
    els.settingsModal.classList.add('hidden');
    els.settingsModal.classList.remove('flex');
  }

  // =========================================================================
  // EVENT LISTENERS
  // =========================================================================
  function bindUIEventListeners() {
    // Live prompt counter on bulk textarea & split mode selector
    els.bulkPromptInput.addEventListener('input', updatePromptCountIndicator);
    if (els.promptSplitMode) {
      els.promptSplitMode.addEventListener('change', updatePromptCountIndicator);
    }

    // Add Prompts to Queue
    els.btnAddPrompts.addEventListener('click', async () => {
      const raw = els.bulkPromptInput.value || '';
      const mode = els.promptSplitMode ? els.promptSplitMode.value : 'smart';
      const parsedPrompts = parseBulkPrompts(raw, mode);

      if (parsedPrompts.length === 0) {
        logLocal('Please enter at least one prompt before clicking Add to Queue.', 'warn');
        return;
      }

      const snapshot = await window.flowBotAPI.addPrompts(parsedPrompts);
      els.bulkPromptInput.value = '';
      updatePromptCountIndicator();
      renderQueueSnapshot(snapshot);
    });

    // Import TXT / CSV
    els.btnImportFile.addEventListener('click', async () => {
      const mode = els.promptSplitMode ? els.promptSplitMode.value : 'smart';
      const res = await window.flowBotAPI.importPromptsFile(mode);
      if (res && !res.canceled && res.snapshot) {
        renderQueueSnapshot(res.snapshot);
      }
    });

    // Queue Row Action Delegation (Expand/Collapse Prompt + Retry / Delete)
    els.queueTableBody.addEventListener('click', async (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl || actionEl.disabled) return;

      const action = actionEl.getAttribute('data-action');
      const id = actionEl.getAttribute('data-id');
      if (!id) return;

      if (action === 'toggle-expand') {
        // Avoid collapsing if the user is highlighting text inside an expanded prompt
        if (actionEl.tagName !== 'BUTTON') {
          const sel = window.getSelection && window.getSelection();
          if (sel && sel.toString().trim().length > 0) return;
        }

        const isNowExpanded = !expandedRows.has(id);
        if (isNowExpanded) {
          expandedRows.add(id);
        } else {
          expandedRows.delete(id);
        }

        const row = actionEl.closest('tr.queue-row');
        if (row) {
          row.classList.toggle('queue-row-expanded', isNowExpanded);
          const promptEl = row.querySelector('.queue-prompt-text');
          if (promptEl) {
            promptEl.classList.toggle('expanded', isNowExpanded);
            promptEl.title = isNowExpanded ? 'Click to collapse prompt' : 'Click to expand full prompt';
          }
          const toggleBtn = row.querySelector('.queue-expand-toggle');
          if (toggleBtn) {
            toggleBtn.textContent = isNowExpanded ? 'Show less ▴' : 'Show more ▾';
          }
        }
        return;
      }

      if (action === 'delete') {
        expandedRows.delete(id);
        const snapshot = await window.flowBotAPI.removePrompt(id);
        renderQueueSnapshot(snapshot);
      } else if (action === 'retry') {
        const snapshot = await window.flowBotAPI.retryPrompt(id);
        renderQueueSnapshot(snapshot);
      }
    });

    // Queue Header Bulk Actions
    if (els.btnCopyAllPrompts) {
      let copyAllResetTimer = null;
      els.btnCopyAllPrompts.addEventListener('click', async () => {
        if (!Array.isArray(currentQueue) || currentQueue.length === 0) {
          logLocal('ℹ️ Prompt queue is empty — nothing to copy.');
          return;
        }

        const prompts = currentQueue
          .map((item) => {
            const raw =
              item &&
              (item.text !== undefined
                ? item.text
                : item.prompt !== undefined
                ? item.prompt
                : item.fullText !== undefined
                ? item.fullText
                : item.rawPrompt || '');
            return String(raw || '').replace(/[ \t\r\n]+$/, '').trim();
          })
          .filter((str) => str.length > 0);

        if (prompts.length === 0) {
          logLocal('ℹ️ Prompt queue is empty — nothing to copy.');
          return;
        }

        const allPromptsText = prompts.join('\n\n');
        let copiedOk = false;

        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(allPromptsText);
            copiedOk = true;
          }
        } catch (_) {
          copiedOk = false;
        }

        if (!copiedOk) {
          try {
            const fallbackArea = document.createElement('textarea');
            fallbackArea.value = allPromptsText;
            fallbackArea.setAttribute('readonly', '');
            fallbackArea.style.position = 'fixed';
            fallbackArea.style.top = '-9999px';
            fallbackArea.style.left = '-9999px';
            document.body.appendChild(fallbackArea);
            fallbackArea.select();
            copiedOk = document.execCommand('copy');
            document.body.removeChild(fallbackArea);
          } catch (err) {
            logLocal(`⚠️ Could not copy prompts to clipboard: ${err.message}`, 'warn');
            return;
          }
        }

        const labelSpan = els.btnCopyAllPrompts.querySelector('span');
        if (labelSpan) {
          labelSpan.textContent = `✓ Copied (${prompts.length})`;
        } else {
          els.btnCopyAllPrompts.textContent = `✓ Copied (${prompts.length})`;
        }
        els.btnCopyAllPrompts.classList.add('is-copied');

        if (copyAllResetTimer) {
          clearTimeout(copyAllResetTimer);
        }
        copyAllResetTimer = setTimeout(() => {
          if (labelSpan) {
            labelSpan.textContent = 'Copy All';
          } else {
            els.btnCopyAllPrompts.textContent = 'Copy All';
          }
          els.btnCopyAllPrompts.classList.remove('is-copied');
          copyAllResetTimer = null;
        }, 2000);

        logLocal(
          `📋 Copied all ${prompts.length} prompt(s) from queue to clipboard.`,
          'success'
        );
      });
    }

    els.btnRetryFailed.addEventListener('click', async () => {
      const snapshot = await window.flowBotAPI.retryAllFailed();
      renderQueueSnapshot(snapshot);
    });

    els.btnClearCompleted.addEventListener('click', async () => {
      const snapshot = await window.flowBotAPI.clearQueue(true);
      renderQueueSnapshot(snapshot);
    });

    els.btnClearAll.addEventListener('click', async () => {
      if (currentQueue.length === 0) return;
      const snapshot = await window.flowBotAPI.clearQueue(false);
      renderQueueSnapshot(snapshot);
    });

    // + New Window Button (Multi-Instance Profile Slot)
    if (els.btnNewBotWindow) {
      els.btnNewBotWindow.addEventListener('click', async () => {
        const api = window.electronAPI || window.flowBotAPI;
        if (api && typeof api.openNewWindow === 'function') {
          els.btnNewBotWindow.disabled = true;
          try {
            const res = await api.openNewWindow();
            if (res && res.profileNumber) {
              logLocal(
                `🪟 Opened new Bot Window: Profile ${res.profileNumber} (Chrome Port ${res.debugPort})`,
                'success'
              );
            }
          } finally {
            els.btnNewBotWindow.disabled = false;
          }
        }
      });
    }

    // Chrome Connection Buttons
    els.btnLaunchChrome.addEventListener('click', async () => {
      els.btnLaunchChrome.disabled = true;
      try {
        const res = await window.flowBotAPI.launchChrome();
        if (res && res.connected) {
          updateConnectionUI(true, res.tabUrl);
        }
        if (res && res.snapshot) {
          renderQueueSnapshot(res.snapshot);
        }
      } finally {
        els.btnLaunchChrome.disabled = false;
      }
    });

    els.btnConnectChrome.addEventListener('click', async () => {
      els.btnConnectChrome.disabled = true;
      try {
        const res = await window.flowBotAPI.connectChrome();
        if (res && res.success) {
          updateConnectionUI(true, res.tabUrl);
        }
      } finally {
        els.btnConnectChrome.disabled = false;
      }
    });

    // Folder Picker & Open Folder
    els.btnSelectFolder.addEventListener('click', async () => {
      const res = await window.flowBotAPI.selectOutputFolder();
      if (res && !res.canceled && res.path) {
        els.outputPathInput.value = res.path;
      }
    });

    els.btnOpenFolder.addEventListener('click', async () => {
      await window.flowBotAPI.openOutputFolder();
    });

    // Videos Per Prompt Quick Buttons (1x, 2x, 3x, 4x) & Numeric Input (1-20)
    document.querySelectorAll('.vpp-quick-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const val = Math.min(20, Math.max(1, parseInt(btn.getAttribute('data-vpp'), 10) || 1));
        syncVideosPerPromptUI(val);
        const saved = await window.flowBotAPI.updateConfig({ videosPerPrompt: val });
        currentConfig = saved;
      });
    });

    if (els.videosPerPromptInput) {
      els.videosPerPromptInput.addEventListener('change', async () => {
        const val = Math.min(20, Math.max(1, parseInt(els.videosPerPromptInput.value, 10) || 1));
        syncVideosPerPromptUI(val);
        const saved = await window.flowBotAPI.updateConfig({ videosPerPrompt: val });
        currentConfig = saved;
      });
    }

    // Bot Execution Controls: Start, Pause, Resume, Stop
    els.btnStartBot.addEventListener('click', async () => {
      await window.flowBotAPI.startBot();
    });

    els.btnPauseBot.addEventListener('click', async () => {
      await window.flowBotAPI.pauseBot();
    });

    els.btnResumeBot.addEventListener('click', async () => {
      await window.flowBotAPI.resumeBot();
    });

    els.btnStopBot.addEventListener('click', async () => {
      await window.flowBotAPI.stopBot();
    });

    // Copy Terminal Logs
    if (els.btnCopyLogs) {
      let copyResetTimer = null;
      els.btnCopyLogs.addEventListener('click', async () => {
        if (!els.terminalLogContainer) return;
        const lines = Array.from(els.terminalLogContainer.children)
          .map((lineEl) => {
            const ts = lineEl.querySelector('.log-ts');
            const msg = lineEl.querySelector('.log-msg');
            if (ts && msg) {
              return `${ts.textContent} ${msg.textContent}`.trim();
            }
            return (lineEl.textContent || '').trim();
          })
          .filter(Boolean);
        const logText = lines.join('\n') || els.terminalLogContainer.innerText || '';

        try {
          await navigator.clipboard.writeText(logText);
          els.btnCopyLogs.textContent = 'Copied!';
          els.btnCopyLogs.classList.add('copied');
          if (copyResetTimer) clearTimeout(copyResetTimer);
          copyResetTimer = setTimeout(() => {
            els.btnCopyLogs.textContent = 'Copy';
            els.btnCopyLogs.classList.remove('copied');
            copyResetTimer = null;
          }, 1500);
        } catch (err) {
          logLocal(`Could not copy logs to clipboard: ${err.message}`, 'warn');
        }
      });
    }

    // Clear Terminal Logs
    els.btnClearLog.addEventListener('click', () => {
      els.terminalLogContainer.replaceChildren();
      logLocal('Activity log cleared.');
    });

    // Settings Modal Controls
    els.btnOpenSettings.addEventListener('click', async () => {
      const latestConfig = await window.flowBotAPI.getConfig();
      populateSettingsModal(latestConfig);
      openSettingsModal();
    });

    els.btnCloseSettingsTop.addEventListener('click', closeSettingsModal);
    els.btnCloseSettings.addEventListener('click', closeSettingsModal);
    els.settingsModal.addEventListener('click', (e) => {
      if (e.target === els.settingsModal) {
        closeSettingsModal();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.settingsModal.classList.contains('hidden')) {
        closeSettingsModal();
      }
    });

    // New Project Click Random Delay Quick-Preset Buttons (1s-4s, 1s-10s, 3s-8s)
    document.querySelectorAll('.delay-preset-btn[data-delay-min]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetMin = Number(btn.getAttribute('data-delay-min'));
        const presetMax = Number(btn.getAttribute('data-delay-max'));
        if (els.settingNewProjectDelayMin) {
          els.settingNewProjectDelayMin.value = presetMin;
        }
        if (els.settingNewProjectDelayMax) {
          els.settingNewProjectDelayMax.value = presetMax;
        }
        syncNewProjectDelayPresetButtons(presetMin, presetMax);
      });
    });

    if (els.settingNewProjectDelayMin && els.settingNewProjectDelayMax) {
      const handleManualDelayInput = () => {
        syncNewProjectDelayPresetButtons(
          els.settingNewProjectDelayMin.value,
          els.settingNewProjectDelayMax.value
        );
      };
      els.settingNewProjectDelayMin.addEventListener('input', handleManualDelayInput);
      els.settingNewProjectDelayMax.addEventListener('input', handleManualDelayInput);
    }

    // Pre-Paste Random Delay Quick-Preset Buttons (1s-4s, 2s-6s, 3s-10s)
    document.querySelectorAll('.prepaste-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetMin = Number(btn.getAttribute('data-prepaste-min'));
        const presetMax = Number(btn.getAttribute('data-prepaste-max'));
        if (els.settingPrePasteDelayMin) {
          els.settingPrePasteDelayMin.value = presetMin;
        }
        if (els.settingPrePasteDelayMax) {
          els.settingPrePasteDelayMax.value = presetMax;
        }
        syncPrePasteDelayPresetButtons(presetMin, presetMax);
      });
    });

    if (els.settingPrePasteDelayMin && els.settingPrePasteDelayMax) {
      const handleManualPrePasteInput = () => {
        syncPrePasteDelayPresetButtons(
          els.settingPrePasteDelayMin.value,
          els.settingPrePasteDelayMax.value
        );
      };
      els.settingPrePasteDelayMin.addEventListener('input', handleManualPrePasteInput);
      els.settingPrePasteDelayMax.addEventListener('input', handleManualPrePasteInput);
    }

    // Pre-Submit Random Delay Quick-Preset Buttons (1s-3s, 1s-5s, 2s-6s)
    document.querySelectorAll('.presubmit-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetMin = Number(btn.getAttribute('data-presubmit-min'));
        const presetMax = Number(btn.getAttribute('data-presubmit-max'));
        if (els.settingPreSubmitDelayMin) {
          els.settingPreSubmitDelayMin.value = presetMin;
        }
        if (els.settingPreSubmitDelayMax) {
          els.settingPreSubmitDelayMax.value = presetMax;
        }
        syncPreSubmitDelayPresetButtons(presetMin, presetMax);
      });
    });

    if (els.settingPreSubmitDelayMin && els.settingPreSubmitDelayMax) {
      const handleManualPreSubmitInput = () => {
        syncPreSubmitDelayPresetButtons(
          els.settingPreSubmitDelayMin.value,
          els.settingPreSubmitDelayMax.value
        );
      };
      els.settingPreSubmitDelayMin.addEventListener('input', handleManualPreSubmitInput);
      els.settingPreSubmitDelayMax.addEventListener('input', handleManualPreSubmitInput);
    }

    // Card Error Retry Random Delay Quick-Preset Buttons (1s-4s, 2s-6s, 4s-10s)
    document.querySelectorAll('.cardretry-delay-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetMin = Number(btn.getAttribute('data-cardretry-delay-min'));
        const presetMax = Number(btn.getAttribute('data-cardretry-delay-max'));
        if (els.settingCardRetryDelayMin) {
          els.settingCardRetryDelayMin.value = presetMin;
        }
        if (els.settingCardRetryDelayMax) {
          els.settingCardRetryDelayMax.value = presetMax;
        }
        syncCardRetryDelayPresetButtons(presetMin, presetMax);
      });
    });

    if (els.settingCardRetryDelayMin && els.settingCardRetryDelayMax) {
      const handleManualCardRetryDelayInput = () => {
        syncCardRetryDelayPresetButtons(
          els.settingCardRetryDelayMin.value,
          els.settingCardRetryDelayMax.value
        );
      };
      els.settingCardRetryDelayMin.addEventListener('input', handleManualCardRetryDelayInput);
      els.settingCardRetryDelayMax.addEventListener('input', handleManualCardRetryDelayInput);
    }

    // Card Retry Clicks Quick-Preset Button (5-8 Clicks)
    document.querySelectorAll('.cardretry-clicks-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetMin = Number(btn.getAttribute('data-cardretry-clicks-min'));
        const presetMax = Number(btn.getAttribute('data-cardretry-clicks-max'));
        if (els.settingCardRetryClicksMin) {
          els.settingCardRetryClicksMin.value = presetMin;
        }
        if (els.settingCardRetryClicksMax) {
          els.settingCardRetryClicksMax.value = presetMax;
        }
        syncCardRetryClicksPresetButtons(presetMin, presetMax);
      });
    });

    if (els.settingCardRetryClicksMin && els.settingCardRetryClicksMax) {
      const handleManualCardRetryClicksInput = () => {
        syncCardRetryClicksPresetButtons(
          els.settingCardRetryClicksMin.value,
          els.settingCardRetryClicksMax.value
        );
      };
      els.settingCardRetryClicksMin.addEventListener('input', handleManualCardRetryClicksInput);
      els.settingCardRetryClicksMax.addEventListener('input', handleManualCardRetryClicksInput);
    }

    els.btnSaveSettings.addEventListener('click', async () => {
      const delayPair = sanitizeDelayRangePair(
        els.settingNewProjectDelayMin ? els.settingNewProjectDelayMin.value : 2,
        els.settingNewProjectDelayMax ? els.settingNewProjectDelayMax.value : 6,
        2,
        6
      );
      if (els.settingNewProjectDelayMin) {
        els.settingNewProjectDelayMin.value = delayPair.minSec;
      }
      if (els.settingNewProjectDelayMax) {
        els.settingNewProjectDelayMax.value = delayPair.maxSec;
      }

      const prePastePair = sanitizeDelayRangePair(
        els.settingPrePasteDelayMin ? els.settingPrePasteDelayMin.value : 2,
        els.settingPrePasteDelayMax ? els.settingPrePasteDelayMax.value : 6,
        2,
        6
      );
      if (els.settingPrePasteDelayMin) {
        els.settingPrePasteDelayMin.value = prePastePair.minSec;
      }
      if (els.settingPrePasteDelayMax) {
        els.settingPrePasteDelayMax.value = prePastePair.maxSec;
      }

      const preSubmitPair = sanitizeDelayRangePair(
        els.settingPreSubmitDelayMin ? els.settingPreSubmitDelayMin.value : 1,
        els.settingPreSubmitDelayMax ? els.settingPreSubmitDelayMax.value : 4,
        1,
        4
      );
      if (els.settingPreSubmitDelayMin) {
        els.settingPreSubmitDelayMin.value = preSubmitPair.minSec;
      }
      if (els.settingPreSubmitDelayMax) {
        els.settingPreSubmitDelayMax.value = preSubmitPair.maxSec;
      }

      const cardRetryDelayPair = sanitizeDelayRangePair(
        els.settingCardRetryDelayMin ? els.settingCardRetryDelayMin.value : 2,
        els.settingCardRetryDelayMax ? els.settingCardRetryDelayMax.value : 6,
        2,
        6
      );
      if (els.settingCardRetryDelayMin) {
        els.settingCardRetryDelayMin.value = cardRetryDelayPair.minSec;
      }
      if (els.settingCardRetryDelayMax) {
        els.settingCardRetryDelayMax.value = cardRetryDelayPair.maxSec;
      }

      const cardRetryClicksPair = sanitizeRetryClicksPair(
        els.settingCardRetryClicksMin ? els.settingCardRetryClicksMin.value : 5,
        els.settingCardRetryClicksMax ? els.settingCardRetryClicksMax.value : 8,
        5,
        8
      );
      if (els.settingCardRetryClicksMin) {
        els.settingCardRetryClicksMin.value = cardRetryClicksPair.minClicks;
      }
      if (els.settingCardRetryClicksMax) {
        els.settingCardRetryClicksMax.value = cardRetryClicksPair.maxClicks;
      }

      const autoSwitchServer = els.settingAutoSwitchServer
        ? Boolean(els.settingAutoSwitchServer.checked)
        : true;

      const autoStartAfterLaunch = els.settingAutoStartAfterLaunch
        ? Boolean(els.settingAutoStartAfterLaunch.checked)
        : true;

      const selectedAgent = els.settingFlowAgentMode ? els.settingFlowAgentMode.value : 'off';
      const flowAgentMode = ['off', 'force-off', 'force-on'].includes(selectedAgent)
        ? selectedAgent
        : 'off';

      const flowViewMode =
        els.settingFlowViewMode && ['grid', 'batch', 'off'].includes(els.settingFlowViewMode.value)
          ? els.settingFlowViewMode.value
          : 'off';

      const validSubmitMethods = ['random', 'click', 'enter'];
      const rawSubmitMethod = els.settingSubmitMethod
        ? String(els.settingSubmitMethod.value || 'random').toLowerCase()
        : 'random';
      const chosenSubmitMethod = validSubmitMethods.includes(rawSubmitMethod)
        ? rawSubmitMethod
        : 'random';

      const updatedPayload = {
        targetUrlKeyword: els.cfgTargetUrlKeyword.value.trim() || 'labs.google',
        cdpPort: Number(els.cfgCdpPort.value) || 9222,
        promptInputSelector:
          els.cfgPromptInputSelector.value.trim() || "textarea, [contenteditable='true']",
        generateButtonSelector:
          els.cfgGenerateButtonSelector.value.trim() ||
          "button[aria-label*='Generate'], button[type='submit']",
        videoElementSelector: els.cfgVideoElementSelector.value.trim() || 'video',
        downloadButtonSelector:
          els.cfgDownloadButtonSelector.value.trim() || "button[aria-label*='Download'], a[download]",
        generationTimeoutSec: Number(els.cfgGenerationTimeoutSec.value) || 180,
        delayBetweenPromptsSec: Number(els.cfgDelayBetweenPromptsSec.value) || 10,
        maxRetries: Number(els.cfgMaxRetries.value ?? 2),
        keystrokeDelayMs: Number(els.cfgKeystrokeDelayMs.value ?? 15),
        infiniteRefreshOnError: els.cfgInfiniteRefreshOnError
          ? Boolean(els.cfgInfiniteRefreshOnError.checked)
          : true,
        newProjectDelayMinSec: delayPair.minSec,
        newProjectDelayMaxSec: delayPair.maxSec,
        prePasteDelayMinSec: prePastePair.minSec,
        prePasteDelayMaxSec: prePastePair.maxSec,
        preSubmitDelayMinSec: preSubmitPair.minSec,
        preSubmitDelayMaxSec: preSubmitPair.maxSec,
        submitMethod: chosenSubmitMethod,
        cardRetryDelayMinSec: cardRetryDelayPair.minSec,
        cardRetryDelayMaxSec: cardRetryDelayPair.maxSec,
        cardRetryClicksMin: cardRetryClicksPair.minClicks,
        cardRetryClicksMax: cardRetryClicksPair.maxClicks,
        autoSwitchServerOnFailure: autoSwitchServer,
        autoStartAfterLaunch,
        flowAgentMode,
        flowViewMode
      };

      const saved = await window.flowBotAPI.updateConfig(updatedPayload);
      populateSettingsModal(saved);
      logLocal(
        `Settings saved: Flow Agent (${String(saved.flowAgentMode || 'off').toUpperCase()}), View Mode (${String(saved.flowViewMode || 'off').toUpperCase()}), Auto-Start (${saved.autoStartAfterLaunch !== false ? 'ON' : 'OFF'}), Card Retry (${saved.cardRetryClicksMin}–${saved.cardRetryClicksMax} clicks).`,
        'success'
      );
      closeSettingsModal();
    });

    els.btnResetSettings.addEventListener('click', async () => {
      const reset = await window.flowBotAPI.resetConfig();
      populateSettingsModal(reset);
    });

    // Auto-Updater Controls
    if (els.btnCheckUpdates) {
      els.btnCheckUpdates.addEventListener('click', async () => {
        if (window.flowBotAPI && typeof window.flowBotAPI.checkForUpdates === 'function') {
          updaterDismissedDuringDownload = false;
          await window.flowBotAPI.checkForUpdates();
        }
      });
    }

    if (els.btnInstallUpdate) {
      els.btnInstallUpdate.addEventListener('click', async () => {
        if (currentState === 'RUNNING') {
          const ok = window.confirm(
            'A video generation batch is currently running. Stop the current run and restart now to install the update?'
          );
          if (!ok) return;
        }
        if (window.flowBotAPI && typeof window.flowBotAPI.installUpdate === 'function') {
          await window.flowBotAPI.installUpdate();
        }
      });
    }

    if (els.btnDismissUpdate) {
      els.btnDismissUpdate.addEventListener('click', () => {
        hideUpdateBanner();
        if (latestUpdaterState === 'downloading' || latestUpdaterState === 'available') {
          updaterDismissedDuringDownload = true;
        }
      });
    }
  }

  // =========================================================================
  // AUTO-UPDATER BANNER & HEADER VERSION PILL UI
  // =========================================================================
  let updateAutoHideTimer = null;
  let latestUpdaterState = 'idle';
  let updaterDismissedDuringDownload = false;

  function hideUpdateBanner() {
    if (updateAutoHideTimer) {
      clearTimeout(updateAutoHideTimer);
      updateAutoHideTimer = null;
    }
    if (els.updateBanner) {
      els.updateBanner.classList.add('hidden');
    }
  }

  function showUpdateBanner({
    variant = 'info',
    dotClass = 'w-2 h-2 rounded-full bg-indigo-400 shrink-0',
    message = '',
    showProgress = false,
    percent = 0,
    showInstall = false,
    dismissLabel = 'Later',
    autoHideMs = 0
  }) {
    if (!els.updateBanner) return;
    if (updateAutoHideTimer) {
      clearTimeout(updateAutoHideTimer);
      updateAutoHideTimer = null;
    }

    els.updateBanner.className = `update-banner update-banner-${variant}`;
    if (els.updateBannerDot) els.updateBannerDot.className = dotClass;
    if (els.updateBannerMessage) els.updateBannerMessage.textContent = message;

    if (els.updateProgressWrap && els.updateProgressFill) {
      els.updateProgressWrap.classList.toggle('hidden', !showProgress);
      els.updateProgressFill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    }

    if (els.btnInstallUpdate) {
      els.btnInstallUpdate.classList.toggle('hidden', !showInstall);
    }

    if (els.btnDismissUpdate) {
      const span = els.btnDismissUpdate.querySelector('span');
      if (span) span.textContent = dismissLabel;
    }

    if (autoHideMs > 0) {
      updateAutoHideTimer = setTimeout(() => {
        hideUpdateBanner();
      }, autoHideMs);
    }
  }

  function handleUpdaterStatus(data) {
    if (!data || !data.state) return;
    latestUpdaterState = data.state;

    if (els.updateCheckIcon) {
      els.updateCheckIcon.classList.toggle('animate-spin-slow', data.state === 'checking');
    }

    switch (data.state) {
      case 'checking':
        if (data.manual) {
          showUpdateBanner({
            variant: 'info',
            dotClass: 'w-2 h-2 rounded-full bg-indigo-400 animate-pulse-blue shrink-0',
            message: data.message || 'Checking for updates...',
            showProgress: false,
            showInstall: false,
            dismissLabel: 'Hide'
          });
        }
        break;

      case 'available': {
        updaterDismissedDuringDownload = false;
        const ver = data.version ? `v${data.version}` : 'update';
        showUpdateBanner({
          variant: 'info',
          dotClass: 'w-2 h-2 rounded-full bg-indigo-400 animate-pulse-blue shrink-0',
          message: `Downloading ${ver} — 0%`,
          showProgress: true,
          percent: 0,
          showInstall: false,
          dismissLabel: 'Hide'
        });
        break;
      }

      case 'downloading': {
        if (updaterDismissedDuringDownload) return;
        const pct = Math.max(0, Math.min(100, Math.round(Number(data.percent) || 0)));
        const ver = data.version ? `v${data.version}` : 'update';
        showUpdateBanner({
          variant: 'info',
          dotClass: 'w-2 h-2 rounded-full bg-sky-400 animate-pulse-blue shrink-0',
          message: `Downloading ${ver} — ${pct}%`,
          showProgress: true,
          percent: pct,
          showInstall: false,
          dismissLabel: 'Hide'
        });
        break;
      }

      case 'downloaded': {
        updaterDismissedDuringDownload = false;
        const ver = data.version ? `v${data.version}` : 'update';
        if (els.btnCheckUpdates) {
          els.btnCheckUpdates.classList.add('version-pill-ready');
          els.btnCheckUpdates.title = `Update ${ver} ready — click to install`;
        }
        showUpdateBanner({
          variant: 'ready',
          dotClass: 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse-dot shrink-0',
          message: `Update ${ver} ready! Restart when your batch finishes to install.`,
          showProgress: false,
          showInstall: true,
          dismissLabel: 'Later'
        });
        break;
      }

      case 'up-to-date': {
        if (data.manual) {
          const ver = data.version ? `v${data.version}` : '';
          showUpdateBanner({
            variant: 'success',
            dotClass: 'w-2 h-2 rounded-full bg-emerald-400 shrink-0',
            message: ver
              ? `You're on the latest version (${ver})`
              : data.message || "You're on the latest version",
            showProgress: false,
            showInstall: false,
            dismissLabel: 'Close',
            autoHideMs: 3000
          });
        }
        break;
      }

      case 'dev-mode':
        if (data.manual) {
          showUpdateBanner({
            variant: 'warn',
            dotClass: 'w-2 h-2 rounded-full bg-amber-400 shrink-0',
            message: data.message || 'Dev mode: build installer to test updates',
            showProgress: false,
            showInstall: false,
            dismissLabel: 'Close',
            autoHideMs: 4000
          });
        }
        break;

      case 'error':
        if (data.manual) {
          showUpdateBanner({
            variant: 'error',
            dotClass: 'w-2 h-2 rounded-full bg-rose-400 shrink-0',
            message: `Update check failed: ${data.message || 'Unable to reach GitHub Releases'}`,
            showProgress: false,
            showInstall: false,
            dismissLabel: 'Dismiss',
            autoHideMs: 6000
          });
        }
        break;

      default:
        break;
    }
  }

  // =========================================================================
  // CHATGPT AUTO MODAL, FIFO PASTE-TO-QUEUE PIPELINE & AUTO-START HANDOVER
  // =========================================================================
  const chatgptAPI = window.electronAPI || window.flowBotAPI;
  let chatgptRunning = false;
  let chatgptAutoSaveTimer = null;
  const chatgptPasteQueue = [];
  let chatgptPasteWorkerActive = false;
  let chatgptIdleResolvers = [];

  function calculateChatgptTargetTotal() {
    const totalPhases = Math.min(
      30,
      Math.max(1, parseInt(els.chatgptTotalPhases && els.chatgptTotalPhases.value, 10) || 13)
    );
    const perPhase = Math.min(
      50,
      Math.max(1, parseInt(els.chatgptPromptsPerPhase && els.chatgptPromptsPerPhase.value, 10) || 10)
    );
    const phase6 = Math.min(
      50,
      Math.max(1, parseInt(els.chatgptPhase6Prompts && els.chatgptPhase6Prompts.value, 10) || 20)
    );
    let total = 0;
    for (let p = 1; p <= totalPhases; p++) {
      total += p === 6 ? phase6 : perPhase;
    }
    if (els.chatgptTargetTotalBadge) {
      els.chatgptTargetTotalBadge.textContent = `Target: ${total} prompts`;
    }
    return { totalPhases, promptsPerPhase: perPhase, phase6Prompts: phase6, targetTotal: total };
  }

  function readChatgptFormConfig() {
    const calc = calculateChatgptTargetTotal();
    return {
      masterPrompt: (els.chatgptMasterPrompt && els.chatgptMasterPrompt.value) || '',
      totalPhases: calc.totalPhases,
      promptsPerPhase: calc.promptsPerPhase,
      phase6Prompts: calc.phase6Prompts,
      continueTemplate:
        ((els.chatgptContinueTemplate && els.chatgptContinueTemplate.value) || '').trim() ||
        'Continue to Phase {phase} and generate all {count} prompts in the exact same format.',
      autoStartBot: els.chatgptAutoStartBot ? Boolean(els.chatgptAutoStartBot.checked) : true,
      autoScroll: els.chatgptAutoScroll ? Boolean(els.chatgptAutoScroll.checked) : true
    };
  }

  function populateChatgptModal(cfg) {
    if (!cfg) return;
    if (els.chatgptMasterPrompt) els.chatgptMasterPrompt.value = cfg.masterPrompt || '';
    if (els.chatgptTotalPhases) els.chatgptTotalPhases.value = String(cfg.totalPhases ?? 13);
    if (els.chatgptPromptsPerPhase) els.chatgptPromptsPerPhase.value = String(cfg.promptsPerPhase ?? 10);
    if (els.chatgptPhase6Prompts) els.chatgptPhase6Prompts.value = String(cfg.phase6Prompts ?? 20);
    if (els.chatgptContinueTemplate) {
      els.chatgptContinueTemplate.value =
        cfg.continueTemplate ||
        'Continue to Phase {phase} and generate all {count} prompts in the exact same format.';
    }
    if (els.chatgptAutoStartBot) {
      els.chatgptAutoStartBot.checked = Boolean(cfg.autoStartBot ?? true);
    }
    if (els.chatgptAutoScroll) {
      els.chatgptAutoScroll.checked = Boolean(cfg.autoScroll ?? true);
    }
    calculateChatgptTargetTotal();
  }

  function scheduleChatgptAutoSave() {
    if (els.chatgptSavedIndicator) {
      els.chatgptSavedIndicator.textContent = 'Saving...';
    }
    if (chatgptAutoSaveTimer) clearTimeout(chatgptAutoSaveTimer);
    chatgptAutoSaveTimer = setTimeout(async () => {
      chatgptAutoSaveTimer = null;
      if (chatgptAPI && typeof chatgptAPI.chatgptSaveConfig === 'function') {
        await chatgptAPI.chatgptSaveConfig(readChatgptFormConfig()).catch(() => {});
        if (els.chatgptSavedIndicator) {
          els.chatgptSavedIndicator.textContent = 'Saved';
        }
      }
    }, 350);
  }

  function openChatgptModal() {
    if (!els.chatgptModal) return;
    els.chatgptModal.classList.remove('hidden');
    els.chatgptModal.classList.add('flex');
  }

  function closeChatgptModal() {
    if (!els.chatgptModal) return;
    els.chatgptModal.classList.add('hidden');
    els.chatgptModal.classList.remove('flex');
  }

  function updateChatgptRunningUI(isRunning, statusText = '') {
    chatgptRunning = Boolean(isRunning);
    if (els.btnStartChatgptAuto) els.btnStartChatgptAuto.disabled = chatgptRunning;
    if (els.btnStopChatgptModal) els.btnStopChatgptModal.disabled = !chatgptRunning;

    if (els.chatgptLivePill) {
      els.chatgptLivePill.classList.toggle('hidden', !chatgptRunning);
    }
    if (chatgptRunning && els.chatgptLivePillText && statusText) {
      els.chatgptLivePillText.textContent = `ChatGPT Auto: ${statusText}`;
    }
  }

  function waitForChatgptPasteQueueIdle() {
    if (!chatgptPasteWorkerActive && chatgptPasteQueue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      chatgptIdleResolvers.push(resolve);
    });
  }

  function notifyChatgptPasteQueueIdle() {
    if (!chatgptPasteWorkerActive && chatgptPasteQueue.length === 0 && chatgptIdleResolvers.length > 0) {
      const resolvers = chatgptIdleResolvers.splice(0, chatgptIdleResolvers.length);
      resolvers.forEach((r) => r());
    }
  }

  async function processChatgptPasteQueue() {
    if (chatgptPasteWorkerActive) return;
    chatgptPasteWorkerActive = true;

    try {
      while (chatgptPasteQueue.length > 0) {
        const item = chatgptPasteQueue.shift();
        if (!item || !item.promptText || !els.bulkPromptInput || !els.btnAddPrompts) {
          continue;
        }

        // Temporarily ensure Smart Block Mode when pasting a multi-line extracted prompt so it queues as 1 prompt
        const prevSplitMode = els.promptSplitMode ? els.promptSplitMode.value : 'smart';
        const switchedToSmart = Boolean(
          els.promptSplitMode && prevSplitMode === 'line' && item.promptText.includes('\n')
        );
        if (switchedToSmart) {
          els.promptSplitMode.value = 'smart';
        }

        try {
          els.bulkPromptInput.value = item.promptText;
          els.bulkPromptInput.dispatchEvent(new Event('input', { bubbles: true }));

          // Programmatically click the existing Add to Queue button
          els.btnAddPrompts.click();

          // Wait until Add to Queue clears bulkPromptInput (max 2000ms) so prompts never overwrite each other
          const waitClearStart = Date.now();
          while (els.bulkPromptInput.value !== '' && Date.now() - waitClearStart < 2000) {
            await new Promise((r) => setTimeout(r, 25));
          }

          // 120ms DOM/queue settle spacing before processing next prompt
          await new Promise((r) => setTimeout(r, 120));
        } finally {
          if (switchedToSmart && els.promptSplitMode) {
            els.promptSplitMode.value = prevSplitMode;
          }
        }
      }
    } finally {
      chatgptPasteWorkerActive = false;
      notifyChatgptPasteQueueIdle();
    }
  }

  function enqueueExtractedPromptToBulkInput(payload) {
    if (!payload || !payload.promptText) return;
    chatgptPasteQueue.push(payload);
    processChatgptPasteQueue();
  }

  function bindChatgptAutoControls() {
    if (els.btnOpenChatgptAuto) {
      els.btnOpenChatgptAuto.addEventListener('click', async () => {
        if (chatgptAPI && typeof chatgptAPI.chatgptLoadConfig === 'function') {
          const savedCfg = await chatgptAPI.chatgptLoadConfig().catch(() => null);
          if (savedCfg) populateChatgptModal(savedCfg);
        }
        openChatgptModal();
      });
    }

    if (els.btnCloseChatgptTop) els.btnCloseChatgptTop.addEventListener('click', closeChatgptModal);
    if (els.btnCloseChatgptModal) els.btnCloseChatgptModal.addEventListener('click', closeChatgptModal);
    if (els.chatgptModal) {
      els.chatgptModal.addEventListener('click', (e) => {
        if (e.target === els.chatgptModal) closeChatgptModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.chatgptModal && !els.chatgptModal.classList.contains('hidden')) {
        closeChatgptModal();
      }
    });

    const autoSaveFields = [
      els.chatgptMasterPrompt,
      els.chatgptTotalPhases,
      els.chatgptPromptsPerPhase,
      els.chatgptPhase6Prompts,
      els.chatgptContinueTemplate,
      els.chatgptAutoStartBot,
      els.chatgptAutoScroll
    ].filter(Boolean);

    autoSaveFields.forEach((field) => {
      const evtName = field.type === 'checkbox' ? 'change' : 'input';
      field.addEventListener(evtName, () => {
        calculateChatgptTargetTotal();
        scheduleChatgptAutoSave();
      });
    });

    if (els.btnStartChatgptAuto) {
      els.btnStartChatgptAuto.addEventListener('click', async () => {
        if (!chatgptAPI || typeof chatgptAPI.chatgptStart !== 'function') return;
        const formCfg = readChatgptFormConfig();
        const topicMessage = (els.chatgptTopicMessage && els.chatgptTopicMessage.value) || '';
        if (!formCfg.masterPrompt.trim() && !topicMessage.trim()) {
          logLocal('⚠️ Please enter a Master Prompt or Topic/Message before starting ChatGPT Auto.', 'warn');
          return;
        }

        const res = await chatgptAPI.chatgptStart({
          ...formCfg,
          topicMessage
        });

        if (!res || !res.success) {
          logLocal(`⚠️ ChatGPT Auto could not start: ${(res && res.error) || 'Unknown error'}`, 'warn');
          return;
        }

        updateChatgptRunningUI(true, `Phase 1/${formCfg.totalPhases} • 0/${formCfg.targetTotal}`);
        closeChatgptModal();
      });
    }

    const handleStopChatgpt = async () => {
      if (chatgptAPI && typeof chatgptAPI.chatgptStop === 'function') {
        await chatgptAPI.chatgptStop();
      }
      updateChatgptRunningUI(false);
    };

    if (els.btnStopChatgptHeader) els.btnStopChatgptHeader.addEventListener('click', handleStopChatgpt);
    if (els.btnStopChatgptModal) els.btnStopChatgptModal.addEventListener('click', handleStopChatgpt);
  }

  // =========================================================================
  // PHONE REMOTE MODAL (MOBILE PWA WI-FI & TAILSCALE 4G/5G)
  // =========================================================================
  function populatePhoneRemoteModal(info) {
    if (!info) return;

    if (els.remoteStatusBadge) {
      els.remoteStatusBadge.textContent = `LIVE :${info.port || 3847}`;
    }
    if (els.remotePinDisplay) {
      els.remotePinDisplay.textContent = String(info.pin || '------');
    }
    if (els.remoteLanUrlInput) {
      els.remoteLanUrlInput.value = info.lanUrl || `http://127.0.0.1:${info.port || 3847}`;
    }

    if (info.tailscaleDetected && info.anywhereUrl) {
      if (els.remoteTailscaleBadge) {
        els.remoteTailscaleBadge.textContent = 'Tailscale Connected (4G/5G Ready)';
        els.remoteTailscaleBadge.className = 'text-[10.5px] font-studio-mono text-emerald-400';
      }
      if (els.remoteAnywhereUrlInput) {
        els.remoteAnywhereUrlInput.value = info.anywhereUrl;
      }
      if (els.btnCopyAnywhereUrl) {
        els.btnCopyAnywhereUrl.disabled = false;
      }
    } else {
      if (els.remoteTailscaleBadge) {
        els.remoteTailscaleBadge.textContent = 'Tailscale Not Detected';
        els.remoteTailscaleBadge.className = 'text-[10.5px] font-studio-mono text-amber-300';
      }
      if (els.remoteAnywhereUrlInput) {
        els.remoteAnywhereUrlInput.value =
          'Install Tailscale on PC & Phone to get your 4G/5G Anywhere URL';
      }
      if (els.btnCopyAnywhereUrl) {
        els.btnCopyAnywhereUrl.disabled = true;
      }
    }
  }

  async function refreshPhoneRemoteInfo() {
    if (typeof window.flowBotAPI.getRemoteInfo !== 'function') return;
    try {
      const info = await window.flowBotAPI.getRemoteInfo();
      populatePhoneRemoteModal(info);
    } catch (_) {}
  }

  function openPhoneRemoteModal() {
    if (!els.phoneRemoteModal) return;
    refreshPhoneRemoteInfo();
    els.phoneRemoteModal.classList.remove('hidden');
    els.phoneRemoteModal.classList.add('flex');
  }

  function closePhoneRemoteModal() {
    if (!els.phoneRemoteModal) return;
    els.phoneRemoteModal.classList.add('hidden');
    els.phoneRemoteModal.classList.remove('flex');
  }

  function bindPhoneRemoteControls() {
    if (els.btnOpenPhoneRemote) {
      els.btnOpenPhoneRemote.addEventListener('click', openPhoneRemoteModal);
    }
    if (els.btnClosePhoneRemoteTop) {
      els.btnClosePhoneRemoteTop.addEventListener('click', closePhoneRemoteModal);
    }
    if (els.btnClosePhoneRemote) {
      els.btnClosePhoneRemote.addEventListener('click', closePhoneRemoteModal);
    }
    if (els.btnRefreshRemoteInfo) {
      els.btnRefreshRemoteInfo.addEventListener('click', async () => {
        await refreshPhoneRemoteInfo();
        logLocal('📱 Refreshed Phone Remote network & Tailscale URLs.');
      });
    }
    if (els.phoneRemoteModal) {
      els.phoneRemoteModal.addEventListener('click', (e) => {
        if (e.target === els.phoneRemoteModal) closePhoneRemoteModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (
        e.key === 'Escape' &&
        els.phoneRemoteModal &&
        !els.phoneRemoteModal.classList.contains('hidden')
      ) {
        closePhoneRemoteModal();
      }
    });

    if (els.btnCopyRemotePin) {
      els.btnCopyRemotePin.addEventListener('click', async () => {
        const pin = (els.remotePinDisplay && els.remotePinDisplay.textContent.trim()) || '';
        if (!pin || pin === '------') return;
        try {
          await navigator.clipboard.writeText(pin);
          const orig = els.btnCopyRemotePin.textContent;
          els.btnCopyRemotePin.textContent = 'Copied!';
          setTimeout(() => {
            els.btnCopyRemotePin.textContent = orig;
          }, 1400);
        } catch (_) {}
      });
    }

    if (els.btnRegenerateRemotePin) {
      els.btnRegenerateRemotePin.addEventListener('click', async () => {
        if (typeof window.flowBotAPI.regenerateRemotePin !== 'function') return;
        const info = await window.flowBotAPI.regenerateRemotePin();
        populatePhoneRemoteModal(info);
      });
    }

    if (els.btnCopyAnywhereUrl) {
      els.btnCopyAnywhereUrl.addEventListener('click', async () => {
        const url = (els.remoteAnywhereUrlInput && els.remoteAnywhereUrlInput.value.trim()) || '';
        if (!url.startsWith('http')) return;
        try {
          await navigator.clipboard.writeText(url);
          const orig = els.btnCopyAnywhereUrl.textContent;
          els.btnCopyAnywhereUrl.textContent = 'Copied!';
          setTimeout(() => {
            els.btnCopyAnywhereUrl.textContent = orig;
          }, 1400);
        } catch (_) {}
      });
    }

    if (els.btnCopyLanUrl) {
      els.btnCopyLanUrl.addEventListener('click', async () => {
        const url = (els.remoteLanUrlInput && els.remoteLanUrlInput.value.trim()) || '';
        if (!url.startsWith('http')) return;
        try {
          await navigator.clipboard.writeText(url);
          const orig = els.btnCopyLanUrl.textContent;
          els.btnCopyLanUrl.textContent = 'Copied!';
          setTimeout(() => {
            els.btnCopyLanUrl.textContent = orig;
          }, 1400);
        } catch (_) {}
      });
    }
  }

  // =========================================================================
  // IPC REAL-TIME SUBSCRIPTIONS & INITIALIZATION
  // =========================================================================
  async function initializeDashboard() {
    bindUIEventListeners();
    bindChatgptAutoControls();
    bindPhoneRemoteControls();

    // Subscribe to Main Process events
    window.flowBotAPI.onLog((entry) => {
      appendLog(entry);
    });

    window.flowBotAPI.onStateChange((data) => {
      if (data.state) updateBotStateUI(data.state);
      if (typeof data.connected === 'boolean') updateConnectionUI(data.connected, data.tabUrl);
    });

    window.flowBotAPI.onQueueUpdate((snapshot) => {
      renderQueueSnapshot(snapshot);
    });

    window.flowBotAPI.onConnectionChange((info) => {
      updateConnectionUI(Boolean(info.connected), info.tabUrl);
    });

    if (typeof window.flowBotAPI.onUpdaterStatus === 'function') {
      window.flowBotAPI.onUpdaterStatus((data) => {
        handleUpdaterStatus(data);
      });
    }

    // Subscribe to ChatGPT Auto events
    if (chatgptAPI && typeof chatgptAPI.onChatgptLog === 'function') {
      chatgptAPI.onChatgptLog((entry) => {
        appendLog(entry);
      });
    }

    if (chatgptAPI && typeof chatgptAPI.onChatgptStatus === 'function') {
      chatgptAPI.onChatgptStatus((data) => {
        if (!data) return;
        const active =
          Boolean(data.running) ||
          data.state === 'connecting' ||
          data.state === 'waiting-login' ||
          data.state === 'running';
        updateChatgptRunningUI(active, data.message || '');
      });
    }

    if (chatgptAPI && typeof chatgptAPI.onChatgptPromptExtracted === 'function') {
      chatgptAPI.onChatgptPromptExtracted((payload) => {
        enqueueExtractedPromptToBulkInput(payload);
      });
    }

    if (chatgptAPI && typeof chatgptAPI.onChatgptError === 'function') {
      chatgptAPI.onChatgptError(() => {
        updateChatgptRunningUI(false);
      });
    }

    if (chatgptAPI && typeof chatgptAPI.onChatgptComplete === 'function') {
      chatgptAPI.onChatgptComplete(async (payload) => {
        await waitForChatgptPasteQueueIdle();
        updateChatgptRunningUI(false);

        const totalExtracted = Number((payload && payload.totalExtracted) || 0);
        const autoStartBot = Boolean(payload && payload.autoStartBot);

        if (autoStartBot && totalExtracted > 0) {
          logLocal(
            `🚀 All ${totalExtracted} prompts queued! Automatically starting Google Flow Bot...`,
            'success'
          );
          await new Promise((r) => setTimeout(r, 800));

          try {
            const chromeStatus = await window.flowBotAPI.getChromeStatus();
            if (!chromeStatus || !chromeStatus.connected) {
              logLocal(
                '⚠️ Chrome is not connected to Google Flow yet. Click "Connect" and then "Start Bot" to begin video generation.',
                'warn'
              );
              return;
            }
            if (els.btnStartBot && !els.btnStartBot.disabled && currentState !== 'RUNNING') {
              els.btnStartBot.click();
            } else {
              logLocal('ℹ️ Google Flow Bot is already active or paused — prompts are ready in the queue.');
            }
          } catch (err) {
            logLocal(
              `⚠️ Could not auto-start Google Flow Bot: ${err.message}. Click "Start Bot" manually to begin.`,
              'warn'
            );
          }
        }
      });
    }

    // Load saved config, queue state, app version, saved ChatGPT Auto config, and multi-instance slot info
    const instanceAPI = window.electronAPI || window.flowBotAPI;
    const [cfg, snapshot, appVersion, chatgptCfg, instanceInfo] = await Promise.all([
      window.flowBotAPI.getConfig(),
      window.flowBotAPI.getQueue(),
      typeof window.flowBotAPI.getAppVersion === 'function'
        ? window.flowBotAPI.getAppVersion().catch(() => '1.0.0')
        : Promise.resolve('1.0.0'),
      chatgptAPI && typeof chatgptAPI.chatgptLoadConfig === 'function'
        ? chatgptAPI.chatgptLoadConfig().catch(() => null)
        : Promise.resolve(null),
      instanceAPI && typeof instanceAPI.getInstanceInfo === 'function'
        ? instanceAPI.getInstanceInfo().catch(() => null)
        : Promise.resolve(null)
    ]);

    if (els.appVersionText && appVersion) {
      els.appVersionText.textContent = `v${appVersion}`;
    }

    if (chatgptCfg) {
      populateChatgptModal(chatgptCfg);
    }

    populateSettingsModal(cfg);
    renderQueueSnapshot(snapshot);

    const activeProfileNum = (instanceInfo && instanceInfo.profileNumber) || 1;
    const activeDebugPort = (instanceInfo && instanceInfo.debugPort) || (cfg && cfg.cdpPort) || 9222;

    if (els.instanceProfileBadge) {
      els.instanceProfileBadge.textContent = `Profile ${activeProfileNum} • :${activeDebugPort}`;
    }
    if (els.headerSubtitleText) {
      els.headerSubtitleText.textContent = `Profile ${activeProfileNum} (CDP :${activeDebugPort}) · Bulk Video Queue & Verified Auto-Downloader`;
    }
    if (instanceInfo && instanceInfo.effectiveOutputDir && els.outputPathInput) {
      els.outputPathInput.value = instanceInfo.effectiveOutputDir;
    }

    logLocal(`Flow Studio v${appVersion || '1.0.0'} initialized and ready.`);
    logLocal(
      `🪟 Window ready: Profile ${activeProfileNum} (Chrome Port ${activeDebugPort})`,
      'success'
    );
    logLocal(
      `Click "Launch Chrome" or "Connect" (port ${activeDebugPort}) to attach to Google Flow.`
    );
  }

  document.addEventListener('DOMContentLoaded', initializeDashboard);
})();
