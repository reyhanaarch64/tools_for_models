const { createResult, createContext } = require('./context');
const { SEVERITY_ORDER, normalizeTarget } = require('../utils');
const recon = require('./recon'); const fingerprint=require('./fingerprint'); const security=require('./security'); const csp=require('./csp'); const methods=require('./methods'); const exposure=require('./exposure'); const sensitive=require('./sensitive'); const frontend=require('./frontend'); const mixed=require('./mixed'); const xss=require('./xss'); const tls=require('./tls');

const MODULES = {
  recon, fingerprint, security, csp, methods, exposure, sensitive, frontend, mixed, xss, tls
};

async function runScan(target, options={}) {
  const normalized=normalizeTarget(target);
  const result=createResult(normalized,!!options.rootMode);
  const ctx=createContext(result,options);
  const only=options.only || null;
  try {
    ctx.event('scan','scan started',{target:normalized,root_mode:!!options.rootMode});
    const selected = only ? [String(only)] : (Array.isArray(options.modules) && options.modules.length ? options.modules : ['recon','fingerprint','security','csp','methods','exposure','sensitive','frontend','mixed','xss','tls']);
    const safeSelected=[];
    for (const name of selected) if (MODULES[name] && !safeSelected.includes(name)) safeSelected.push(name);
    if (!safeSelected.includes('recon')) safeSelected.unshift('recon');
    for (const name of safeSelected) {
      if (name === 'xss' || name === 'frontend' || name === 'security' || name === 'csp' || name === 'methods' || name === 'exposure' || name === 'sensitive' || name === 'fingerprint' || name === 'mixed' || name === 'tls') {
        if (!ctx.primaryResponse) await recon.run(ctx);
      }
      await MODULES[name].run(ctx);
      if (!result.modules_used.includes(name)) result.modules_used.push(name);
    }
    result.findings.sort((a,b)=>(SEVERITY_ORDER[a.severity]??9)-(SEVERITY_ORDER[b.severity]??9) || a.title.localeCompare(b.title));
    result.status='complete'; result.finished_at=new Date().toISOString();
    ctx.event('scan','scan complete',{findings:result.findings.length,requests:result.requests.length});
  } catch (error) {
    result.status='error'; result.error=error.message; result.finished_at=new Date().toISOString(); ctx.event('scan','scan failed',{error:error.message});
  }
  delete result.events;
  return result;
}

module.exports={runScan,MODULES};
