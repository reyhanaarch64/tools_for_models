const { URL } = require('node:url');
const { request } = require('../http');
const { stripHtml, normalizeTarget, truncate } = require('../utils');

function q(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

async function getJson(url, options = {}) {
  const r = await request('GET', url, { ...options, maxBytes: options.maxBytes || 1024 * 1024, timeoutMs: options.timeoutMs || 8000, textOnly: true });
  let data = null;
  try { data = r.text ? JSON.parse(r.text) : null; } catch (_) {}
  return { response: r, data };
}

function parseRss(xml, limit = 20) {
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  for (const match of xml.matchAll(re)) {
    const block = match[0];
    const value = tag => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? stripHtml(m[1]).replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
    };
    items.push({
      title: value('title'), link: value('link'), pubDate: value('pubDate'),
      description: value('description'), source: value('source'),
    });
    if (items.length >= limit) break;
  }
  if (!items.length) {
    for (const match of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
      const block = match[0];
      const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      const link = (block.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] || (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1];
      const published = (block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1];
      const summary = (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1];
      items.push({ title: title ? stripHtml(title).trim() : null, link: link ? stripHtml(link).trim() : null, pubDate: published ? stripHtml(published).trim() : null, description: summary ? stripHtml(summary).trim() : null });
      if (items.length >= limit) break;
    }
  }
  return items;
}

async function rssFeed(args) {
  const r = await request('GET', normalizeTarget(args.url), { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1' }, maxBytes: 512 * 1024, timeoutMs: 9000, textOnly: true });
  return { status: r.status, ok: r.ok, url: r.finalUrl, title: (r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || null, items: parseRss(r.text, Math.min(Math.max(Number(args.limit || 20), 1), 50)), truncated: r.truncated, error: r.error || null };
}

async function newsSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required');
  const url = q('https://news.google.com/rss/search', { q: query, hl: args.language || 'id', gl: args.country || 'ID', ceid: `${args.country || 'ID'}:${args.language || 'id'}` });
  return { provider: 'Google News RSS', query, ...(await rssFeed({ url, limit: args.limit || 15 })) };
}

async function newsHeadlines(args) {
  const topic = String(args.topic || 'WORLD').toUpperCase();
  const supported = ['WORLD','NATION','BUSINESS','TECHNOLOGY','ENTERTAINMENT','SPORTS','SCIENCE','HEALTH'];
  if (!supported.includes(topic)) throw new Error(`topic must be one of ${supported.join(', ')}`);
  const url = q(`https://news.google.com/rss/headlines/section/topic/${topic}`, { hl: args.language || 'id', gl: args.country || 'ID', ceid: `${args.country || 'ID'}:${args.language || 'id'}` });
  return { provider: 'Google News RSS', topic, ...(await rssFeed({ url, limit: args.limit || 15 })) };
}

function firstObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (Array.isArray(value) && value[0]) return value[0];
  return null;
}

function normalizeBmkgGempa(data) {
  const gempa = firstObject(data?.Infogempa?.gempa) || firstObject(data?.gempa) || firstObject(data?.data);
  if (!gempa) return data;
  return {
    date: gempa.Tanggal || null,
    localTime: gempa.Jam || null,
    dateTime: gempa.DateTime || null,
    magnitude: gempa.Magnitude ? Number(gempa.Magnitude) : null,
    depth: gempa.Kedalaman || null,
    coordinates: gempa.point?.coordinates || null,
    latitude: gempa.Lintang || null,
    longitude: gempa.Bujur || null,
    region: gempa.Wilayah || null,
    potential: gempa.Potensi || null,
    felt: gempa.Dirasakan || null,
    shakemap: gempa.Shakemap ? `https://static.bmkg.go.id/${gempa.Shakemap}` : null,
  };
}

async function bmkgEarthquake(args) {
  const mode = args.mode || 'latest';
  const endpoints = {
    latest: 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json',
    significant: 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json',
    felt: 'https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json',
  };
  if (!endpoints[mode]) throw new Error('mode must be latest, significant, or felt');
  const { response, data } = await getJson(endpoints[mode], { maxBytes: 512 * 1024 });
  const raw = data?.Infogempa?.gempa;
  const earthquakes = Array.isArray(raw) ? raw.map(x => normalizeBmkgGempa({ gempa: x })) : [normalizeBmkgGempa(data)];
  return { source: 'BMKG', mode, status: response.status, earthquakes: earthquakes.filter(Boolean).slice(0, Math.min(Math.max(Number(args.limit || 15), 1), 30)), error: response.error || null };
}

async function bmkgWeather(args) {
  const adm4 = String(args.adm4 || '').trim();
  if (!/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/.test(adm4)) throw new Error('adm4 must use the BMKG administrative code format, e.g. 31.71.03.1001');
  const { response, data } = await getJson(q('https://api.bmkg.go.id/publik/prakiraan-cuaca', { adm4 }), { maxBytes: 1024 * 1024 });
  return { source: 'BMKG', status: response.status, data, error: response.error || null };
}

async function bmkgMarineMeta(args) {
  const file = String(args.file || 'area_province.json').replace(/^\/+/, '').replace(/[^a-zA-Z0-9._-]/g, '');
  const endpoint = `https://maritim.bmkg.go.id/marine2026-data/meta/${file}`;
  const { response, data } = await getJson(endpoint, { maxBytes: 2 * 1024 * 1024 });
  return { source: 'BMKG Maritime', status: response.status, data, error: response.error || null };
}

async function bmkgMarineForecast(args) {
  const kind = args.kind === 'pelabuhan' ? 'pelabuhan' : 'perairan';
  const code = String(args.code || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!code) throw new Error('code is required');
  const endpoint = `https://maritim.bmkg.go.id/marine2026-data/${kind}/${encodeURIComponent(code)}.json`;
  const { response, data } = await getJson(endpoint, { maxBytes: 2 * 1024 * 1024 });
  return { source: 'BMKG Maritime', status: response.status, kind, code, data, error: response.error || null };
}

async function cryptoPrice(args, services = {}) {
  const ids = String(args.ids || 'bitcoin').split(',').map(x => x.trim()).filter(Boolean).slice(0, 30).join(',');
  const vs = String(args.vsCurrency || 'usd').toLowerCase();
  const headers = { accept: 'application/json' };
  if (services.coinGecko) headers['x-cg-demo-api-key'] = services.coinGecko;
  const { response, data } = await getJson(q('https://api.coingecko.com/api/v3/simple/price', { ids, vs_currencies: vs, include_market_cap: args.includeMarketCap ? 'true' : undefined, include_24hr_change: args.include24hChange ? 'true' : undefined }), { headers, maxBytes: 256 * 1024 });
  return { status: response.status, ids: ids.split(','), currency: vs, data, error: response.error || null };
}

async function goldPrice(args) {
  const symbol = String(args.symbol || 'XAU').toUpperCase();
  const { response, data } = await getJson(`https://api.gold-api.com/price/${encodeURIComponent(symbol)}`, { maxBytes: 64 * 1024 });
  return { status: response.status, symbol, data, error: response.error || null };
}

async function stockPrice(args) {
  const symbol = String(args.symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('symbol is required');
  const endpoint = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=json`;
  const { response, data } = await getJson(endpoint, { maxBytes: 128 * 1024 });
  return { status: response.status, symbol, data, error: response.error || null, source: 'Stooq' };
}

async function wikipediaSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required');
  const { response, data } = await getJson(q('https://en.wikipedia.org/w/api.php', { action: 'query', list: 'search', srsearch: query, format: 'json', origin: '*', srlimit: Math.min(Math.max(Number(args.limit || 10), 1), 20) }), { maxBytes: 512 * 1024, headers: { 'user-agent': 'kernote-node-beta/3.0' } });
  return { status: response.status, query, results: data?.query?.search || [], error: response.error || null };
}

async function wikipediaSummary(args) {
  const title = String(args.title || '').trim();
  if (!title) throw new Error('title is required');
  const lang = String(args.lang || 'en').toLowerCase().replace(/[^a-z-]/g, '');
  const { response, data } = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { maxBytes: 256 * 1024, headers: { 'user-agent': 'kernote-node-beta/3.0' } });
  return { status: response.status, title, data, error: response.error || null };
}

async function countryInfo(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required');
  const endpoint = `https://restcountries.com/v3.1/${/^\d+$/.test(query) ? 'alpha' : 'name'}/${encodeURIComponent(query)}?fullText=false`;
  const { response, data } = await getJson(endpoint, { maxBytes: 512 * 1024 });
  return { status: response.status, query, countries: Array.isArray(data) ? data.slice(0, 10) : [], error: response.error || null };
}

async function publicIp() {
  const r = await request('GET', 'https://api.ipify.org?format=json', { maxBytes: 32 * 1024, timeoutMs: 5000, textOnly: true });
  let data = null; try { data = JSON.parse(r.text); } catch (_) { data = { ip: r.text.trim() }; }
  return { status: r.status, ...data };
}

async function urlDownload(args) {
  const url = normalizeTarget(args.url);
  const r = await request('GET', url, { maxBytes: Math.min(Number(args.maxBodyBytes || 1024 * 1024), 2 * 1024 * 1024), timeoutMs: 10000, textOnly: true, maxRedirects: 5 });
  return { status: r.status, ok: r.ok, finalUrl: r.finalUrl, contentType: r.contentType, bodySize: r.bodySize, skippedBody: r.skippedBody, text: r.skippedBody ? null : truncate(r.text, Number(args.maxTextChars || 100000)), truncated: r.truncated, error: r.error || null };
}

async function githubRaw(args, token) {
  const owner = String(args.owner || '').trim(), repo = String(args.repo || '').trim(), path = String(args.path || '').replace(/^\/+/, '');
  if (!owner || !repo || !path) throw new Error('owner, repo and path are required');
  const ref = args.ref ? `?${new URLSearchParams({ ref: String(args.ref) }).toString()}` : '';
  const headers = { accept: 'application/vnd.github.raw+json', 'user-agent': 'kernote-node-beta/3.0' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await request('GET', `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(args.ref || 'HEAD')}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers, maxBytes: 1024 * 1024, timeoutMs: 9000, textOnly: true });
  return { status: r.status, ok: r.ok, url: r.finalUrl, contentType: r.contentType, text: r.text, truncated: r.truncated, error: r.error || null, queryRef: ref || null };
}

async function githubReleases(args, token) {
  const owner = String(args.owner || '').trim(), repo = String(args.repo || '').trim();
  if (!owner || !repo) throw new Error('owner and repo are required');
  const headers = { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'kernote-node-beta/3.0' };
  if (token) headers.authorization = `Bearer ${token}`;
  const endpoint = q(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`, { per_page: Math.min(Math.max(Number(args.limit || 10), 1), 30) });
  const r = await request('GET', endpoint, { headers, maxBytes: 512 * 1024, timeoutMs: 9000, textOnly: true });
  let data; try { data = JSON.parse(r.text); } catch (_) { data = r.text; }
  return { status: r.status, ok: r.ok, releases: Array.isArray(data) ? data.map(x => ({ id:x.id, tag_name:x.tag_name, name:x.name, prerelease:x.prerelease, draft:x.draft, published_at:x.published_at, html_url:x.html_url, body:x.body ? truncate(x.body, 10000) : null })) : data, error:r.error||null };
}

async function npmDownloads(args) {
  const pkg = String(args.package || '').trim();
  if (!pkg) throw new Error('package is required');
  const period = String(args.period || 'last-week');
  const endpoint = `https://api.npmjs.org/downloads/point/${encodeURIComponent(period)}/${pkg}`;
  const { response, data } = await getJson(endpoint, { maxBytes: 128 * 1024 });
  return { status: response.status, package: pkg, period, data, error: response.error || null };
}

module.exports = {
  rssFeed, newsSearch, newsHeadlines, bmkgEarthquake, bmkgWeather, bmkgMarineMeta, bmkgMarineForecast,
  cryptoPrice, goldPrice, stockPrice, wikipediaSearch, wikipediaSummary, countryInfo, publicIp, urlDownload,
  githubRaw, githubReleases, npmDownloads,
};
