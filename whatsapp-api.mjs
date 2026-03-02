#!/usr/bin/env node
/**
 * WhatsApp Management API for The Proxies
 * Runs alongside OpenClaw gateway, proxying /v1/* and handling /api/whatsapp/*
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  useMultiFileAuthState,
  makeWASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';

// Try to import QR matrix generator from qrcode-terminal vendor
import QRCodeModule from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_INTERNAL_PORT || '3001', 10);
const API_PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.OPENCLAW_STATE_DIR || '/data';
const WA_BASE_DIR = path.join(DATA_DIR, 'credentials', 'whatsapp');

// Backwards compat: single-account path used for legacy "default" account
const WA_AUTH_DIR = path.join(WA_BASE_DIR, 'default');

// Gateway webhook for forwarding incoming WhatsApp messages
const GATEWAY_WEBHOOK_URL = process.env.GATEWAY_WEBHOOK_URL || 'https://api.the-proxies.ai/api/agents/webhooks/whatsapp';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Minimal silent logger for Baileys
const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

// ============ Multi-tenant account state ============
// Map<accountId, { pairing, listenerSock }>
const accounts = new Map();

function getAccountAuthDir(accountId) {
  return path.join(WA_BASE_DIR, accountId);
}

function getAccountState(accountId) {
  if (!accounts.has(accountId)) {
    accounts.set(accountId, { pairing: null, listenerSock: null });
  }
  return accounts.get(accountId);
}

// Legacy globals for backward compat (default account)
let activePairing = null;
let listenerSock = null;

// ============ Message Forwarding to Gateway ============

/**
 * Forward an incoming WhatsApp message to the Agent HQ gateway webhook.
 * Fire-and-forget: logs success/failure but never throws.
 */
async function forwardToGateway(sender, message, timestamp, messageId, pushName, accountId = 'default') {
  if (!WEBHOOK_SECRET) {
    console.log('[whatsapp-api] WEBHOOK_SECRET not set, skipping gateway forwarding');
    return;
  }

  const payload = JSON.stringify({
    sender,
    message,
    timestamp: timestamp || Math.floor(Date.now() / 1000),
    messageId: messageId || null,
    pushName: pushName || null,
    accountId,
  });

  try {
    const url = new URL(GATEWAY_WEBHOOK_URL);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? await import('node:https') : await import('node:http');

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
    };

    await new Promise((resolve, reject) => {
      const req = transport.default.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[whatsapp-api] Forwarded message from ${sender} to gateway (${res.statusCode})`);
          } else {
            console.error(`[whatsapp-api] Gateway returned ${res.statusCode}: ${body}`);
          }
          resolve();
        });
      });
      req.on('error', (err) => {
        console.error(`[whatsapp-api] Failed to forward message to gateway: ${err.message}`);
        resolve(); // Don't reject — fire-and-forget
      });
      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.error(`[whatsapp-api] Gateway forwarding error: ${err.message}`);
  }
}

/**
 * Attach a messages.upsert listener to a Baileys socket.
 * Only forwards incoming text messages (not outgoing or status updates).
 */
function attachMessageListener(sock, accountId = 'default') {
  sock.ev.on('messages.upsert', (upsert) => {
    if (!upsert.messages) return;

    for (const msg of upsert.messages) {
      // Skip outgoing messages (fromMe) and status broadcasts
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      // Extract text content
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;

      if (!text) continue; // Skip non-text messages (images, etc.)

      const sender = msg.key.remoteJid?.split('@')[0] || 'unknown';
      const timestamp = msg.messageTimestamp
        ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp))
        : Math.floor(Date.now() / 1000);
      const messageId = msg.key.id || null;
      const pushName = msg.pushName || null;

      console.log(`[whatsapp-api] Incoming message from ${pushName || sender}: ${text.slice(0, 80)}...`);

      // Forward to gateway (fire-and-forget)
      forwardToGateway(sender, text, timestamp, messageId, pushName, accountId);
    }
  });
}

/**
 * Start a persistent WhatsApp listener for message forwarding.
 * Supports per-account listeners. accountId='default' for backward compat.
 */
async function startMessageListener(accountId = 'default') {
  const authDir = getAccountAuthDir(accountId);
  const credsPath = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    console.log(`[whatsapp-api] [${accountId}] No credentials found, skipping listener`);
    return;
  }

  if (!WEBHOOK_SECRET) {
    console.log(`[whatsapp-api] [${accountId}] WEBHOOK_SECRET not set, skipping listener`);
    return;
  }

  const acct = getAccountState(accountId);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      version,
      logger: silentLogger,
      printQRInTerminal: false,
      browser: [`The Proxies [${accountId}]`, 'Web', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    acct.listenerSock = sock;
    // Legacy compat
    if (accountId === 'default') listenerSock = sock;

    sock.ev.on('creds.update', saveCreds);
    attachMessageListener(sock, accountId);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log(`[whatsapp-api] [${accountId}] Listener connected`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        acct.listenerSock = null;
        if (accountId === 'default') listenerSock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[whatsapp-api] [${accountId}] Session logged out, not reconnecting`);
        } else {
          console.log(`[whatsapp-api] [${accountId}] Listener disconnected (code: ${statusCode}), reconnecting in 5s...`);
          setTimeout(() => startMessageListener(accountId), 5000);
        }
      }
    });

    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (err) => {
        console.error(`[whatsapp-api] [${accountId}] Listener WebSocket error:`, err.message);
      });
    }
  } catch (err) {
    console.error(`[whatsapp-api] [${accountId}] Failed to start listener:`, err.message);
    setTimeout(() => startMessageListener(accountId), 10000);
  }
}

/**
 * Start listeners for ALL accounts that have saved credentials.
 */
function startAllMessageListeners() {
  try {
    if (!fs.existsSync(WA_BASE_DIR)) return;
    const dirs = fs.readdirSync(WA_BASE_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        const credsPath = path.join(WA_BASE_DIR, dir.name, 'creds.json');
        if (fs.existsSync(credsPath)) {
          console.log(`[whatsapp-api] Starting listener for account: ${dir.name}`);
          startMessageListener(dir.name);
        }
      }
    }
  } catch (err) {
    console.error('[whatsapp-api] Failed to scan account directories:', err.message);
  }
}

// ============ QR Rendering ============

function qrToSvgDataUrl(qrString) {
  const QRCode = QRCodeModule.default || QRCodeModule;
  const ErrorLevel = QRErrorCorrectLevel.default || QRErrorCorrectLevel;

  const qr = new QRCode(-1, ErrorLevel.L);
  qr.addData(qrString);
  qr.make();

  const modules = qr.getModuleCount();
  const scale = 8;
  const margin = 4;
  const size = (modules + margin * 2) * scale;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  svg += `<rect width="${size}" height="${size}" fill="white"/>`;

  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) {
        const x = (col + margin) * scale;
        const y = (row + margin) * scale;
        svg += `<rect x="${x}" y="${y}" width="${scale}" height="${scale}" fill="black"/>`;
      }
    }
  }

  svg += '</svg>';
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ============ Auth ============

function checkAuth(req) {
  if (!TOKEN) return false;
  const auth = req.headers.authorization;
  return auth && auth.startsWith('Bearer ') && auth.slice(7) === TOKEN;
}

// ============ WhatsApp Status ============

function getWhatsAppStatus(accountId = 'default') {
  const authDir = getAccountAuthDir(accountId);
  const credsPath = path.join(authDir, 'creds.json');
  const exists = fs.existsSync(credsPath);
  let phoneNumber = null;

  if (exists) {
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const rawId = creds.me?.id || '';
      phoneNumber = rawId.split('@')[0]?.split(':')[0] || null;
      if (phoneNumber && !phoneNumber.startsWith('+')) {
        phoneNumber = '+' + phoneNumber;
      }
    } catch {
      // ignore parse errors
    }
  }

  return { connected: exists, phoneNumber, accountId, authDir };
}

/**
 * List all WhatsApp accounts that have saved credentials.
 */
function listWhatsAppAccounts() {
  const result = [];
  try {
    if (!fs.existsSync(WA_BASE_DIR)) return result;
    const dirs = fs.readdirSync(WA_BASE_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        const status = getWhatsAppStatus(dir.name);
        if (status.connected) {
          result.push(status);
        }
      }
    }
  } catch {}
  return result;
}

// ============ Pairing ============

async function startPairing(force = false, accountId = 'default') {
  const acct = getAccountState(accountId);
  const authDir = getAccountAuthDir(accountId);

  // Clean up existing pairing for this account
  if (acct.pairing?.sock) {
    try { acct.pairing.sock.ws?.close(); } catch {}
    acct.pairing = null;
  }
  // Legacy compat
  if (accountId === 'default') activePairing = null;

  // Stop existing message listener for this account (will be restarted after pairing)
  if (acct.listenerSock) {
    try { acct.listenerSock.ws?.close(); } catch {}
    acct.listenerSock = null;
  }
  if (accountId === 'default') listenerSock = null;

  const status = getWhatsAppStatus(accountId);
  if (status.connected && !force) {
    return { alreadyConnected: true, phoneNumber: status.phoneNumber, accountId };
  }

  // If forcing, remove old creds
  if (force && status.connected) {
    try {
      const files = fs.readdirSync(authDir);
      for (const file of files) {
        fs.unlinkSync(path.join(authDir, file));
      }
    } catch {}
  }

  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (activePairing?.sock) {
        try { activePairing.sock.ws?.close(); } catch {}
      }
      activePairing = null;
      resolve({ error: 'Timed out waiting for QR code (30s)' });
    }, 30000);

    let sock;
    try {
      sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
        },
        version,
        logger: silentLogger,
        printQRInTerminal: false,
        browser: [`The Proxies [${accountId}]`, 'Web', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve({ error: `Failed to create WhatsApp socket: ${err.message}` });
      return;
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        clearTimeout(timeout);
        const qrDataUrl = qrToSvgDataUrl(qr);
        const pairingState = {
          sock,
          qrDataUrl,
          connected: false,
          error: null,
          startedAt: Date.now(),
        };
        acct.pairing = pairingState;
        if (accountId === 'default') activePairing = pairingState;
        console.log(`[whatsapp-api] [${accountId}] QR code generated, waiting for scan...`);
        resolve({ qrDataUrl, message: 'Scan this QR in WhatsApp → Linked Devices', accountId });
      }

      if (connection === 'open') {
        console.log(`[whatsapp-api] [${accountId}] WhatsApp connected!`);
        if (acct.pairing) {
          acct.pairing.connected = true;
          if (accountId === 'default' && activePairing) activePairing.connected = true;
          setTimeout(() => {
            try { acct.pairing?.sock?.ws?.close(); } catch {}
            startMessageListener(accountId);
          }, 2000);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[whatsapp-api] [${accountId}] Session logged out`);
          if (acct.pairing) acct.pairing.error = 'Session logged out';
        } else if (acct.pairing && !acct.pairing.connected) {
          if (!acct.pairing.qrDataUrl) {
            acct.pairing.error = `Connection closed (code: ${statusCode})`;
          }
        }
      }
    });

    // Handle socket errors
    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (err) => {
        console.error('[whatsapp-api] WebSocket error:', err.message);
      });
    }
  });
}

async function waitForPairing(timeoutMs = 60000, accountId = 'default') {
  const acct = getAccountState(accountId);
  const pairing = acct.pairing;

  if (!pairing) {
    return { connected: false, message: 'No active pairing session' };
  }
  if (pairing.connected) {
    return { connected: true, phoneNumber: getWhatsAppStatus(accountId).phoneNumber, accountId };
  }
  if (pairing.error) {
    return { connected: false, error: pairing.error };
  }
  if (Date.now() - pairing.startedAt > 180000) {
    return { connected: false, error: 'Pairing session expired (3 min)' };
  }

  return new Promise((resolve) => {
    const deadline = Date.now() + Math.min(timeoutMs, 10000);
    const interval = setInterval(() => {
      if (acct.pairing?.connected) {
        clearInterval(interval);
        resolve({ connected: true, phoneNumber: getWhatsAppStatus(accountId).phoneNumber, accountId });
      } else if (acct.pairing?.error || Date.now() > deadline) {
        clearInterval(interval);
        resolve({
          connected: false,
          error: acct.pairing?.error || null,
          waiting: !acct.pairing?.error,
        });
      }
    }, 500);
  });
}

async function disconnectWhatsApp(accountId = 'default') {
  const acct = getAccountState(accountId);
  const authDir = getAccountAuthDir(accountId);

  // Clean up active pairing
  if (acct.pairing?.sock) {
    try { acct.pairing.sock.ws?.close(); } catch {}
    acct.pairing = null;
  }
  if (accountId === 'default') activePairing = null;

  // Stop message listener
  if (acct.listenerSock) {
    try { acct.listenerSock.ws?.close(); } catch {}
    acct.listenerSock = null;
  }
  if (accountId === 'default') listenerSock = null;

  // Remove credential files
  try {
    if (fs.existsSync(authDir)) {
      const files = fs.readdirSync(authDir);
      for (const file of files) {
        fs.unlinkSync(path.join(authDir, file));
      }
    }
    return { success: true, accountId };
  } catch (err) {
    return { success: false, error: err.message, accountId };
  }
}

// ============ HTTP Helpers ============

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

// ============ Proxy to OpenClaw ============

function proxyToOpenClaw(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: OPENCLAW_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${OPENCLAW_PORT}` },
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxy.on('error', () => {
    jsonResponse(res, 502, { error: 'OpenClaw gateway unreachable' });
  });

  req.pipe(proxy);
}

// ============ Request Router ============

async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    });
    res.end();
    return;
  }

  // WhatsApp management endpoints
  // Supports both /api/whatsapp/* (default account) and /api/whatsapp/:accountId/*
  if (req.url.startsWith('/api/whatsapp/')) {
    if (!checkAuth(req)) {
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      // Parse accountId from URL: /api/whatsapp/accounts/:accountId/...
      // or use 'default' for legacy /api/whatsapp/... endpoints
      const accountMatch = req.url.match(/^\/api\/whatsapp\/accounts\/([^/]+)\/(.+)$/);
      const accountId = accountMatch ? accountMatch[1] : 'default';
      const subPath = accountMatch ? `/api/whatsapp/${accountMatch[2]}` : req.url;

      if (subPath === '/api/whatsapp/status' && req.method === 'GET') {
        jsonResponse(res, 200, getWhatsAppStatus(accountId));
        return;
      }

      if (subPath === '/api/whatsapp/pair/start' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await startPairing(body?.force === true, accountId);
        jsonResponse(res, 200, result);
        return;
      }

      if (subPath === '/api/whatsapp/pair/wait' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await waitForPairing(body?.timeoutMs || 60000, accountId);
        jsonResponse(res, 200, result);
        return;
      }

      if (subPath === '/api/whatsapp/disconnect' && req.method === 'DELETE') {
        const result = await disconnectWhatsApp(accountId);
        jsonResponse(res, 200, result);
        return;
      }

      // List all accounts
      if (req.url === '/api/whatsapp/accounts' && req.method === 'GET') {
        jsonResponse(res, 200, { accounts: listWhatsAppAccounts() });
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[whatsapp-api] Error:', err);
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  // Everything else proxies to OpenClaw gateway
  proxyToOpenClaw(req, res);
}

// ============ Server ============

const server = http.createServer(handleRequest);
server.listen(API_PORT, '0.0.0.0', () => {
  console.log(`[whatsapp-api] Management API listening on port ${API_PORT}`);
  console.log(`[whatsapp-api] Proxying to OpenClaw on port ${OPENCLAW_PORT}`);
  console.log(`[whatsapp-api] WhatsApp auth dir: ${WA_AUTH_DIR}`);

  // Start persistent message listeners for ALL paired accounts
  startAllMessageListeners();
});
