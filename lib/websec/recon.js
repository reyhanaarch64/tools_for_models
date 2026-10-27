const dns = require('node:dns').promises;
const { URL } = require('node:url');
const { finding } = require('./models');
const { extractLinksAndForms, sameOrigin } = require('../utils');

async function run(ctx) {
  ctx.event('recon', 'requesting target');
  const response = await ctx.request('GET', ctx.target);
  ctx.primaryResponse = response;
  ctx.result.meta = {
    status: response.status,
    final_url: response.finalUrl,
    content_type: response.contentType,
    response_size: response.bodySize,
    duration_ms: response.durationMs,
    truncated: !!response.truncated,
    redirects: response.redirects
  };
  ctx.result.headers = response.headers;

  try {
    const hostname = new URL(response.finalUrl).hostname;
    const addresses = (await dns.lookup(hostname, { all: true })).map(x => x.address).sort();
    ctx.result.meta.dns_addresses = [...new Set(addresses)];
  } catch (error) {
    ctx.result.meta.dns_addresses = [];
    ctx.result.meta.dns_error = error.message;
  }

  if (response.status >= 500) {
    ctx.finding(finding('server-error', 'target returned a server error', {
      severity: 'low', category: 'recon', target: response.finalUrl,
      description: 'the initial request returned a 5xx response.',
      recommendation: 'review server-side logs and error handling if this is your application.',
      evidence: { status: response.status }
    }));
  }

  const [links, forms] = extractLinksAndForms(response.text, response.finalUrl);
  ctx.result.meta.html_links = links.length;
  ctx.result.meta.forms = forms;
  const seen = new Set();
  for (const item of links) {
    if (!sameOrigin(response.finalUrl, item.url) || seen.has(item.url)) continue;
    seen.add(item.url);
    if (ctx.result.discovered.length >= ctx.config.maxDiscoveredUrls) break;
    ctx.result.discovered.push({ url: item.url, source: 'html', tag: item.tag, attribute: item.attribute });
  }

  for (const endpoint of ['/robots.txt', '/sitemap.xml', '/.well-known/security.txt']) {
    if (ctx.result.discovered.length >= ctx.config.maxDiscoveredUrls) break;
    const u = new URL(endpoint, response.finalUrl).toString();
    const r = await ctx.request('GET', u, { maxBytes: 512 * 1024 });
    if (r.status > 0 && r.status < 400) {
      ctx.result.discovered.push({ url: u, source: endpoint.slice(1), status: r.status });
      ctx.extra[endpoint.slice(1)] = r.text;
    }
  }

  if (response.status === 200 && !response.error && response.bodySize === 0) {
    ctx.finding(finding('empty-body', 'empty successful response', {
      severity: 'info', category: 'recon', target: response.finalUrl,
      description: 'the server returned status 200 with an empty body.', evidence: { status: 200 }
    }));
  }
  ctx.event('recon', 'recon complete', { status: response.status, links: links.length });
}

module.exports = { run };
