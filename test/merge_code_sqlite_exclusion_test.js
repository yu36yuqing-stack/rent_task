'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = fs.readFileSync(path.join(__dirname, '../scripts/merge_code.sh'), 'utf8');
const rsyncLine = script.split('\n').find(line => line.startsWith('RSYNC_CMD='));
const excludes = [...rsyncLine.matchAll(/--exclude '([^']+)'/g)].map(match => match[1]);
for (const pattern of ['*.db', '*.db-wal', '*.db-shm', '*.db-journal']) assert(excludes.includes(pattern));
const pullLine = script.split('\n').find(line => line.startsWith('PULL_DB_CMD='));
const pullFilters = [...pullLine.matchAll(/--(include|exclude) '([^']+)'/g)]
    .flatMap(match => [`--${match[1]}`, match[2]]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-release-exclusions-'));
const source = path.join(root, 'source'), destination = path.join(root, 'destination');
const write = (directory, file, value) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
};
const read = file => fs.readFileSync(path.join(destination, file), 'utf8');

try {
    const protectedFiles = [];
    for (const name of ['rent_robot', 'rent_robot_order', 'rent_robot_price', 'rent_robot_runtime', 'rent_robot_stats', 'nested/custom']) {
        for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal']) {
            const file = `database/${name}${suffix}`;
            protectedFiles.push(file);
            write(source, file, 'LOCAL DATA MUST NOT UPLOAD');
            write(destination, file, 'PRODUCTION DATA MUST NOT CHANGE');
        }
    }
    // Receiver-only sidecars model live SQLite files missing from the local checkout.
    for (const suffix of ['.db-wal', '.db-shm', '.db-journal']) {
        const receiverOnly = `database/remote_only${suffix}`;
        protectedFiles.push(receiverOnly);
        write(destination, receiverOnly, 'PRODUCTION DATA MUST NOT CHANGE');
        write(source, `database/local_only${suffix}`, 'LOCAL DATA MUST NOT UPLOAD');
    }
    for (const file of ['coverage/index.html', 'log/job.log', 'config/cloudinfo.md', 'config/CloudInfo.md', 'database/rent_robot_runtime.db.corrupt']) {
        protectedFiles.push(file);
        write(source, file, 'LOCAL DATA MUST NOT UPLOAD');
        write(destination, file, 'PRODUCTION DATA MUST NOT CHANGE');
    }
    write(source, 'price/new.js', 'new updated code');
    write(destination, 'price/new.js', 'old code');
    write(destination, 'obsolete.js', 'delete unused code');
    const result = spawnSync('rsync', ['-az', '--delete', ...excludes.flatMap(pattern => ['--exclude', pattern]), `${source}/`, `${destination}/`], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    for (const file of protectedFiles) assert.strictEqual(read(file), 'PRODUCTION DATA MUST NOT CHANGE', file);
    for (const suffix of ['.db-wal', '.db-shm', '.db-journal']) assert(!fs.existsSync(path.join(destination, `database/local_only${suffix}`)));
    assert.strictEqual(read('price/new.js'), 'new updated code');
    assert(!fs.existsSync(path.join(destination, 'obsolete.js')));

    const pullSource = path.join(root, 'remote-database');
    const businessFiles = ['rent_robot.db', 'rent_robot_order.db', 'rent_robot_price.db', 'rent_robot_stats.db', 'nested/custom.db'];
    const runtimeFiles = ['rent_robot_runtime.db', 'rent_robot_runtime.db-wal', 'rent_robot_runtime.db-shm',
        'rent_robot_runtime.db-journal', 'rent_robot_runtime.db.corrupt', 'rent_robot_runtime.db.backup.db',
        'nested/rent_robot_runtime.db', 'nested/rent_robot_runtime.db.backup.db'];
    const nonDatabaseFiles = ['rent_robot.db-wal', 'rent_robot.db-shm', 'rent_robot.db-journal', 'schema.js', 'nested/notes.txt'];
    for (const file of [...businessFiles, ...runtimeFiles, ...nonDatabaseFiles]) write(pullSource, file, `REMOTE:${file}`);
    for (const existingRuntime of [false, true]) {
        const pullDestination = path.join(root, existingRuntime ? 'existing-local-database' : 'fresh-local-database');
        fs.mkdirSync(pullDestination, { recursive: true });
        if (existingRuntime) for (const file of runtimeFiles) write(pullDestination, file, 'LOCAL RUNTIME MUST NOT CHANGE');
        const pull = spawnSync('rsync', ['-az', ...pullFilters, `${pullSource}/`, `${pullDestination}/`], { encoding: 'utf8' });
        assert.strictEqual(pull.status, 0, pull.stderr);
        for (const file of businessFiles) assert.strictEqual(fs.readFileSync(path.join(pullDestination, file), 'utf8'), `REMOTE:${file}`);
        for (const file of runtimeFiles) {
            const target = path.join(pullDestination, file);
            if (existingRuntime) assert.strictEqual(fs.readFileSync(target, 'utf8'), 'LOCAL RUNTIME MUST NOT CHANGE', file);
            else assert(!fs.existsSync(target), `Runtime must not be pulled: ${file}`);
        }
        for (const file of nonDatabaseFiles) assert(!fs.existsSync(path.join(pullDestination, file)), file);
    }
    const syntax = spawnSync('bash', ['-n', path.join(__dirname, '../scripts/merge_code.sh')], { encoding: 'utf8' });
    assert.strictEqual(syntax.status, 0, syntax.stderr);
    console.log(`[PASS] actual release rsync filters: ${protectedFiles.length} protected files, receiver-only sidecars, no local upload, code update/delete and shell syntax`);
    console.log(`[PASS] actual database pull filters: ${businessFiles.length} business files synced; ${runtimeFiles.length} Runtime files and ${nonDatabaseFiles.length} non-database files excluded; fresh and existing local Runtime verified`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
