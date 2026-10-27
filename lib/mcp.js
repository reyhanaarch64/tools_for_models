const { getToolDefinitions, callTool } = require('./tools');
const credentials = require('../credential');
const { getBaseUrl } = require('./oauth');
const { authenticateMcp } = require('./request-auth');
const { recordToolUsage, reserveToolUsage, TOOL_CALL_LIMIT } = require('./user-store');

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];

function json(res, status, payload, headers = {}) {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  }
  res.end(JSON.stringify(payload));
}

function errorResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function readBody(req, maxBytes = 2 * 1024 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function pickProtocolVersion(requested) {
  return typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : '2026-07-28';
}

function authRequired() {
  if (credentials.multiUser && credentials.multiUser.enabled === false) return false;
  return true;
}

async function getContext(req) {
  if (!authRequired()) return { mode: 'legacy', uid: null, credentials: {} };
  return authenticateMcp(req);
}

async function dispatch(message, context) {
  const method = message && message.method;
  const id = message && message.id;
  const params = message && message.params ? message.params : {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: pickProtocolVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Kernote-Node-beta', version: '3.0.0-beta.1' },
        instructions: 'Kernote-Node-beta multi-user MCP workspace with isolated JavaScript execution. Credential-backed tools use the authenticated account. Cloud notes are scoped to the authenticated user; notes_list exposes only public note metadata, notes_get returns original Markdown only for public notes, and private notes are inaccessible through MCP. Web security tools are for systems you own or are authorized to test.',
      },
    };
  }

  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0', id,
      result: {
        serverInfo: { name: 'Kernote-Node-beta', version: '3.0.0-beta.1' },
        capabilities: { tools: { listChanged: false } },
        protocolVersions: PROTOCOL_VERSIONS,
      },
    };
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: getToolDefinitions() } };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    if (!name) return errorResponse(id, -32602, 'missing tool name');
    if (!getToolDefinitions().some(tool => tool.name === name)) {
      return {
        jsonrpc: '2.0', id,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', message: `unknown tool: ${name}` }) }],
        },
      };
    }
    const started = Date.now();
    let success = false;
    let shouldRecordUsage = false;
    try {
      if (context.uid) {
        const reservation = await reserveToolUsage(context.uid, context.email, name);
        if (!reservation.allowed) {
          return {
            jsonrpc: '2.0', id,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({
                error: 'tool_usage_limit_reached',
                message: `batas penggunaan tool ${name} sudah tercapai (${TOOL_CALL_LIMIT}/${TOOL_CALL_LIMIT}).`,
                tool: name,
                limit: TOOL_CALL_LIMIT,
                used: reservation.count,
                remaining: 0,
              }) }],
            },
          };
        }
        shouldRecordUsage = true;
      }
      const result = await callTool(name, args, context);
      success = !result.isError;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return {
        jsonrpc: '2.0', id,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: true, message: error && error.message ? error.message : String(error) }) }],
        },
      };
    } finally {
      if (context.uid && shouldRecordUsage) {
        try { await recordToolUsage(context.uid, name, success, Date.now() - started); } catch (_) {}
      }
    }
  }

  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  return errorResponse(id, -32601, `method not found: ${method}`);
}

async function handleMcpHttp(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-session-id, mcp-protocol-version');
    return res.end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'MCP endpoint accepts POST requests only' });
  }

  const context = await getContext(req);
  if (!context) {
    const base = getBaseUrl(req);
    return json(res, 401, { error: 'unauthorized' }, {
      'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    });
  }

  const message = await readBody(req);
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return json(res, 400, errorResponse(message && message.id, -32600, 'invalid JSON-RPC request'));
  }

  const result = await dispatch(message, context);
  if (result === null) {
    res.statusCode = 202;
    res.setHeader('access-control-allow-origin', '*');
    return res.end();
  }

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('mcp-protocol-version', pickProtocolVersion(message.params && message.params.protocolVersion));
  return json(res, 200, result);
}

module.exports = { handleMcpHttp };
