const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = [
    'action_engine',
    'blacklist',
    'database',
    'h5',
    'order',
    'pipeline',
    'product',
    'report',
    'stats',
    'user'
];

const FILE_EXT_RE = /\.(js|md)$/i;

const RULES = [
    {
        id: 'frontend_pure_account_find',
        severity: 'P0',
        title: '前端按纯 game_account 查找当前卡片',
        regex: /find\(\(x\)\s*=>[\s\S]{0,160}?game_account[\s\S]{0,160}?===\s*[a-zA-Z_][a-zA-Z0-9_]*/g,
        customCheck: (snippet) => !/game_id/i.test(snippet)
    },
    {
        id: 'map_by_account_only',
        severity: 'P1',
        title: 'Map 仅按 game_account 建索引',
        regex: /new Map\([\s\S]{0,260}?game_account[\s\S]{0,140}?\]\)/g,
        customCheck: (snippet) => !/game_id/i.test(snippet)
    },
    {
        id: 'sql_where_account_only',
        severity: 'P0',
        title: 'SQL 仅按 game_account 查询/更新',
        regex: /WHERE[\s\S]{0,160}?game_account\s*=\s*\?/g,
        customCheck: (snippet) => !/game_id/i.test(snippet)
    },
    {
        id: 'sql_in_account_only',
        severity: 'P1',
        title: 'SQL 仅按 game_account IN 查询',
        regex: /WHERE[\s\S]{0,220}?game_account\s+IN\s*\(\$\{placeholders\}\)/g,
        customCheck: (snippet) => !/game_id/i.test(snippet)
    },
    {
        id: 'table_game_account_without_game_id',
        severity: 'P0',
        title: '表结构含 game_account 但未见 game_id',
        regex: /CREATE TABLE IF NOT EXISTS[\s\S]{0,800}?game_account TEXT[\s\S]{0,800}?\)/g,
        customCheck: (snippet) => !/game_id\s+TEXT/i.test(snippet)
    },
    {
        id: 'helper_name_account_only',
        severity: 'P2',
        title: 'Helper 命名仍是纯账号口径',
        regex: /list(AccountRemarksByUserAndAccounts|OwnersByGameAccounts|PlatformRestrictByUserAndAccounts)\s*\(/g
    }
];

function walk(dir, out = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
            continue;
        }
        if (!FILE_EXT_RE.test(entry.name)) continue;
        out.push(full);
    }
    return out;
}

function getLineInfo(text, index) {
    const before = text.slice(0, index);
    const line = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const col = index - lineStart + 1;
    return { line, col };
}

function compactSnippet(snippet = '') {
    return String(snippet || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

function scanFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    const hits = [];
    for (const rule of RULES) {
        const re = new RegExp(rule.regex.source, rule.regex.flags);
        let m;
        while ((m = re.exec(text))) {
            const snippet = m[0];
            if (typeof rule.customCheck === 'function' && !rule.customCheck(snippet)) continue;
            const pos = getLineInfo(text, m.index);
            hits.push({
                file,
                rule_id: rule.id,
                severity: rule.severity,
                title: rule.title,
                line: pos.line,
                col: pos.col,
                snippet: compactSnippet(snippet)
            });
        }
    }
    return hits;
}

function main() {
    const files = TARGET_DIRS
        .map((dir) => path.join(ROOT, dir))
        .filter((dir) => fs.existsSync(dir))
        .flatMap((dir) => walk(dir));

    const hits = files.flatMap(scanFile)
        .sort((a, b) => {
            const order = { P0: 0, P1: 1, P2: 2 };
            if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            return a.line - b.line;
        });

    const summary = hits.reduce((acc, hit) => {
        acc[hit.severity] = (acc[hit.severity] || 0) + 1;
        return acc;
    }, {});

    console.log(JSON.stringify({
        ok: true,
        scanned_files: files.length,
        total_hits: hits.length,
        summary,
        hits: hits.map((hit) => ({
            severity: hit.severity,
            title: hit.title,
            file: path.relative(ROOT, hit.file),
            line: hit.line,
            col: hit.col,
            rule_id: hit.rule_id,
            snippet: hit.snippet
        }))
    }, null, 2));
}

main();
