const { startAuthorization } = require('../lib/oauth');
module.exports = async function handler(req, res) { await startAuthorization(req, res); };
