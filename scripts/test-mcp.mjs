import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp-server.mjs'], cwd: process.cwd(), stderr: 'pipe' });
const client = new Client({ name: 'hhba-mcp-smoke-test', version: '0.1.0' });
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((tool) => tool.name);
for (const required of ['draft_human_capability_request', 'get_human_capability_request', 'get_human_capability_result']) {
  if (!names.includes(required)) throw new Error(`Missing MCP tool: ${required}`);
}
const draft = await client.callTool({ name: 'draft_human_capability_request', arguments: {
  goal: '审查一个 Java 项目的性能瓶颈', human_gap_type: 'EXPERT_JUDGMENT', human_gap_reason: '需要资深工程师审查架构与压测证据。',
  capability_requirements: ['Java', '性能优化'], deliverables: ['诊断报告', '改造建议'], completed_work: ['已收集 profiling 数据']
} });
const draftBody = draft.structuredContent || JSON.parse(draft.content[0].text);
if (!draftBody.id || draftBody.status !== 'DRAFT') throw new Error('MCP draft response is invalid');
if (!client.getInstructions()?.includes('Shadow Mode')) throw new Error('MCP server instructions were not received');
console.log(JSON.stringify({ tools: names, draftId: draftBody.id, instructions: 'received' }));
await transport.close();
