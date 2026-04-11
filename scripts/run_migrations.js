#!/usr/bin/env node
'use strict';

const { runPendingMigrations } = require('../database/migration_runner');

runPendingMigrations({ logger: console }).then((summary) => {
    console.log(JSON.stringify({
        ok: true,
        ...summary
    }));
}).catch((err) => {
    console.error(`[Migration] failed: ${String(err && err.message ? err.message : err)}`);
    process.exit(1);
});
