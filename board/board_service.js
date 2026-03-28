const crypto = require('crypto');
const { fetch } = require('undici');
const {
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
} = require('../database/board_card_db');

const BOARD_HTTP_USER = String(process.env.BOARD_HTTP_USER || 'admin').trim() || 'admin';
const BOARD_HTTP_PASSWORD = String(process.env.BOARD_HTTP_PASSWORD || 'admin');

function maskMobile(mobile) {
    const text = String(mobile || '').trim();
    if (!/^\d{11}$/.test(text)) return text;
    return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

function toDisplayAccount(row = {}) {
    const account = String(row.account || '').trim();
    const remark = String(row.remark || '').trim();
    const gameName = String(row.game_name || 'WZRY').trim() || 'WZRY';
    return {
        id: Number(row.id || 0),
        account,
        game_name: gameName,
        remark,
        display_name: remark ? `${remark}（${account}）` : account,
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

function md5(text) {
    return crypto.createHash('md5').update(String(text || ''), 'utf8').digest('hex');
}

function parseDigestChallenge(headerValue) {
    const raw = String(headerValue || '').trim();
    if (!raw.toLowerCase().startsWith('digest ')) return null;
    const body = raw.slice(7);
    const out = {};
    const regex = /(\w+)=("([^"]*)"|([^,]+))/g;
    let match = null;
    while ((match = regex.exec(body))) {
        out[match[1]] = String(match[3] !== undefined ? match[3] : match[4] || '').trim();
    }
    return out;
}

function buildDigestAuthorization({ method, uri, username, password, challenge, nc = '00000001' }) {
    const realm = String(challenge.realm || '').trim();
    const nonce = String(challenge.nonce || '').trim();
    const qopRaw = String(challenge.qop || 'auth').trim();
    const qop = qopRaw.split(',').map((item) => String(item || '').trim()).find((item) => item === 'auth') || 'auth';
    const opaque = String(challenge.opaque || '').trim();
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${String(method || 'GET').toUpperCase()}:${uri}`);
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    const parts = [
        `username="${username}"`,
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        `uri="${uri}"`,
        `response="${response}"`
    ];
    if (opaque) parts.push(`opaque="${opaque}"`);
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
    return `Digest ${parts.join(', ')}`;
}

function normalizeSmsPhone(phone) {
    const digits = String(phone || '').replace(/\D+/g, '');
    const normalized = digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
    if (!/^\d{11}$/.test(normalized)) throw new Error('收件人必须是 11 位手机号');
    return normalized;
}

async function sendBoardSmsRequest({ boardIp, sid, phone, content }) {
    const urlObj = new URL(`http://${boardIp}/mgr`);
    urlObj.searchParams.set('a', 'sendsms');
    urlObj.searchParams.set('sid', String(sid));
    urlObj.searchParams.set('phone', phone);
    urlObj.searchParams.set('content', content);
    const requestPath = `${urlObj.pathname}${urlObj.search}`;
    const first = await fetch(urlObj.toString(), {
        method: 'GET',
        headers: {
            Accept: '*/*',
            Referer: `http://${boardIp}/mgr`
        }
    });
    const challenge = parseDigestChallenge(first.headers.get('www-authenticate'));
    if (!challenge) {
        const firstBody = await first.text().catch(() => '');
        return {
            status: first.status,
            raw_text: String(firstBody || '').trim(),
            ok: first.ok
        };
    }
    const authHeader = buildDigestAuthorization({
        method: 'GET',
        uri: requestPath,
        username: BOARD_HTTP_USER,
        password: BOARD_HTTP_PASSWORD,
        challenge
    });
    const second = await fetch(urlObj.toString(), {
        method: 'GET',
        headers: {
            Accept: '*/*',
            Authorization: authHeader,
            Referer: `http://${boardIp}/mgr`
        }
    });
    const text = await second.text().catch(() => '');
    return {
        status: second.status,
        raw_text: String(text || '').trim(),
        ok: second.ok
    };
}

async function buildBoardCardTreeByUser(userId) {
    await initBoardCardDb();
    const boards = await listBoardCardsByUser(userId);
    const slots = await listBoardMobileSlotsByUser(userId);
    const accounts = await listBoardMobileAccountsByUser(userId);

    const accountMap = new Map();
    for (const row of accounts) {
        const slotId = Number(row.mobile_slot_id || 0);
        if (!accountMap.has(slotId)) accountMap.set(slotId, []);
        accountMap.get(slotId).push(toDisplayAccount(row));
    }

    const slotMap = new Map();
    for (const row of slots) {
        const boardId = Number(row.board_id || 0);
        if (!slotMap.has(boardId)) slotMap.set(boardId, []);
        const slotId = Number(row.id || 0);
        const slotAccounts = accountMap.get(slotId) || [];
        slotMap.get(boardId).push({
            id: slotId,
            slot_index: Number(row.slot_index || 0),
            mobile: String(row.mobile || '').trim(),
            mobile_masked: maskMobile(row.mobile),
            account_count: slotAccounts.length,
            accounts: slotAccounts,
            create_date: String(row.create_date || '').trim(),
            modify_date: String(row.modify_date || '').trim(),
            is_deleted: Number(row.is_deleted || 0),
            desc: String(row.desc || '').trim()
        });
    }

    const outBoards = boards.map((row) => {
        const boardId = Number(row.id || 0);
        const mobiles = (slotMap.get(boardId) || []).sort((a, b) => Number(a.slot_index || 0) - Number(b.slot_index || 0));
        return {
            id: boardId,
            board_name: String(row.board_name || '').trim() || `板卡#${boardId}`,
            board_ip: String(row.board_ip || '').trim(),
            board_mgr_path: String(row.board_mgr_path || DEFAULT_MGR_PATH).trim() || DEFAULT_MGR_PATH,
            mobile_count: mobiles.filter((item) => item.mobile).length,
            can_add_mobile_slot: mobiles.length < 2,
            create_date: String(row.create_date || '').trim(),
            modify_date: String(row.modify_date || '').trim(),
            is_deleted: Number(row.is_deleted || 0),
            desc: String(row.desc || '').trim(),
            mobiles
        };
    });

    const mobile_count = outBoards.reduce((sum, board) => sum + Number(board.mobile_count || 0), 0);
    const account_count = outBoards.reduce((sum, board) => {
        return sum + board.mobiles.reduce((inner, mobile) => inner + Number(mobile.account_count || 0), 0);
    }, 0);

    return {
        boards: outBoards,
        summary: {
            board_count: outBoards.length,
            mobile_count,
            account_count
        }
    };
}

async function listBoardCardsByUserTree(user) {
    return buildBoardCardTreeByUser(Number(user && user.id || 0));
}

async function getBoardCardByUser(user, boardId) {
    const uid = Number(user && user.id || 0);
    const boardList = await buildBoardCardTreeByUser(uid);
    const targetId = Number(boardId || 0);
    return boardList.boards.find((item) => Number(item.id || 0) === targetId) || null;
}

async function createBoardCardForUser(user, input = {}) {
    const uid = Number(user && user.id || 0);
    await createBoardCardByUser(uid, input);
    return buildBoardCardTreeByUser(uid);
}

async function createBoardMobileSlotForUser(user, input = {}) {
    const uid = Number(user && user.id || 0);
    await createBoardMobileSlotByUser(uid, input);
    return buildBoardCardTreeByUser(uid);
}

async function createBoardMobileAccountForUser(user, input = {}) {
    const uid = Number(user && user.id || 0);
    await createBoardMobileAccountByUser(uid, input);
    return buildBoardCardTreeByUser(uid);
}

async function listBoardSmsRecordsForUser(user, mobileSlotId) {
    const uid = Number(user && user.id || 0);
    const rows = await listBoardSmsRecordsByUser(uid, mobileSlotId);
    return rows.map((row) => ({
        id: Number(row.id || 0),
        board_id: Number(row.board_id || 0),
        mobile_slot_id: Number(row.mobile_slot_id || 0),
        sender_mobile: String(row.sender_mobile || '').trim(),
        recipient_mobile: String(row.recipient_mobile || '').trim(),
        sms_content: String(row.sms_content || '').trim(),
        send_status: String(row.send_status || '').trim(),
        send_result: String(row.send_result || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    }));
}

async function sendBoardSmsByUser(user, payload) {
    const board = await getBoardCardByUser(user, payload && payload.board_id);
    if (!board) {
        const err = new Error('板卡不存在或无权限访问');
        err.statusCode = 404;
        throw err;
    }
    const mobileId = Number(payload && payload.mobile_id || 0);
    const mobile = board.mobiles.find((item) => Number(item.id || 0) === mobileId);
    if (!mobile) {
        const err = new Error('手机号不存在或不属于当前板卡');
        err.statusCode = 400;
        throw err;
    }
    const recipient = normalizeSmsPhone(payload && payload.recipient);
    const content = String(payload && payload.content || '').trim();
    if (!content) {
        const err = new Error('短信内容不能为空');
        err.statusCode = 400;
        throw err;
    }
    let smsResult = null;
    let sendError = null;
    try {
        smsResult = await sendBoardSmsRequest({
            boardIp: board.board_ip,
            sid: Number(mobile.slot_index || 0),
            phone: recipient,
            content
        });
    } catch (e) {
        sendError = e;
        smsResult = {
            ok: false,
            status: Number(e && e.statusCode) || 500,
            raw_text: String((e && e.message) || '板卡短信请求异常').trim()
        };
    }
    try {
        await createBoardSmsRecordByUser(Number(user && user.id || 0), {
            board_id: board.id,
            mobile_slot_id: mobile.id,
            sender_mobile: mobile.mobile,
            recipient_mobile: recipient,
            sms_content: content,
            send_status: smsResult.ok ? 'success' : 'fail',
            send_result: smsResult.raw_text || `status=${smsResult.status}`,
            desc: 'board sendsms'
        });
    } catch (_) {
    }
    if (sendError) {
        const err = new Error(smsResult.raw_text || '板卡短信请求异常');
        err.statusCode = Number(sendError.statusCode || 502);
        throw err;
    }
    if (!smsResult.ok) {
        const err = new Error(smsResult.raw_text || `板卡短信接口调用失败(${smsResult.status})`);
        err.statusCode = 502;
        throw err;
    }
    return {
        board_id: board.id,
        mobile_id: mobile.id,
        mobile: mobile.mobile,
        recipient,
        slot_index: Number(mobile.slot_index || 0),
        message: smsResult.raw_text || '短信已发送'
    };
}

module.exports = {
    DEFAULT_MGR_PATH,
    initBoardCardDb,
    listBoardCardsByUserTree,
    getBoardCardByUser,
    createBoardCardForUser,
    createBoardMobileSlotForUser,
    createBoardMobileAccountForUser,
    listBoardSmsRecordsForUser,
    sendBoardSmsByUser
};
