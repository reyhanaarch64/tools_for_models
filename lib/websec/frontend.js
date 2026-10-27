const { URL } = require('node:url');
const { sameOrigin } = require('../utils');
const { finding } = require('./models');
async function run(ctx) {
  ctx.event('frontend','analyzing javascript and frontend resources');
  const html = ctx.primaryResponse.text || '';
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
  const assets = []; const sourceMaps = []; const endpoints = new Set();
  for (const src of scripts.slice(0,50)) {
    let url; try { url = new URL(src, ctx.primaryResponse.finalUrl).toString(); } catch (_) { continue; }
    if (!sameOrigin(ctx.primaryResponse.finalUrl, url)) continue;
    const r = await ctx.request('GET', url, { maxBytes: ctx.config.maxJsBytes });
    assets.push({url,status:r.status,size:r.bodySize,content_type:r.contentType});
    const match = r.text.match(/sourceMappingURL=([^\s*]+)/);
    if (match) { try { sourceMaps.push(new URL(match[1].trim(), url).toString()); } catch (_) {} }
    for (const m of r.text.matchAll(/["']((?:https?:\/\/|\/)[A-Za-z0-9_./?=&:%-]{3,})["']/g)) {
      try { const ep = new URL(m[1], url).toString(); if (sameOrigin(ctx.primaryResponse.finalUrl, ep)) endpoints.add(ep); } catch (_) {}
    }
  }
  if (sourceMaps.length) ctx.finding(finding('source-map-reference','javascript source map reference exposed',{severity:'low',category:'frontend',target:ctx.primaryResponse.finalUrl,description:'same-origin JavaScript files reference source maps.',recommendation:'ensure production source maps do not disclose sensitive source or secrets unless that exposure is intentional.',evidence:{source_maps:sourceMaps.slice(0,20)}}));
  ctx.result.frontend = { scripts: assets, source_maps: sourceMaps, endpoint_hints: [...endpoints].sort().slice(0,100) };
  ctx.event('frontend','frontend analysis complete',{scripts:assets.length,endpoint_hints:endpoints.size});
}
module.exports = { run };
