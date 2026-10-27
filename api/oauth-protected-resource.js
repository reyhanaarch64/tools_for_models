const { getBaseUrl } = require('../lib/oauth');

module.exports = async function handler(req, res) {
  const base = getBaseUrl(req);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.statusCode = 200;
  res.end(JSON.stringify({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  }));
};
