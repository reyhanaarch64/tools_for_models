const { finding } = require('./models');

function parseSetCookies(headers) {
  const raw = [];
  if (Array.isArray(headers['set-cookie'])) raw.push(...headers['set-cookie']);
  else if (headers['set-cookie']) raw.push(...String(headers['set-cookie']).split(/,(?=[^;]+?=)/));
  return raw.map(line => {
    const first = line.split(';')[0] || '';
    const [name] = first.split('=', 1);
    const low = line.toLowerCase();
    return {
      name: String(name || '').trim(),
      secure: /(?:^|;)\s*secure(?:;|$)/i.test(line),
      httponly: /(?:^|;)\s*httponly(?:;|$)/i.test(line),
      samesite: ((line.match(/(?:^|;)\s*samesite\s*=\s*([^;]+)/i) || [,''])[1] || '').trim(),
      path: ((line.match(/(?:^|;)\s*path\s*=\s*([^;]+)/i) || [,''])[1] || '').trim(),
      domain: ((line.match(/(?:^|;)\s*domain\s*=\s*([^;]+)/i) || [,''])[1] || '').trim()
    };
  }).filter(x => x.name);
}

async function run(ctx) {
  ctx.event('security', 'checking headers and cookies');
  const r = ctx.primaryResponse;
  const h = Object.fromEntries(Object.entries(r.headers).map(([k,v]) => [k.toLowerCase(), v]));
  const checks = [
    ['strict-transport-security','medium','HSTS is missing','enable HSTS on HTTPS responses after confirming all relevant subdomains support HTTPS.'],
    ['content-security-policy','medium','Content-Security-Policy is missing','define a suitable CSP for scripts, styles, frames, and other resource types.'],
    ['x-content-type-options','low','X-Content-Type-Options is missing','send X-Content-Type-Options: nosniff.'],
    ['x-frame-options','medium','clickjacking protection header is missing','send an appropriate X-Frame-Options value and/or frame-ancestors CSP directive.'],
    ['referrer-policy','low','Referrer-Policy is missing','set an explicit referrer policy appropriate for the application.'],
    ['permissions-policy','low','Permissions-Policy is missing','set Permissions-Policy for browser capabilities your application does not need.']
  ];
  for (const [header, severity, title, recommendation] of checks) if (!h[header]) {
    ctx.finding(finding(`missing-${header.replaceAll('-', '_')}`, title, { severity, category: 'headers', target: r.finalUrl, confidence: 'high', description: 'the response did not include the expected security header.', recommendation, evidence: { header, status: r.status } }));
  }
  const cors = h['access-control-allow-origin'] || '';
  const allowCredentials = (h['access-control-allow-credentials'] || '').toLowerCase();
  if (cors === '*') ctx.finding(finding('cors-wildcard', 'CORS allows any origin', { severity: 'medium', category: 'cors', target: r.finalUrl, description: 'the response allows cross-origin reads from any origin.', impact: 'this can be unsafe when sensitive resources are intended to be read only by trusted origins.', recommendation: 'restrict allowed origins to the origins actually required by the application.', evidence: {'access-control-allow-origin': cors, 'access-control-allow-credentials': allowCredentials} }));
  if (cors === '*' && allowCredentials === 'true') ctx.finding(finding('cors-wildcard-credentials', 'CORS has wildcard origin with credentials indicator', { severity: 'high', category: 'cors', target: r.finalUrl, description: 'the response combines wildcard origin behavior with an allow-credentials signal.', recommendation: 'use an explicit allowlist of trusted origins and review credentialed cross-origin access.', evidence: {'access-control-allow-origin': cors, 'access-control-allow-credentials': allowCredentials} }));
  const cookies = parseSetCookies(r.headers);
  for (const item of cookies) {
    if (r.finalUrl.toLowerCase().startsWith('https://') && !item.secure) ctx.finding(finding(`cookie-no-secure-${item.name}`, 'cookie is missing Secure', { severity: 'medium', category: 'cookies', target: r.finalUrl, description: 'a cookie was set over HTTPS without Secure.', recommendation: 'set Secure for cookies that should never be sent over cleartext HTTP.', evidence: item }));
    if (!item.httponly) ctx.finding(finding(`cookie-no-httponly-${item.name}`, 'cookie is missing HttpOnly', { severity: 'low', category: 'cookies', target: r.finalUrl, description: 'a cookie is readable by browser scripts.', recommendation: 'set HttpOnly for cookies that do not need client-side script access.', evidence: item }));
  }
  ctx.result.cookies = cookies;
  ctx.event('security', 'security checks complete', { findings: ctx.result.findings.length, cookies: cookies.length });
}
module.exports = { run };
