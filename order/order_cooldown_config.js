const { getUserRuleByName } = require('../database/user_rule_db');

const COOLDOWN_RELEASE_RULE_NAME = '冷却期释放时长';
const DEFAULT_COOLDOWN_RELEASE_DELAY_MIN = 10;
const MIN_COOLDOWN_RELEASE_DELAY_MIN = 0;
const MAX_COOLDOWN_RELEASE_DELAY_MIN = 120;

function normalizeCooldownReleaseDelayMin(v, fallback = DEFAULT_COOLDOWN_RELEASE_DELAY_MIN) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(MIN_COOLDOWN_RELEASE_DELAY_MIN, Math.min(MAX_COOLDOWN_RELEASE_DELAY_MIN, Math.floor(n)));
}

async function getCooldownConfigByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) {
        return {
            release_delay_min: DEFAULT_COOLDOWN_RELEASE_DELAY_MIN
        };
    }
    const rule = await getUserRuleByName(uid, COOLDOWN_RELEASE_RULE_NAME);
    const detail = rule && rule.rule_detail && typeof rule.rule_detail === 'object' ? rule.rule_detail : {};
    return {
        release_delay_min: normalizeCooldownReleaseDelayMin(
            detail.release_delay_min ?? detail.cooldown_release_delay_min ?? detail.value,
            DEFAULT_COOLDOWN_RELEASE_DELAY_MIN
        )
    };
}

module.exports = {
    COOLDOWN_RELEASE_RULE_NAME,
    DEFAULT_COOLDOWN_RELEASE_DELAY_MIN,
    MIN_COOLDOWN_RELEASE_DELAY_MIN,
    MAX_COOLDOWN_RELEASE_DELAY_MIN,
    normalizeCooldownReleaseDelayMin,
    getCooldownConfigByUser
};
