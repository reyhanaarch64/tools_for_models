const { authorizeComplete } = require('../lib/oauth');
module.exports = async function handler(req, res) { await authorizeComplete(req, res); };
