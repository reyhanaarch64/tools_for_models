const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');
const { URL } = require('node:url');
const credentials = require('../../credential');
const { request } = require('../http');
const { stalkTikTok } = require('../tiktok');
const { runScan } = require('../websec/scanner');
const notes = require('../notes');
const { executeJavaScript } = require('./javascript-executor');
const { inspectTls } = require('../websec/tls');
const { normalizeTarget, stripHtml, extractLinksAndForms, assertAllowedTarget, truncate } = require('../utils');
const extra = require('./extra');
const { getStats, buildToolUsageSummary } = require('../user-store');

const GH_API = 'https://api.github.com';

function textResult(value, isError = false) {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

function schema(properties, required = [], additionalProperties = false) {
  return { type: 'object', properties, required, additionalProperties };
}
function s(description) { return { type: 'string', description }; }
function n(description) { return { type: 'number', description }; }
function b(description) { return { type: 'boolean', description }; }
function a(items, description) { return { type: 'array', items, description }; }

const definitions = [
  { name:'usage_read', description:"Read the authenticated account's MCP tool usage, including per-tool calls used, maximum allowed calls, remaining quota, successful calls, and last use. Every normal account is limited to 400 calls per tool; approved accounts are unlimited. Optionally pass an exact tool name to inspect one tool.", inputSchema:schema({ tool:s('Optional exact MCP tool name to inspect; omit to return all tools.') }) },
  { name:'javascript_execute', description:'Execute short JavaScript tasks in an isolated QuickJS runtime with memory and CPU interruption limits. Supports async/await, stdout/stderr capture, controlled axios/fetch HTTP(S), selected lightweight modules, and per-user Gmail sending through the connected Kernote account. No filesystem, subprocess, server sockets, or persistent background jobs. Network requests are filtered and capped; use only for tasks you are authorized to run.', inputSchema:schema({ code:s('JavaScript source. Runs inside an async function, so top-level await and return are supported. Maximum 32 KB.'), timeoutMs:n('Execution time limit in milliseconds, 500-30000; defaults to 20000. Runtime initialization is excluded from this limit.') },['code'])},
  { name:'http_request', description:'General HTTP client. Supports methods, headers, query parameters, JSON/text body, redirects, timeouts and text-only response handling.', inputSchema:schema({
    url:s('HTTP/HTTPS URL'), method:s('HTTP method, e.g. GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS'), headers:{type:'object',additionalProperties:{type:'string'}}, query:{type:'object',additionalProperties:{type:['string','number','boolean']}}, body:s('Raw request body string'), json:{type:['object','array','string','number','boolean','null']}, timeoutMs:n('Timeout, max 10000 ms'), maxBodyBytes:n('Maximum text response bytes, max 2097152'), maxRedirects:n('Maximum redirects, max 8'), textOnly:b('Skip binary/media response bodies; default true')
  },['url'])},
  { name:'send_email', description:"Send an email using the authenticated Kernote account's Gmail credentials. Configure the account connection from the Kernote dashboard.", inputSchema:schema({ to:s('Recipient email address'), subject:s('Email subject'), text:s('Plain-text email body'), html:s('Optional HTML email body') },['to','subject','text'])},
  { name:'stalk_tiktok', description:'Read public TikTok profile data from the profile page rehydration payload.', inputSchema:schema({ username:s('TikTok username, with or without @'), deep:b('Include deeper profile/page data') },['username'])},
  { name:'weather', description:'Current weather and forecast using Open-Meteo; no API key required.', inputSchema:schema({ location:s('City/place name; used when latitude/longitude are omitted'), latitude:n('Latitude'), longitude:n('Longitude'), hourly:a({type:'string'},'Optional Open-Meteo hourly fields'), days:n('Forecast days 1-16'), timezone:s('Timezone or auto') })},
  { name:'geocoding', description:'Convert a place name to coordinates using Open-Meteo geocoding.', inputSchema:schema({ query:s('Place name'), count:n('Maximum results, max 10'), language:s('Language code'), countryCode:s('Two-letter country code') },['query'])},
  { name:'timezone', description:'Resolve timezone/current time by timezone name or latitude/longitude using Node Intl and Open-Meteo.', inputSchema:schema({ timezone:s('IANA timezone, e.g. Asia/Jakarta'), latitude:n('Latitude'), longitude:n('Longitude'), locale:s('Locale for formatted output') })},
  { name:'dns_lookup', description:'Resolve common DNS record types using the Node DNS resolver.', inputSchema:schema({ hostname:s('Hostname'), type:s('A, AAAA, MX, TXT, CNAME, NS, SOA, SRV, CAA, PTR') },['hostname'])},
  { name:'whois', description:'Look up RDAP registration data for an IP or domain.', inputSchema:schema({ query:s('Domain or IP address') },['query'])},
  { name:'ip_info', description:'Get public IP/geolocation/ASN information from ipwho.is.', inputSchema:schema({ ip:s('IPv4/IPv6 address; omit to inspect the server egress IP') })},
  { name:'ssl_check', description:'Inspect the TLS certificate and negotiated TLS details for an HTTPS host.', inputSchema:schema({ url:s('HTTPS URL') },['url'])},
  { name:'url_inspector', description:'Inspect a URL with a text-only GET and summarize status, redirects, headers and HTML metadata.', inputSchema:schema({ url:s('HTTP/HTTPS URL'), timeoutMs:n('Timeout in milliseconds') },['url'])},
  { name:'http_headers', description:'Fetch a URL and return response headers without downloading binary/media bodies.', inputSchema:schema({ url:s('HTTP/HTTPS URL'), method:s('HEAD or GET'), timeoutMs:n('Timeout in milliseconds') },['url'])},
  { name:'github', description:"GitHub API utility using the authenticated Kernote account's GitHub token when configured. Supports repo info, user info, search and file retrieval.", inputSchema:schema({ action:s('repo, user, search, file'), owner:s('Repository owner'), repo:s('Repository name'), path:s('Repository file path'), ref:s('Git ref'), username:s('GitHub username'), query:s('Search query'), type:s('Search type: repositories, issues, code, users'), perPage:n('Results per page, max 30') },['action'])},
  { name:'npm', description:'Query the public npm registry for package metadata and versions.', inputSchema:schema({ package:s('npm package name'), version:s('Optional exact version or dist-tag') },['package'])},
  { name:'news_search', description:'Search current news through Google News RSS. Returns headlines, links, dates and source labels without requiring an API key.', inputSchema:schema({ query:s('News search query'), language:s('Language code, default id'), country:s('Country code, default ID'), limit:n('Maximum results, max 30') },['query'])},
  { name:'news_headlines', description:'Get topic headlines from Google News RSS.', inputSchema:schema({ topic:s('WORLD, NATION, BUSINESS, TECHNOLOGY, ENTERTAINMENT, SPORTS, SCIENCE or HEALTH'), language:s('Language code'), country:s('Country code'), limit:n('Maximum results, max 30') },['topic'])},
  { name:'rss_feed', description:'Fetch a public RSS or Atom feed and normalize entries to JSON.', inputSchema:schema({ url:s('RSS/Atom feed URL'), limit:n('Maximum entries, max 50') },['url'])},
  { name:'earthquake_bmkg', description:'Get Indonesian earthquake data from the official BMKG open earthquake feeds.', inputSchema:schema({ mode:s('latest, significant, or felt'), limit:n('Maximum results, max 30') })},
  { name:'bmkg_weather', description:'Get official BMKG village-level weather forecast by administrative code.', inputSchema:schema({ adm4:s('BMKG ADM4 code, e.g. 31.71.03.1001') },['adm4'])},
  { name:'bmkg_marine_meta', description:'Read BMKG maritime metadata files for public marine locations.', inputSchema:schema({ file:s('Metadata file name, e.g. area_province.json or pelabuhan.json') })},
  { name:'bmkg_marine_forecast', description:'Read an official BMKG maritime forecast for a port or water area code.', inputSchema:schema({ kind:s('perairan or pelabuhan'), code:s('BMKG maritime location code') },['code'])},
  { name:'crypto_price', description:'Get current cryptocurrency prices from CoinGecko. A personal CoinGecko key can be configured per account, but the tool can use the public endpoint when available.', inputSchema:schema({ ids:s('Comma-separated CoinGecko IDs, e.g. bitcoin,ethereum'), vsCurrency:s('Quote currency, e.g. usd,idr'), includeMarketCap:b('Include market cap'), include24hChange:b('Include 24h change') },['ids'])},
  { name:'gold_price', description:'Get current precious-metal asset prices from Gold API.', inputSchema:schema({ symbol:s('Asset symbol, default XAU') })},
  { name:'stock_price', description:'Get a lightweight public stock quote snapshot from Stooq.', inputSchema:schema({ symbol:s('Stooq symbol, e.g. AAPL.US') },['symbol'])},
  { name:'wikipedia_search', description:'Search Wikipedia through its public API.', inputSchema:schema({ query:s('Search query'), limit:n('Maximum results, max 20') },['query'])},
  { name:'wikipedia_summary', description:'Get a Wikipedia REST summary for a page title.', inputSchema:schema({ title:s('Wikipedia page title'), lang:s('Wikipedia language code, default en') },['title'])},
  { name:'country_info', description:'Look up public country information from REST Countries.', inputSchema:schema({ query:s('Country name or numeric ISO code') },['query'])},
  { name:'public_ip', description:'Return the server egress public IP address.', inputSchema:schema({})},
  { name:'url_download', description:'Download text-oriented content from a URL while skipping binary/media bodies and capping response size.', inputSchema:schema({ url:s('HTTP/HTTPS URL'), maxBodyBytes:n('Maximum body bytes'), maxTextChars:n('Maximum returned characters') },['url'])},
  { name:'github_raw', description:"Retrieve raw text from a GitHub repository path. Uses the authenticated account's GitHub token when configured.", inputSchema:schema({ owner:s('Repository owner'), repo:s('Repository name'), path:s('File path'), ref:s('Branch, tag or commit') },['owner','repo','path'])},
  { name:'github_releases', description:"List recent GitHub releases for a repository, using the authenticated account's GitHub token when configured.", inputSchema:schema({ owner:s('Repository owner'), repo:s('Repository name'), limit:n('Maximum releases, max 30') },['owner','repo'])},
  { name:'npm_downloads', description:'Get npm download counts for a package over a public reporting period.', inputSchema:schema({ package:s('npm package name'), period:s('NPM download period, e.g. last-week or last-month') },['package'])},
  { name:'currency', description:'Currency conversion using the public Frankfurter rates API.', inputSchema:schema({ from:s('Base currency code'), to:s('Target currency code'), amount:n('Amount to convert') },['from','to','amount'])},
  { name:'air_quality', description:'Current and forecast air quality using Open-Meteo Air Quality.', inputSchema:schema({ location:s('City/place name'), latitude:n('Latitude'), longitude:n('Longitude'), days:n('Forecast days') })},
  { name:'earthquake', description:'Query recent earthquakes from the USGS GeoJSON feed.', inputSchema:schema({ period:s('hour, day, week, or month'), minMagnitude:n('Minimum magnitude'), limit:n('Maximum results, max 50') })},
  { name:'public_holidays', description:'List public holidays from the Nager.Date API.', inputSchema:schema({ countryCode:s('Two-letter country code'), year:n('Year') },['countryCode','year'])},
  { name:'sunrise_sunset', description:'Get sunrise, sunset and civil/nautical/astronomical twilight times.', inputSchema:schema({ latitude:n('Latitude'), longitude:n('Longitude'), date:s('YYYY-MM-DD, or today') },['latitude','longitude'])},
  { name:'webpage_extract', description:'Fetch a webpage and extract title, metadata, links/forms and readable text without downloading media.', inputSchema:schema({ url:s('HTTP/HTTPS URL'), maxTextChars:n('Maximum extracted text characters') },['url'])},
  { name:'dns_propagation', description:'Compare public DNS answers from Google DNS and Cloudflare DNS over HTTPS.', inputSchema:schema({ hostname:s('Hostname'), type:s('DNS record type, e.g. A, AAAA, MX, TXT') },['hostname'])},
  { name:'robots_txt', description:'Fetch and summarize robots.txt as text.', inputSchema:schema({ url:s('Site URL or absolute robots.txt URL') },['url'])},
  { name:'sitemap', description:'Fetch and parse sitemap.xml locations.', inputSchema:schema({ url:s('Site URL or sitemap.xml URL'), limit:n('Maximum URLs, max 200') },['url'])},
  { name:'favicon', description:"Inspect a site's favicon endpoint without downloading the image body.", inputSchema:schema({ url:s('Site URL') },['url'])},
  { name:'website_metadata', description:'Extract basic HTML metadata such as title, description, canonical URL and Open Graph tags.', inputSchema:schema({ url:s('HTTP/HTTPS URL') },['url'])},
  { name:'port_check', description:'Check TCP connectivity to explicitly supplied host/port values. Use only on systems you are authorized to test.', inputSchema:schema({ host:s('Hostname/IP'), ports:a({type:'integer'},'TCP ports, max 16'), timeoutMs:n('Connection timeout') },['host','ports'])},
  { name:'websec_scan', description:'Run multiple passive/lightweight web security assessment modules on an authorized HTTP(S) target. Does not exploit vulnerabilities.', inputSchema:schema({ target:s('Authorized HTTP/HTTPS target'), modules:a({type:'string'},'recon, fingerprint, security, csp, methods, exposure, sensitive, frontend, mixed, xss, tls'), timeoutMs:n('Per-request timeout, max 10000 ms'), rootMode:b('Enables the fuller path/method checks; does not enable nmap'), maxDiscoveredUrls:n('Maximum discovered same-origin URLs'), maxXssCandidates:n('Maximum benign reflection candidates') },['target'])},
  ...['websec_recon','websec_fingerprint','websec_headers','websec_csp','websec_methods','websec_exposure','websec_sensitive_paths','websec_frontend','websec_mixed_content','websec_xss','websec_tls','websec_dns'].map(name=>({
    name,
    description:`Run the ${name.replace('websec_','')} web security module against an authorized HTTP(S) target.`,
    inputSchema:schema({ target:s('Authorized HTTP/HTTPS target'), timeoutMs:n('Per-request timeout') },['target'])
  })),

  { name:'notes_list', description:"List the authenticated user's public cloud notes. Returns only noteId, title, description, status, and updatedAt. Private notes are never included.", inputSchema:schema({})},
  { name:'notes_get', description:"Read one public cloud note by exact noteId. The server decrypts encrypted-at-rest content before returning the original Markdown. Private notes cannot be opened through MCP.", inputSchema:schema({ noteId:s('Exact noteId, no spaces') },['noteId'])},
  { name:'notes_create', description:"Create a cloud Markdown note for the authenticated user. noteId must be unique and contain no spaces. By default notes are private and encrypted at rest.", inputSchema:schema({ noteId:s('Unique noteId using letters, numbers, - or _ only'), title:s('Note title'), description:s('Short description, maximum 300 characters'), content:s('Markdown content'), status:s('draft or published; default draft'), visibility:s('public or private; default private'), encrypted:b('Encrypt note content at rest in the database; default true') },['noteId','title'])},
  { name:'notes_update', description:"Update an existing cloud Markdown note by exact noteId. Can change title, description, content, status, visibility, and at-rest encryption.", inputSchema:schema({ noteId:s('Exact noteId, no spaces'), title:s('New note title'), description:s('Short description, maximum 300 characters'), content:s('Replacement Markdown content'), status:s('draft or published'), visibility:s('public or private'), encrypted:b('Encrypt note content at rest') },['noteId'])},
  { name:'notes_append', description:"Append Markdown to an existing cloud note by exact noteId. The note remains subject to its current visibility and encryption settings.", inputSchema:schema({ noteId:s('Exact noteId, no spaces'), content:s('Markdown text to append') },['noteId','content'])},
  { name:'notes_delete', description:"Delete a cloud note by exact noteId for the authenticated user.", inputSchema:schema({ noteId:s('Exact noteId, no spaces') },['noteId'])},
];

function getToolDefinitions() { return definitions; }

async function getJson(url, options={}) {
  const r=await request('GET',url,{...options,maxBytes:options.maxBytes||2*1024*1024,timeoutMs:options.timeoutMs||8000,textOnly:true});
  let data=null;
  try { data=r.text ? JSON.parse(r.text) : null; } catch (_) { data=null; }
  return {response:r,data};
}

function withQuery(base, params) {
  const u=new URL(base);
  for (const [k,v] of Object.entries(params||{})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k,String(v));
  return u.toString();
}

async function httpRequestTool(args) {
  const u=new URL(args.url);
  if (args.query) for (const [k,v] of Object.entries(args.query)) u.searchParams.set(k,String(v));
  let body=args.body;
  const headers={...(args.headers||{})};
  if (args.json !== undefined) { body=JSON.stringify(args.json); if (!Object.keys(headers).some(k=>k.toLowerCase()==='content-type')) headers['content-type']='application/json'; }
  if (body !== undefined && body !== null && !Buffer.isBuffer(body)) body=String(body);
  const r=await request(args.method||'GET',u.toString(),{headers,body,timeoutMs:args.timeoutMs,maxBytes:args.maxBodyBytes,textOnly:args.textOnly!==false,maxRedirects:args.maxRedirects});
  return {
    url:r.url,status:r.status,ok:r.ok,finalUrl:r.finalUrl,contentType:r.contentType,bodySize:r.bodySize,
    truncated:r.truncated,skippedBody:r.skippedBody,redirects:r.redirects,durationMs:r.durationMs,error:r.error,
    headers:r.headers,body:r.skippedBody?null:r.text
  };
}

async function sendEmail(args, context = {}) {
  const cfg=context.credentials?.gmail || credentials.gmail || {};
  if (!cfg.user || !cfg.appPassword) throw new Error('Gmail is not connected for the authenticated account; configure it in the Kernote dashboard.');
  const nodemailer = require('nodemailer');
  const transporter=nodemailer.createTransport({service:'gmail',auth:{user:cfg.user,pass:String(cfg.appPassword).replace(/\s/g,'')}});
  const info=await transporter.sendMail({from:cfg.user,to:args.to,subject:args.subject,text:args.text,html:args.html||undefined});
  return {sent:true,messageId:info.messageId||null,to:args.to,subject:args.subject};
}

async function githubTool(args, context = {}) {
  const token=context.credentials?.github?.token || credentials.github?.token;
  const headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'kernote-node-beta/3.0'};
  if (token) headers.Authorization=`Bearer ${token}`;
  let endpoint;
  switch (args.action) {
    case 'repo': if (!args.owner||!args.repo) throw new Error('owner and repo required'); endpoint=`${GH_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`; break;
    case 'user': endpoint=args.username?`${GH_API}/users/${encodeURIComponent(args.username)}`:`${GH_API}/user`; break;
    case 'search': {
      const type=args.type||'repositories'; const map={repositories:'repositories',issues:'issues',code:'code',users:'users'}; if (!map[type]) throw new Error('unsupported GitHub search type');
      endpoint=withQuery(`${GH_API}/search/${map[type]}`,{q:args.query,per_page:Math.min(Number(args.perPage||10),30)}); break;
    }
    case 'file':
      if (!args.owner||!args.repo||!args.path) throw new Error('owner, repo and path required');
      endpoint=`${GH_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${args.path.split('/').map(encodeURIComponent).join('/')}`;
      if (args.ref) endpoint += `?ref=${encodeURIComponent(args.ref)}`;
      break;
    default: throw new Error('unknown GitHub action');
  }
  const r=await request('GET',endpoint,{headers,maxBytes:2*1024*1024,timeoutMs:9000,textOnly:true});
  let data; try{data=JSON.parse(r.text);}catch(_){data=r.text.slice(0,20000);}
  if (args.action==='file' && data && !Array.isArray(data) && data.content && data.encoding==='base64') {
    try { data.decodedContent=Buffer.from(data.content.replace(/\n/g,''),'base64').toString('utf8').slice(0,500000); delete data.content; } catch (_) {}
  }
  if (data && typeof data==='object') delete data.token;
  return {status:r.status,ok:r.ok,data,headers:r.headers};
}

async function npmTool(args) {
  const pkg=String(args.package||'').trim(); if (!pkg) throw new Error('package required');
  const path=pkg.startsWith('@') ? pkg : encodeURIComponent(pkg);
  const endpoint=`https://registry.npmjs.org/${path}${args.version?`/${encodeURIComponent(args.version)}`:''}`;
  const r=await request('GET',endpoint,{headers:{Accept:'application/json'},maxBytes:2*1024*1024,timeoutMs:9000,textOnly:true});
  let data; try{data=JSON.parse(r.text);}catch(_){data=r.text.slice(0,50000);}
  if (data && data.versions) data.versions=Object.keys(data.versions).slice(-50);
  return {status:r.status,ok:r.ok,data};
}

async function geocode(query,count,language,countryCode){
  const endpoint=withQuery('https://geocoding-api.open-meteo.com/v1/search',{name:query,count:Math.min(Number(count||5),10),language:language||'en',format:'json',countryCode});
  const {response,data}=await getJson(endpoint,{maxBytes:256*1024});
  return {status:response.status,results:data?.results||[],error:response.error||''};
}

async function resolveLocation(args) {
  if (Number.isFinite(args.latitude) && Number.isFinite(args.longitude)) return {latitude:Number(args.latitude),longitude:Number(args.longitude)};
  if (!args.location) throw new Error('location or latitude/longitude required');
  const geo=await geocode(args.location,1,'en');
  const first=geo.results[0]; if (!first) throw new Error('location not found');
  return {latitude:first.latitude,longitude:first.longitude,name:first.name,country:first.country,timezone:first.timezone};
}

async function weatherTool(args) {
  const loc=await resolveLocation(args); const days=Math.min(Math.max(Number(args.days||3),1),16);
  const endpoint=withQuery('https://api.open-meteo.com/v1/forecast',{latitude:loc.latitude,longitude:loc.longitude,current:'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,wind_speed_10m',hourly:Array.isArray(args.hourly)&&args.hourly.length?args.hourly.join(','):undefined,forecast_days:days,timezone:args.timezone||'auto'});
  const {response,data}=await getJson(endpoint,{maxBytes:1024*1024});
  return {status:response.status,location:loc,current:data?.current||null,hourly:data?.hourly||null,daily:data?.daily||null,timezone:data?.timezone||loc.timezone||null,error:response.error||''};
}

async function airQualityTool(args) {
  const loc=await resolveLocation(args); const days=Math.min(Math.max(Number(args.days||2),1),7);
  const endpoint=withQuery('https://air-quality-api.open-meteo.com/v1/air-quality',{latitude:loc.latitude,longitude:loc.longitude,current:'pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,european_aqi',hourly:'pm10,pm2_5,us_aqi,european_aqi',forecast_days:days,timezone:'auto'});
  const {response,data}=await getJson(endpoint,{maxBytes:1024*1024});
  return {status:response.status,location:loc,current:data?.current||null,hourly:data?.hourly||null,timezone:data?.timezone||loc.timezone||null,error:response.error||''};
}

async function timezoneTool(args) {
  let tz=args.timezone;
  if (!tz && Number.isFinite(args.latitude) && Number.isFinite(args.longitude)) {
    const endpoint=withQuery('https://api.open-meteo.com/v1/forecast',{latitude:args.latitude,longitude:args.longitude,current:'temperature_2m',timezone:'auto'});
    const {response,data}=await getJson(endpoint,{maxBytes:128*1024});
    if (response.status!==200 || !data?.timezone) throw new Error('timezone lookup failed');
    tz=data.timezone;
  }
  if (!tz) throw new Error('timezone or coordinates required');
  const date=new Date(args.dateTime||Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('invalid dateTime');
  const locale=args.locale||'en-US';
  const parts=new Intl.DateTimeFormat(locale,{timeZone:tz,dateStyle:'full',timeStyle:'long'}).format(date);
  const offsetParts=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset',hour:'2-digit',minute:'2-digit'}).formatToParts(date);
  const offset=(offsetParts.find(x=>x.type==='timeZoneName')||{}).value||'';
  return {timezone:tz,dateTime:date.toISOString(),local:parts,offset};
}

async function dnsLookup(args) {
  const host=args.hostname; const type=(args.type||'A').toUpperCase(); let records;
  switch(type){
    case 'A': records=await dns.resolve4(host); break; case 'AAAA': records=await dns.resolve6(host); break; case 'MX': records=await dns.resolveMx(host); break;
    case 'TXT': records=await dns.resolveTxt(host); break; case 'CNAME': records=await dns.resolveCname(host); break; case 'NS': records=await dns.resolveNs(host); break;
    case 'SOA': records=await dns.resolveSoa(host); break; case 'SRV': records=await dns.resolveSrv(host); break; case 'CAA': records=await dns.resolveCaa(host); break;
    case 'PTR': records=await dns.reverse(host); break; default: throw new Error('unsupported DNS record type');
  }
  return {hostname:host,type,records};
}

async function whoisTool(args) {
  const q=String(args.query||'').trim(); if (!q) throw new Error('query required');
  const endpoint=`https://rdap.org/${net.isIP(q)?'ip':'domain'}/${encodeURIComponent(q)}`;
  const {response,data}=await getJson(endpoint,{maxBytes:1024*1024,timeoutMs:9000});
  return {status:response.status,ok:response.ok,data,error:response.error||''};
}

async function ipInfo(args) {
  const endpoint=args.ip?`https://ipwho.is/${encodeURIComponent(args.ip)}`:'https://ipwho.is/';
  const {response,data}=await getJson(endpoint,{maxBytes:256*1024});
  return {status:response.status,ok:response.ok,data,error:response.error||''};
}

async function sslCheck(args) {
  const url=normalizeTarget(args.url); if (!url.startsWith('https://')) throw new Error('ssl_check requires HTTPS');
  const data=await inspectTls(url,Math.min(Number(args.timeoutMs||8000),10000)); return {url,...data};
}

async function urlInspector(args) {
  const r=await request('GET',normalizeTarget(args.url),{maxBytes:512*1024,timeoutMs:args.timeoutMs||8000,textOnly:true});
  const metadata={title:(r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]?.replace(/\s+/g,' ').trim()||null,
    contentLength:r.headers['content-length']||null,server:r.headers.server||null,
    securityHeaders:Object.fromEntries(['strict-transport-security','content-security-policy','x-content-type-options','x-frame-options','referrer-policy','permissions-policy'].map(k=>[k,r.headers[k]||null]))};
  return {status:r.status,ok:r.ok,finalUrl:r.finalUrl,contentType:r.contentType,bodySize:r.bodySize,durationMs:r.durationMs,redirects:r.redirects,headers:r.headers,metadata,error:r.error};
}

async function httpHeaders(args) {
  const method=(args.method||'HEAD').toUpperCase();
  const r=await request(method==='GET'?'GET':'HEAD',normalizeTarget(args.url),{maxBytes:2048,timeoutMs:args.timeoutMs||8000,textOnly:true});
  return {status:r.status,ok:r.ok,finalUrl:r.finalUrl,contentType:r.contentType,headers:r.headers,redirects:r.redirects,durationMs:r.durationMs,error:r.error};
}

async function currencyTool(args) {
  const from=String(args.from).toUpperCase(), to=String(args.to).toUpperCase();
  const endpoint=withQuery('https://api.frankfurter.app/latest',{amount:args.amount,from,to});
  const {response,data}=await getJson(endpoint,{maxBytes:128*1024});
  return {status:response.status,data,error:response.error||''};
}

async function earthquakeTool(args) {
  const period=['hour','day','week','month'].includes(args.period)?args.period:'day'; const min=Number.isFinite(args.minMagnitude)?args.minMagnitude:0; const limit=Math.min(Math.max(Number(args.limit||20),1),50);
  const endpoint=`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${min>=4?'4.5':min>=2.5?'2.5':'all'}_${period}.geojson`;
  const {response,data}=await getJson(endpoint,{maxBytes:1024*1024});
  const features=(data?.features||[]).sort((a,b)=>(b.properties?.mag||0)-(a.properties?.mag||0)).slice(0,limit);
  return {status:response.status,count:features.length,earthquakes:features.map(f=>({id:f.id,time:f.properties?.time,mag:f.properties?.mag,place:f.properties?.place,tsunami:f.properties?.tsunami,url:f.properties?.url,coordinates:f.geometry?.coordinates}))};
}

async function holidaysTool(args) {
  const endpoint=`https://date.nager.at/api/v3/PublicHolidays/${encodeURIComponent(args.year)}/${encodeURIComponent(args.countryCode.toUpperCase())}`;
  const {response,data}=await getJson(endpoint,{maxBytes:512*1024}); return {status:response.status,holidays:Array.isArray(data)?data:[],error:response.error||''};
}

async function sunriseTool(args) {
  const endpoint=withQuery('https://api.sunrise-sunset.org/json',{lat:args.latitude,lng:args.longitude,date:args.date||'today',formatted:0});
  const {response,data}=await getJson(endpoint,{maxBytes:128*1024}); return {status:response.status,...(data||{}),error:response.error||''};
}

async function webpageExtract(args) {
  const url=normalizeTarget(args.url); const r=await request('GET',url,{maxBytes:1024*1024,timeoutMs:9000,textOnly:true});
  const [links,forms]=extractLinksAndForms(r.text,r.finalUrl);
  const meta={title:(r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]?.replace(/\s+/g,' ').trim()||null,description:(r.text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)||[])[1]||null,canonical:(r.text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)||[])[1]||null};
  return {status:r.status,ok:r.ok,finalUrl:r.finalUrl,contentType:r.contentType,title:meta.title,description:meta.description,canonical:meta.canonical,links:links.slice(0,150),forms,text:stripHtml(r.text).slice(0,Math.min(Number(args.maxTextChars||20000),50000)),truncated:r.truncated};
}

async function dnsPropagation(args) {
  const host=args.hostname,type=(args.type||'A').toUpperCase();
  const endpoints=[
    ['google','https://dns.google/resolve'],
    ['cloudflare','https://cloudflare-dns.com/dns-query']
  ];
  const answers={};
  for(const [name,base] of endpoints){
    const url=withQuery(base,{name:host,type});
    const r=await request('GET',url,{headers:{Accept:'application/dns-json'},maxBytes:256*1024,timeoutMs:7000,textOnly:true});
    try{answers[name]=JSON.parse(r.text);}catch(_){answers[name]={status:r.status,error:r.error||'invalid response'};}
  }
  return {hostname:host,type,answers};
}

async function textFetch(args, type) {
  let target=args.url.trim();
  if (!/^https?:\/\//i.test(target)) target=new URL(type,target.endsWith('/')?'https://'+target:'https://'+target).toString();
  if (type==='robots') target=new URL('/robots.txt',target).toString();
  if (type==='sitemap') target=target.toLowerCase().endsWith('.xml')?target:new URL('/sitemap.xml',target).toString();
  const r=await request('GET',target,{maxBytes:512*1024,timeoutMs:8000,textOnly:true}); return {status:r.status,ok:r.ok,url:r.finalUrl,text:r.text,truncated:r.truncated,error:r.error};
}

async function robotsTool(args){ return textFetch(args,'robots'); }
async function sitemapTool(args){ const r=await textFetch(args,'sitemap'); const limit=Math.min(Math.max(Number(args.limit||100),1),200); const urls=[...r.text.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m=>m[1].trim()).slice(0,limit); return {...r,urls}; }
async function faviconTool(args){ const base=normalizeTarget(args.url); const u=new URL('/favicon.ico',base); const r=await request('HEAD',u.toString(),{maxBytes:0,timeoutMs:8000,textOnly:true}); return {status:r.status,ok:r.ok,url:u.toString(),contentType:r.contentType,headers:r.headers,error:r.error}; }
async function websiteMetadata(args){ const r=await request('GET',normalizeTarget(args.url),{maxBytes:512*1024,timeoutMs:8000,textOnly:true}); const text=r.text; const pick=(re)=>{const m=text.match(re);return m?m[1].trim():null;}; const metadata={title:pick(/<title[^>]*>([\s\S]*?)<\/title>/i),description:pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i),canonical:pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i),openGraph:{}}; for(const m of text.matchAll(/<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*)["']/gi)) metadata.openGraph[m[1]]=m[2]; return {status:r.status,finalUrl:r.finalUrl,contentType:r.contentType,metadata,error:r.error}; }

function checkPort(host,port,timeoutMs){return new Promise(resolve=>{const started=Date.now(); const socket=net.createConnection({host,port}); let done=false; const finish=(open,error)=>{if(done)return;done=true;socket.destroy();resolve({host,port,open,error:error||null,durationMs:Date.now()-started});}; socket.setTimeout(timeoutMs,()=>finish(false,'timeout')); socket.once('connect',()=>finish(true,null)); socket.once('error',e=>finish(false,e.message));});}
async function portCheck(args){ await assertAllowedTarget(args.host); const timeoutMs=Math.min(Math.max(Number(args.timeoutMs||1500),250),5000); const ports=[...new Set((args.ports||[]).map(Number).filter(p=>p>0&&p<65536))].slice(0,16); if(!ports.length)throw new Error('ports must contain at least one valid TCP port'); const results=[]; for(const port of ports)results.push(await checkPort(args.host,port,timeoutMs)); return {host:args.host,results}; }

async function websec(args,name){ const moduleMap={websec_recon:'recon',websec_fingerprint:'fingerprint',websec_headers:'security',websec_csp:'csp',websec_methods:'methods',websec_exposure:'exposure',websec_sensitive_paths:'sensitive',websec_frontend:'frontend',websec_mixed_content:'mixed',websec_xss:'xss',websec_tls:'tls',websec_dns:'recon'}; const module=moduleMap[name]; if(!module)throw new Error('unknown websec module'); const result=await runScan(args.target,{modules:[module],timeoutMs:args.timeoutMs}); if(name==='websec_dns') return {target:result.target,dns_addresses:result.meta.dns_addresses||[],dns_error:result.meta.dns_error||''}; return result; }

async function callTool(name,args,context={}){
  switch(name){
    case 'javascript_execute': { const result = await executeJavaScript(args, context); return textResult(result, !result.success); }
    case 'usage_read': {
      if (!context.uid) throw new Error('usage_read requires an authenticated Kernote account.');
      const stats = await getStats(context.uid);
      const names = getToolDefinitions().map(tool => tool.name);
      return textResult(buildToolUsageSummary(stats, context.email, names, args.tool));
    }
    case 'http_request': return textResult(await httpRequestTool(args));
    case 'send_email': return textResult(await sendEmail(args,context));
    case 'notes_list': { if (!context.uid) throw new Error('authenticated user required'); return textResult(await notes.listNotes(context.uid, { publicOnly: true })); }
    case 'notes_get': { if (!context.uid) throw new Error('authenticated user required'); return textResult(await notes.getNote(context.uid, args.noteId, { allowPrivate: false, withContent: true })); }
    case 'notes_create': { if (!context.uid) throw new Error('authenticated user required'); return textResult(await notes.createNote(context.uid, args)); }
    case 'notes_update': { if (!context.uid) throw new Error('authenticated user required'); return textResult(await notes.updateNote(context.uid, args.noteId, args)); }
    case 'notes_append': { if (!context.uid) throw new Error('authenticated user required'); return textResult(await notes.appendNote(context.uid, args.noteId, args.content)); }
    case 'notes_delete': { if (!context.uid) throw new Error('authenticated user required'); return textResult(await notes.deleteNote(context.uid, args.noteId)); }
    case 'stalk_tiktok': return textResult(await stalkTikTok(args.username,args.deep));
    case 'weather': return textResult(await weatherTool(args));
    case 'geocoding': return textResult(await geocode(args.query,args.count,args.language,args.countryCode));
    case 'timezone': return textResult(await timezoneTool(args));
    case 'dns_lookup': return textResult(await dnsLookup(args));
    case 'whois': return textResult(await whoisTool(args));
    case 'ip_info': return textResult(await ipInfo(args));
    case 'ssl_check': return textResult(await sslCheck(args));
    case 'url_inspector': return textResult(await urlInspector(args));
    case 'http_headers': return textResult(await httpHeaders(args));
    case 'github': return textResult(await githubTool(args,context));
    case 'npm': return textResult(await npmTool(args));
    case 'news_search': return textResult(await extra.newsSearch(args));
    case 'news_headlines': return textResult(await extra.newsHeadlines(args));
    case 'rss_feed': return textResult(await extra.rssFeed(args));
    case 'earthquake_bmkg': return textResult(await extra.bmkgEarthquake(args));
    case 'bmkg_weather': return textResult(await extra.bmkgWeather(args));
    case 'bmkg_marine_meta': return textResult(await extra.bmkgMarineMeta(args));
    case 'bmkg_marine_forecast': return textResult(await extra.bmkgMarineForecast(args));
    case 'crypto_price': return textResult(await extra.cryptoPrice(args,context.credentials?.services || {}));
    case 'gold_price': return textResult(await extra.goldPrice(args));
    case 'stock_price': return textResult(await extra.stockPrice(args));
    case 'wikipedia_search': return textResult(await extra.wikipediaSearch(args));
    case 'wikipedia_summary': return textResult(await extra.wikipediaSummary(args));
    case 'country_info': return textResult(await extra.countryInfo(args));
    case 'public_ip': return textResult(await extra.publicIp());
    case 'url_download': return textResult(await extra.urlDownload(args));
    case 'github_raw': return textResult(await extra.githubRaw(args,context.credentials?.github?.token || credentials.github?.token));
    case 'github_releases': return textResult(await extra.githubReleases(args,context.credentials?.github?.token || credentials.github?.token));
    case 'npm_downloads': return textResult(await extra.npmDownloads(args));
    case 'currency': return textResult(await currencyTool(args));
    case 'air_quality': return textResult(await airQualityTool(args));
    case 'earthquake': return textResult(await earthquakeTool(args));
    case 'public_holidays': return textResult(await holidaysTool(args));
    case 'sunrise_sunset': return textResult(await sunriseTool(args));
    case 'webpage_extract': return textResult(await webpageExtract(args));
    case 'dns_propagation': return textResult(await dnsPropagation(args));
    case 'robots_txt': return textResult(await robotsTool(args));
    case 'sitemap': return textResult(await sitemapTool(args));
    case 'favicon': return textResult(await faviconTool(args));
    case 'website_metadata': return textResult(await websiteMetadata(args));
    case 'port_check': return textResult(await portCheck(args));
    case 'websec_scan': return textResult(await runScan(args.target,args));
    default:
      if (name.startsWith('websec_')) return textResult(await websec(args,name));
      throw new Error(`unknown tool: ${name}`);
  }
}

module.exports={getToolDefinitions,callTool};
