const crypto = require('node:crypto');
const { URL } = require('node:url');
const { sameOrigin, queryParams, replaceQueryParam, truncate } = require('../utils');
const { finding } = require('./models');
function reflectionContext(text, canary) {
  const idx = text.indexOf(canary); if (idx < 0) return null;
  const before = text.slice(Math.max(0,idx-50),idx).toLowerCase();
  let context = 'html-text';
  if (before.includes('<script') && !before.includes('</script>')) context = 'script';
  else if (before.slice(-30).includes('=') && !before.slice(-30).includes('<')) context = 'attribute-like';
  return { context, snippet: text.slice(Math.max(0,idx-120),Math.min(text.length,idx+canary.length+120)).replace(/\n/g,' ') };
}
async function run(ctx) {
  ctx.event('xss','checking reflected input with a benign canary');
  const seen = new Set(); const candidates = [];
  for (const item of ctx.result.discovered) {
    if (!sameOrigin(ctx.primaryResponse.finalUrl,item.url)) continue;
    for (const [key] of queryParams(item.url)) {
      const base = item.url.split('?')[0]; const pair = `${base}|${key}`;
      if (!seen.has(pair)) { seen.add(pair); candidates.push([item.url,key]); }
      if (candidates.length >= ctx.config.maxXssCandidates) break;
    }
    if (candidates.length >= ctx.config.maxXssCandidates) break;
  }
  for (const [key] of queryParams(ctx.primaryResponse.finalUrl)) {
    const pair = `${ctx.primaryResponse.finalUrl.split('?')[0]}|${key}`;
    if (!seen.has(pair)) { seen.add(pair); candidates.push([ctx.primaryResponse.finalUrl,key]); }
    if (candidates.length >= ctx.config.maxXssCandidates) break;
  }
  for (const [original,key] of candidates.slice(0,ctx.config.maxXssCandidates)) {
    const canary = `websec-canary-${crypto.randomBytes(6).toString('hex')}`;
    const testUrl = replaceQueryParam(original,key,canary);
    const r = await ctx.request('GET',testUrl,{maxBytes:ctx.config.maxBodyBytes});
    if (r.status >= 400 || !r.text) continue;
    const found = reflectionContext(r.text,canary);
    if (found) ctx.finding(finding(`reflected-input-${key}`,'potential reflected input / XSS indicator',{severity:found.context==='script'||found.context==='attribute-like'?'medium':'low',confidence:'medium',category:'xss',target:testUrl,description:'a benign canary was reflected into the response. reflection alone does not prove exploitable XSS.',impact:'untrusted input reflected into an unsafe browser context can become cross-site scripting.',recommendation:'validate and contextually encode untrusted output, then manually verify the exact browser parsing context.',evidence:{parameter:key,canary,context:found.context,snippet:truncate(found.snippet,400),status:r.status}}));
  }
  ctx.event('xss','reflection analysis complete',{candidates:candidates.length,new_findings:ctx.result.findings.filter(f=>f.category==='xss').length});
}
module.exports = { run };
