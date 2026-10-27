const { authenticateFirebaseRequest } = require('../../lib/request-auth');
const { getStats, buildToolUsageSummary } = require('../../lib/user-store');
const { getToolDefinitions } = require('../../lib/tools');

module.exports = async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  try {
    const user = await authenticateFirebaseRequest(req);
    const stats = await getStats(user.uid);
    const toolCatalog = getToolDefinitions().map(tool => tool.name);
    const usageLimits = buildToolUsageSummary(stats, user.email, toolCatalog);
    res.end(JSON.stringify({ ...stats, toolCatalog, usageLimits }));
  } catch (error) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: error.message }));
  }
};
