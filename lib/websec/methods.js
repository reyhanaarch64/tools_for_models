const { finding } = require('./models');
async function run(ctx) {
  ctx.event('methods', 'checking http methods');
  const base = ctx.primaryResponse ? ctx.primaryResponse.finalUrl : ctx.target;
  const methods = ['OPTIONS','HEAD','GET'];
  if (ctx.config.rootMode) methods.push('PUT','DELETE','TRACE','CONNECT','PATCH');
  const results = {}; const dangerous = [];
  for (const method of methods) {
    const r = await ctx.request(method, base, { maxBytes: 1024 });
    results[method] = { status: r.status, error: r.error, duration_ms: r.durationMs };
    if (method === 'TRACE' && r.status >= 200 && r.status < 300) {
      dangerous.push(method);
      ctx.finding(finding('http-trace-enabled','HTTP TRACE method enabled',{severity:'medium',category:'methods',target:base,description:'server responds successfully to TRACE.',recommendation:'disable TRACE on the web server.',evidence:{status:r.status}}));
    }
    if ((method === 'PUT' || method === 'DELETE') && r.status > 0 && r.status < 400 && r.status !== 405) {
      dangerous.push(method);
      ctx.finding(finding(`http-method-${method.toLowerCase()}`,`HTTP ${method} method appears allowed`,{severity:'high',confidence:'medium',category:'methods',target:base,description:`server responds to ${method} with a non-error status. verify that this is intentionally exposed and protected.`,recommendation:'limit HTTP methods to those required and protect write/delete operations with strong authorization.',evidence:{status:r.status,method},requires_root:true}));
    }
  }
  if (results.OPTIONS && results.OPTIONS.status) {
    const r = await ctx.request('OPTIONS', base, { maxBytes: 512 });
    const allow = r.headers.allow || r.headers['access-control-allow-methods'] || '';
    if (allow) {
      results.Allow = allow;
      for (const m of ['TRACE','PUT','DELETE']) if (allow.toUpperCase().includes(m) && !dangerous.includes(m)) {
        ctx.finding(finding(`allow-header-${m.toLowerCase()}`,`Allow header exposes ${m}`,{severity:m === 'TRACE'?'medium':'high',category:'methods',target:base,description:`Allow/Access-Control-Allow-Methods mentions ${m}.`,recommendation:'review whether the method must be publicly allowed.',evidence:{allow},requires_root:ctx.config.rootMode}));
      }
    }
  }
  ctx.result.methods = results; ctx.result.modules_used.push('methods');
  ctx.event('methods', 'method check complete', { checked: Object.keys(results) });
}
module.exports = { run };
