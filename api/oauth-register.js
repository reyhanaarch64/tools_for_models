const { registerClient } = require('../lib/user-store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : await readJson(req);
    const clientId = await registerClient(body);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 201;
    res.end(JSON.stringify({
      client_id: clientId,
      client_name: body.client_name || 'MCP Client',
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types || ['authorization_code', 'refresh_token'],
      response_types: body.response_types || ['code'],
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
    }));
  } catch (error) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_client_metadata', error_description: error.message }));
  }
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
