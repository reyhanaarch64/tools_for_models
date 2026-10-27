const { handleMcpHttp } = require('../lib/mcp');

module.exports = async function handler(req, res) {
  try {
    await handleMcpHttp(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: error && error.message ? error.message : 'internal error' }
    }));
  }
};
