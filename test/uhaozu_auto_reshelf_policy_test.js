'use strict';

const assert = require('assert');
const {
    UHAOZU_AUTO_RESHELF_CONFIG_KEY: key,
    normalizeUhaozuReshelfReason: normalize,
    validateUhaozuAutoReshelfValue: validate,
    loadUhaozuAutoReshelfPolicy: load,
    matchUhaozuAutoReshelfReason: match
} = require('../product/uhaozu_auto_reshelf_policy');

async function main() {
    assert.strictEqual(normalize(null), '');
    assert.strictEqual(normalize(' 账号 人脸识别： '), '账号人脸识别');
    assert.strictEqual(normalize('商品开启禁玩，已自动下架'), '商品开启禁玩,已自动下架');
    assert.deepStrictEqual(validate({ reasons: ['账号人脸识别', ' 账号人脸识别： ', '商品开启禁玩，已自动下架'] }), {
        reasons: ['账号人脸识别', '商品开启禁玩，已自动下架']
    });
    assert.deepStrictEqual(validate({ reasons: [] }), { reasons: [] });
    for (const value of [null, false, [], {}, { reasons: null }, { reasons: 'x' }, { reasons: [], enabled: true },
        { reasons: Array(101).fill('x') }, { reasons: [''] }, { reasons: [3] }, { reasons: [':'] },
        { reasons: ['x'.repeat(1001)] }]) {
        assert.throws(() => validate(value), { code: 'INVALID_UHAOZU_RESHELF_CONFIG' });
    }
    const reasons = ['检测游戏在线，请确认游戏离线后手动上架', '账号人脸识别', '商品开启禁玩,已自动下架'];
    let reads = 0;
    const getConfig = async (actualKey) => {
        reads++;
        assert.strictEqual(actualKey, key);
        return { found: true, id: 18, version: reads, value: { reasons: [...reasons] } };
    };
    const first = await load({ getConfig });
    const second = await load({ getConfig });
    assert.strictEqual(reads, 2, 'each round must get current database configuration');
    assert.strictEqual(first.version, 1);
    assert.strictEqual(second.version, 2);
    assert(Object.isFrozen(first) && Object.isFrozen(first.reasons));
    assert.throws(() => first.reasons.push('unexpected'));
    for (const text of [...reasons, '账号人脸识别：', ' 商品开启禁玩， 已自动下架 ', '检测到游戏在线，请离线后手动上架']) {
        assert.strictEqual(match(text, first), true, text);
    }
    for (const text of ['', null, '账号被冻结', '账号人脸识别：账号封禁', '商品开启禁玩,已自动下架，账号封禁',
        '当前商品被设置禁止上架', '账号异常，暂时无法完成游戏授权']) {
        assert.strictEqual(match(text, first), false, String(text));
    }
    const empty = await load({ getConfig: async () => ({ found: true, id: 1, version: 4, value: { reasons: [] } }) });
    assert.strictEqual(empty.available, true);
    assert.strictEqual(match(reasons[0], empty), false);
    const faceOnly = await load({ getConfig: async () => ({ found: true, value: { reasons: ['账号人脸识别'] } }) });
    assert.strictEqual(match(reasons[0], faceOnly), false);
    assert.strictEqual(match('检测到游戏在线，请离线后手动上架', faceOnly), false, 'legacy online matcher also respects removal');
    assert.strictEqual(match('账号人脸识别', faceOnly), true);
    for (const policy of [undefined, {}, { available: false, reasons }, { available: true, reasons: null }, { available: true, reasons: [null, ''] }]) {
        assert.strictEqual(match('账号人脸识别', policy), false);
    }
    const warnings = [];
    const missing = await load({ getConfig: async () => ({ found: false }), logger: { warn: (line) => warnings.push(line) } });
    assert.strictEqual(missing.available, false);
    assert.strictEqual(missing.error, 'SYSTEM_CONFIG_NOT_FOUND');
    const invalid = await load({ getConfig: async () => ({ found: true, id: 2, version: 5, value: 'sensitive-value' }),
        logger: { log: (line) => warnings.push(line) } });
    assert.strictEqual(invalid.id, 2);
    assert.strictEqual(invalid.version, 5);
    assert.strictEqual(invalid.error, 'INVALID_UHAOZU_RESHELF_CONFIG');
    const unavailable = await load({ getConfig: async () => { throw new Error('sensitive failure'); }, logger: {} });
    assert.strictEqual(unavailable.error, 'CONFIG_READ_FAILED');
    await load({ getConfig: async () => null, logger: { log: (line) => warnings.push(line) } });
    assert(warnings.every((line) => !line.includes('sensitive')));
    assert.strictEqual(match('账号人脸识别', invalid), false);
    assert.strictEqual(match('账号人脸识别', missing), false);
    console.log('[PASS] Uhaozu configuration validation, matching, immutable per-round snapshots and fail-closed reads');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
