const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const puppeteer = require('puppeteer-core');

const DEFAULT_CHATGPT_CONFIG = {
  masterPrompt: '',
  totalPhases: 13,
  promptsPerPhase: 10,
  phase6Prompts: 20,
  continueTemplate:
    'Continue to Phase {phase} and generate all {count} prompts in the exact same format.',
  autoStartBot: true,
  autoScroll: true
};

class ChatGPTController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.profileNumber = Math.max(1, parseInt(options.profileNumber, 10) || 1);
    this.debugPort =
      Number(options.debugPort) || 9222 + (this.profileNumber - 1);
    this.getBrowser = typeof options.getBrowser === 'function' ? options.getBrowser : () => null;
    this.getConfigDir =
      typeof options.getConfigDir === 'function' ? options.getConfigDir : () => process.cwd();
    this.getCdpPort =
      typeof options.getCdpPort === 'function' ? options.getCdpPort : () => this.debugPort;

    this.isRunning = false;
    this.shouldStop = false;
    this.activeAbortSleep = null;
  }

  // ===========================================================================
  // LOCAL CONFIG PERSISTENCE (chatgpt-auto-config.json inside userData)
  // ===========================================================================
  _getConfigFilePath() {
    const dir = this.getConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'chatgpt-auto-config.json');
  }

  loadConfig() {
    const filePath = this._getConfigFilePath();
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
          ...DEFAULT_CHATGPT_CONFIG,
          ...parsed,
          totalPhases: Math.min(30, Math.max(1, parseInt(parsed.totalPhases || 13, 10))),
          promptsPerPhase: Math.min(50, Math.max(1, parseInt(parsed.promptsPerPhase || 10, 10))),
          phase6Prompts: Math.min(50, Math.max(1, parseInt(parsed.phase6Prompts || 20, 10))),
          autoStartBot: Boolean(parsed.autoStartBot ?? true),
          autoScroll: Boolean(parsed.autoScroll ?? true)
        };
      }
    } catch (_) {
      // Fall back to defaults on parse error
    }
    return { ...DEFAULT_CHATGPT_CONFIG };
  }

  saveConfig(partial = {}) {
    const current = this.loadConfig();
    const merged = {
      ...current,
      ...partial,
      masterPrompt: String(
        partial.masterPrompt !== undefined ? partial.masterPrompt : current.masterPrompt || ''
      ),
      totalPhases: Math.min(
        30,
        Math.max(1, parseInt(partial.totalPhases ?? current.totalPhases ?? 13, 10) || 13)
      ),
      promptsPerPhase: Math.min(
        50,
        Math.max(1, parseInt(partial.promptsPerPhase ?? current.promptsPerPhase ?? 10, 10) || 10)
      ),
      phase6Prompts: Math.min(
        50,
        Math.max(1, parseInt(partial.phase6Prompts ?? current.phase6Prompts ?? 20, 10) || 20)
      ),
      continueTemplate: String(
        partial.continueTemplate !== undefined
          ? partial.continueTemplate
          : current.continueTemplate || DEFAULT_CHATGPT_CONFIG.continueTemplate
      ),
      autoStartBot: Boolean(
        partial.autoStartBot !== undefined ? partial.autoStartBot : current.autoStartBot ?? true
      ),
      autoScroll: Boolean(
        partial.autoScroll !== undefined ? partial.autoScroll : current.autoScroll ?? true
      )
    };

    try {
      fs.writeFileSync(this._getConfigFilePath(), JSON.stringify(merged, null, 2), 'utf-8');
    } catch (err) {
      this.log(`⚠️ Failed to save ChatGPT Auto config: ${err.message}`, 'warn');
    }
    return merged;
  }

  // ===========================================================================
  // LOGGING & SLEEP HELPERS
  // ===========================================================================
  log(message, level = 'info') {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${hh}:${mm}:${ss}`;
    this.emit('log', {
      timestamp,
      level,
      message,
      formatted: `[${timestamp}] ${message}`
    });
  }

  _emitStatus(payload) {
    this.emit('status', {
      running: this.isRunning,
      ...payload
    });
  }

  _interruptibleSleep(ms) {
    return new Promise((resolve) => {
      if (this.shouldStop) return resolve();
      const timer = setTimeout(() => {
        this.activeAbortSleep = null;
        resolve();
      }, ms);
      this.activeAbortSleep = () => {
        clearTimeout(timer);
        this.activeAbortSleep = null;
        resolve();
      };
    });
  }

  stop() {
    if (!this.isRunning) {
      this.shouldStop = true;
      return { success: true, wasRunning: false };
    }
    this.shouldStop = true;
    if (this.activeAbortSleep) {
      this.activeAbortSleep();
    }
    this.log('🛑 ChatGPT Auto: Stop requested by user. Aborting gracefully...', 'warn');
    this._emitStatus({
      running: false,
      state: 'stopping',
      message: 'Stopping ChatGPT Auto...'
    });
    return { success: true, wasRunning: true };
  }

  // ===========================================================================
  // PROFESSIONAL CHATGPT INTERNAL-CONTAINER AUTO-SCROLL ENGINE
  // ===========================================================================
  async autoScrollChatGPT(page) {
    if (!page || page.isClosed()) return;

    try {
      const scrollBtnCoords = await page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        const candidates = [];

        const consider = (el, inMain) => {
          if (!el) return;
          const sh = el.scrollHeight || 0;
          const ch = el.clientHeight || 0;
          if (sh <= ch + 30) return;

          if (el !== document.scrollingElement && el !== document.documentElement) {
            const style = window.getComputedStyle(el);
            const ovY = (style.overflowY || '').toLowerCase();
            if (ovY !== 'auto' && ovY !== 'scroll' && ovY !== 'overlay') return;
          }
          candidates.push({ el, sh, ch, inMain });
        };

        if (main) {
          consider(main, true);
          main.querySelectorAll('*').forEach((node) => consider(node, true));
        }
        consider(document.scrollingElement, false);

        if (candidates.length === 0) return null;

        // Pick primary chat thread scroll container (prefer inside <main>, largest viewport + scrollHeight)
        candidates.sort((a, b) => {
          if (a.inMain !== b.inMain) return a.inMain ? -1 : 1;
          if (Math.abs(b.ch - a.ch) > 80) return b.ch - a.ch;
          return b.sh - a.sh;
        });

        const container = candidates[0].el;
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;

        try {
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        } catch (_) {
          container.scrollTop = container.scrollHeight;
        }

        // Also gently scroll the last visible block of the latest assistant turn into view if not near bottom
        if (distanceFromBottom > 60) {
          const turns = Array.from(
            document.querySelectorAll(
              '[data-message-author-role="assistant"], article[data-testid^="conversation-turn-"]'
            )
          );
          const latest = turns.length > 0 ? turns[turns.length - 1] : null;
          if (latest) {
            const blocks = Array.from(
              latest.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote')
            );
            const target = blocks.length > 0 ? blocks[blocks.length - 1] : latest;
            try {
              target.scrollIntoView({ behavior: 'smooth', block: 'end' });
            } catch (_) {}
          }
        }

        // Check for ChatGPT's floating circular scroll-to-bottom button above the composer
        if (distanceFromBottom > 150) {
          const composer = document.querySelector('#prompt-textarea');
          const composerTop = composer ? composer.getBoundingClientRect().top : window.innerHeight - 100;
          const buttons = Array.from((main || document).querySelectorAll('button'));
          for (const btn of buttons) {
            const style = window.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
              continue;
            }
            const r = btn.getBoundingClientRect();
            if (r.width < 22 || r.width > 48 || r.height < 22 || r.height > 48) continue;
            if (Math.abs(r.width - r.height) > 10) continue;
            if (r.bottom > composerTop + 6 || r.top < composerTop - 110) continue;
            if (!btn.querySelector('svg')) continue;

            const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (
              testId.includes('send') ||
              testId.includes('stop') ||
              testId.includes('voice') ||
              testId.includes('composer') ||
              aria.includes('send') ||
              aria.includes('stop') ||
              aria.includes('voice') ||
              aria.includes('attach') ||
              aria.includes('upload') ||
              aria.includes('dictate') ||
              aria.includes('copy')
            ) {
              continue;
            }
            return {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2)
            };
          }
        }

        return null;
      });

      if (scrollBtnCoords && scrollBtnCoords.x > 0 && scrollBtnCoords.y > 0) {
        await page.mouse.click(scrollBtnCoords.x, scrollBtnCoords.y, { delay: 30 }).catch(() => {});
      }
    } catch (_) {
      // Non-fatal scroll error
    }
  }

  // ===========================================================================
  // STRUCTURED DOM LINE EXTRACTION (THINK-MODE SAFE & CITATION-PILL SAFE)
  // ===========================================================================
  async extractAssistantTurnLines(page) {
    return page.evaluate(() => {
      const isThoughtAccordion = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const tag = el.tagName;
        if (tag === 'DETAILS') return true;
        const testId = (el.getAttribute('data-testid') || '').toLowerCase();
        const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
        if (
          testId.includes('thought') ||
          testId.includes('reasoning') ||
          cls.includes('thought-summary') ||
          cls.includes('reasoning-summary')
        ) {
          return true;
        }
        // Check if this element has a toggle button / summary heading like "Worked for 27s" or "Thought for 18s"
        const headerBtn = el.querySelector(':scope > button, :scope > div > button, :scope > summary');
        if (headerBtn) {
          const btnTxt = (headerBtn.innerText || headerBtn.textContent || '').trim().toLowerCase();
          if (/^(?:thinking|thought\s+for|worked\s+for|reasoned\s+for)\b/.test(btnTxt)) {
            return true;
          }
        }
        return false;
      };

      const hasThoughtAncestor = (el, stopRoot) => {
        let curr = el;
        while (curr && curr !== stopRoot && curr !== document.body) {
          if (isThoughtAccordion(curr)) return true;
          curr = curr.parentElement;
        }
        return false;
      };

      const extractLinesFromContainer = (container) => {
        const clone = container.cloneNode(true);

        // Strip citation pills, SVGs, buttons, superscripts, scripts, and external source link chips (e.g. "한국은행 +1")
        const junkSelectors = [
          'svg',
          'button',
          'style',
          'script',
          'sup',
          '[data-testid*="citation" i]',
          '[data-testid*="webpage" i]',
          '[data-testid*="source" i]',
          '[class*="citation" i]',
          '[class*="footnote" i]',
          'a[target="_blank"]',
          'a[rel*="noopener"]'
        ];
        clone.querySelectorAll(junkSelectors.join(',')).forEach((n) => n.remove());

        // Also strip standalone pill spans like "한국은행 +1" or "+2"
        clone.querySelectorAll('span').forEach((sp) => {
          const t = (sp.textContent || '').trim();
          if (/^.+\s+\+\d+$/.test(t) && t.length < 40) {
            sp.remove();
          }
        });

        const blockTags = new Set([
          'H1',
          'H2',
          'H3',
          'H4',
          'H5',
          'H6',
          'P',
          'DIV',
          'BLOCKQUOTE',
          'SECTION',
          'ARTICLE',
          'PRE',
          'TABLE',
          'TR',
          'UL',
          'OL'
        ]);

        let out = '';
        const walk = (node) => {
          if (!node) return;
          if (node.nodeType === 3) {
            out += node.nodeValue || '';
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName;
          if (tag === 'BR') {
            out += '\n';
            return;
          }
          if (tag === 'HR') {
            out += '\n---\n';
            return;
          }
          if (tag === 'LI') {
            if (out && !out.endsWith('\n')) out += '\n';
            out += '- ';
            for (const child of node.childNodes) walk(child);
            if (!out.endsWith('\n')) out += '\n';
            return;
          }
          const isBlock = blockTags.has(tag);
          if (isBlock && out && !out.endsWith('\n')) out += '\n';
          for (const child of node.childNodes) walk(child);
          if (isBlock && out && !out.endsWith('\n')) out += '\n';
        };

        walk(clone);

        return out
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((line) => line.replace(/[ \t]+/g, ' ').trim())
          .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };

      const assistants = Array.from(
        document.querySelectorAll('[data-message-author-role="assistant"]')
      );
      let latestTurn = assistants.length > 0 ? assistants[assistants.length - 1] : null;
      if (!latestTurn) {
        const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"]'));
        for (let i = turns.length - 1; i >= 0; i--) {
          if (turns[i].querySelector('.markdown, .prose')) {
            latestTurn = turns[i];
            break;
          }
        }
      }
      if (!latestTurn) return '';

      // Gather final-answer markdown containers (explicitly skipping any Think/Reasoning accordion)
      const allMarkdowns = Array.from(
        latestTurn.querySelectorAll('.markdown, [class*="markdown"], .prose')
      ).filter((el) => {
        if (hasThoughtAncestor(el, latestTurn)) return false;
        // Skip nested markdown wrappers whose parent is already in the list
        let p = el.parentElement;
        while (p && p !== latestTurn) {
          if (p.matches && p.matches('.markdown, [class*="markdown"], .prose')) return false;
          p = p.parentElement;
        }
        return true;
      });

      if (allMarkdowns.length > 0) {
        const parts = allMarkdowns.map((md) => extractLinesFromContainer(md)).filter(Boolean);
        const joined = parts.join('\n\n').trim();
        if (joined.length > 0) return joined;
      }

      // Safe fallback: use innerText on latestTurn after stripping leading thinking summary lines
      const rawInner = (latestTurn.innerText || '').replace(/\r\n/g, '\n').trim();
      const lines = rawInner.split('\n').map((l) => l.trim());
      while (
        lines.length > 0 &&
        /^(?:thinking\.{0,3}|thought\s+for\s+\d+|worked\s+for\s+\d+|reasoned\s+for\s+\d+)/i.test(
          lines[0]
        )
      ) {
        lines.shift();
      }
      return lines.join('\n').trim();
    });
  }

  // ===========================================================================
  // EXACT PROMPT SPLITTING, NON-VIDEO CUTOFF & CLEAN FLATTENING
  // ===========================================================================
  _normalizeFingerprint(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  _cleanAndFlattenPromptBlock(blockText) {
    const raw = String(blockText || '').replace(/\r\n/g, '\n').trim();
    if (!raw) return '';

    const rawLines = raw.split('\n');
    const keptLines = [];

    // Non-video trailing section cutoffs (stop collecting this prompt block here)
    const cutoffLinePatterns = [
      /^#{0,6}\s*\*{0,2}\s*Connection\s*\*{0,2}\s*:?(?:\s|$)/i,
      /^#{0,6}\s*\*{0,2}\s*Narration\s*\*{0,2}\s*:?(?:\s|$)/i,
      /^#{0,6}\s*\*{0,2}\s*Voiceover\s*\*{0,2}\s*:?(?:\s|$)/i,
      /^#{0,6}\s*\*{0,2}\s*Technical accuracy notes?\s*\*{0,2}\s*:?(?:\s|$)/i,
      /^#{0,6}\s*\*{0,2}\s*Phase\s+\d{1,2}\s*(?:complete|·|\-|—|:)/i,
      /^#{0,6}\s*\*{0,2}\s*Ready for Phase\s+\d{1,2}/i,
      /^#{0,6}\s*\*{0,2}\s*Continue to Phase\s+\d{1,2}/i,
      /^#{0,6}\s*\*{0,2}\s*PHASE\s+\d{1,2}\s*·\s*PROMPTS/i
    ];

    for (let i = 0; i < rawLines.length; i++) {
      let line = rawLines[i].trim();
      if (!line) continue;

      // Skip stray code fences and horizontal dividers
      if (/^```[a-z0-9_-]*$/i.test(line)) continue;
      if (/^(?:---+|\*\*\*+|===+)$/.test(line)) continue;

      // Cut off trailing non-video sections once past the Prompt N header line
      if (i > 0 && cutoffLinePatterns.some((rx) => rx.test(line))) {
        break;
      }

      // Clean markdown heading/bold/underscore wrappers while keeping "- Shot 1", "Camera", "Sound", etc.
      line = line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/^\*{1,2}\s*|\s*\*{1,2}$/g, '')
        .replace(/^`+|`+$/g, '')
        .trim();

      if (!line) continue;
      keptLines.push(line);
    }

    // Strip any remaining trailing ChatGPT conversational wrap-up lines
    const trailingFooterRegex =
      /^(?:would you like|do you want|shall i|ready for|ready to|let me know|reply\b|say\s+["']?(?:continue|next|yes)|type\s+["']?(?:continue|next|yes)|just say|next up\b|coming up\b|phase\s+\d+\s+(?:is\s+)?complete|end of phase|that completes|if you(?:'d| would) like|want me to|continue to phase|proceed to phase|all\s+\d+\s+prompts?\s+(?:for|in)\s+phase)/i;

    while (keptLines.length > 1) {
      const last = keptLines[keptLines.length - 1];
      if (
        trailingFooterRegex.test(last) ||
        (last.length < 95 &&
          /\?$/.test(last) &&
          /(?:phase|continue|proceed|next|generate|more)/i.test(last))
      ) {
        keptLines.pop();
        continue;
      }
      break;
    }

    if (keptLines.length === 0) return '';

    // Flatten cleanly into a single line (ZERO blank lines) so Bulk Prompt Input always queues it as 1 prompt
    return keptLines
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parses structured line-delimited ChatGPT output into prompt items: [{ number, text }].
   * Tailored to exact `Prompt N — <Title>` format, keeping Visual / AI Video Prompt, Shots, Camera, and Sound,
   * while stripping Connection, Narration, Technical accuracy notes, and Phase footers.
   */
  extractPromptItemsFromAssistantText(structuredText) {
    const text = String(structuredText || '').replace(/\r\n/g, '\n');
    if (!text.trim()) return [];

    // Primary exact regex matching `Prompt N — <Title>` (supports —, –, -, :, .)
    const exactRegex =
      /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2}|_{1,2})?[ \t]*Prompt[ \t]*#?[ \t]*(\d{1,3})[ \t]*(?:—|–|-|:|\.)[ \t]*([^\n]+)/gi;
    let matches = [...text.matchAll(exactRegex)];

    // Relaxed `Prompt N` line-start regex if separator wasn't present on the header line
    if (matches.length === 0) {
      const relaxedRegex =
        /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2}|_{1,2})?[ \t]*Prompt[ \t]*#?[ \t]*(\d{1,3})\b/gi;
      matches = [...text.matchAll(relaxedRegex)];
    }

    if (matches.length > 0) {
      const items = [];
      for (let i = 0; i < matches.length; i++) {
        const startIdx = matches[i].index + (matches[i][0].startsWith('\n') ? 1 : 0);
        const endIdx = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const promptNum = parseInt(matches[i][1], 10);
        const rawBlock = text.slice(startIdx, endIdx);
        const flattened = this._cleanAndFlattenPromptBlock(rawBlock);
        if (flattened.length >= 25) {
          items.push({
            number: Number.isFinite(promptNum) ? promptNum : null,
            text: flattened
          });
        }
      }
      if (items.length > 0) {
        return items;
      }
    }

    // Secondary fallback ONLY if 0 `Prompt N` matches exist: numbered items > 40 chars
    const numberedRegex = /(?:^|\n)[ \t]*(?:\*{1,2})?(\d{1,3})[.)][ \t]+/g;
    const numMatches = [...text.matchAll(numberedRegex)];
    if (numMatches.length >= 2) {
      const fallbackItems = [];
      for (let i = 0; i < numMatches.length; i++) {
        const startIdx = numMatches[i].index + (numMatches[i][0].startsWith('\n') ? 1 : 0);
        const endIdx = i + 1 < numMatches.length ? numMatches[i + 1].index : text.length;
        const num = parseInt(numMatches[i][1], 10);
        const rawBlock = text.slice(startIdx, endIdx);
        const flattened = this._cleanAndFlattenPromptBlock(rawBlock);
        if (flattened.length > 40) {
          fallbackItems.push({
            number: Number.isFinite(num) ? num : null,
            text: flattened
          });
        }
      }
      return fallbackItems;
    }

    return [];
  }

  /**
   * Convenience wrapper returning plain flattened prompt strings.
   */
  extractPromptsFromAssistantText(structuredText) {
    return this.extractPromptItemsFromAssistantText(structuredText).map((item) => item.text);
  }

  _detectPhaseSignalsInText(structuredText, totalPhases) {
    const text = String(structuredText || '');
    let highestPhase = 0;
    let completedPhase = 0;

    const headerRx = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*Phase[ \t]+(\d{1,2})\b/gi;
    for (const m of text.matchAll(headerRx)) {
      const num = parseInt(m[1], 10);
      if (num >= 1 && num <= totalPhases && num > highestPhase) {
        highestPhase = num;
      }
    }

    const completeRx = /\bPhase[ \t]+(\d{1,2})[ \t]+complete\b/gi;
    for (const m of text.matchAll(completeRx)) {
      const num = parseInt(m[1], 10);
      if (num >= 1 && num <= totalPhases && num > completedPhase) {
        completedPhase = num;
      }
    }

    return { highestPhase, completedPhase };
  }

  // ===========================================================================
  // CHATGPT COMPOSER, FAST PASTE & THINK-MODE-SAFE COMPLETION WAIT
  // ===========================================================================
  async _isComposerReady(page) {
    try {
      return await page.evaluate(() => {
        const selectors = [
          'div[contenteditable="true"]#prompt-textarea',
          'textarea#prompt-textarea',
          '#prompt-textarea',
          'div.ProseMirror[contenteditable="true"]'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 80 && rect.height >= 18) {
            return true;
          }
        }
        return false;
      });
    } catch (_) {
      return false;
    }
  }

  async _waitForComposerReady(page) {
    for (let i = 0; i < 4; i++) {
      if (this.shouldStop) return false;
      if (await this._isComposerReady(page)) return true;
      await this._interruptibleSleep(2000);
    }

    this.log(
      '⚠️ Please complete ChatGPT login / verification in the opened Chrome tab... (waiting up to 120s)',
      'warn'
    );
    this._emitStatus({
      state: 'waiting-login',
      message: 'Waiting for ChatGPT login / verification in Chrome tab...'
    });

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (this.shouldStop) return false;
      if (await this._isComposerReady(page)) {
        this.log('✅ ChatGPT prompt composer is ready!', 'success');
        return true;
      }
      await this._interruptibleSleep(2000);
    }

    return false;
  }

  /**
   * Fast, ProseMirror/React-compatible prompt injection & single Send click.
   * Returns assistant turn count recorded right before sending.
   */
  async sendMessageToChatGPT(page, text, autoScroll = true) {
    const prevAssistantCount = await page.evaluate(() => {
      const roles = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (roles.length > 0) return roles.length;
      const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"]'));
      return turns.filter((t) => t.querySelector('.markdown, .prose')).length;
    });

    const injected = await page.evaluate((payloadText) => {
      const selectors = [
        'div[contenteditable="true"]#prompt-textarea',
        'textarea#prompt-textarea',
        '#prompt-textarea',
        'div.ProseMirror[contenteditable="true"]'
      ];
      let composer = null;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 80 && r.height >= 18) {
            composer = el;
            break;
          }
        }
      }
      if (!composer) return { ok: false, reason: 'Composer not found' };

      composer.focus();

      if (composer.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        if (setter) {
          setter.call(composer, payloadText);
        } else {
          composer.value = payloadText;
        }
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: composer.value.trim().length > 0, method: 'textarea-setter' };
      }

      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false, null);
      } catch (_) {}

      // Attempt A: Synthetic ClipboardEvent('paste')
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', payloadText);
        const pasteEvt = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        composer.dispatchEvent(pasteEvt);
      } catch (_) {}

      if ((composer.innerText || '').trim().length > 0) {
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, method: 'clipboard-paste' };
      }

      // Attempt B: execCommand('insertText')
      try {
        composer.focus();
        document.execCommand('insertText', false, payloadText);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (_) {}

      if ((composer.innerText || '').trim().length > 0) {
        return { ok: true, method: 'execCommand-insertText' };
      }

      // Attempt C: TrustedHTML-safe <p> paragraph nodes + input event
      try {
        const frag = document.createDocumentFragment();
        const lines = payloadText.split('\n');
        for (const line of lines) {
          const p = document.createElement('p');
          if (line.length > 0) {
            p.textContent = line;
          } else {
            p.appendChild(document.createElement('br'));
          }
          frag.appendChild(p);
        }
        composer.replaceChildren(frag);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (_) {}

      return {
        ok: (composer.innerText || '').trim().length > 0,
        method: 'paragraph-nodes'
      };
    }, text);

    if (!injected || !injected.ok) {
      await page.click('#prompt-textarea').catch(() => {});
      let cdp = null;
      try {
        cdp = await page.target().createCDPSession();
        await cdp.send('Input.insertText', { text });
      } finally {
        if (cdp) await cdp.detach().catch(() => {});
      }
    }

    // Wait up to 5 seconds for Send button to become enabled, then click ONCE
    let clickedSend = false;
    const sendDeadline = Date.now() + 5000;
    while (Date.now() < sendDeadline) {
      if (this.shouldStop) return prevAssistantCount;

      const sendCoords = await page.evaluate(() => {
        const selectors = [
          'button[data-testid="send-button"]:not([disabled])',
          'button[aria-label*="Send" i]:not([disabled])',
          'form button[type="submit"]:not([disabled])'
        ];
        for (const sel of selectors) {
          const btns = Array.from(document.querySelectorAll(sel));
          for (const btn of btns) {
            const style = window.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            const r = btn.getBoundingClientRect();
            if (r.width >= 18 && r.height >= 18) {
              return {
                found: true,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2)
              };
            }
          }
        }
        return { found: false };
      });

      if (sendCoords && sendCoords.found) {
        await page.mouse.click(sendCoords.x, sendCoords.y, { delay: 50 });
        clickedSend = true;
        break;
      }

      await this._interruptibleSleep(250);
    }

    if (!clickedSend) {
      await page.keyboard.press('Enter');
    }

    if (autoScroll) {
      await this._interruptibleSleep(450);
      await this.autoScrollChatGPT(page);
    }

    return prevAssistantCount;
  }

  /**
   * Think-Mode-Safe Completion Detector (5-minute timeout per phase):
   * - Continuously auto-scrolls ChatGPT's internal thread container when `autoScroll` is enabled
   * - Excludes reasoning/thinking accordions ("Thinking...", "Worked for 27s") from final text
   * - Auto-clicks "Continue generating" if ChatGPT pauses mid-response
   * - Confirms completion ONLY when new turn exists, Stop button & active thinking are gone,
   *   substantial final markdown content is present, AND either:
   *     (a) Copy action button is visible on the turn + text unchanged for 2 checks (2.5s), OR
   *     (b) Text unchanged for 4 consecutive checks (5s) after Stop button disappeared.
   */
  async waitForResponseComplete(page, prevAssistantCount, autoScroll = true) {
    const startTime = Date.now();
    const maxTimeoutMs = 5 * 60 * 1000; // 5 minutes (300s) for Think mode + 20-prompt Phase 6
    let lastText = '';
    let unchangedChecks = 0;
    let stableSince = null;
    let lastProgressLogAt = startTime;

    while (Date.now() - startTime < maxTimeoutMs) {
      await this._interruptibleSleep(1200);
      if (this.shouldStop) {
        throw new Error('ChatGPT Auto stopped by user');
      }

      if (autoScroll) {
        await this.autoScrollChatGPT(page);
      }

      const state = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) {
            return false;
          }
          const r = el.getBoundingClientRect();
          return r.width > 10 && r.height > 10;
        };

        const roleAssistants = Array.from(
          document.querySelectorAll('[data-message-author-role="assistant"]')
        );
        let assistantCount = roleAssistants.length;
        let latestAssistant =
          roleAssistants.length > 0 ? roleAssistants[roleAssistants.length - 1] : null;

        if (!latestAssistant) {
          const turns = Array.from(
            document.querySelectorAll('article[data-testid^="conversation-turn-"]')
          ).filter((t) => t.querySelector('.markdown, .prose'));
          assistantCount = turns.length;
          latestAssistant = turns.length > 0 ? turns[turns.length - 1] : null;
        }

        const latestArticle = latestAssistant
          ? latestAssistant.closest('article[data-testid^="conversation-turn-"]') ||
            latestAssistant.closest('article') ||
            latestAssistant.parentElement
          : null;

        // Check Stop streaming button
        const stopBtn = Array.from(
          document.querySelectorAll(
            'button[data-testid="stop-button"], button[aria-label*="Stop streaming" i], button[aria-label*="Stop generating" i], button[aria-label="Stop" i]'
          )
        ).find(isVisible);

        // Check "Continue generating" button
        let continueBtnCoords = null;
        const allButtons = Array.from(document.querySelectorAll('button'));
        for (const btn of allButtons) {
          if (!isVisible(btn)) continue;
          const label = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (label.includes('continue generating')) {
            const r = btn.getBoundingClientRect();
            continueBtnCoords = {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2)
            };
            break;
          }
        }

        // Check Copy action button on the latest assistant turn (strong completion signal)
        let hasCopyActionButton = false;
        if (latestArticle) {
          const copyBtn = Array.from(
            latestArticle.querySelectorAll(
              'button[data-testid="copy-turn-action-button"], button[aria-label="Copy" i], button[aria-label*="Copy response" i]'
            )
          ).find(isVisible);
          hasCopyActionButton = Boolean(copyBtn);
        }

        // Detect active Thinking/Reasoning indicator on the latest turn
        let isThinkingIndicatorVisible = false;
        if (latestArticle) {
          const turnRawText = (latestArticle.innerText || '').trim();
          const firstLine = (turnRawText.split(/\r?\n/)[0] || '').trim().toLowerCase();
          if (
            /^thinking\b/.test(firstLine) ||
            /^reasoning\b/.test(firstLine) ||
            Boolean(latestArticle.querySelector('[data-testid*="thinking" i], .result-thinking'))
          ) {
            isThinkingIndicatorVisible = true;
          }
        }

        return {
          assistantCount,
          isStreaming: Boolean(stopBtn),
          isThinkingIndicatorVisible,
          hasCopyActionButton,
          continueBtnCoords
        };
      });

      // Automatically click "Continue generating" if ChatGPT paused mid-response
      if (state.continueBtnCoords) {
        this.log('🤖 ChatGPT Auto: Clicking "Continue generating" to finish response...');
        await page.mouse.click(state.continueBtnCoords.x, state.continueBtnCoords.y, { delay: 50 });
        unchangedChecks = 0;
        stableSince = null;
        await this._interruptibleSleep(1500);
        continue;
      }

      const hasNewTurn = state.assistantCount > prevAssistantCount;
      const finalMarkdownText = hasNewTurn ? await this.extractAssistantTurnLines(page) : '';

      const hasSubstantialContent = Boolean(
        finalMarkdownText.length > 100 ||
          /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*Prompt[ \t]*#?[ \t]*\d{1,3}\b/i.test(
            finalMarkdownText
          ) ||
          /\bPhase[ \t]+\d{1,2}[ \t]+complete\b/i.test(finalMarkdownText)
      );

      // Still actively thinking if thinking indicator is visible and final answer markdown hasn't arrived
      const stillActivelyThinking = state.isThinkingIndicatorVisible && !hasSubstantialContent;

      if (hasNewTurn && !state.isStreaming && !stillActivelyThinking && hasSubstantialContent) {
        if (finalMarkdownText === lastText) {
          unchangedChecks++;
          if (stableSince === null) {
            stableSince = Date.now();
          }
          const stableMs = Date.now() - stableSince;
          const strongActionComplete =
            state.hasCopyActionButton && unchangedChecks >= 2 && stableMs >= 2500;
          const strongTimeComplete = unchangedChecks >= 4 && stableMs >= 5000;

          if (strongActionComplete || strongTimeComplete) {
            if (autoScroll) {
              await this.autoScrollChatGPT(page);
            }
            return finalMarkdownText;
          }
        } else {
          lastText = finalMarkdownText;
          unchangedChecks = 1;
          stableSince = Date.now();
        }
      } else {
        if (finalMarkdownText && finalMarkdownText !== lastText) {
          lastText = finalMarkdownText;
        }
        unchangedChecks = 0;
        stableSince = null;
      }

      if (Date.now() - lastProgressLogAt >= 15000) {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const phaseStateLabel = stillActivelyThinking
          ? 'thinking (Think mode)'
          : state.isStreaming
          ? 'streaming'
          : 'finalizing';
        this.log(
          `🤖 ChatGPT ${phaseStateLabel}... (${elapsedSec}s, ${finalMarkdownText.length} final chars)`
        );
        lastProgressLogAt = Date.now();
      }
    }

    if (lastText && lastText.length > 60) {
      this.log(
        '⚠️ ChatGPT turn reached 300s limit; extracting final response text received so far...',
        'warn'
      );
      return lastText;
    }

    throw new Error('Timed out waiting for ChatGPT response after 300 seconds.');
  }

  // ===========================================================================
  // MAIN 13-PHASE ORCHESTRATION PIPELINE
  // ===========================================================================
  async start(options = {}) {
    if (this.isRunning) {
      return { success: false, error: 'ChatGPT Auto is already running.' };
    }

    const saved = this.saveConfig({
      masterPrompt: options.masterPrompt,
      totalPhases: options.totalPhases,
      promptsPerPhase: options.promptsPerPhase,
      phase6Prompts: options.phase6Prompts,
      continueTemplate: options.continueTemplate,
      autoStartBot: options.autoStartBot,
      autoScroll: options.autoScroll
    });

    const masterPrompt = String(saved.masterPrompt || '').trim();
    const topicMessage = String(options.topicMessage || '').trim();
    if (!masterPrompt && !topicMessage) {
      return {
        success: false,
        error: 'Please enter a Master Prompt or Topic/Message before starting ChatGPT Auto.'
      };
    }

    const totalPhases = saved.totalPhases;
    const promptsPerPhase = saved.promptsPerPhase;
    const phase6Prompts = saved.phase6Prompts;
    const continueTemplate =
      saved.continueTemplate || DEFAULT_CHATGPT_CONFIG.continueTemplate;
    const autoStartBot = Boolean(saved.autoStartBot);
    const autoScroll = Boolean(saved.autoScroll ?? true);

    const schedule = [];
    for (let p = 1; p <= totalPhases; p++) {
      schedule.push(p === 6 ? phase6Prompts : promptsPerPhase);
    }
    const targetTotalPrompts = schedule.reduce((sum, n) => sum + n, 0);

    const cumulativeTargets = [];
    let runningSum = 0;
    for (const count of schedule) {
      runningSum += count;
      cumulativeTargets.push(runningSum);
    }

    this.isRunning = true;
    this.shouldStop = false;

    let browser = null;
    let ownsConnection = false;
    let flowPage = null;

    try {
      this._emitStatus({
        state: 'connecting',
        phase: 0,
        totalPhases,
        totalExtracted: 0,
        targetTotal: targetTotalPrompts,
        message: 'Connecting to Debug Chrome...'
      });

      const sharedBrowser = this.getBrowser();
      if (sharedBrowser && sharedBrowser.isConnected()) {
        browser = sharedBrowser;
        ownsConnection = false;
      } else {
        const port =
          Number(options.debugPort) ||
          Number(this.getCdpPort()) ||
          Number(this.debugPort) ||
          9222;
        this.log(`🤖 ChatGPT Auto: Connecting to Debug Chrome on http://127.0.0.1:${port}...`);
        browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${port}`,
          defaultViewport: null
        });
        ownsConnection = true;
      }

      // Preserve reference to existing Google Flow tab so we NEVER close it and can restore focus later
      const existingPages = await browser.pages();
      flowPage =
        existingPages.find((p) => {
          const u = (p.url() || '').toLowerCase();
          return u.includes('flow.google.com') || u.includes('labs.google');
        }) || null;

      this.log('🤖 ChatGPT Auto: Opening https://chatgpt.com/ in a new Chrome tab...');
      const chatPage = await browser.newPage();
      await chatPage.bringToFront();
      await chatPage.goto('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      const composerReady = await this._waitForComposerReady(chatPage);
      if (!composerReady) {
        if (this.shouldStop) {
          throw new Error('ChatGPT Auto stopped by user');
        }
        throw new Error(
          'ChatGPT prompt composer did not become ready within 120 seconds. Please sign in to ChatGPT in Chrome and try again.'
        );
      }

      const seenFingerprints = new Set();
      let totalExtracted = 0;
      let currentPhase = 1;
      let consecutiveZeroTurns = 0;

      const emitExtractedFromText = async (structuredText, phaseLabel) => {
        const parsedItems = this.extractPromptItemsFromAssistantText(structuredText);
        const newItems = [];

        for (const item of parsedItems) {
          if (this.shouldStop) break;
          const fp = this._normalizeFingerprint(item.text);
          if (!fp || seenFingerprints.has(fp)) continue;

          seenFingerprints.add(fp);
          totalExtracted++;
          newItems.push({
            number: item.number != null ? item.number : totalExtracted,
            text: item.text
          });

          this.emit('prompt-extracted', {
            index: totalExtracted,
            promptNumber: item.number != null ? item.number : totalExtracted,
            totalCollected: totalExtracted,
            targetTotal: targetTotalPrompts,
            phase: phaseLabel,
            promptText: item.text
          });

          this._emitStatus({
            state: 'running',
            phase: phaseLabel,
            totalPhases,
            totalExtracted,
            targetTotal: targetTotalPrompts,
            message: `Phase ${phaseLabel}/${totalPhases} • ${totalExtracted}/${targetTotalPrompts}`
          });

          await this._interruptibleSleep(180);
        }

        if (newItems.length > 0) {
          const firstNum = newItems[0].number;
          const lastNum = newItems[newItems.length - 1].number;
          this.log(
            `📋 ChatGPT Auto: Extracted ${newItems.length} prompt(s) from Phase ${phaseLabel} (Prompt ${firstNum} → Prompt ${lastNum}). Total collected: ${totalExtracted}/${targetTotalPrompts}`,
            'success'
          );
        } else {
          const sample = String(structuredText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
          this.log(
            `⚠️ ChatGPT Auto: Extracted 0 prompts from Phase ${phaseLabel}. Sample extracted text: "${sample}"`,
            'warn'
          );
        }

        return newItems.length;
      };

      const computeNextPhaseAfterTurn = (prevPhase, structuredText, addedCount) => {
        const { highestPhase, completedPhase } = this._detectPhaseSignalsInText(
          structuredText,
          totalPhases
        );

        let phasesSatisfiedByCount = 0;
        for (let idx = 0; idx < cumulativeTargets.length; idx++) {
          if (totalExtracted >= cumulativeTargets[idx]) {
            phasesSatisfiedByCount = idx + 1;
          }
        }

        // If on Phase 6 (20 prompts) and ChatGPT returned a partial batch (e.g. 10 of 20) without declaring Phase 6 complete, request remaining prompts
        if (
          prevPhase === 6 &&
          phase6Prompts > promptsPerPhase &&
          addedCount > 0 &&
          completedPhase < 6 &&
          totalExtracted < cumulativeTargets[5] &&
          highestPhase <= 6
        ) {
          const remainingForPhase6 = cumulativeTargets[5] - totalExtracted;
          return {
            nextPhase: 6,
            expectedCount: remainingForPhase6,
            isContinuationOfSamePhase: true
          };
        }

        const completedUpTo = Math.max(
          prevPhase,
          completedPhase,
          highestPhase,
          phasesSatisfiedByCount
        );
        const nextPhase = completedUpTo + 1;
        const expectedCount =
          nextPhase <= totalPhases ? schedule[nextPhase - 1] : promptsPerPhase;
        return { nextPhase, expectedCount, isContinuationOfSamePhase: false };
      };

      // -----------------------------------------------------------------------
      // TURN 1: Send Master Prompt + Topic/Message
      // -----------------------------------------------------------------------
      const initialMessage =
        masterPrompt && topicMessage
          ? `${masterPrompt}\n\n${topicMessage}`
          : masterPrompt || topicMessage;

      this.log(
        `🤖 ChatGPT Auto: Submitting Master Prompt + Topic for Phase 1/${totalPhases} (target: ${targetTotalPrompts} prompts, auto-scroll: ${
          autoScroll ? 'ON' : 'OFF'
        })...`
      );
      this._emitStatus({
        state: 'running',
        phase: 1,
        totalPhases,
        totalExtracted: 0,
        targetTotal: targetTotalPrompts,
        message: `Phase 1/${totalPhases} • 0/${targetTotalPrompts}`
      });

      const prevCount1 = await this.sendMessageToChatGPT(chatPage, initialMessage, autoScroll);
      const turn1Text = await this.waitForResponseComplete(chatPage, prevCount1, autoScroll);
      const added1 = await emitExtractedFromText(turn1Text, 1);

      if (added1 === 0) {
        consecutiveZeroTurns = 1;
      }

      let nextPlan = computeNextPhaseAfterTurn(1, turn1Text, added1);
      currentPhase = nextPlan.nextPhase;

      // -----------------------------------------------------------------------
      // SUBSEQUENT PHASES: Auto-Continue through Phase 13 (140 prompts)
      // -----------------------------------------------------------------------
      while (!this.shouldStop && totalExtracted < targetTotalPrompts && currentPhase <= totalPhases) {
        const expectedForNextPhase = nextPlan.expectedCount || schedule[currentPhase - 1];
        const continuationPrompt = nextPlan.isContinuationOfSamePhase
          ? `Continue Phase ${currentPhase} and generate the remaining ${expectedForNextPhase} prompts in the exact same format.`
          : continueTemplate
              .replace(/\{phase\}/gi, String(currentPhase))
              .replace(/\{count\}/gi, String(expectedForNextPhase));

        this.log(
          `🤖 ChatGPT Auto: Requesting Phase ${currentPhase}/${totalPhases} (expecting ${expectedForNextPhase} prompts)...`
        );
        this._emitStatus({
          state: 'running',
          phase: currentPhase,
          totalPhases,
          totalExtracted,
          targetTotal: targetTotalPrompts,
          message: `Phase ${currentPhase}/${totalPhases} • ${totalExtracted}/${targetTotalPrompts}`
        });

        const prevCount = await this.sendMessageToChatGPT(
          chatPage,
          continuationPrompt,
          autoScroll
        );
        const turnText = await this.waitForResponseComplete(chatPage, prevCount, autoScroll);
        const addedThisTurn = await emitExtractedFromText(turnText, currentPhase);

        if (addedThisTurn === 0) {
          consecutiveZeroTurns++;
          if (consecutiveZeroTurns >= 2) {
            this.log(
              `⚠️ ChatGPT Auto: 2 consecutive continuation turns yielded 0 new prompts. Stopping cleanly with ${totalExtracted} extracted prompt(s).`,
              'warn'
            );
            break;
          }
          nextPlan = {
            nextPhase: currentPhase + 1,
            expectedCount:
              currentPhase + 1 <= totalPhases ? schedule[currentPhase] : promptsPerPhase,
            isContinuationOfSamePhase: false
          };
          currentPhase = nextPlan.nextPhase;
        } else {
          consecutiveZeroTurns = 0;
          nextPlan = computeNextPhaseAfterTurn(currentPhase, turnText, addedThisTurn);
          currentPhase = nextPlan.nextPhase;
        }
      }

      if (this.shouldStop) {
        this.log(
          `🛑 ChatGPT Auto aborted by user (${totalExtracted} prompt(s) extracted so far).`,
          'warn'
        );
        this._emitStatus({
          running: false,
          state: 'stopped',
          phase: Math.min(currentPhase, totalPhases),
          totalPhases,
          totalExtracted,
          targetTotal: targetTotalPrompts,
          message: 'Stopped'
        });
        return { success: false, aborted: true, totalExtracted };
      }

      this.log(
        `✅ ChatGPT Auto finished! Extracted & queued ${totalExtracted} prompt(s). Switching back to Google Flow...`,
        'success'
      );

      if (flowPage && !flowPage.isClosed()) {
        await flowPage.bringToFront().catch(() => {});
      }

      this._emitStatus({
        running: false,
        state: 'complete',
        phase: totalPhases,
        totalPhases,
        totalExtracted,
        targetTotal: targetTotalPrompts,
        message: `Done • ${totalExtracted} queued`
      });

      this.emit('complete', {
        totalExtracted,
        targetTotal: targetTotalPrompts,
        autoStartBot
      });

      return { success: true, totalExtracted, autoStartBot };
    } catch (err) {
      const errMsg = err ? err.message || String(err) : 'Unknown ChatGPT Auto error';
      if (!this.shouldStop) {
        this.log(`❌ ChatGPT Auto Error: ${errMsg}`, 'error');
        this.emit('error', { message: errMsg });
      }
      this._emitStatus({
        running: false,
        state: this.shouldStop ? 'stopped' : 'error',
        message: errMsg
      });
      return { success: false, error: errMsg };
    } finally {
      this.isRunning = false;
      this.shouldStop = false;
      this.activeAbortSleep = null;
      if (ownsConnection && browser) {
        try {
          browser.disconnect();
        } catch (_) {}
      }
    }
  }
}

module.exports = {
  ChatGPTController,
  DEFAULT_CHATGPT_CONFIG
};
