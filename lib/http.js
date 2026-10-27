const { setTimeout: sleepTimeout } = require('node:timers/promises');
const { URL } = require('node:url');
const { assertAllowedTarget, truncate } = require('./utils');

const TEXT_TYPES = [
  'text/', 'application/json', 'application/javascript', 'application/x-javascript',
  'application/xml', 'application/xhtml+xml', 'application/ld+json', 'application/manifest+json',
  'application/graphql-response+json', 'application/sql', 'image/svg+xml'
];

function isTextualContentType(value) {
  const ct = String(value || '').split(';')[0].trim().toLowerCase();
  if (!ct) return true;
  if (ct.startsWith('image/') && ct !== 'image/svg+xml') return false;
  if (ct.startsWith('video/') || ct.startsWith('audio/') || ct.startsWith('font/')) return false;
  if (ct === 'application/octet-stream' || ct === 'application/zip' || ct === 'application/pdf') return false;
  return TEXT_TYPES.some(prefix => ct === prefix || ct.startsWith(prefix));
}

function decodeBuffer(buffer, contentType) {
  let charset = 'utf-8';
  const match = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  if (match && match[1]) charset = match[1].toLowerCase();
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (_) {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function request(method, target, options = {}) {
  const maxBytes = Math.min(Math.max(Number(options.maxBytes || 512 * 1024), 0), 2 * 1024 * 1024);
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 8000), 250), 10000);
  const maxRedirects = Math.min(Math.max(Number(options.maxRedirects == null ? 5 : options.maxRedirects), 0), 8);
  const headers = { 'User-Agent': 'kernote-node-beta/3.0 (authorized-security-testing)', 'Accept': '*/*', ...(options.headers || {}) };
  let current = target;
  const redirects = [];
  const started = Date.now();

  await assertAllowedTarget(current);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const u = new URL(current);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http/https URLs are allowed');
      const response = await fetch(current, {
        method: method.toUpperCase(),
        headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal
      });
      const location = response.headers.get('location');
      if (location && response.status >= 300 && response.status < 400 && redirectCount < maxRedirects) {
        try { await response.body?.cancel(); } catch (_) {}
        clearTimeout(timer);
        const next = new URL(location, current).toString();
        await assertAllowedTarget(next);
        redirects.push({ from: current, to: next, status: response.status });
        current = next;
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      const textual = isTextualContentType(contentType);
      let body = Buffer.alloc(0);
      let truncated = false;
      let skippedBody = false;
      if (method.toUpperCase() !== 'HEAD' && !options.skipBody) {
        if (!textual && options.textOnly !== false) {
          skippedBody = true;
          await response.body?.cancel();
        } else {
          const reader = response.body ? response.body.getReader() : null;
          const chunks = [];
          let total = 0;
          if (reader) {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              total += part.value.byteLength;
              if (total > maxBytes) {
                const allowed = part.value.slice(0, Math.max(0, maxBytes - (total - part.value.byteLength)));
                if (allowed.byteLength) chunks.push(Buffer.from(allowed));
                truncated = true;
                await reader.cancel();
                break;
              }
              chunks.push(Buffer.from(part.value));
            }
          }
          body = Buffer.concat(chunks);
        }
      }

      const headersObject = {};
      for (const [k,v] of response.headers.entries()) headersObject[k] = v;
      if (typeof response.headers.getSetCookie === 'function') {
        const cookies = response.headers.getSetCookie();
        if (cookies.length) headersObject['set-cookie'] = cookies;
      }
      const text = skippedBody ? '' : decodeBuffer(body, contentType);
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      return {
        url: target,
        status: response.status,
        ok: response.ok,
        headers: headersObject,
        contentType,
        bodySize: body.length,
        body,
        text,
        textual,
        skippedBody,
        truncated,
        finalUrl: current,
        redirects,
        durationMs,
        error: ''
      };
    } catch (error) {
      clearTimeout(timer);
      return {
        url: target, status: 0, ok: false, headers: {}, contentType: '', bodySize: 0, body: Buffer.alloc(0),
        text: '', textual: true, skippedBody: false, truncated: false, finalUrl: current,
        redirects, durationMs: Date.now() - started, error: error.name === 'AbortError' ? 'request timeout' : error.message
      };
    }
  }

  return { url: target, status: 0, ok: false, headers: {}, contentType: '', bodySize: 0, body: Buffer.alloc(0), text: '', textual: true, skippedBody: false, truncated: false, finalUrl: current, redirects, durationMs: Date.now() - started, error: 'too many redirects' };
}

function jsonBody(obj) {
  return JSON.stringify(obj);
}

module.exports = { request, jsonBody, isTextualContentType, decodeBuffer };
