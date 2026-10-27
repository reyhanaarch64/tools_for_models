const { finding } = require('./models');

function add(ctx, name, kind, evidence, confidence = 'medium', version = '') {
  if (!name) return;
  const key = `${name.toLowerCase()}|${kind.toLowerCase()}`;
  if (ctx.result.technologies.some(x => `${x.name.toLowerCase()}|${x.kind.toLowerCase()}` === key)) return;
  ctx.result.technologies.push({ name, kind, evidence: ctx.truncate(evidence), confidence, version });
}

async function run(ctx) {
  ctx.event('fingerprint', 'identifying technologies');
  const r = ctx.primaryResponse;
  const headers = Object.fromEntries(Object.entries(r.headers).map(([k,v]) => [k.toLowerCase(), v]));
  const html = (r.text || '').slice(0, 500000).toLowerCase();
  if (headers.server) add(ctx, headers.server.split('/')[0], 'web server', `server header: ${headers.server}`, 'high');
  if (headers['x-powered-by']) add(ctx, headers['x-powered-by'].split('/')[0].trim(), 'runtime', `x-powered-by: ${headers['x-powered-by']}`, 'high');
  const markers = [
    ['next.js','framework',['__next_data__','/_next/']], ['react','frontend',['data-reactroot','react-dom','react.production.min.js']],
    ['vue.js','frontend',['data-v-','vue.runtime','vue.js']], ['angular','frontend',['ng-version','angular.min.js']],
    ['jquery','javascript library',['jquery.min.js','jquery.js']], ['bootstrap','css framework',['bootstrap.min.css','bootstrap.js']],
    ['wordpress','cms',['wp-content','wp-includes','wordpress']], ['drupal','cms',['drupalsettings','/sites/default/']], ['laravel','framework',['laravel_session']]
  ];
  for (const [name, kind, patterns] of markers) {
    const marker = patterns.find(x => html.includes(x.toLowerCase()) || Object.entries(headers).some(([k,v]) => `${k}:${v}`.toLowerCase().includes(x.toLowerCase())));
    if (marker) add(ctx, name, kind, `matched marker: ${marker}`, 'medium');
  }
  const rawHeaders = Object.entries(headers).map(([k,v]) => `${k}:${v}`).join(' ').toLowerCase();
  for (const [name, patterns] of [['cloudflare',['cf-ray','cf-cache-status','server: cloudflare']],['akamai',['akamai','x-akamai']],['fastly',['fastly','x-served-by','x-cache-hits']]]) {
    if (patterns.some(x => rawHeaders.includes(x))) add(ctx, name, 'cdn', 'header indicator', 'medium');
  }
  if (['cf-ray','cf-mitigated','x-sucuri-id','x-akamai-transformed'].some(x => rawHeaders.includes(x))) add(ctx, 'waf indicator', 'waf', 'security gateway header detected', 'low');
  const generator = r.text.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i);
  if (generator) add(ctx, generator[1], 'generator', 'meta generator tag', 'high');
  ctx.event('fingerprint', 'fingerprint complete', { technologies: ctx.result.technologies.length });
}
module.exports = { run };
