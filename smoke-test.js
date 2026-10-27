const { getToolDefinitions } = require('./lib/tools');
const tools = getToolDefinitions();
const names = tools.map(tool => tool.name);
const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
const javascriptTool = tools.find(tool => tool.name === 'javascript_execute');
const result = { ok: duplicates.length === 0 && !!javascriptTool && tools.length === 65, toolCount: tools.length, duplicates, javascriptExecute: !!javascriptTool, tools: names };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
