const tls = require('node:tls');
const { URL } = require('node:url');
const { finding } = require('./models');
function namesToObject(value) {
  const out = {}; for (const item of value || []) if (Array.isArray(item) && Array.isArray(item[0]) && item[0].length === 2) out[item[0][0]] = item[0][1]; return out;
}
function inspectTls(url, timeoutMs=8000) {
  return new Promise((resolve,reject)=>{
    const u = new URL(url);
    const socket = tls.connect({host:u.hostname,port:Number(u.port||443),servername:u.hostname,rejectUnauthorized:true},()=>{
      const cert = socket.getPeerCertificate(); const cipher=socket.getCipher();
      resolve({version:socket.getProtocol(),cipher:cipher&&cipher.name,cipher_bits:cipher&&cipher.bits,subject:namesToObject(cert.subject),issuer:namesToObject(cert.issuer),not_before:cert.valid_from,not_after:cert.valid_to,san:String(cert.subjectaltname||'').split(',').map(x=>x.replace(/^DNS:/i,'').trim()).filter(Boolean).slice(0,100)}); socket.end();
    });
    socket.setTimeout(timeoutMs,()=>{socket.destroy(new Error('TLS inspection timeout'));});
    socket.on('error',reject);
  });
}
async function run(ctx) {
  ctx.event('tls','inspecting TLS certificate');
  const u = new URL(ctx.primaryResponse.finalUrl);
  if (u.protocol !== 'https:') { ctx.result.tls={enabled:false}; return; }
  try {
    const data = await inspectTls(ctx.primaryResponse.finalUrl,ctx.config.timeoutMs);
    let daysLeft=null;
    if (data.not_after) daysLeft=Math.floor((new Date(data.not_after)-new Date())/86400000);
    ctx.result.tls={enabled:true,...data,days_left:daysLeft};
    if (daysLeft !== null && daysLeft < 0) ctx.finding(finding('tls-certificate-expired','TLS certificate appears expired',{severity:'high',confidence:'high',category:'tls',target:ctx.primaryResponse.finalUrl,description:'the presented certificate expiration date is in the past.',recommendation:'renew the certificate and verify the deployed certificate.',evidence:{...ctx.result.tls}}));
    else if (daysLeft !== null && daysLeft < 30) ctx.finding(finding('tls-certificate-near-expiry','TLS certificate expires soon',{severity:'medium',confidence:'high',category:'tls',target:ctx.primaryResponse.finalUrl,description:'the certificate is within 30 days of expiration.',recommendation:'renew before expiration and automate renewal where appropriate.',evidence:{...ctx.result.tls}}));
  } catch (error) {
    ctx.result.tls={enabled:true,error:error.message};
    ctx.finding(finding('tls-inspection-failed','TLS certificate inspection failed',{severity:'low',confidence:'medium',category:'tls',target:ctx.primaryResponse.finalUrl,description:'the scanner could not inspect the TLS certificate with the current trust configuration.',recommendation:'verify certificate configuration manually.',evidence:{error:error.message}}));
  }
  ctx.event('tls','tls inspection complete');
}
module.exports={run,inspectTls};
