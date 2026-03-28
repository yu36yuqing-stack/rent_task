const { openDatabase } = require('./sqlite_client');
const { getAliveUserGameAccountByUserAndAccount } = require('./user_game_account_db');

const DEFAULT_MGR_PATH = '/mgr';

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function normalizeUserId(userId) {
    return Number(userId || 0);
}

function normalizeBoardName(name) {
    return String(name || '').trim();
}

function normalizeBoardIp(ip) {
    return String(ip || '').trim();
}

function normalizeMgrPath(pathname) {
    const text = String(pathname || DEFAULT_MGR_PATH).trim() || DEFAULT_MGR_PATH;
    return text.startsWith('/') ? text : `/${text}`;
}

function normalizeMobile(mobile) {
    const digits = String(mobile || '').replace(/\D+/g, '');
    const normalized = digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
    if (!/^\d{11}$/.test(normalized)) throw new Error('手机号必须是 11 位数字');
    return normalized;
}

function normalizeSlotIndex(slotIndex) {
    const n = Number(slotIndex || 0);
    if (!Number.isFinite(n) || n < 1 || n > 2) throw new Error('卡槽只能选择 卡1 或 卡2');
    return Math.floor(n);
}

function normalizeAccount(account) {
    return String(account || '').trim();
}

function normalizeRemark(remark) {
    return String(remark || '').trim();
}

function maskMobile(mobile) {
    const text = String(mobile || '').trim();
    if (!/^\d{11}$/.test(text)) return text;
    return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

async function initBoardCardDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS board_card (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                board_name TEXT NOT NULL,
                board_ip TEXT NOT NULL,
                board_mgr_path TEXT NOT NULL DEFAULT '/mgr',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE TABLE IF NOT EXISTS board_mobile_slot (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                board_id INTEGER NOT NULL,
                slot_index INTEGER NOT NULL,
                mobile TEXT NOT NULL,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE TABLE IF NOT EXISTS board_mobile_account (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                mobile_slot_id INTEGER NOT NULL,
                account TEXT NOT NULL,
                remark TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE TABLE IF NOT EXISTS board_sms_record (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                board_id INTEGER NOT NULL,
                mobile_slot_id INTEGER NOT NULL,
                sender_mobile TEXT NOT NULL DEFAULT '',
                recipient_mobile TEXT NOT NULL DEFAULT '',
                sms_content TEXT NOT NULL DEFAULT '',
                send_status TEXT NOT NULL DEFAULT '',
                send_result TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_board_card_alive
            ON board_card(user_id, board_ip, is_deleted)
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_board_mobile_slot_alive
            ON board_mobile_slot(user_id, board_id, slot_index, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_board_mobile_slot_board_alive
            ON board_mobile_slot(board_id, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_board_mobile_account_slot_alive
            ON board_mobile_account(mobile_slot_id, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_board_sms_record_slot_alive
            ON board_sms_record(mobile_slot_id, is_deleted, id DESC)
        `);
    } finally {
        db.close();
    }
}

async function seedBoardCardsByUserIfNeeded(userId) {
    await initBoardCardDb();
    const uid = normalizeUserId(userId);
    if (!uid) return;
    const db = openDatabase();
    try {
        const countRow = await get(db, `
            SELECT COUNT(1) AS total
            FROM board_card
            WHERE user_id = ? AND is_deleted = 0
        `, [uid]);
        if (Number(countRow && countRow.total || 0) > 0) return;
        return;
    } finally {
        db.close();
    }
}

function rowToBoard(row = {}) {
    return {
        id: Number(row.id || 0),
        board_name: String(row.board_name || '').trim(),
        board_ip: String(row.board_ip || '').trim(),
        board_mgr_path: normalizeMgrPath(row.board_mgr_path || DEFAULT_MGR_PATH),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function listBoardCardsByUser(userId) {
    await seedBoardCardsByUserIfNeeded(userId);
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM board_card
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
    } finally {
        db.close();
    }
}

async function listBoardMobileSlotsByUser(userId) {
    await seedBoardCardsByUserIfNeeded(userId);
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM board_mobile_slot
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY board_id ASC, slot_index ASC, id ASC
        `, [uid]);
    } finally {
        db.close();
    }
}

async function listBoardMobileAccountsByUser(userId) {
    await seedBoardCardsByUserIfNeeded(userId);
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM board_mobile_account
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY mobile_slot_id ASC, id ASC
        `, [uid]);
    } finally {
        db.close();
    }
}

async function createBoardCardByUser(userId, input = {}) {
    await initBoardCardDb();
    const uid = normalizeUserId(userId);
    const boardName = normalizeBoardName(input.board_name);
    const boardIp = normalizeBoardIp(input.board_ip);
    const boardMgrPath = normalizeMgrPath(input.board_mgr_path || DEFAULT_MGR_PATH);
    const desc = String(input.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!boardName) throw new Error('板卡名称不能为空');
    if (!boardIp) throw new Error('板卡 IP 不能为空');
    const db = openDatabase();
    try {
        const exists = await get(db, `
            SELECT id
            FROM board_card
            WHERE user_id = ? AND board_ip = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, boardIp]);
        if (exists) throw new Error('该板卡 IP 已存在');
        const now = nowText();
        const ret = await run(db, `
            INSERT INTO board_card
            (user_id, board_name, board_ip, board_mgr_path, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `, [uid, boardName, boardIp, boardMgrPath, now, now, desc]);
        const row = await get(db, `SELECT * FROM board_card WHERE id = ?`, [Number(ret.lastID || 0)]);
        return rowToBoard(row);
    } finally {
        db.close();
    }
}

async function createBoardMobileSlotByUser(userId, input = {}) {
    await initBoardCardDb();
    const uid = normalizeUserId(userId);
    const boardId = Number(input.board_id || 0);
    const slotIndex = normalizeSlotIndex(input.slot_index);
    const mobile = normalizeMobile(input.mobile);
    const desc = String(input.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!boardId) throw new Error('board_id 不能为空');
    const db = openDatabase();
    try {
        const board = await get(db, `
            SELECT *
            FROM board_card
            WHERE id = ? AND user_id = ? AND is_deleted = 0
            LIMIT 1
        `, [boardId, uid]);
        if (!board) throw new Error('板卡不存在');
        const slots = await all(db, `
            SELECT *
            FROM board_mobile_slot
            WHERE board_id = ? AND user_id = ? AND is_deleted = 0
            ORDER BY slot_index ASC, id ASC
        `, [boardId, uid]);
        if (slots.length >= 2) throw new Error('一张板卡最多只能绑定 2 个卡位手机号');
        if (slots.some((item) => String(item.mobile || '').trim() === mobile)) throw new Error('该手机号已绑定到当前板卡');
        if (slots.some((item) => Number(item.slot_index || 0) === slotIndex)) throw new Error(`卡${slotIndex} 已被占用`);
        const now = nowText();
        const ret = await run(db, `
            INSERT INTO board_mobile_slot
            (user_id, board_id, slot_index, mobile, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `, [uid, boardId, slotIndex, mobile, now, now, desc]);
        return await get(db, `SELECT * FROM board_mobile_slot WHERE id = ?`, [Number(ret.lastID || 0)]);
    } finally {
        db.close();
    }
}

async function createBoardMobileAccountByUser(userId, input = {}) {
    await initBoardCardDb();
    const uid = normalizeUserId(userId);
    const mobileSlotId = Number(input.mobile_slot_id || 0);
    const account = normalizeAccount(input.account);
    const desc = String(input.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!mobileSlotId) throw new Error('mobile_slot_id 不能为空');
    if (!account) throw new Error('账号不能为空');
    const accountRow = await getAliveUserGameAccountByUserAndAccount(uid, account);
    if (!accountRow) throw new Error('账号不存在');
    const remark = normalizeRemark(accountRow.account_remark);
    const db = openDatabase();
    try {
        const slot = await get(db, `
            SELECT *
            FROM board_mobile_slot
            WHERE id = ? AND user_id = ? AND is_deleted = 0
            LIMIT 1
        `, [mobileSlotId, uid]);
        if (!slot) throw new Error('手机号卡位不存在');
        const accounts = await all(db, `
            SELECT *
            FROM board_mobile_account
            WHERE mobile_slot_id = ? AND user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [mobileSlotId, uid]);
        if (accounts.length >= 5) throw new Error('一个手机号最多只能绑定 5 个账号');
        if (accounts.some((item) => String(item.account || '').trim() === account)) throw new Error('该账号已绑定到当前手机号');
        const now = nowText();
        const ret = await run(db, `
            INSERT INTO board_mobile_account
            (user_id, mobile_slot_id, account, remark, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `, [uid, mobileSlotId, account, remark, now, now, desc]);
        return await get(db, `SELECT * FROM board_mobile_account WHERE id = ?`, [Number(ret.lastID || 0)]);
    } finally {
        db.close();
    }
}

async function createBoardSmsRecordByUser(userId, input = {}) {
    await initBoardCardDb();
    const uid = normalizeUserId(userId);
    const boardId = Number(input.board_id || 0);
    const mobileSlotId = Number(input.mobile_slot_id || 0);
    const senderMobile = String(input.sender_mobile || '').trim();
    const recipientMobile = String(input.recipient_mobile || '').trim();
    const smsContent = String(input.sms_content || '').trim();
    const sendStatus = String(input.send_status || '').trim();
    const sendResult = String(input.send_result || '').trim();
    const desc = String(input.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    const db = openDatabase();
    try {
        const now = nowText();
        const ret = await run(db, `
            INSERT INTO board_sms_record
            (user_id, board_id, mobile_slot_id, sender_mobile, recipient_mobile, sms_content, send_status, send_result, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [uid, boardId, mobileSlotId, senderMobile, recipientMobile, smsContent, sendStatus, sendResult, now, now, desc]);
        return await get(db, `SELECT * FROM board_sms_record WHERE id = ?`, [Number(ret.lastID || 0)]);
    } finally {
        db.close();
    }
}

async function listBoardSmsRecordsByUser(userId, mobileSlotId) {
    await initBoardCardDb();
    const uid = normalizeUserId(userId);
    const slotId = Number(mobileSlotId || 0);
    if (!uid || !slotId) return [];
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM board_sms_record
            WHERE user_id = ? AND mobile_slot_id = ? AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 100
        `, [uid, slotId]);
    } finally {
        db.close();
    }
}

module.exports = {
    DEFAULT_MGR_PATH,
    initBoardCardDb,
    listBoardCardsByUser,
    listBoardMobileSlotsByUser,
    listBoardMobileAccountsByUser,
    listBoardSmsRecordsByUser,
    createBoardCardByUser,
    createBoardMobileSlotByUser,
    createBoardMobileAccountByUser,
    createBoardSmsRecordByUser
};
