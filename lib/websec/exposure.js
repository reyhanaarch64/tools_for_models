const { URL } = require('node:url');
const { finding } = require('./models');
const { sameOrigin, extractLinksAndForms } = require('../utils');
const INTERESTING_FILES = ['.zip','.tar','.gz','.bak','.old','.sql','.env','.log','.conf','.config','.map'];
function isListing(text) { const low=String(text||'').toLowerCase(); return ['index of /','directory listing for','<title>index of'].some(x=>low.includes(x)); }
async function run(ctx) {
  ctx.event('exposure','checking public resources and directory listings');
  async function inspectListing(listingUrl,response) {
    const entries=[]; const [urls]=extractLinksAndForms(response.text,response.finalUrl);
    for (const link of urls.slice(0,ctx.config.maxDirectoryEntries)) {
      if (!sameOrigin(ctx.primaryResponse.finalUrl,link.url)) continue;
      const child=await ctx.request('GET',link.url,{maxBytes:256*1024});
      entries.push({url:link.url,label:link.value,status:child.status,content_type:child.contentType,size:child.bodySize});
    }
    ctx.result.directories.push({url:listingUrl,status:response.status,entries});
    ctx.finding(finding(`directory-listing-${ctx.result.directories.length}`,'directory listing exposed',{severity:'high',category:'exposure',target:listingUrl,description:'the server returned a recognizable directory index.',impact:'directory contents can be enumerated by unauthorized visitors.',recommendation:'disable directory indexing or protect the directory with appropriate access controls.',evidence:{url:listingUrl,entries:entries.slice(0,20)}}));
    for (const entry of entries) {
      const name=String(entry.label||'').split('?')[0].toLowerCase();
      if (INTERESTING_FILES.some(ext=>name.endsWith(ext))) ctx.finding(finding(`exposed-file-${ctx.result.findings.length}`,'potentially sensitive file exposed through directory listing',{severity:'high',confidence:'medium',category:'exposure',target:entry.url,description:'a file with a potentially sensitive extension was visible in a public directory listing.',recommendation:'remove unnecessary sensitive files from web-accessible directories or restrict access.',evidence:{directory:listingUrl,entry}}));
    }
  }
  if (ctx.primaryResponse.status===200 && isListing(ctx.primaryResponse.text)) await inspectListing(ctx.primaryResponse.finalUrl,ctx.primaryResponse);
  const candidates=[];
  for (const item of ctx.result.discovered) if (item.url) candidates.push(item.url);
  if (ctx.extra['robots.txt']) for (const line of ctx.extra['robots.txt'].split(/\r?\n/)) { const m=line.match(/^\s*(?:allow|disallow|sitemap)\s*:\s*(\S+)/i); if (m && m[1].startsWith('/')) candidates.push(new URL(m[1],ctx.primaryResponse.finalUrl).toString()); }
  if (ctx.extra['sitemap.xml']) for (const m of ctx.extra['sitemap.xml'].matchAll(/<loc>([^<]+)<\/loc>/gi)) candidates.push(m[1].trim());
  const seen=new Set();
  for (const url of candidates) {
    if (seen.has(url)||seen.size>=ctx.config.maxDiscoveredUrls||!sameOrigin(ctx.primaryResponse.finalUrl,url)) continue;
    seen.add(url); const r=await ctx.request('GET',url,{maxBytes:512*1024});
    if (r.status===200 && isListing(r.text)) await inspectListing(url,r);
  }
  for (const item of ctx.result.discovered.slice(0,ctx.config.maxDiscoveredUrls)) {
    const low=String(item.url||'').toLowerCase().split('?')[0];
    if (INTERESTING_FILES.some(x=>low.endsWith(x))) ctx.finding(finding(`disclosed-sensitive-file-${ctx.result.findings.length}`,'potentially sensitive file publicly linked',{severity:'medium',confidence:'medium',category:'exposure',target:item.url,description:'a resource with a potentially sensitive file extension was disclosed in discovered content.',recommendation:'verify that the file is intentionally public and contains no secrets or internal configuration.',evidence:{source:item}}));
  }
  ctx.event('exposure','exposure checks complete',{directories:ctx.result.directories.length});
}
module.exports={run};
