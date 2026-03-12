const GAME_PROFILES = [
    {
        canonical_id: '1',
        canonical_name: 'WZRY',
        ids: ['1', 'A2705', '1104466820'],
        names: ['WZRY', 'wzry', '王者荣耀', '王者', '王者荣耀手游']
    },
    {
        canonical_id: '2',
        canonical_name: '和平精英',
        ids: ['2', 'A2706', '1106467070'],
        names: ['和平精英', '和平', 'HPJY', 'hpjy', 'PUBG', 'pubg', '和平精英手游']
    },
    {
        canonical_id: '3',
        canonical_name: 'CFM',
        ids: ['3', 'A2804', '1104512706'],
        names: ['CFM', 'cfm', '枪战王者', 'CFM枪战王者', '穿越火线', '穿越火线手游', '手游版CF']
    }
];

const PROFILE_BY_ID = new Map();
const PROFILE_BY_NAME = new Map();

for (const profile of GAME_PROFILES) {
    for (const id of profile.ids) {
        PROFILE_BY_ID.set(String(id).trim(), profile);
    }
    for (const name of profile.names) {
        const key = String(name).trim();
        if (!key) continue;
        PROFILE_BY_NAME.set(key, profile);
        PROFILE_BY_NAME.set(key.toLowerCase(), profile);
    }
    PROFILE_BY_NAME.set(profile.canonical_name, profile);
    PROFILE_BY_NAME.set(profile.canonical_name.toLowerCase(), profile);
}

function pickProfile(gameId, gameName) {
    const rawId = String(gameId || '').trim();
    const rawName = String(gameName || '').trim();
    if (rawId && PROFILE_BY_ID.has(rawId)) return PROFILE_BY_ID.get(rawId);
    if (rawName && PROFILE_BY_NAME.has(rawName)) return PROFILE_BY_NAME.get(rawName);
    if (rawName && PROFILE_BY_NAME.has(rawName.toLowerCase())) return PROFILE_BY_NAME.get(rawName.toLowerCase());
    return null;
}

function normalizeUnknownGameName(gameId, gameName) {
    const rawName = String(gameName || '').trim();
    if (rawName) return rawName;
    const rawId = String(gameId || '').trim();
    if (rawId) return `UNKNOWN_${rawId}`;
    return 'WZRY';
}

function normalizeGameProfile(gameId, gameName, options = {}) {
    const profile = pickProfile(gameId, gameName);
    if (profile) {
        return {
            game_id: profile.canonical_id,
            game_name: profile.canonical_name,
            canonical: true
        };
    }

    const preserveUnknown = options.preserveUnknown !== false;
    if (preserveUnknown) {
        const rawId = String(gameId || '').trim();
        const rawName = normalizeUnknownGameName(gameId, gameName);
        return {
            game_id: rawId || String(options.fallbackId || '1'),
            game_name: rawName,
            canonical: false
        };
    }

    return {
        game_id: String(options.fallbackId || '1'),
        game_name: String(options.fallbackName || 'WZRY').trim() || 'WZRY',
        canonical: false
    };
}

function canonicalGameName(inputName, fallbackName = 'WZRY') {
    return normalizeGameProfile('', inputName, {
        preserveUnknown: true,
        fallbackName
    }).game_name;
}

function canonicalGameId(inputId, inputName, fallbackId = '1') {
    return normalizeGameProfile(inputId, inputName, {
        preserveUnknown: true,
        fallbackId
    }).game_id;
}

function canonicalGameNameById(inputId, inputName, fallbackName = 'WZRY') {
    return normalizeGameProfile(inputId, inputName, {
        preserveUnknown: true,
        fallbackName
    }).game_name;
}

module.exports = {
    GAME_PROFILES,
    normalizeGameProfile,
    canonicalGameName,
    canonicalGameId,
    canonicalGameNameById
};
