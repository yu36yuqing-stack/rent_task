const {
    initUserDb,
    createUserByAdmin,
    verifyUserLogin,
    getActiveUserByAccount,
    listActiveUsers
} = require('../database/user_db');

async function initUserModule() {
    await initUserDb();
}

async function login(account, password) {
    return verifyUserLogin(account, password);
}

// 当前业务无自助注册入口，用户数据仅允许管理员预置。
async function register() {
    throw new Error('当前未开放注册入口，请由管理员创建用户');
}

module.exports = {
    initUserModule,
    login,
    register,
    createUserByAdmin,
    getActiveUserByAccount,
    listActiveUsers
};
