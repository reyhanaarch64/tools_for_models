const { finding } = require('./models');
async function run(ctx) {
  ctx.event('csp', 'analyzing content-security-policy');
  const r = ctx.primaryResponse;
  if (!r) return;
  const h = Object.fromEntries(Object.entries(r.headers).map(([k,v]) => [k.toLowerCase(), v]));
  const csp = h['content-security-policy'] || h['content-security-policy-report-only'] || '';
  if (!csp) { ctx.result.modules_used.push('csp'); return; }
  const issues = [];
  if (/unsafe-inline/i.test(csp)) issues.push(['unsafe-inline','medium',"CSP contains 'unsafe-inline'"]);
  if (/unsafe-eval/i.test(csp)) issues.push(['unsafe-eval','medium',"CSP contains 'unsafe-eval'"]);
  if (/(?:default-src|script-src|style-src)\s+[^;]*\*/i.test(csp)) issues.push(['wildcard-source','medium','CSP allows wildcard (*) in a critical directive']);
  if (/script-src[^;]*(?:data:|blob:)/i.test(csp)) issues.push(['data-blob-script','low','CSP allows data: or blob: in script-src']);
  if (!/object-src/i.test(csp) && !/default-src/i.test(csp)) issues.push(['missing-object-src','low','CSP missing object-src (and no default-src)']);
  if (!/base-uri/i.test(csp)) issues.push(['missing-base-uri','low','CSP missing base-uri directive']);
  if (!/form-action/i.test(csp)) issues.push(['missing-form-action','info','CSP missing form-action directive']);
  for (const [id,severity,title] of issues) ctx.finding(finding(`csp-${id}`, title, { severity, category: 'headers', target: r.finalUrl, confidence: 'high', description: 'Content-Security-Policy analysis found a configuration that weakens browser protection.', recommendation: 'tighten CSP: avoid unsafe-inline/unsafe-eval, restrict sources, and complete important directives.', evidence: { csp_snippet: csp.slice(0,400) } }));
  ctx.result.meta.csp = csp.slice(0,800);
  ctx.result.modules_used.push('csp');
  ctx.event('csp', 'csp analysis complete', { issues: issues.length });
}
module.exports = { run };
