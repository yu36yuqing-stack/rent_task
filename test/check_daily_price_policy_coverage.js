'use strict';
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const {createCoverageMap}=require('istanbul-lib-coverage');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'coverage/daily-price-policy');
const map=createCoverageMap(JSON.parse(fs.readFileSync(path.join(directory,'coverage-final.json'),'utf8')));
const core=['price/daily_price_policy.js','database/user_channel_package_ratio_db.js','database/migrations/20261007_019_daily_price_policy.js',
    'price/channel_package_ratio.js','price/package_ratio_service.js','price/channel_adapters/uhaozu_price_adapter.js',
    'price/channel_adapters/uuzuhao_price_adapter.js','price/channel_adapters/zuhaowang_price_adapter.js',
    'price/price_ladder_service.js','price/price_ladder_reconcile_service.js','h5/public/js/ui/daily_price_policy.js','h5/public/js/ui/help_sheet.js'];
const files=[...core,'h5/public/js/menu_price.js','h5/local_h5_server.js'];
const results=files.map(file=>{
    const coverage=map.fileCoverageFor(path.join(root,file)),lines=coverage.getLineCoverage(),summary=coverage.toSummary();
    const tracked=spawnSync('git',['ls-files','--error-unmatch',file],{cwd:root,encoding:'utf8'}).status===0;
    let selected;
    if(!tracked)selected=Object.keys(lines).map(Number);
    else{
        const diff=spawnSync('git',['diff','HEAD','--unified=0','--',file],{cwd:root,encoding:'utf8'});
        if(diff.status!==0)throw new Error(diff.stderr);
        const changed=new Set();
        for(const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)){
            const count=match[2]===undefined?1:Number(match[2]);
            for(let line=Number(match[1]);line<Number(match[1])+count;line++)changed.add(line);
        }
        selected=[...changed].filter(line=>Object.hasOwn(lines,line));
    }
    const missed=selected.filter(line=>!lines[line]),pct=selected.length?100*(selected.length-missed.length)/selected.length:100;
    if(pct<90||(core.includes(file)&&summary.lines.pct<90))process.exitCode=1;
    return {file,changed_total:selected.length,changed_covered:selected.length-missed.length,changed_percent:pct,missed,
        lines:summary.lines.pct,branches:summary.branches.pct,functions:summary.functions.pct};
});
const total=results.reduce((s,r)=>s+r.changed_total,0),covered=results.reduce((s,r)=>s+r.changed_covered,0);
const coreMap=createCoverageMap({});
for(const file of core)coreMap.addFileCoverage(map.fileCoverageFor(path.join(root,file)));
fs.writeFileSync(path.join(directory,'changed-lines.json'),JSON.stringify({baseline:'HEAD; new files full file',threshold:90,
    changed_total:total,changed_covered:covered,changed_percent:covered*100/total,
    core_summary:coreMap.getCoverageSummary().toJSON(),included_scope_summary:map.getCoverageSummary().toJSON(),files:results},null,2)+'\n');
console.table(results);
console.log('Core file coverage:',JSON.stringify(coreMap.getCoverageSummary()));
