const http = require('node:http');
const { handleMcpHttp } = require('./lib/mcp');
const port = Number(process.env.PORT || 3000);
const server=http.createServer((req,res)=>{handleMcpHttp(req,res).catch(error=>{res.statusCode=500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:error.message}));});});
server.listen(port,()=>console.log(`Kernote-Node-beta listening on http://localhost:${port}/mcp`));
