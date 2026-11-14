// Strong raw-model comparator: the same direct read-only tool implementations,
// lazy Docdex, compact initial exposure and progressive discovery. No Codali
// answer rewriting, verification repair policy or instruction orchestration.
import { DocdexClient } from '../../packages/codali/dist/docdex/DocdexClient.js';
import { createDocdexTools } from '../../packages/codali/dist/tools/docdex/DocdexTools.js';
import { createFileTools } from '../../packages/codali/dist/tools/filesystem/FileTools.js';
import { createSearchTool } from '../../packages/codali/dist/tools/search/SearchTool.js';
import { createCalculatorTool } from '../../packages/codali/dist/tools/calculation/CalculatorTool.js';
import { createDeterministicTools } from '../../packages/codali/dist/tools/deterministic/DeterministicTools.js';
import { createDocumentTools } from '../../packages/codali/dist/tools/documents/DocumentTools.js';
import { createJavaScriptVerificationTool } from '../../packages/codali/dist/tools/verification/JavaScriptVerificationTool.js';
import { createVitestTool } from '../../packages/codali/dist/tools/verification/VitestTool.js';
import { createAdesTool } from '../../packages/codali/dist/tools/entities/AdesTool.js';
import { createTnlTool } from '../../packages/codali/dist/tools/research/TnlTool.js';
import { createBrowserTools } from '../../packages/codali/dist/tools/browser/BrowserTool.js';
import { createTimeTool } from '../../packages/codali/dist/tools/system/TimeTool.js';
import { retrieveTools } from '../../packages/codali/dist/tools/ToolRetrieval.js';
import { toolDescriptorFor } from '../../packages/codali/dist/tools/ToolRegistry.js';
import { permissionKind } from '../../packages/codali/dist/permissions/PermissionGate.js';

export function fullTrustTools(registry, workspace, startDocdex, initialTools) {
  for (const tool of [...createFileTools(), createSearchTool(), createCalculatorTool(), ...createDeterministicTools(), ...createDocumentTools(), createJavaScriptVerificationTool(), createVitestTool(), createAdesTool(), createTnlTool(), createTimeTool(), ...createBrowserTools()]) {
    if (tool.readOnly && ['read','web'].includes(permissionKind(toolDescriptorFor(tool)))) registry.register(tool);
  }
  let actual;
  const placeholder = new DocdexClient({ baseUrl: 'http://127.0.0.1:1', repoRoot: workspace });
  for (const tool of createDocdexTools(placeholder,{ includeCatalog:true, allowSearchWebFallback:false })) if (tool.readOnly && ['read','web'].includes(permissionKind(toolDescriptorFor(tool)))) {
    registry.register({...tool,handler:async(args,context)=>{
      actual ??= startDocdex().then(client=>createDocdexTools(client,{includeCatalog:true,allowSearchWebFallback:false}));
      const target=(await actual).find(item=>item.name===tool.name);if(!target)throw Error('Unavailable Docdex operation');return target.handler(args,context);
    }});
  }
  if(initialTools?.some(name=>name!=='tools_describe'&&!registry.list().some(tool=>tool.name===name)))throw Error('interaction.initialTools: unavailable read-only tool');
  const exposed=new Set([...(initialTools??['docdex_search','docdex_open','calculate']),'tools_describe']);
  registry.register({name:'tools_describe',description:'Find tools by a capability query, or load up to four names. Includes Docdex repo/web/memory, browser, calculations, algebra/constraints, SQL/dataframes, JSON validation, documents/PDF/spreadsheets, tests, entities and time. Loaded tools become directly callable.',readOnly:true,capability:'discovery',
    inputSchema:{type:'object',properties:{query:{type:'string',maxLength:500},names:{type:'array',items:{type:'string'},maxItems:4}},additionalProperties:false},
    handler:async({query,names})=>{
      const requested=names??(query?retrieveTools(query,registry.list().filter(tool=>tool.name!=='tools_describe'),4).map(item=>item.tool.name):undefined);
      if(requested&&(requested.length>4||requested.some(name=>!registry.list().some(tool=>tool.name===name))))throw Error('Unknown tool');
      if(requested)requested.forEach(name=>exposed.add(name));
      return{output:JSON.stringify(registry.list().filter(tool=>!requested||requested.includes(tool.name)).map(tool=>({name:tool.name,description:tool.description.slice(0,requested?200:80),...(requested?{inputSchema:tool.inputSchema}:{})})))};
    }});
  return exposed;
}
