'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const tests=['daily_price_logging_test.js','help_sheet_test.js','pricing_ladder_help_h5_test.js','daily_price_policy_test.js','daily_price_policy_integration_test.js','daily_price_policy_publish_test.js','daily_price_policy_h5_test.js','run_zuhaowang_snapshot_repair_tests.js'];
for(const test of tests){
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rent-daily-suite-')),env={...process.env};
    for(const name of ['MAIN','PRICE','RUNTIME','ORDER','STATS']) env[`${name}_DB_FILE_PATH`]=path.join(temp,`${name}.db`);
    const out=spawnSync(process.execPath,[path.join(__dirname,test)],{env,encoding:'utf8',maxBuffer:30*1024*1024});
    process.stdout.write(out.stdout||'');process.stderr.write(out.stderr||'');
    if(out.status!==0)process.exit(out.status||1);
}
console.log('[PASS] daily policy and related regression suites');
