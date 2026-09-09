#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../h5/public/js/menu_products.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, { filename: 'menu_products.js' });

const csgo = { game_id: '4', game_name: 'CSGO' };
const wzry = { game_id: '1', game_name: 'WZRY' };

for (const action of ['forbidden', 'prod_guard', 'maintenance', 'auth_revoke']) {
    assert.strictEqual(context.shouldShowMoreOpsAction(csgo, action), false, `CSGO应隐藏 ${action}`);
    assert.strictEqual(context.shouldShowMoreOpsAction(wzry, action), true, `非CSGO应保留 ${action}`);
}
for (const action of ['order_off', 'cooldown', 'purchase', 'cost', 'sold']) {
    assert.strictEqual(context.shouldShowMoreOpsAction(csgo, action), true, `CSGO应保留 ${action}`);
}

assert.ok(source.includes("els.moreOpsForbiddenBtn.classList.toggle('hidden', hideCsgoOnlyActions)"));
assert.ok(source.includes("els.moreOpsProdGuardBtn.classList.toggle('hidden', hideCsgoOnlyActions)"));
assert.ok(source.includes("els.moreOpsMaintenanceBtn.classList.toggle('hidden', hideCsgoOnlyActions)"));
assert.ok(source.includes("els.moreOpsAuthRevokeBtn.classList.toggle('hidden', hideCsgoOnlyActions)"));

console.log('[PASS] h5_csgo_more_ops_smoke_test');
