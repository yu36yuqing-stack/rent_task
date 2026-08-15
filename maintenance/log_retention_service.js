const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { once } = require('events');

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_LOG_DIR = path.resolve(__dirname, '..', 'log');
const APPLICATION_LOG_FILES = [
    'rent_robot_main.log',
    'order_worker.log',
    'order_stats_worker.log',
    'auth_revoke_worker.log',
    'tg_notify.log'
];

function exists(filePath) {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function fileBytes(filePath) {
    try {
        return Math.max(0, Number(fs.statSync(filePath).size || 0));
    } catch {
        return 0;
    }
}

function replaceFile(source, target) {
    try {
        fs.renameSync(source, target);
    } catch (err) {
        if (!['EEXIST', 'EPERM'].includes(String(err && err.code || ''))) throw err;
        if (exists(target)) fs.unlinkSync(target);
        fs.renameSync(source, target);
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStableFile(filePath, options = {}) {
    const intervalMs = Math.max(10, Number(options.interval_ms || 50));
    const maxChecks = Math.max(2, Number(options.max_checks || 6));
    let previous = '';
    let stableChecks = 0;
    for (let i = 0; i < maxChecks; i += 1) {
        const stat = fs.statSync(filePath);
        const signature = `${stat.size}:${stat.mtimeMs}`;
        if (signature === previous) stableChecks += 1;
        else stableChecks = 0;
        if (stableChecks >= 2) return;
        previous = signature;
        await delay(intervalMs);
    }
}

function parseLogTimestamp(line) {
    const raw = String(line || '');
    const match = raw.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]?/);
    if (!match) return null;
    const value = Date.parse(match[1].includes('T') ? match[1] : match[1].replace(' ', 'T'));
    return Number.isFinite(value) ? value : null;
}

async function writeLine(stream, line) {
    if (!stream.write(`${line}\n`, 'utf8')) await once(stream, 'drain');
}

async function filterSource(sourcePath, compressed, cutoffMs, output) {
    if (!exists(sourcePath) || fileBytes(sourcePath) === 0) {
        return { input_lines: 0, retained_lines: 0, removed_lines: 0, removed_raw_bytes: 0 };
    }
    const source = fs.createReadStream(sourcePath);
    const input = compressed ? source.pipe(zlib.createGunzip()) : source;
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let keepCurrentRecord = true;
    let inputLines = 0;
    let retainedLines = 0;
    let removedLines = 0;
    let removedRawBytes = 0;
    for await (const line of lines) {
        inputLines += 1;
        const timestamp = parseLogTimestamp(line);
        if (timestamp !== null) keepCurrentRecord = timestamp >= cutoffMs;
        if (keepCurrentRecord) {
            await writeLine(output, line);
            retainedLines += 1;
        } else {
            removedLines += 1;
            removedRawBytes += Buffer.byteLength(line, 'utf8') + 1;
        }
    }
    return {
        input_lines: inputLines,
        retained_lines: retainedLines,
        removed_lines: removedLines,
        removed_raw_bytes: removedRawBytes
    };
}

function workPaths(logDir, fileName) {
    const archiveDir = path.join(logDir, 'archive');
    const workDir = path.join(logDir, '.retention_work');
    return {
        active: path.join(logDir, fileName),
        history: path.join(archiveDir, `${fileName}.history.log.gz`),
        snapshot: path.join(workDir, `${fileName}.snapshot`),
        consumed: path.join(workDir, `${fileName}.consumed`),
        next: path.join(workDir, `${fileName}.history.next.gz`),
        archiveDir,
        workDir
    };
}

function recoverInterruptedCommit(paths) {
    if (exists(paths.consumed)) {
        if (exists(paths.next)) replaceFile(paths.next, paths.history);
        fs.unlinkSync(paths.consumed);
    } else if (exists(paths.next)) {
        fs.unlinkSync(paths.next);
    }
}

async function buildHistory(paths, cutoffMs) {
    const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
    const output = fs.createWriteStream(paths.next, { flags: 'w' });
    const finished = new Promise((resolve, reject) => {
        output.once('finish', resolve);
        output.once('error', reject);
        gzip.once('error', reject);
    });
    gzip.pipe(output);
    try {
        const history = await filterSource(paths.history, true, cutoffMs, gzip);
        const snapshot = await filterSource(paths.snapshot, false, cutoffMs, gzip);
        gzip.end();
        await finished;
        return {
            input_lines: history.input_lines + snapshot.input_lines,
            retained_lines: history.retained_lines + snapshot.retained_lines,
            removed_lines: history.removed_lines + snapshot.removed_lines,
            removed_raw_bytes: history.removed_raw_bytes + snapshot.removed_raw_bytes
        };
    } catch (err) {
        gzip.destroy();
        output.destroy();
        if (exists(paths.next)) fs.unlinkSync(paths.next);
        throw err;
    }
}

async function pruneSingleLog(fileName, options = {}) {
    const logDir = path.resolve(options.log_dir || options.logDir || DEFAULT_LOG_DIR);
    const retainDays = Math.max(1, Math.floor(Number(options.retention_days || options.retentionDays || DEFAULT_RETENTION_DAYS)));
    const now = options.now instanceof Date ? options.now : new Date();
    const cutoffMs = now.getTime() - retainDays * 24 * 60 * 60 * 1000;
    const paths = workPaths(logDir, fileName);
    fs.mkdirSync(paths.archiveDir, { recursive: true });
    fs.mkdirSync(paths.workDir, { recursive: true });
    recoverInterruptedCommit(paths);

    if (!exists(paths.snapshot)) {
        if (!exists(paths.active) && !exists(paths.history)) {
            return { file_name: fileName, skipped: true, reason: 'not_found' };
        }
        if (!exists(paths.active)) fs.closeSync(fs.openSync(paths.active, 'a'));
        fs.renameSync(paths.active, paths.snapshot);
        fs.closeSync(fs.openSync(paths.active, 'a'));
    } else if (!exists(paths.active)) {
        fs.closeSync(fs.openSync(paths.active, 'a'));
    }

    const beforeBytes = fileBytes(paths.history) + fileBytes(paths.snapshot) + fileBytes(paths.active);
    await waitForStableFile(paths.snapshot);
    const counts = await buildHistory(paths, cutoffMs);

    fs.renameSync(paths.snapshot, paths.consumed);
    replaceFile(paths.next, paths.history);
    fs.unlinkSync(paths.consumed);

    const afterBytes = fileBytes(paths.history) + fileBytes(paths.active);
    return {
        file_name: fileName,
        skipped: false,
        retention_days: retainDays,
        cutoff_at: new Date(cutoffMs).toISOString(),
        active_file: paths.active,
        archive_file: paths.history,
        before_bytes: beforeBytes,
        after_bytes: afterBytes,
        freed_bytes: Math.max(0, beforeBytes - afterBytes),
        ...counts
    };
}

async function pruneApplicationLogs(options = {}) {
    const retainDays = Math.max(1, Math.floor(Number(options.retention_days || options.retentionDays || DEFAULT_RETENTION_DAYS)));
    const requestedFiles = Array.isArray(options.files) && options.files.length > 0
        ? options.files.map((item) => String(item || '').trim()).filter(Boolean)
        : APPLICATION_LOG_FILES;
    const files = requestedFiles.filter((fileName) => APPLICATION_LOG_FILES.includes(fileName));
    const details = [];
    for (const fileName of files) {
        const result = await pruneSingleLog(fileName, { ...options, retention_days: retainDays });
        details.push(result);
        if (typeof options.on_progress === 'function') await options.on_progress(result);
    }
    const processed = details.filter((item) => !item.skipped);
    return {
        target: 'application_logs',
        retention_days: retainDays,
        log_dir: path.resolve(options.log_dir || options.logDir || DEFAULT_LOG_DIR),
        files: details,
        processed_files: processed.length,
        skipped_files: details.length - processed.length,
        deleted_rows: processed.reduce((sum, item) => sum + Number(item.removed_lines || 0), 0),
        before_bytes: processed.reduce((sum, item) => sum + Number(item.before_bytes || 0), 0),
        after_bytes: processed.reduce((sum, item) => sum + Number(item.after_bytes || 0), 0),
        estimated_deleted_bytes: processed.reduce((sum, item) => sum + Number(item.removed_raw_bytes || 0), 0),
        freed_bytes: processed.reduce((sum, item) => sum + Number(item.freed_bytes || 0), 0)
    };
}

module.exports = {
    DEFAULT_RETENTION_DAYS,
    DEFAULT_LOG_DIR,
    APPLICATION_LOG_FILES,
    parseLogTimestamp,
    pruneSingleLog,
    pruneApplicationLogs
};
