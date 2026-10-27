const net = require('node:net');
const dns = require('node:dns').promises;
let ipaddr = null;
try { ipaddr = require('ipaddr.js'); } catch (_) { /* minimal fallback keeps static checks available before npm install */ }
const { URL } = require('node:url');
const credentials = require('../credential');

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function truncate(value, max = 4000) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function normalizeTarget(target) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('target is required');
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('target must use http:// or https://');
  return u.toString();
}

function sameOrigin(a, b) {
  try {
    const x = new URL(a); const y = new URL(b);
    return x.protocol === y.protocol && x.hostname === y.hostname && (x.port || defaultPort(x.protocol)) === (y.port || defaultPort(y.protocol));
  } catch (_) { return false; }
}

function defaultPort(protocol) { return protocol === 'https:' ? '443' : '80'; }

function queryParams(url) {
  const u = new URL(url);
  return [...u.searchParams.entries()];
}

function replaceQueryParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinksAndForms(html, baseUrl) {
  const results = [];
  const forms = [];
  const tagRe = /<([a-z][\w-]*)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html || ''))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const href = attrs.match(/\b(?:href|src|action|data)\s*=\s*["']([^"']+)["']/i);
    if (href) {
      try {
        const value = href[1];
        if (!/^(?:javascript:|mailto:|tel:|data:|#)/i.test(value)) {
          const url = new URL(value, baseUrl).toString();
          results.push({ url, value, tag, attribute: href[0].split('=')[0].trim() });
        }
      } catch (_) {}
    }
    if (tag === 'form') {
      const actionMatch = attrs.match(/\baction\s*=\s*["']([^"']*)["']/i);
      const methodMatch = attrs.match(/\bmethod\s*=\s*["']([^"']*)["']/i);
      forms.push({ action: actionMatch ? new URL(actionMatch[1] || baseUrl, baseUrl).toString() : baseUrl, method: (methodMatch ? methodMatch[1] : 'GET').toUpperCase() });
    }
  }
  return [results, forms];
}

function ipv6ToWords(input) {
  let value = String(input || '').toLowerCase().split('%')[0];
  const ipv4Match = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = ipv4Match[1].split('.').map(Number);
    if (ipv4.some(n => n < 0 || n > 255)) return null;
    const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = value.slice(0, -ipv4Match[1].length) + hi + ':' + lo;
  }
  if ((value.match(/::/g) || []).length > 1) return null;
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  if (left.concat(right).some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const all = left.concat(Array(Math.max(0, missing)).fill('0'), right).map(part => parseInt(part, 16));
  return all.length === 8 ? all : null;
}

function getPrivateCidrReason(ip) {
  let value = String(ip || '').trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.includes('%')) value = value.split('%')[0];
  if (value === 'localhost' || value.endsWith('.localhost')) return 'localhost';

  if (net.isIP(value) === 6) {
    try {
      if (ipaddr) {
        const parsed = ipaddr.parse(value);
        if (parsed.kind() === 'ipv6') {
          if (parsed.isIPv4MappedAddress()) return getPrivateCidrReason(parsed.toIPv4Address().toString());
          const range = parsed.range();
          if (range === 'loopback') return 'loopback IPv6';
          if (range === 'uniqueLocal') return 'private IPv6';
          if (range === 'linkLocal') return 'link-local IPv6';
          if (range === 'unspecified') return 'unspecified IPv6';
          if (range === 'multicast') return 'multicast IPv6';
          // IPv4-compatible IPv6 encodings can hide loopback/private IPv4 values.
          const words = parsed.parts;
          if (words.slice(0, 6).every(part => part === 0)) {
            const packed = (((words[6] << 16) | words[7]) >>> 0);
            const mappedIp = [packed >>> 24, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join('.');
            const reason = getPrivateCidrReason(mappedIp);
            if (reason) return reason;
          }
        }
        return '';
      }

      // Fallback for local syntax/smoke checks when npm dependencies are not installed.
      const words = ipv6ToWords(value);
      if (!words) return 'invalid IP address';
      if (words.every((part, index) => index === 7 ? part === 1 : part === 0)) return 'loopback IPv6';
      if (words.every(part => part === 0)) return 'unspecified IPv6';
      if ((words[0] & 0xfe00) === 0xfc00) return 'private IPv6';
      if ((words[0] & 0xffc0) === 0xfe80) return 'link-local IPv6';
      if ((words[0] & 0xff00) === 0xff00) return 'multicast IPv6';
      if (words.slice(0, 5).every(part => part === 0) && words[5] === 0xffff) {
        const packed = (((words[6] << 16) | words[7]) >>> 0);
        const mappedIp = [packed >>> 24, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join('.');
        return getPrivateCidrReason(mappedIp);
      }
      if ((words[0] & 0xe000) !== 0x2000) return 'reserved/non-global IPv6';
      if (words[0] === 0x2001 && words[1] === 0x0db8) return 'documentation IPv6';
      if (words[0] === 0x2002) {
        const mappedIp = [words[1] >>> 8, words[1] & 255, words[2] >>> 8, words[2] & 255].join('.');
        const reason = getPrivateCidrReason(mappedIp);
        if (reason) return reason;
      }
      return '';
    } catch (_) {
      return 'invalid IP address';
    }
  }

  if (net.isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return 'private IPv4';
    if (a === 127) return 'loopback IPv4';
    if (a === 169 && b === 254) return 'link-local IPv4';
    if (a === 172 && b >= 16 && b <= 31) return 'private IPv4';
    if (a === 192 && b === 168) return 'private IPv4';
    if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT';
    if (a === 0) return 'unspecified IPv4';
    if (a >= 224) return 'multicast/reserved IPv4';
    return '';
  }
  return '';
}

async function assertAllowedTarget(urlOrHost) {
  if (credentials.security && credentials.security.allowPrivateTargets) return;
  let hostname;
  try { hostname = new URL(urlOrHost).hostname; } catch (_) { hostname = String(urlOrHost).trim(); }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  const directReason = getPrivateCidrReason(hostname);
  if (directReason) throw new Error(`private/internal destination blocked: ${directReason}`);
  if (net.isIP(hostname)) return;
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const item of addresses) {
      const reason = getPrivateCidrReason(item.address);
      if (reason) throw new Error(`private/internal destination blocked: ${hostname} -> ${item.address} (${reason})`);
    }
  } catch (error) {
    if (/blocked/.test(error.message)) throw error;
    // DNS failure is handled by the caller as a normal request failure.
  }
}

const SENSITIVE_PATHS = [
  '/.env', '/.git/HEAD', '/.git/config', '/.git/index', '/.git/logs/HEAD',
  '/phpinfo.php', '/server-status', '/server-info', '/debug', '/actuator', '/actuator/env',
  '/.well-known/security.txt', '/config.php', '/config.json', '/database.yml', '/docker-compose.yml',
  '/docker-compose.yaml', '/backup.zip', '/backup.tar.gz', '/site.zip', '/db.sql', '/dump.sql',
  '/error.log', '/access.log', '/app.log', '/debug.log', '/composer.json', '/package.json',
  '/package-lock.json', '/yarn.lock', '/pnpm-lock.yaml', '/.npmrc', '/.DS_Store', '/web.config',
  '/.htaccess', '/.htpasswd', '/wp-config.php', '/wp-admin/', '/admin/', '/administrator/',
  '/graphql', '/swagger.json', '/openapi.json', '/api-docs', '/swagger-ui/', '/console/'
];

module.exports = {
  SEVERITY_ORDER, truncate, normalizeTarget, sameOrigin, queryParams, replaceQueryParam,
  stripHtml, extractLinksAndForms, assertAllowedTarget, SENSITIVE_PATHS, getPrivateCidrReason
};
