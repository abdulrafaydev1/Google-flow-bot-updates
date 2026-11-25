const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_SVG_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#0b0f17"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="50%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#10b981"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="20" y="20" width="472" height="472" rx="96" fill="none" stroke="#6366f1" stroke-opacity="0.35" stroke-width="8"/>
  <rect x="96" y="148" width="220" height="216" rx="34" fill="url(#accent)"/>
  <path d="M416 172 L332 232 L332 280 L416 340 Z" fill="#10b981"/>
  <circle cx="156" cy="208" r="16" fill="#0b0f17" opacity="0.65"/>
</svg>`;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/svg+xml'
};

/**
 * Constant-time PIN comparison using crypto.timingSafeEqual on equal-length buffers.
 */
function verifyPinConstantTime(providedPin, expectedPin) {
  const aStr = String(providedPin === undefined || providedPin === null ? '' : providedPin).trim();
  const bStr = String(expectedPin === undefined || expectedPin === null ? '' : expectedPin).trim();
  if (!aStr || !bStr) return false;

  const aBuf = Buffer.from(aStr, 'utf-8');
  const bBuf = Buffer.from(bStr, 'utf-8');

  if (aBuf.length !== bBuf.length) {
    // Compare bBuf with itself to maintain constant time before returning false
    crypto.timingSafeEqual(bBuf, bBuf);
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Checks if an IPv4 address belongs to the Tailscale CGNAT range (100.64.0.0/10 -> 100.64.x.x - 100.127.x.x).
 */
function isTailscaleIp(ip, ifaceName = '') {
  if (!ip || typeof ip !== 'string') return false;
  if (/tailscale/i.test(String(ifaceName || ''))) return true;
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Checks if an IPv4 address is a private LAN address (192.168.x.x, 10.x.x.x, 172.16-31.x.x).
 */
function isPrivateLanIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

class MobileRemoteServer {
  constructor(options = {}) {
    this.configManager = options.configManager;
    this.getStateCallback = options.getState;
    this.handleActionCallback = options.handleAction;
    this.getScreenshotCallback = options.getScreenshot;
    this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

    this.staticDir = options.staticDir || path.join(__dirname, '..', 'mobile-pwa');
    this.server = null;
    this.activePort = null;
    this._starting = false;
  }

  isListening() {
    return Boolean(this.server && this.server.listening);
  }

  /**
   * Auto-discovers Tailscale Anywhere IP (100.64.0.0/10) and Local Wi-Fi / LAN IP (192.168.x.x / 10.x.x.x).
   */
  getConnectionDetails() {
    const cfg = this.configManager ? this.configManager.getConfig() : {};
    const enabled = cfg.remoteControlEnabled !== false;
    const port = this.activePort || Number(cfg.remoteControlPort) || 3847;
    const pin = String(cfg.remoteControlPin || '000000');

    let tailscaleIp = null;
    const lanCandidates = [];

    try {
      const nets = os.networkInterfaces() || {};
      for (const [ifaceName, addrs] of Object.entries(nets)) {
        if (!Array.isArray(addrs)) continue;
        for (const addr of addrs) {
          if (!addr || addr.internal) continue;
          const isIPv4 = addr.family === 'IPv4' || addr.family === 4;
          if (!isIPv4 || !addr.address) continue;

          const ip = addr.address.trim();
          if (isTailscaleIp(ip, ifaceName)) {
            if (!tailscaleIp) {
              tailscaleIp = ip;
            }
            continue;
          }

          if (isPrivateLanIp(ip)) {
            const isVirtual =
              /vethernet|wsl|docker|vmware|virtualbox|vbox|hyper-v|loopback|bluetooth|npcap/i.test(
                ifaceName
              );
            const isWifiOrEthernet = /wi-?fi|wlan|ethernet|lan|en\d|eth\d/i.test(ifaceName);
            const is192 = ip.startsWith('192.168.');

            let priority = 10;
            if (isVirtual) priority -= 8;
            if (isWifiOrEthernet) priority += 5;
            if (is192) priority += 3;

            lanCandidates.push({ ip, ifaceName, priority });
          }
        }
      }
    } catch (_) {
      // Ignore interface enumeration errors
    }

    lanCandidates.sort((a, b) => b.priority - a.priority);
    const lanIp = lanCandidates.length > 0 ? lanCandidates[0].ip : null;

    const lanUrl = lanIp ? `http://${lanIp}:${port}` : `http://127.0.0.1:${port}`;
    const anywhereUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : null;

    return {
      enabled,
      listening: this.isListening(),
      port,
      pin,
      lanIp,
      tailscaleIp,
      lanUrl,
      anywhereUrl,
      tailscaleDetected: Boolean(tailscaleIp)
    };
  }

  async start() {
    if (this.isListening() || this._starting) {
      return this.getConnectionDetails();
    }

    const cfg = this.configManager ? this.configManager.getConfig() : {};
    if (cfg.remoteControlEnabled === false) {
      return this.getConnectionDetails();
    }

    const basePort = Number(cfg.remoteControlPort) || 3847;
    this._starting = true;

    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidatePort = basePort + attempt;
        const started = await this._tryListen(candidatePort);
        if (started) {
          this.activePort = candidatePort;
          const details = this.getConnectionDetails();
          this.onLog(
            `📱 Mobile Remote PWA server active on ${details.lanUrl}${
              details.anywhereUrl ? ` (Anywhere: ${details.anywhereUrl})` : ''
            }`
          );
          return details;
        }
      }
    } finally {
      this._starting = false;
    }

    return this.getConnectionDetails();
  }

  _tryListen(port) {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        this._handleRequest(req, res).catch((err) => {
          this._sendJson(res, 500, {
            ok: false,
            error: err && err.message ? err.message : 'Internal server error'
          });
        });
      });

      const onError = (err) => {
        srv.removeListener('listening', onListening);
        try {
          srv.close();
        } catch (_) {}
        if (err && err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(false);
        }
      };

      const onListening = () => {
        srv.removeListener('error', onError);
        this.server = srv;
        resolve(true);
      };

      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(port, '0.0.0.0');
    });
  }

  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.activePort = null;
    await new Promise((resolve) => {
      try {
        srv.close(() => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  _sendJson(res, statusCode, data) {
    if (res.writableEnded) return;
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-remote-pin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(body);
  }

  _readJsonBody(req, maxBytes = 256 * 1024) {
    return new Promise((resolve, reject) => {
      let raw = '';
      let bytes = 0;

      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          reject(new Error('Payload too large'));
          try {
            req.destroy();
          } catch (_) {}
          return;
        }
        raw += chunk.toString('utf-8');
      });

      req.on('end', () => {
        if (!raw || !raw.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error('Invalid JSON payload'));
        }
      });

      req.on('error', (err) => reject(err));
    });
  }

  _extractPin(req, parsedUrl, bodyObj = null) {
    const headerPin = req.headers['x-remote-pin'];
    if (headerPin) return String(headerPin).trim();
    const queryPin = parsedUrl.searchParams.get('pin');
    if (queryPin) return String(queryPin).trim();
    if (bodyObj && bodyObj.pin !== undefined) return String(bodyObj.pin).trim();
    return '';
  }

  _serveStaticFile(res, relativeFile) {
    if (relativeFile === 'icon.svg' || relativeFile === 'favicon.ico') {
      const iconPath = path.join(this.staticDir, 'icon.svg');
      let svgContent = DEFAULT_SVG_ICON;
      try {
        if (fs.existsSync(iconPath)) {
          svgContent = fs.readFileSync(iconPath, 'utf-8');
        }
      } catch (_) {}
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(svgContent);
      return;
    }

    const safeFile = path.basename(relativeFile);
    const fullPath = path.join(this.staticDir, safeFile);
    const ext = path.extname(safeFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      if (!fs.existsSync(fullPath)) {
        this._sendJson(res, 404, { ok: false, error: 'Not Found' });
        return;
      }
      const content = fs.readFileSync(fullPath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    } catch (err) {
      this._sendJson(res, 500, { ok: false, error: 'Failed to read static asset' });
    }
  }

  async _handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-remote-pin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      res.end();
      return;
    }

    const host = req.headers.host || '127.0.0.1';
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const pathname = parsedUrl.pathname;

    // 1. Public Static PWA Routes (No PIN required)
    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') {
        this._serveStaticFile(res, 'index.html');
        return;
      }
      if (
        pathname === '/styles.css' ||
        pathname === '/app.js' ||
        pathname === '/manifest.json' ||
        pathname === '/sw.js' ||
        pathname === '/icon.svg' ||
        pathname === '/favicon.ico'
      ) {
        this._serveStaticFile(res, pathname.slice(1));
        return;
      }
    }

    // 2. Protected /api/* Routes
    if (!pathname.startsWith('/api/')) {
      this._sendJson(res, 404, { ok: false, error: 'Route not found' });
      return;
    }

    const cfg = this.configManager ? this.configManager.getConfig() : {};
    const expectedPin = String(cfg.remoteControlPin || '');

    // POST /api/auth
    if (pathname === '/api/auth' && req.method === 'POST') {
      let body = {};
      try {
        body = await this._readJsonBody(req);
      } catch (err) {
        this._sendJson(res, 400, { ok: false, error: err.message });
        return;
      }

      const candidatePin = this._extractPin(req, parsedUrl, body);
      if (!verifyPinConstantTime(candidatePin, expectedPin)) {
        this._sendJson(res, 401, { ok: false, error: 'Invalid PIN' });
        return;
      }

      this._sendJson(res, 200, {
        ok: true,
        authenticated: true
      });
      return;
    }

    // All other /api/* routes require valid PIN via header or query
    const headerOrQueryPin = this._extractPin(req, parsedUrl);
    if (!verifyPinConstantTime(headerOrQueryPin, expectedPin)) {
      this._sendJson(res, 401, { ok: false, error: 'Invalid PIN' });
      return;
    }

    // GET /api/state?profile=1
    if (pathname === '/api/state' && req.method === 'GET') {
      const requestedProfile = parsedUrl.searchParams.get('profile');
      const profileNum = requestedProfile ? parseInt(requestedProfile, 10) : null;
      if (typeof this.getStateCallback !== 'function') {
        this._sendJson(res, 500, { ok: false, error: 'State handler not configured' });
        return;
      }
      const stateData = await this.getStateCallback(profileNum);
      this._sendJson(res, 200, {
        ok: true,
        ...stateData
      });
      return;
    }

    // POST /api/action
    if (pathname === '/api/action' && req.method === 'POST') {
      let body = {};
      try {
        body = await this._readJsonBody(req);
      } catch (err) {
        this._sendJson(res, 400, { ok: false, error: err.message });
        return;
      }

      if (typeof this.handleActionCallback !== 'function') {
        this._sendJson(res, 500, { ok: false, error: 'Action handler not configured' });
        return;
      }

      const profileNumber =
        body.profileNumber !== undefined && body.profileNumber !== null
          ? parseInt(body.profileNumber, 10)
          : null;
      const action = String(body.action || '').trim();
      const payload = body.payload || {};

      const actionResult = await this.handleActionCallback({
        profileNumber,
        action,
        payload
      });

      this._sendJson(res, 200, {
        ok: Boolean(actionResult && actionResult.success !== false),
        ...actionResult
      });
      return;
    }

    // GET /api/screenshot?profile=1
    if (pathname === '/api/screenshot' && req.method === 'GET') {
      const requestedProfile = parsedUrl.searchParams.get('profile');
      const profileNum = requestedProfile ? parseInt(requestedProfile, 10) : null;
      if (typeof this.getScreenshotCallback !== 'function') {
        this._sendJson(res, 404, { ok: false, error: 'Screenshot handler not available' });
        return;
      }

      const shot = await this.getScreenshotCallback(profileNum);
      if (!shot || !shot.success || !shot.buffer) {
        this._sendJson(res, 404, {
          ok: false,
          error: (shot && shot.error) || 'Chrome tab is not connected on this profile.'
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': shot.buffer.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      res.end(shot.buffer);
      return;
    }

    this._sendJson(res, 404, { ok: false, error: 'API endpoint not found' });
  }
}

module.exports = {
  MobileRemoteServer
};
