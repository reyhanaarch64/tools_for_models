const { URL } = require('node:url');
const { SENSITIVE_PATHS } = require('../utils');
const { finding } = require('./models');
async function run(ctx) {
  ctx.event('sensitive','checking common sensitive paths');
  const base=ctx.primaryResponse ? ctx.primaryResponse.finalUrl : ctx.target; const u=new URL(base); const origin=`${u.protocol}//${u.host}`;
  const paths=ctx.config.rootMode ? SENSITIVE_PATHS : SENSITIVE_PATHS.slice(0,18); const found=[];
  for (const path of paths) {
    const url=new URL(path,origin+'/').toString();
    try {
      let r=await ctx.request('HEAD',url,{maxBytes:0});
      if ([0,404,405].includes(r.status)) r=await ctx.request('GET',url,{maxBytes:2048});
      if ([200,301,302,403].includes(r.status)) {
        const high=['/.env','/.git/HEAD','/.git/config','/phpinfo.php','/server-status'].includes(path);
        const severity=r.status===403?'low':(high?'high':'medium');
        found.push({path,status:r.status,url:r.finalUrl});
        ctx.finding(finding(`sensitive-path-${path.replace(/^\//,'').replace(/[/.]/g,'-')}`,`sensitive path responds: ${path}`,{severity,confidence:'medium',category:'exposure',target:url,description:`sensitive path responded with status ${r.status}.`,recommendation:'block public access to sensitive files/paths, move them outside the web root, or protect them with authentication.',evidence:{path,status:r.status,content_type:r.contentType}}));
      }
    } catch (_) {}
  }
  ctx.result.discovered.push(...found.map(x=>({url:x.url,status:x.status,source:'sensitive'})));
  ctx.result.modules_used.push('sensitive');
  ctx.event('sensitive','sensitive path check complete',{interesting:found.length});
}
module.exports={run};
