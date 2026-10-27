const { request } = require('../http');
const { requestRecord, finding } = require('./models');
const { normalizeTarget, truncate } = require('../utils');

function createResult(target, rootMode = false) {
  return {
    scan_id: Math.random().toString(16).slice(2, 14),
    target: normalizeTarget(target),
    started_at: new Date().toISOString(),
    finished_at: '',
    status: 'running',
    error: '',
    root_mode: !!rootMode,
    meta: {},
    technologies: [],
    findings: [],
    requests: [],
    directories: [],
    discovered: [],
    cookies: [],
    tls: {},
    headers: {},
    frontend: {},
    methods: {},
    modules_used: [],
    events: []
  };
}

function createContext(result, options = {}) {
  const config = {
    timeoutMs: Math.min(Math.max(Number(options.timeoutMs || 8000), 250), 10000),
    maxBodyBytes: Math.min(Math.max(Number(options.maxBodyBytes || 2 * 1024 * 1024), 4096), 2 * 1024 * 1024),
    maxJsBytes: Math.min(Math.max(Number(options.maxJsBytes || 1024 * 1024), 4096), 1024 * 1024),
    maxDiscoveredUrls: Math.min(Math.max(Number(options.maxDiscoveredUrls || 60), 10), 120),
    maxDirectoryEntries: Math.min(Math.max(Number(options.maxDirectoryEntries || 30), 5), 60),
    maxXssCandidates: Math.min(Math.max(Number(options.maxXssCandidates || 8), 1), 12),
    rootMode: !!options.rootMode
  };

  const ctx = {
    result,
    config,
    target: result.target,
    primaryResponse: null,
    extra: {},
    event(stage, message, data = {}) {
      const item = { time: new Date().toISOString(), stage, message, data };
      if (ctx.result.events.length < 180) ctx.result.events.push(item);
    },
    finding(item) {
      if (!ctx.result.findings.some(f => f.id === item.id && f.target === item.target)) {
        ctx.result.findings.push(item);
        ctx.event('finding', item.title, { id: item.id, severity: item.severity, target: item.target });
      }
    },
    async request(method, url, options = {}) {
      const r = await request(method, url, {
        maxBytes: options.maxBytes || config.maxBodyBytes,
        timeoutMs: options.timeoutMs || config.timeoutMs,
        headers: options.headers,
        body: options.body,
        skipBody: options.skipBody,
        textOnly: true,
        maxRedirects: 5
      });
      ctx.result.requests.push(requestRecord(method, url, r));
      return r;
    },
    truncate
  };
  return ctx;
}

module.exports = { createResult, createContext };
