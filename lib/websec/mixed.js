const { finding } = require('./models');
async function run(ctx) {
  ctx.event('mixed','checking mixed content');
  const r = ctx.primaryResponse;
  if (!r || !r.finalUrl.toLowerCase().startsWith('https://')) { ctx.result.modules_used.push('mixed'); return; }
  const found = [];
  for (const re of [/(?:src|href|action|data)\s*=\s*["'](http:\/\/[^"']+)["']/gi,/url\(\s*["']?(http:\/\/[^"')\s]+)/gi]) {
    for (const m of r.text.matchAll(re)) found.push(m[1]);
  }
  const unique = [...new Set(found)];
  if (unique.length) ctx.finding(finding('mixed-content','mixed content detected (http resources on https page)',{severity:'medium',confidence:'high',category:'frontend',target:r.finalUrl,description:'the HTTPS page contains resource references using HTTP.',impact:'can cause broken content or expose resource loading to interception.',recommendation:'use HTTPS or relative URLs for all resources.',evidence:{count:unique.length,examples:unique.slice(0,8)}}));
  ctx.result.frontend.mixed_content = unique.slice(0,20); ctx.result.modules_used.push('mixed');
  ctx.event('mixed','mixed content check complete',{count:unique.length});
}
module.exports = { run };
