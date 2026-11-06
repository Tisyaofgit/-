import {executeOperator,compileWorkbookPayload,evaluateCompiledFormula,runCompiledMacro} from './mechanical_runtime.mjs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
try{const request=JSON.parse(raw);let result,compiled;
 if(request.payload){compiled=compileWorkbookPayload(request.payload);result=request.formula_ref?evaluateCompiledFormula(compiled,request.formula_ref,request.owner||{}):request.macro_ref?runCompiledMacro(compiled,request.macro_ref,request.owner||{}):compiled;}
 else result=executeOperator(request.operator,request.args,request.context||{});
 console.log(JSON.stringify({status:'CALCULATED',result,...(compiled?{source_integrity:compiled.source_integrity,derived_projections:compiled.derived_projections}:{} )}));}
catch(error){console.error(JSON.stringify({status:'FAILED',error:typeof error.toJSON==='function'?error.toJSON():{message:error.message}}));process.exitCode=2;}
