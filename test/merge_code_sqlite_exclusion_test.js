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
    const syntax = spawnSync('bash', ['-n', path.join(__dirname, '../scripts/merge_code.sh')], { encoding: 'utf8' });
    assert.strictEqual(syntax.status, 0, syntax.stderr);
    console.log(`[PASS] actual release rsync filters: ${protectedFiles.length} protected files, receiver-only sidecars, no local upload, code update/delete and shell syntax`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
