'use strict';

const { request } = require('../http');

const MAX_CODE_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 96 * 1024;
const MAX_LOG_BYTES = 24 * 1024;
const MAX_NETWORK_CALLS = 8;
const MAX_NETWORK_BYTES = 768 * 1024;
const MAX_NETWORK_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const HARD_TIMEOUT_MS = 30000;
const MEMORY_LIMIT_BYTES = 24 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const MAX_OBJECT_REFERENCES = 1200;
const MAX_BINARY_BYTES = 256 * 1024;

const EXTERNAL_MODULES = new Set([
  'axios', 'cheerio', 'tough-cookie', 'form-data', 'qs', 'ipaddr.js',
  'zod', 'lodash', 'json5', 'fast-xml-parser', 'xmlbuilder2', 'csv-parse',
  'csv-stringify', 'yaml', 'toml', 'smol-toml', 'jsonpath-plus', 'jmespath',
  'dayjs', 'luxon', 'date-fns', 'rrule', 'uuid', 'nanoid', 'base64-js', 'he',
  'iconv-lite', 'linkedom', 'parse5', 'marked', 'turndown', 'sanitize-html',
  'htmlparser2', 'rss-parser', 'robots-parser', '@mozilla/readability',
  'mailparser', 'email-addresses', 'validator', 'semver', 'minimatch',
  'micromatch', 'diff', 'slugify', 'pluralize', 'fast-deep-equal', 'deepmerge',
  'p-limit', 'bottleneck', 'p-retry', 'nodemailer'
]);

const BUILTIN_ALIASES = Object.freeze({
  assert: 'node:assert',
  buffer: 'node:buffer',
  crypto: 'node:crypto',
  events: 'node:events',
  path: 'node:path',
  querystring: 'node:querystring',
  stream: 'node:stream',
  string_decoder: 'node:string_decoder',
  url: 'node:url',
  util: 'node:util',
});

const BLOCKED_MODULES = new Set([
  'fs', 'fs/promises', 'node:fs', 'node:fs/promises',
  'child_process', 'node:child_process', 'worker_threads', 'node:worker_threads',
  'cluster', 'node:cluster', 'vm', 'node:vm', 'module', 'node:module',
  'process', 'node:process', 'http', 'node:http', 'https', 'node:https',
  'net', 'node:net', 'tls', 'node:tls', 'dns', 'node:dns', 'os', 'node:os',
  'inspector', 'node:inspector', 'repl', 'node:repl', 'v8', 'node:v8',
  'perf_hooks', 'node:perf_hooks', 'readline', 'node:readline',
  'timers', 'node:timers', 'timers/promises', 'node:timers/promises'
]);

const FORBIDDEN_PROPERTIES = new Set([
  '__proto__', 'prototype', 'constructor', 'caller', 'callee', 'arguments',
  'then', 'inspect', 'runInContext', 'mixin', 'noConflict', 'template'
]);

const BUILTIN_MODULES = new Set(Object.keys(BUILTIN_ALIASES));

function loadModule(name) {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_ALIASES, name)) {
    return require(BUILTIN_ALIASES[name]);
  }
  switch (name) {
    case 'axios': return require('axios');
    case 'cheerio': return require('cheerio');
    case 'tough-cookie': return require('tough-cookie');
    case 'form-data': return require('form-data');
    case 'qs': return require('qs');
    case 'ipaddr.js': return require('ipaddr.js');
    case 'zod': return require('zod');
    case 'lodash': return require('lodash');
    case 'json5': return require('json5');
    case 'fast-xml-parser': return require('fast-xml-parser');
    case 'xmlbuilder2': return require('xmlbuilder2');
    case 'csv-parse': return require('csv-parse/sync');
    case 'csv-stringify': return require('csv-stringify/sync');
    case 'yaml': return require('yaml');
    case 'toml': return require('toml');
    case 'smol-toml': return require('smol-toml');
    case 'jsonpath-plus': return require('jsonpath-plus');
    case 'jmespath': return require('jmespath');
    case 'dayjs': return require('dayjs');
    case 'luxon': return require('luxon');
    case 'date-fns': return require('date-fns');
    case 'rrule': return require('rrule');
    case 'uuid': return require('uuid');
    case 'nanoid': return require('nanoid');
    case 'base64-js': return require('base64-js');
    case 'he': return require('he');
    case 'iconv-lite': return require('iconv-lite');
    case 'linkedom': return require('linkedom');
    case 'parse5': return require('parse5');
    case 'marked': return require('marked');
    case 'turndown': return require('turndown');
    case 'sanitize-html': return require('sanitize-html');
    case 'htmlparser2': return require('htmlparser2');
    case 'rss-parser': return require('rss-parser');
    case 'robots-parser': return require('robots-parser');
    case '@mozilla/readability': return require('@mozilla/readability');
    case 'mailparser': return require('mailparser');
    case 'email-addresses': return require('email-addresses');
    case 'validator': return require('validator');
    case 'semver': return require('semver');
    case 'minimatch': return require('minimatch');
    case 'micromatch': return require('micromatch');
    case 'diff': return require('diff');
    case 'slugify': return require('slugify');
    case 'pluralize': return require('pluralize');
    case 'fast-deep-equal': return require('fast-deep-equal');
    case 'deepmerge': return require('deepmerge');
    case 'p-limit': return require('p-limit');
    case 'bottleneck': return require('bottleneck');
    case 'p-retry': return require('p-retry');
    default: throw new Error(`module blocked: ${name}`);
  }
}

function asText(value, max = 16 * 1024) {
  const text = typeof value === 'string' ? value : safeJson(value);
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

function safeJson(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
      if (item instanceof Error) return { name: item.name, message: item.message, code: item.code || undefined };
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }, 2) ?? String(value);
  } catch (_) {
    return String(value);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toPlain(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12) return '[max depth]';
  if (value === null || value === undefined) return value === undefined ? null : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return { name: value.name || 'Error', message: value.message || String(value), code: value.code || undefined };
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { type: 'Buffer', base64: value.toString('base64'), byteLength: value.length };
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 5000).map(item => toPlain(item, depth + 1, seen));
  const out = {};
  for (const key of Object.keys(value).slice(0, 500)) {
    if (FORBIDDEN_PROPERTIES.has(key) || key.startsWith('_')) continue;
    let next;
    try { next = value[key]; } catch (_) { continue; }
    if (typeof next === 'function') continue;
    out[key] = toPlain(next, depth + 1, seen);
  }
  return out;
}

async function executeJavaScript(args, context = {}) {
  if (!context.uid) throw new Error('javascript_execute membutuhkan akun Kernote terautentikasi melalui OAuth.');
  const code = String(args.code == null ? '' : args.code);
  if (!code.trim()) throw new Error('parameter code tidak boleh kosong.');
  const codeBytes = Buffer.byteLength(code, 'utf8');
  if (codeBytes > MAX_CODE_BYTES) throw new Error(`kode terlalu besar: maksimum ${MAX_CODE_BYTES} byte.`);

  const requestedTimeout = Number(args.timeoutMs || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(500, Math.min(Math.floor(requestedTimeout), HARD_TIMEOUT_MS))
    : DEFAULT_TIMEOUT_MS;
  const requestStartedAt = Date.now();
  let startedAt = requestStartedAt;
  let deadline = Number.POSITIVE_INFINITY;
  const stdout = [];
  const stderr = [];
  let logBytes = 0;
  let networkCalls = 0;
  let networkBytes = 0;
  const objectRefs = new Map();
  const moduleCache = new Map();
  const networkLog = [];
  let nextRef = 1;
  let runtime = null;
  let vm = null;
  let timedOut = false;
  let sandboxDisposed = false;
  let emailSendCount = 0;

  function writeLog(target, argsList) {
    const line = argsList.map(item => asText(item, 6000)).join(' ');
    const remaining = Math.max(0, MAX_LOG_BYTES - logBytes);
    if (!remaining) return;
    const clipped = line.length > remaining ? `${line.slice(0, remaining)}… [output limit]` : line;
    target.push(clipped);
    logBytes += clipped.length + 1;
  }

  function moduleValue(name) {
    if (name === 'axios') return null;
    if (name === 'nodemailer') return null;
    if (moduleCache.has(name)) return moduleCache.get(name);
    if (!EXTERNAL_MODULES.has(name) && !BUILTIN_MODULES.has(name)) {
      throw new Error(BLOCKED_MODULES.has(name) ? `module blocked: ${name}` : `module not allowlisted: ${name}`);
    }
    const loaded = loadModule(name);
    moduleCache.set(name, loaded);
    return loaded;
  }

  function storeRef(value, owner = null) {
    if (objectRefs.size >= MAX_OBJECT_REFERENCES) throw new Error('batas object reference sandbox tercapai.');
    const id = nextRef++;
    objectRefs.set(id, { value, owner });
    return id;
  }

  function encodeHost(value, depth = 0, seen = new WeakSet(), moduleName = '') {
    if (depth > 12) return '[max depth]';
    if (value === undefined) return null;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return { __kref: storeRef(value) };
    if (value instanceof Error) return { name: value.name || 'Error', message: value.message || String(value), code: value.code || undefined };
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return { type: 'Buffer', base64: value.toString('base64'), byteLength: value.length };
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    if (Array.isArray(value)) {
      seen.add(value);
      return value.slice(0, 1000).map(item => {
        if (moduleName === 'cheerio' && item && typeof item === 'object' && (item.type || item.name || item.tagName)) {
          return { __kref: storeRef(item) };
        }
        return encodeHost(item, depth + 1, seen, moduleName);
      });
    }
    const proto = Object.getPrototypeOf(value);
    const plain = proto === Object.prototype || proto === null;
    if (moduleName === 'cheerio' && (value.type || value.name || value.tagName) && (value.attribs || value.children)) {
      return { __kref: storeRef(value) };
    }
    if (!plain || Object.keys(value).some(key => typeof value[key] === 'function')) {
      return { __kref: storeRef(value) };
    }
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).slice(0, 500)) {
      if (FORBIDDEN_PROPERTIES.has(key) || key.startsWith('_')) continue;
      let next;
      try { next = value[key]; } catch (_) { continue; }
      if (typeof next === 'function') continue;
      out[key] = encodeHost(next, depth + 1, seen, moduleName);
    }
    return out;
  }

  function decodeGuest(value, depth = 0) {
    if (depth > 12) throw new Error('parameter nesting terlalu dalam.');
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 5000).map(item => decodeGuest(item, depth + 1));
    if (Object.keys(value).length === 1 && Number.isInteger(value.__kref)) {
      const record = objectRefs.get(value.__kref);
      if (!record) throw new Error('invalid sandbox reference.');
      return record.value;
    }
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      if (FORBIDDEN_PROPERTIES.has(key)) continue;
      out[key] = decodeGuest(item, depth + 1);
    }
    return out;
  }

  function parseArgs(json) {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 256 * 1024) {
      throw new Error('parameter module terlalu besar.');
    }
    return decodeGuest(JSON.parse(json));
  }

  function packEnvelope(value, moduleName) {
    const encoded = encodeHost(value, 0, new WeakSet(), moduleName);
    const json = JSON.stringify({ ok: true, value: encoded });
    if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) throw new Error('hasil modul terlalu besar.');
    return json;
  }

  function bridgeCall(moduleName, refId, method, argsJson) {
    if (Date.now() > deadline) throw new Error('execution timeout.');
    if (!EXTERNAL_MODULES.has(moduleName) && !BUILTIN_MODULES.has(moduleName)) throw new Error(`module blocked: ${moduleName}`);
    if (FORBIDDEN_PROPERTIES.has(method) || method.startsWith('__')) throw new Error(`module method blocked: ${method}`);
    const callArgs = parseArgs(argsJson);
    let target;
    let receiver;
    if (refId === 0) {
      target = moduleValue(moduleName);
      receiver = undefined;
    } else {
      const record = objectRefs.get(refId);
      if (!record) throw new Error('invalid sandbox object reference.');
      target = record.value;
      receiver = record.owner || undefined;
    }

    const functionName = typeof target === 'function' ? String(target.name || '') : '';
    if (moduleName === 'buffer') {
      if ((method === '$construct' || functionName === 'alloc' || functionName === 'allocUnsafe' || functionName === 'allocUnsafeSlow') && Number(callArgs[0]) > MAX_BINARY_BYTES) {
        throw new Error(`Buffer allocations are limited to ${MAX_BINARY_BYTES} bytes per call.`);
      }
      if (functionName === 'from' && typeof callArgs[0] === 'string' && Buffer.byteLength(callArgs[0], 'utf8') > MAX_BINARY_BYTES) {
        throw new Error(`Buffer.from input is limited to ${MAX_BINARY_BYTES} bytes.`);
      }
    }
    if (moduleName === 'crypto') {
      if (['scryptSync', 'generateKeyPairSync', 'generatePrimeSync', 'checkPrimeSync'].includes(functionName)) {
        throw new Error(`crypto.${functionName} is disabled in short-lived executions to avoid unbounded CPU work.`);
      }
      if (['randomBytes', 'randomFillSync', 'randomFill'].includes(functionName) && Number(callArgs[0]) > MAX_BINARY_BYTES) {
        throw new Error(`crypto.${functionName} is limited to ${MAX_BINARY_BYTES} random bytes.`);
      }
      if (functionName === 'pbkdf2Sync' && Number(callArgs[2]) > 100000) {
        throw new Error('crypto.pbkdf2Sync supports at most 100000 iterations in this sandbox.');
      }
    }
    let result;
    if (moduleName === 'rss-parser' && method === 'parseURL') throw new Error('rss-parser.parseURL is blocked because it bypasses the controlled network layer; fetch the feed with axios/fetch and use parseString.');
    if (method === '$call') {
      if (typeof target !== 'function') throw new Error(`${moduleName} is not callable.`);
      result = Reflect.apply(target, receiver, callArgs);
    } else if (method === '$construct') {
      if (typeof target !== 'function') throw new Error(`${moduleName} is not a constructor.`);
      result = Reflect.construct(target, callArgs);
    } else if (method.startsWith('$construct:')) {
      const key = method.slice('$construct:'.length);
      if (!key || FORBIDDEN_PROPERTIES.has(key)) throw new Error('constructor blocked.');
      const ctor = target && target[key];
      if (typeof ctor !== 'function') throw new Error(`${key} is not a constructor.`);
      result = Reflect.construct(ctor, callArgs);
    } else {
      const fn = target && target[method];
      if (typeof fn !== 'function') throw new Error(`method unavailable: ${moduleName}.${method}`);
      if (moduleName === 'lodash' && ['template', 'runInContext', 'mixin', 'noConflict'].includes(method)) {
        throw new Error(`method blocked: lodash.${method}`);
      }
      result = Reflect.apply(fn, target, callArgs);
    }

    if (result && typeof result.then === 'function') {
      return makeAsyncBridgePromise(() => result.then(value => packEnvelope(value, moduleName)));
    }
    return vm.newString(packEnvelope(result, moduleName));
  }

  function bridgeGet(moduleName, refId, key) {
    if (Date.now() > deadline) throw new Error('execution timeout.');
    if (FORBIDDEN_PROPERTIES.has(key) || key.startsWith('__')) throw new Error(`module property blocked: ${key}`);
    if (!EXTERNAL_MODULES.has(moduleName) && !BUILTIN_MODULES.has(moduleName)) throw new Error(`module blocked: ${moduleName}`);
    let target;
    if (refId === 0) target = moduleValue(moduleName);
    else {
      const record = objectRefs.get(refId);
      if (!record) throw new Error('invalid sandbox object reference.');
      target = record.value;
    }
    if (target == null) throw new Error(`module property unavailable: ${key}`);
    let value;
    try { value = target[key]; } catch (_) { throw new Error(`module property unavailable: ${key}`); }
    const encoded = typeof value === 'function'
      ? { __kfn: true, refId: storeRef(value, target) }
      : encodeHost(value, 0, new WeakSet(), moduleName);
    const json = JSON.stringify({ ok: true, value: encoded });
    if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) throw new Error('module property too large.');
    return vm.newString(json);
  }

  async function makeNetworkResponse(payload) {
    if (Date.now() > deadline) throw new Error('execution timeout.');
    if (++networkCalls > MAX_NETWORK_CALLS) throw new Error(`network request limit reached (${MAX_NETWORK_CALLS}).`);
    const input = payload && typeof payload === 'object' ? payload : {};
    const urlString = String(input.url || '');
    if (!urlString || urlString.length > 4096) throw new Error('url tidak valid atau terlalu panjang.');
    const u = new URL(urlString);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('hanya URL http/https yang diizinkan.');
    const method = String(input.method || 'GET').toUpperCase();
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new Error('http method tidak diizinkan.');
    const headers = normalizeHeaders(input.headers);
    const body = input.body == null ? undefined : String(input.body);
    if (body && Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new Error('request body maksimum 64 KB.');
    const remainingBytes = MAX_NETWORK_BYTES - networkBytes;
    if (remainingBytes <= 0) throw new Error(`network response budget reached (${MAX_NETWORK_BYTES} bytes).`);
    const started = Date.now();
    const response = await request(method, u.toString(), {
      headers,
      body,
      timeoutMs: Math.min(Math.max(Number(input.timeoutMs || 8000), 250), 10000, Math.max(250, deadline - Date.now() - 250)),
      maxBytes: Math.min(MAX_NETWORK_RESPONSE_BYTES, remainingBytes),
      maxRedirects: Math.min(Math.max(Number(input.maxRedirects == null ? 3 : input.maxRedirects), 0), 5),
      textOnly: true
    });
    networkBytes += response.bodySize || 0;
    const item = {
      method,
      url: response.url || u.toString(),
      finalUrl: response.finalUrl || u.toString(),
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - started,
      bytes: response.bodySize || 0,
      truncated: Boolean(response.truncated),
      error: response.error || ''
    };
    networkLog.push(item);
    if (networkBytes > MAX_NETWORK_BYTES) throw new Error('network response budget exceeded.');
    return {
      url: response.finalUrl || u.toString(),
      status: response.status,
      ok: response.ok,
      headers: response.headers || {},
      contentType: response.contentType || '',
      data: response.text || '',
      truncated: Boolean(response.truncated),
      error: response.error || ''
    };
  }

  function makeAsyncBridgePromise(task) {
    const deferred = vm.newPromise();
    Promise.resolve().then(task).then(value => {
      if (sandboxDisposed || !vm || !runtime) return;
      const valueHandle = vm.newString(typeof value === 'string' ? value : JSON.stringify(value));
      deferred.resolve(valueHandle);
      deferred.settled.then(() => {
        try { if (!sandboxDisposed && runtime) runtime.executePendingJobs(); } catch (_) {}
      });
    }, error => {
      if (sandboxDisposed || !vm || !runtime) return;
      const errorHandle = vm.newError(String(error && error.message || error));
      deferred.reject(errorHandle);
      deferred.settled.then(() => {
        try { if (!sandboxDisposed && runtime) runtime.executePendingJobs(); } catch (_) {}
      });
    });
    return deferred.handle;
  }

  async function sendMail(payload) {
    if (Date.now() > deadline) throw new Error('execution timeout.');
    if (++emailSendCount > 1) throw new Error('maksimum satu email per eksekusi javascript.');
    const gmail = context.credentials && context.credentials.gmail;
    if (!gmail || !gmail.user || !gmail.appPassword) {
      throw new Error('Gmail belum terhubung. hubungkan Gmail dari dashboard Kernote terlebih dahulu.');
    }
    const message = payload && typeof payload === 'object' ? payload : {};
    const to = String(message.to || '').trim();
    const subject = String(message.subject || '').slice(0, 250);
    const text = String(message.text || '');
    const html = message.html == null ? undefined : String(message.html);
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('alamat penerima email tidak valid.');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024 || Buffer.byteLength(html || '', 'utf8') > 64 * 1024) {
      throw new Error('isi email maksimum 64 KB.');
    }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmail.user, pass: String(gmail.appPassword).replace(/\s/g, '') },
      connectionTimeout: Math.max(250, Math.min(15000, deadline - Date.now() - 250)),
      greetingTimeout: Math.max(250, Math.min(15000, deadline - Date.now() - 250)),
      socketTimeout: Math.max(250, Math.min(15000, deadline - Date.now() - 250))
    });
    try {
      const info = await transporter.sendMail({ from: gmail.user, to, subject, text, html });
      return { sent: true, messageId: info.messageId || null, to, subject };
    } finally {
      try { transporter.close(); } catch (_) {}
    }
  }

  function hostFunction(name, callback) {
    const fn = vm.newFunction(name, callback);
    vm.setProp(vm.global, name, fn);
    fn.dispose();
  }

  function resultEnvelope(value, moduleName) {
    return JSON.stringify({ ok: true, value: encodeHost(value, 0, new WeakSet(), moduleName || '') });
  }

  function registerBridge() {
    hostFunction('__kModuleGet', (nameHandle, idHandle, keyHandle) => {
      try {
        return bridgeGet(vm.getString(nameHandle), vm.getNumber(idHandle), vm.getString(keyHandle));
      } catch (error) {
        return vm.newString(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
      }
    });
    hostFunction('__kModuleCall', (nameHandle, idHandle, methodHandle, argsHandle) => {
      try {
        return bridgeCall(vm.getString(nameHandle), vm.getNumber(idHandle), vm.getString(methodHandle), vm.getString(argsHandle));
      } catch (error) {
        return vm.newString(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
      }
    });
    hostFunction('__kNetwork', (payloadHandle) => {
      let payload;
      try { payload = JSON.parse(vm.getString(payloadHandle)); }
      catch (_) { return vm.newString(JSON.stringify({ ok: false, error: 'invalid network request payload' })); }
      return makeAsyncBridgePromise(async () => {
        try {
          const value = await makeNetworkResponse(payload);
          return JSON.stringify({ ok: true, value });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error && error.message || error) });
        }
      });
    });
    hostFunction('__kSendMail', (payloadHandle) => {
      let payload;
      try { payload = JSON.parse(vm.getString(payloadHandle)); }
      catch (_) { return vm.newString(JSON.stringify({ ok: false, error: 'invalid mail payload' })); }
      return makeAsyncBridgePromise(async () => {
        try {
          const value = await sendMail(payload);
          return JSON.stringify({ ok: true, value });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error && error.message || error) });
        }
      });
    });
  }

  try {
    const { getQuickJS } = require('quickjs-emscripten');
    const QuickJS = await getQuickJS();
    runtime = QuickJS.newRuntime({ memoryLimitBytes: MEMORY_LIMIT_BYTES, maxStackSizeBytes: STACK_LIMIT_BYTES });
    runtime.setInterruptHandler(() => Date.now() > deadline);
    vm = runtime.newContext();
    registerBridge();

    const bootstrap = `
      (function () {
        const __hostModuleGet = globalThis.__kModuleGet;
        const __hostModuleCall = globalThis.__kModuleCall;
        const __hostNetwork = globalThis.__kNetwork;
        const __hostSendMail = globalThis.__kSendMail;
        const __hostLog = globalThis.__kLog;
        delete globalThis.__kModuleGet;
        delete globalThis.__kModuleCall;
        delete globalThis.__kNetwork;
        delete globalThis.__kSendMail;
        delete globalThis.__kLog;
        const __forbidden = new Set(['__proto__','prototype','constructor','caller','callee','arguments','then','inspect','runInContext','mixin','noConflict','template']);
        function __decode(raw, moduleName) {
          let env;
          try { env = typeof raw === 'string' ? JSON.parse(raw) : raw; }
          catch (_) { throw new Error('module bridge returned invalid data'); }
          if (env && env.ok === false) throw new Error(env.error || 'module operation failed');
          return __revive(env && Object.prototype.hasOwnProperty.call(env, 'value') ? env.value : env, moduleName);
        }
        function __revive(value, moduleName) {
          if (value && typeof value === 'object') {
            if (value.__kref !== undefined) return __proxy(moduleName, value.__kref);
            if (value.__kfn && value.refId !== undefined) return __proxy(moduleName, value.refId);
            if (Array.isArray(value)) return value.map(v => __revive(v, moduleName));
            const out = {};
            for (const key of Object.keys(value)) out[key] = __revive(value[key], moduleName);
            return out;
          }
          return value;
        }
        function __args(args) {
          return JSON.stringify(args, function (_key, value) {
            if (value && typeof value === 'function' && value.__kernoteRef !== undefined) return { __kref: value.__kernoteRef };
            if (value && typeof value === 'object' && value.__kernoteRef !== undefined) return { __kref: value.__kernoteRef };
            return value;
          });
        }
        function __bridgeCall(name, id, method, args) {
          const raw = __hostModuleCall(name, id, method, __args(args));
          if (raw && typeof raw.then === 'function') return raw.then(v => __decode(v, name));
          return __decode(raw, name);
        }
        function __proxy(name, id) {
          const target = function () {};
          Object.defineProperty(target, '__kernoteRef', { value: id });
          return new Proxy(target, {
            get: function (_target, prop) {
              if (prop === '__kernoteRef') return id;
              if (prop === Symbol.toStringTag) return 'KernoteModuleProxy';
              if (prop === 'then' || typeof prop === 'symbol') return undefined;
              if (__forbidden.has(String(prop)) || String(prop).startsWith('__')) throw new Error('module property blocked: ' + String(prop));
              if (name === 'cheerio' && prop === 'each') {
                return function (callback) {
                  const items = __bridgeCall(name, id, 'toArray', []);
                  if (items && typeof items.then === 'function') throw new Error('async collection is not supported');
                  for (let i = 0; i < items.length; i++) callback.call(items[i], i, items[i]);
                  return __proxy(name, id);
                };
              }
              if (name === 'cheerio' && prop === 'map') {
                return function (callback) {
                  const items = __bridgeCall(name, id, 'toArray', []);
                  if (items && typeof items.then === 'function') throw new Error('async collection is not supported');
                  return items.map((item, index) => callback.call(item, index, item));
                };
              }
              const raw = __hostModuleGet(name, id, String(prop));
              return __decode(raw, name);
            },
            apply: function (_target, _thisArg, args) { return __bridgeCall(name, id, '$call', args); },
            construct: function (_target, args) { return __bridgeCall(name, id, '$construct', args); }
          });
        }
        function __pathGet(object, path, fallback) {
          if (path == null || path === '') return object;
          const parts = Array.isArray(path) ? path : String(path).replace(/\\[(?:"([^"]+)"|'([^']+)'|([^\\]]+))\\]/g, function (_m, a, b, c) { return '.' + (a || b || c); }).split('.').filter(Boolean);
          let value = object;
          for (const part of parts) { if (value == null || !Object.prototype.hasOwnProperty.call(Object(value), part)) return fallback; value = value[part]; }
          return value === undefined ? fallback : value;
        }
        function __entries(collection) {
          if (Array.isArray(collection) || typeof collection === 'string') return Array.from(collection).map((value, index) => [index, value]);
          if (collection && typeof collection === 'object') return Object.keys(collection).map(key => [key, collection[key]]);
          return [];
        }
        function __iteratee(spec) {
          if (typeof spec === 'function') return spec;
          if (Array.isArray(spec) && spec.length === 2) return function (value) { return __pathGet(value, spec[0]) === spec[1]; };
          if (spec && typeof spec === 'object') return function (value) { return Object.keys(spec).every(key => __pathGet(value, key) === spec[key]); };
          if (spec == null) return function (value) { return value; };
          return function (value) { return __pathGet(value, spec); };
        }
        const __lodashMethods = {
          get: (object, path, fallback) => __pathGet(object, path, fallback),
          has: (object, path) => __pathGet(object, path, __lodashMissing) !== __lodashMissing,
          set: (object, path, value) => { const parts = Array.isArray(path) ? path : String(path).split('.'); let node = object; for (let i=0;i<parts.length-1;i++) { if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {}; node = node[parts[i]]; } node[parts[parts.length-1]] = value; return object; },
          map: (collection, spec) => { const fn = __iteratee(spec); return __entries(collection).map(([key,value]) => fn(value,key,collection)); },
          filter: (collection, spec) => { const fn = __iteratee(spec); return __entries(collection).filter(([key,value]) => fn(value,key,collection)).map(([,value]) => value); },
          reject: (collection, spec) => { const fn = __iteratee(spec); return __entries(collection).filter(([key,value]) => !fn(value,key,collection)).map(([,value]) => value); },
          each: (collection, spec) => { const fn=__iteratee(spec); for (const [key,value] of __entries(collection)) if (fn(value,key,collection)===false) break; return collection; },
          forEach: (collection, spec) => __lodashMethods.each(collection,spec),
          find: (collection, spec) => { const fn=__iteratee(spec); for (const [key,value] of __entries(collection)) if (fn(value,key,collection)) return value; },
          findIndex: (collection, spec) => { const fn=__iteratee(spec); const entries=__entries(collection); for(let i=0;i<entries.length;i++) if(fn(entries[i][1],entries[i][0],collection)) return i; return -1; },
          some: (collection, spec) => { const fn=__iteratee(spec); return __entries(collection).some(([key,value]) => fn(value,key,collection)); },
          every: (collection, spec) => { const fn=__iteratee(spec); return __entries(collection).every(([key,value]) => fn(value,key,collection)); },
          partition: (collection, spec) => { const fn=__iteratee(spec); const yes=[],no=[]; for(const [key,value] of __entries(collection)) (fn(value,key,collection)?yes:no).push(value); return [yes,no]; },
          groupBy: (collection, spec) => { const fn=__iteratee(spec), out={}; for(const [key,value] of __entries(collection)) { const group=String(fn(value,key,collection)); (out[group]||(out[group]=[])).push(value); } return out; },
          keyBy: (collection, spec) => { const fn=__iteratee(spec), out={}; for(const [key,value] of __entries(collection)) out[String(fn(value,key,collection))]=value; return out; },
          countBy: (collection, spec) => { const fn=__iteratee(spec), out={}; for(const [key,value] of __entries(collection)) { const group=String(fn(value,key,collection)); out[group]=(out[group]||0)+1; } return out; },
          sortBy: (collection, spec) => { const specs=Array.isArray(spec)?spec:[spec]; return __entries(collection).map(([key,value],index)=>({key,value,index,sort:specs.map(item=>__iteratee(item)(value,key,collection))})).sort((a,b)=>{for(let i=0;i<a.sort.length;i++){const x=a.sort[i],y=b.sort[i]; if(x<y)return -1;if(x>y)return 1;}return a.index-b.index;}).map(item=>item.value); },
          orderBy: (collection, specs, orders) => { const paths=Array.isArray(specs)?specs:[specs], directions=Array.isArray(orders)?orders:[orders]; return __entries(collection).map(([key,value,index])=>({key,value,index,sort:paths.map(spec=>__iteratee(spec)(value,key,collection))})).sort((a,b)=>{for(let i=0;i<a.sort.length;i++){const x=a.sort[i],y=b.sort[i];if(x<y)return (directions[i]||directions[0])==='desc'?1:-1;if(x>y)return (directions[i]||directions[0])==='desc'?-1:1;}return a.index-b.index;}).map(item=>item.value); },
          uniq: collection => Array.from(new Set(Array.from(collection||[]))),
          uniqBy: (collection,spec) => { const fn=__iteratee(spec),seen=new Set(),out=[]; for(const [key,value] of __entries(collection)) { const id=fn(value,key,collection); if(!seen.has(id)){seen.add(id);out.push(value);} } return out; },
          compact: collection => Array.from(collection||[]).filter(Boolean),
          flatten: collection => Array.from(collection||[]).reduce((out,value)=>out.concat(Array.isArray(value)?value:[value]),[]),
          flattenDeep: collection => { const out=[]; const visit=arr=>arr.forEach(value=>Array.isArray(value)?visit(value):out.push(value)); visit(Array.from(collection||[])); return out; },
          chunk: (collection,size=1) => { const arr=Array.from(collection||[]),n=Math.max(1,Math.floor(Number(size)||1)),out=[]; for(let i=0;i<arr.length;i+=n)out.push(arr.slice(i,i+n));return out; },
          flatMap: (collection,spec) => { const fn=__iteratee(spec); return __entries(collection).flatMap(([key,value])=>{const result=fn(value,key,collection);return Array.isArray(result)?result:[result];}); },
          sumBy: (collection,spec) => { const fn=__iteratee(spec); return __entries(collection).reduce((sum,[key,value])=>sum+(Number(fn(value,key,collection))||0),0); },
          maxBy: (collection,spec) => { const fn=__iteratee(spec); return __entries(collection).reduce((best,[key,value])=>!best||fn(value,key,collection)>best.rank?{value,rank:fn(value,key,collection)}:best,null)?.value; },
          minBy: (collection,spec) => { const fn=__iteratee(spec); return __entries(collection).reduce((best,[key,value])=>!best||fn(value,key,collection)<best.rank?{value,rank:fn(value,key,collection)}:best,null)?.value; },
          mapValues: (object,spec) => { const fn=__iteratee(spec),out={}; for(const [key,value] of __entries(object))out[key]=fn(value,key,object);return out; },
          pickBy: (object,spec) => { const fn=__iteratee(spec||Boolean),out={};for(const [key,value] of __entries(object))if(fn(value,key,object))out[key]=value;return out; },
          omitBy: (object,spec) => { const fn=__iteratee(spec||Boolean),out={};for(const [key,value] of __entries(object))if(!fn(value,key,object))out[key]=value;return out; },
          includes: (collection,value) => typeof collection==='string'?collection.includes(value):Array.from(collection||[]).includes(value),
          times: (n,spec) => { const fn=__iteratee(spec); return Array.from({length:Math.min(10000,Math.max(0,Math.floor(Number(n)||0)))},(_,i)=>fn(i)); },
          range: (start,end,step) => { if(end===undefined){end=start;start=0;} const inc=Number(step)||(start<end?1:-1); const out=[]; for(let value=Number(start);inc>0?value<Number(end):value>Number(end);value+=inc){if(out.length>=10000)break;out.push(value);}return out; }
        };
        const __lodashMissing = {};
        const __rawLodash = __proxy('lodash',0);
        const __lodash = new Proxy(__rawLodash, { get: function (target, prop) { if (typeof prop==='string' && Object.prototype.hasOwnProperty.call(__lodashMethods,prop)) return __lodashMethods[prop]; return target[prop]; } });
        class __KernoteFormData {
          constructor(){this.__kernoteMultipart=true;this._boundary='----KernoteBoundary'+Math.random().toString(16).slice(2);this._fields=[];this._bytes=0;}
          append(name,value,options){if(this._fields.length>=32)throw new Error('FormData is limited to 32 fields');if(value&&typeof value==='object')throw new Error('FormData accepts text fields only in this sandbox');const field=String(name).replace(/[\\r\\n"]/g,'_');const text=value==null?'':String(value);this._bytes+=field.length+text.length;if(this._bytes>64*1024)throw new Error('FormData payload is limited to 64 KB');const opts=options&&typeof options==='object'?options:{};this._fields.push({name:field,value:text,filename:opts.filename?String(opts.filename).replace(/[\\r\\n"]/g,'_'):''});}
          getHeaders(){return {'content-type':'multipart/form-data; boundary='+this._boundary};}
          getLengthSync(){return this.toString().length;}
          toString(){return this._fields.map(field=>'--'+this._boundary+'\\r\\nContent-Disposition: form-data; name="'+field.name+'"'+(field.filename?'; filename="'+field.filename+'"':'')+'\\r\\n\\r\\n'+field.value+'\\r\\n').join('')+'--'+this._boundary+'--\\r\\n';}
        }
        function __pLimit(concurrency){const cap=Math.min(8,Math.max(1,Math.floor(Number(concurrency)||1)));let active=0;const queue=[];const next=()=>{active--;if(queue.length)queue.shift()();};return function(fn,...args){if(typeof fn!=='function')return Promise.reject(new TypeError('limit expects a function'));return new Promise((resolve,reject)=>{const run=()=>{active++;Promise.resolve().then(()=>fn(...args)).then(resolve,reject).finally(next);};if(active<cap)run();else queue.push(run);});};}
        function __pRetry(fn,options){if(typeof fn!=='function')return Promise.reject(new TypeError('p-retry expects a function'));const opts=options||{};const retries=Math.min(5,Math.max(0,Math.floor(Number(opts.retries==null?2:opts.retries))));let attempt=0;const run=()=>Promise.resolve().then(()=>fn({attemptNumber:attempt+1,retriesLeft:retries-attempt})).catch(error=>{attempt++;if(attempt>retries)throw error;if(typeof opts.shouldRetry==='function'&&!opts.shouldRetry({error,attemptNumber:attempt}))throw error;return run();});return run();}
        if (!__hostModuleGet || !__hostModuleCall || !__hostNetwork || !__hostSendMail || !__hostLog) throw new Error('sandbox bridge unavailable');
        function __require(name) {
          if (typeof name !== 'string') throw new TypeError('module name must be a string');
          if (name.startsWith('node:')) name = name.slice(5);
          if (name === 'axios') return axios;
          if (name === 'nodemailer') return nodemailer;
          if (name === 'form-data') return __KernoteFormData;
          if (name === 'lodash') return __lodash;
          if (name === 'p-limit') return __pLimit;
          if (name === 'p-retry') return __pRetry;
          const permitted = ${JSON.stringify(Array.from(EXTERNAL_MODULES).filter(x => !['axios', 'nodemailer'].includes(x)).concat(Array.from(BUILTIN_MODULES)))};
          if (!permitted.includes(name)) throw new Error('module blocked: ' + name);
          return __proxy(name, 0);
        }
        const __request = function (url, options) {
          const input = typeof url === 'string' ? { url: url } : (url || {});
          const init = options || {};
          const method = String(init.method || input.method || 'GET').toUpperCase();
          const headers = __headersToObject(init.headers || input.headers || {});
          let body = init.body;
          if (body && body.__kernoteMultipart === true && typeof body.getHeaders === 'function') { Object.assign(headers, body.getHeaders()); body = body.toString(); }
          else if (body && typeof body === 'object') {
            const rendered = typeof body.toString === 'function' ? body.toString() : '';
            if (rendered && rendered !== '[object Object]') body = rendered;
            else { body = JSON.stringify(body); if (!headers['content-type']) headers['content-type'] = 'application/json'; }
          }
          return __hostNetwork(JSON.stringify({ url: String(input.url || url), method, headers, body: body == null ? null : String(body), timeoutMs: init.timeoutMs || init.timeout || 8000, maxRedirects: init.maxRedirects } )).then(raw => {
            const response = __decode(raw, '');
            let parsed = response.data;
            if (/json/i.test(response.contentType || '')) { try { parsed = JSON.parse(response.data); } catch (_) {} }
            return {
              url: response.url, status: response.status, ok: response.ok, headers: response.headers,
              data: parsed, text: function () { return Promise.resolve(String(response.data)); },
              json: function () { try { return Promise.resolve(typeof parsed === 'string' ? JSON.parse(parsed) : parsed); } catch (e) { return Promise.reject(e); } },
              arrayBuffer: function () { throw new Error('binary response bodies are not available in this sandbox'); }
            };
          });
        };
        function __headersToObject(headers) {
          const out = {};
          if (headers && typeof headers.forEach === 'function') { headers.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); }); return out; }
          for (const key of Object.keys(headers || {})) out[key.toLowerCase()] = String(headers[key]);
          return out;
        }
        function __axiosRequest(config) {
          const cfg = config || {};
          let url = String(cfg.url || '');
          if (!url) return Promise.reject(new Error('axios: url required'));
          if (cfg.baseURL && !/^https?:\\/\\//i.test(url)) url = String(cfg.baseURL).replace(/\\/$/, '') + '/' + url.replace(/^\\//, '');
          if (cfg.params && typeof cfg.params === 'object') {
            const query = Object.keys(cfg.params).filter(k => cfg.params[k] != null).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(Array.isArray(cfg.params[k]) ? cfg.params[k].join(',') : String(cfg.params[k]))).join('&');
            if (query) url += (url.includes('?') ? '&' : '?') + query;
          }
          let data = cfg.data;
          const headers = __headersToObject(cfg.headers || {});
          if (data !== undefined && data !== null && typeof data === 'object') {
            if (data.__kernoteMultipart === true && typeof data.getHeaders === 'function') { Object.assign(headers, data.getHeaders()); data = data.toString(); }
            else {
              const rendered = typeof data.toString === 'function' ? data.toString() : '';
              if (rendered && rendered !== '[object Object]') data = rendered;
              else { data = JSON.stringify(data); if (!headers['content-type']) headers['content-type'] = 'application/json'; }
            }
          }
          return __hostNetwork(JSON.stringify({ url, method: String(cfg.method || 'GET').toUpperCase(), headers, body: data == null ? null : String(data), timeoutMs: cfg.timeout || 8000, maxRedirects: cfg.maxRedirects })).then(raw => {
            const response = __decode(raw, '');
            let parsed = response.data;
            if (/json/i.test(response.contentType || '') || (typeof parsed === 'string' && /^[\\s]*[\\[{]/.test(parsed))) { try { parsed = JSON.parse(parsed); } catch (_) {} }
            const result = { data: parsed, status: response.status, statusText: '', headers: response.headers, config: cfg, request: null };
            const valid = typeof cfg.validateStatus === 'function' ? cfg.validateStatus(response.status) : (response.status >= 200 && response.status < 300);
            if (!valid) { const error = new Error('Request failed with status code ' + response.status); error.response = result; error.status = response.status; throw error; }
            return result;
          });
        }
        const axios = function (config) { return __axiosRequest(config); };
        axios.request = __axiosRequest;
        for (const method of ['get','delete','head','options']) axios[method] = function (url, config) { return __axiosRequest(Object.assign({}, config || {}, { url, method })); };
        for (const method of ['post','put','patch']) axios[method] = function (url, data, config) { return __axiosRequest(Object.assign({}, config || {}, { url, data, method })); };
        axios.create = function (defaults) {
          const base = Object.assign({}, defaults || {});
          const instance = function (config) { return __axiosRequest(Object.assign({}, base, config || {})); };
          instance.request = instance;
          for (const method of ['get','delete','head','options']) instance[method] = function (url, config) { return __axiosRequest(Object.assign({}, base, config || {}, { url, method })); };
          for (const method of ['post','put','patch']) instance[method] = function (url, data, config) { return __axiosRequest(Object.assign({}, base, config || {}, { url, data, method })); };
          return instance;
        };
        axios.all = function (items) { return Promise.all(items); };
        axios.spread = function (callback) { return function (items) { return callback.apply(null, items); }; };
        axios.isAxiosError = function (error) { return Boolean(error && error.response && error.status); };
        const nodemailer = {
          createTransport: function () {
            return { sendMail: function (message) {
              return __hostSendMail(JSON.stringify({ to: message && message.to, subject: message && message.subject, text: message && message.text, html: message && message.html })).then(raw => __decode(raw, ''));
            } };
          }
        };
        globalThis.require = __require;
        globalThis.fetch = __request;
        globalThis.URL = __require('url').URL;
        globalThis.URLSearchParams = __require('url').URLSearchParams;
        globalThis.console = {
          log: function () { __hostLog('stdout', Array.prototype.slice.call(arguments)); },
          info: function () { __hostLog('stdout', Array.prototype.slice.call(arguments)); },
          debug: function () { __hostLog('stdout', Array.prototype.slice.call(arguments)); },
          warn: function () { __hostLog('stderr', Array.prototype.slice.call(arguments)); },
          error: function () { __hostLog('stderr', Array.prototype.slice.call(arguments)); },
          dir: function () { __hostLog('stdout', Array.prototype.slice.call(arguments)); }
        };
      })();
    `;

    hostFunction('__kLog', (typeHandle, argsHandle) => {
      const type = vm.getString(typeHandle);
      const values = vm.dump(argsHandle);
      const target = type === 'stderr' ? stderr : stdout;
      writeLog(target, Array.isArray(values) ? values : [values]);
      return vm.undefined;
    });

    const setup = vm.evalCode(bootstrap, 'kernote-sandbox-bootstrap.js');
    if (setup.error) {
      const message = vm.dump(setup.error);
      setup.error.dispose();
      throw new Error(message && message.message || safeJson(message));
    }
    setup.value.dispose();

    // Measure the guest-code budget only after QuickJS/WASM and the trusted bridge are ready.
    // Their cold-start cost previously consumed the same 6.5-7s budget and caused false timeouts.
    startedAt = Date.now();
    deadline = startedAt + timeoutMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);

    const wrappedCode = `(async function __kernote_main__(){\n${code}\n})()`;
    let evalResult;
    try {
      evalResult = vm.evalCode(wrappedCode, 'user-code.js');
      if (evalResult.error) {
        const thrown = vm.dump(evalResult.error);
        evalResult.error.dispose();
        throw new Error(thrown && thrown.message || safeJson(thrown));
      }
      const promiseHandle = evalResult.value;
      const remaining = Math.max(1, deadline - Date.now());
      let timeoutHandle;
      let resolved;
      try {
        resolved = await Promise.race([
          vm.resolvePromise(promiseHandle),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
              const err = new Error(`execution timed out after ${timeoutMs} ms`);
              err.code = 'KERNOTE_JS_TIMEOUT';
              reject(err);
            }, remaining);
          })
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      promiseHandle.dispose();
      const guestResult = vm.unwrapResult(resolved);
      let result;
      try { result = vm.dump(guestResult); } finally { guestResult.dispose(); resolved.dispose(); }
      const resultJson = safeJson(result);
      if (Buffer.byteLength(resultJson, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error(`result too large; maximum serialized result is ${MAX_RESULT_BYTES} bytes.`);
      }
      return {
        success: true,
        stdout: stdout.join('\n').slice(0, MAX_LOG_BYTES),
        stderr: stderr.join('\n').slice(0, MAX_LOG_BYTES),
        result: toPlain(result),
        error: null,
        timedOut: false,
        durationMs: Date.now() - requestStartedAt,
        executionDurationMs: Date.now() - startedAt,
        startupMs: Math.max(0, startedAt - requestStartedAt),
        networkRequests: networkLog,
        limits: { timeoutMs, maxCodeBytes: MAX_CODE_BYTES, memoryLimitBytes: MEMORY_LIMIT_BYTES, maxNetworkCalls: MAX_NETWORK_CALLS, maxNetworkBytes: MAX_NETWORK_BYTES }
      };
    } catch (error) {
      timedOut = error && error.code === 'KERNOTE_JS_TIMEOUT' || Date.now() >= deadline;
      const message = String(error && error.message || error);
      if (timedOut) writeLog(stderr, [`execution timed out after ${timeoutMs} ms`]);
      else writeLog(stderr, [message]);
      return {
        success: false,
        stdout: stdout.join('\n').slice(0, MAX_LOG_BYTES),
        stderr: stderr.join('\n').slice(0, MAX_LOG_BYTES),
        result: null,
        error: timedOut ? `execution timed out after ${timeoutMs} ms` : message,
        timedOut,
        durationMs: Date.now() - requestStartedAt,
        executionDurationMs: Date.now() - startedAt,
        startupMs: Math.max(0, startedAt - requestStartedAt),
        networkRequests: networkLog,
        limits: { timeoutMs, maxCodeBytes: MAX_CODE_BYTES, memoryLimitBytes: MEMORY_LIMIT_BYTES, maxNetworkCalls: MAX_NETWORK_CALLS, maxNetworkBytes: MAX_NETWORK_BYTES }
      };
    } finally {
      try { if (evalResult && evalResult.value && evalResult.value.alive) evalResult.value.dispose(); } catch (_) {}
    }
  } catch (error) {
    const message = String(error && error.message || error);
    return {
      success: false,
      stdout: stdout.join('\n').slice(0, MAX_LOG_BYTES),
      stderr: [...stderr, message].join('\n').slice(0, MAX_LOG_BYTES),
      result: null,
      error: message,
      timedOut: timedOut || Date.now() >= deadline,
      durationMs: Date.now() - requestStartedAt,
      executionDurationMs: Math.max(0, Date.now() - startedAt),
      startupMs: Math.max(0, startedAt - requestStartedAt),
      networkRequests: networkLog,
      limits: { timeoutMs, maxCodeBytes: MAX_CODE_BYTES, memoryLimitBytes: MEMORY_LIMIT_BYTES, maxNetworkCalls: MAX_NETWORK_CALLS, maxNetworkBytes: MAX_NETWORK_BYTES }
    };
  } finally {
    sandboxDisposed = true;
    try { if (vm) vm.dispose(); } catch (_) {}
    try { if (runtime) runtime.dispose(); } catch (_) {}
    objectRefs.clear();
    moduleCache.clear();
  }
}

function normalizeHeaders(input) {
  const output = {};
  if (!input || typeof input !== 'object') return output;
  for (const [key, value] of Object.entries(input).slice(0, 80)) {
    if (value == null || /^(host|content-length|connection|proxy-authorization)$/i.test(key)) continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    if (text.length > 4096) continue;
    output[key] = text;
  }
  return output;
}

module.exports = { executeJavaScript };
