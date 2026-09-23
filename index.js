require('dotenv').config();
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.BOT_TOKEN;
const BotClass = TelegramBot.TelegramBot || TelegramBot.default || TelegramBot;
const bot = new BotClass(token, { polling: true });;


const axios = require('axios');
const fs = require('fs');;

const botName = process.env.BOT_NAME || 'OTP BOT';
const adminId = process.env.ADMIN_ID;
const apiKey = process.env.API_KEY;
const baseUrl = process.env.BASE_URL;
const proofGroupId = process.env.PROOF_GROUP_ID;
const forceChannel = process.env.FORCE_JOIN_CHANNEL;
const otpGroupLink = process.env.VIEW_OTP_GROUP;
const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (mongoURI) {
    mongoose.connect(mongoURI)
        .then(() => console.log('✅ Connected to MongoDB Atlas Successfully!'))
        .catch(err => console.error('❌ MongoDB Connection Error:', err));
}

// ================= IN-MEMORY STORAGE (NO MONGODB) ================= //
// console.log(`✅ ${botName} Starting without MongoDB (Telegram Channel & Memory Mode)`);

const usersDB = {};          // { userId: { balance, totalOtps, totalWithdrawn, withdrawTimes, todayNumbersTaken, todayOtps } }
let servicesDB = [
    { name: '💬 WhatsApp', code: 'WhatsApp' },
    { name: '📸 Instagram', code: 'Instagram' },
    { name: '👥 Facebook', code: 'Facebook' },
    { name: '📞 IMO', code: 'IMO' },
    { name: '🎵 TikTok', code: 'TikTok' },
    { name: '🐦 Twitter / X', code: 'Twitter' },
    { name: '🌐 Google / Gmail', code: 'Google' },
    { name: '🪙 Binance', code: 'Binance' },
    { name: '🏦 N26', code: 'N26' },
    { name: '✈️ Telegram', code: 'Telegram' }
];
       // [{ code, name, apiService, apiTag }]
const rangesDB = [];         // [{ serviceCode, range }]
let pendingNumbersDB = [];  // [{ userId, number, serviceCode, date }]
let otpRecordsDB = [];      // [{ userId, number, otp, date }]

const settingsDB = {
    rate: 0.40,
    minWithdraw: 105,
    withdrawStatus: 'on',
    paymentMethods: 'bKash, Nagad',
    dailyReset: new Date().toDateString()
};

// Helper Functions for Local Data
function getUser(userId) {
    if (!usersDB[userId]) {
        usersDB[userId] = {
            userId: userId,
            balance: 0,
            totalOtps: 0,
            totalWithdrawn: 0,
            withdrawTimes: 0,
            todayNumbersTaken: 0,
            todayOtps: 0
        };
    }
    return usersDB[userId];
}


const apiClient = axios.create({ baseURL: baseUrl, headers: { 'mapikey': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }});
const fetchWithTimeout = (requestPromise, timeoutMs) => Promise.race([ requestPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('HARD_TIMEOUT')), timeoutMs)) ]);

const userStates = {};

const mainKeyboard = { reply_markup: { keyboard: [
    [{ text: '🚀 Get Number' }, { text: '🎯 Custom Range' }],
    [{ text: '💰 Wallet' }, { text: '🏦 Withdraw' }],
    [{ text: '📥 OTP History' }, { text: 'ℹ️ Bot Info' }]
], resize_keyboard: true } };

const getCountryFlag = (r) => {
    if(!r) return '🌍';
    if(r.startsWith('251')) return '🇪🇹 ET'; if(r.startsWith('232')) return '🇸🇱 SL';
    if(r.startsWith('225')) return '🇨🇮 CI'; if(r.startsWith('228')) return '🇹🇬 TG';
    if(r.startsWith('224')) return '🇬🇳 GN'; if(r.startsWith('62')) return '🇮🇩 ID';
    if(r.startsWith('234')) return '🇳🇬 NG'; if(r.startsWith('91')) return '🇮🇳 IN';
    if(r.startsWith('1')) return '🇺🇸 US'; return '🌍';
};

const getFullCountryName = (r) => {
    if(!r) return '🌍 Global';
    if(r.startsWith('251')) return '🇪🇹 Ethiopia'; if(r.startsWith('232')) return '🇸🇱 Sierra Leone';
    if(r.startsWith('225')) return '🇨🇮 Ivory Coast'; if(r.startsWith('228')) return '🇹🇬 Togo';
    if(r.startsWith('224')) return '🇬🇳 Guinea'; if(r.startsWith('62')) return '🇮🇩 Indonesia';
    if(r.startsWith('234')) return '🇳🇬 Nigeria'; if(r.startsWith('91')) return '🇮🇳 India';
    if(r.startsWith('1')) return '🇺🇸 USA'; return '🌍 Unknown';
};

// ================= FORCE JOIN (STRICT LOGIC) ================= //
async function checkMembership(chatId) {
    if(!forceChannel || chatId === adminId) return true;
    try {
        let channelId = forceChannel;
        if(channelId.startsWith('http')) {
            const parts = channelId.split('/');
            channelId = '@' + parts[parts.length - 1];
        }
        const member = await bot.getChatMember(channelId, chatId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (e) { return false; }
}

async function sendForceJoinMsg(chatId) {
    const channelUrl = forceChannel.startsWith('http') ? forceChannel : `https://t.me/${forceChannel.replace('@', '')}`;
    bot.sendMessage(chatId, `🛑 <b>Access Restricted!</b>\n\nTo use <b>${botName}</b>, you must join our official channel. Join first and click Verify!`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📢 Join Channel', url: channelUrl }], [{ text: '✅ Verify', callback_data: 'verify_join' }]] }
    });
}

// ================= BOT CORE ================= //
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id.toString();
    if (!(await checkMembership(chatId))) return sendForceJoinMsg(chatId);
    getUser(chatId);
    bot.sendMessage(chatId, `💠 <b>Welcome to ${botName}</b>\n👇 Select an option from the menu:`, { parse_mode: 'HTML', ...mainKeyboard });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    if(!text || text.startsWith('/')) return;

    if (!(await checkMembership(chatId))) return sendForceJoinMsg(chatId);

    try {
        const u = getUser(chatId);
        const state = userStates[chatId];

        // Withdraw Logic
        if (state && state.step === 'withdraw_number') {
            state.number = text;
            state.step = 'withdraw_amount';
            bot.sendMessage(chatId, `✏️ Please enter the <b>AMOUNT</b> you want to withdraw:\n(Available Balance: ${u.balance.toFixed(2)} TK)`, { parse_mode: 'HTML' });
            return;
        }
        if (state && state.step === 'withdraw_amount') {
            const amount = parseFloat(text);
            const minW = settingsDB.minWithdraw || 50;

            if (isNaN(amount) || amount <= 0 || amount > u.balance) {
                delete userStates[chatId];
                return bot.sendMessage(chatId, '❌ <b>Invalid Amount or Insufficient Balance!</b>\nWithdrawal request cancelled.', { parse_mode: 'HTML' });
            }
            if (amount < minW) {
                delete userStates[chatId];
                return bot.sendMessage(chatId, `❌ <b>Minimum withdrawal limit is ${minW} TK!</b>\nWithdrawal request cancelled.`, { parse_mode: 'HTML' });
            }

            u.balance -= amount;
            u.totalWithdrawn += amount;
            u.withdrawTimes += 1;

            bot.sendMessage(chatId, `✅ <b>Withdrawal Request Sent!</b>\n━━━━━━━━━━━━━━━━━━\n💰 <b>Amount:</b> ${amount} TK\n💳 <b>Method:</b> ${state.method}\n📞 <b>Account:</b> <code>${state.number}</code>\n━━━━━━━━━━━━━━━━━━\n⏳ Please wait for Admin approval.`, { parse_mode: 'HTML' });
            bot.sendMessage(adminId, `🚨 <b>NEW WITHDRAWAL REQUEST</b> 🚨\n━━━━━━━━━━━━━━━━━━\n👤 <b>User ID:</b> <code>${chatId}</code>\n💰 <b>Amount:</b> ${amount} TK\n💳 <b>Method:</b> ${state.method}\n📞 <b>Account:</b> <code>${state.number}</code>\n━━━━━━━━━━━━━━━━━━`, { parse_mode: 'HTML' });

            delete userStates[chatId]; return;
        }

        // Standard Menus
        if (text.includes('Wallet')) {
            bot.sendMessage(chatId, `💰 <b>Account Wallet:</b> ${u?.balance?.toFixed(2) || 0} TK\n🔥 <b>Total OTPs:</b> ${u?.totalOtps || 0}\n💳 <b>Total Withdrawn:</b> ${u?.totalWithdrawn?.toFixed(2) || 0} TK`, { parse_mode: 'HTML' });
        }
        else if (text.includes('Bot Info')) {
            const rate = settingsDB.rate || 0.50;
            const aboutText = `💠 <b>${botName.toUpperCase()}</b>  💠\n━━━━━━━━━━━━━━━━━━\nPremium automated OTP system.\n\n🔹 <b>Rate:</b> ${rate.toFixed(2)} TK per OTP.\n🔹 <b>Speed:</b> 24/7 Fast Catching\n\n━━━━━━━━━━━━━━━━━━\n ⚡ <b>Provider:</b> https://t.me/nscoinbuy/\n👨‍💻 <b>Developer:</b> @Arafat4466`;
            bot.sendMessage(chatId, aboutText, { parse_mode: 'HTML', disable_web_page_preview: true });
        }
        else if (text.includes('OTP History')) {
            const otps = otpRecordsDB.filter(o => o.userId === chatId);
            if (otps.length === 0) return bot.sendMessage(chatId, '❌ No OTPs found in the last 48 hours.');
            let fileContent = ""; otps.forEach(o => { fileContent += `${o.number}|${o.otp}\n`; });
            const fileName = `OTPs_${Date.now()}.txt`;
            fs.writeFileSync(fileName, fileContent);
            await bot.sendDocument(chatId, fileName, { caption: `✅ Here are your <b>${otps.length}</b> successful OTPs.`, parse_mode: 'HTML' });
            fs.unlinkSync(fileName);
            otpRecordsDB = otpRecordsDB.filter(o => o.userId !== chatId);
        }
        else if (text.includes('Withdraw')) {
            const wStatus = settingsDB.withdrawStatus || 'on';
            if (wStatus === 'off') return bot.sendMessage(chatId, '❌ <b>Withdrawals are currently CLOSED by the Admin.</b>\nPlease try again later.', { parse_mode: 'HTML' });

            const minW = settingsDB.minWithdraw || 50;
            if (u.balance < minW) return bot.sendMessage(chatId, ` ❌ <b>Your balance is low!</b>\nMinimum withdrawal amount is <b>${minW} TK</b>.\n\n💰 Your Balance: ${u.balance.toFixed(2)} TK`, { parse_mode: 'HTML' });

            const methodsStr = settingsDB.paymentMethods || 'bKash, Nagad';
            const methods = methodsStr.split(',');

            let buttons = [];
            for(let i=0; i<methods.length; i+=2) {
                let row = [];
                if(methods[i]) row.push({ text: `💳 ${methods[i].trim()}`, callback_data: `with_${methods[i].trim()}` });
                if(methods[i+1]) row.push({ text: `💳 ${methods[i+1].trim()}`, callback_data: `with_${methods[i+1].trim()}` });
                buttons.push(row);
            }
            buttons.push([{ text: `❌ Cancel`, callback_data: `with_cancel` }]);
            bot.sendMessage(chatId, '🏦 <b>Select Payment Method:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
        }
        else if (text.includes('Get Number')) showServices(chatId);
        else if (text.includes('Custom Range')) { userStates[chatId] = { step: 'custom' }; bot.sendMessage(chatId, '✏️ Type your specific range:'); }
        else if (/^[0-9]+X*$/i.test(text)) {
            delete userStates[chatId];
            getTwoNumbers(chatId, text.toUpperCase(), null);
        }
    } catch (e) {}
});

function showServices(chatId, messageId = null) {
  if (servicesDB.length === 0) {
    return bot.sendMessage(chatId, '❌ No services added yet.');
  }

  let keyboard = [];
  for (let i = 0; i < servicesDB.length; i += 2) {
    let row = [
      { text: servicesDB[i].name, callback_data: `srv_${servicesDB[i].code}` }
    ];
    if (servicesDB[i + 1]) {
      row.push({ text: servicesDB[i + 1].name, callback_data: `srv_${servicesDB[i + 1].code}` });
    }
    keyboard.push(row);
  }

  if (messageId) {
    bot.editMessageText('📌 <b>Select a service:</b>', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    bot.sendMessage(chatId, '📌 <b>Select a service:</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

async function showRanges(chatId, serviceCode, messageId = null) {
    try {
        const response = await apiClient.get('https://api.zenexnetwork.com/v1/active-ranges', {
            headers: { 'mapikey': apiKey }
        });

        const activeRanges = response.data && response.data.data && response.data.data.active_ranges
            ? response.data.data.active_ranges
            : [];

        let keyboard = [];
let addedRanges = new Set();
let currentRow = [];

activeRanges.forEach(r => {
    if (r.service && serviceCode && r.service.toLowerCase() === serviceCode.toLowerCase()) {
        const flag = typeof getCountryFlag === 'function' ? getCountryFlag(r.range) : '🌍';
        if (!addedRanges.has(r.range)) {
            addedRanges.add(r.range);
            const rangeName = `🟢 ${flag} | ${r.range}`;

            currentRow.push({
                text: rangeName,
                callback_data: `buy_${serviceCode}_${r.range}`
            });

            if (currentRow.length === 2) {
                keyboard.push(currentRow);
                currentRow = [];
            }
        }
    }
});

        keyboard.push([{ text: '« Back', callback_data: 'back_srv' }]);
        const replyMarkup = { inline_keyboard: keyboard };

        if (keyboard.length <= 1) {
            const emptyMsg = '❌ No ranges available right now.';
            return messageId
                ? bot.editMessageText(emptyMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: replyMarkup })
                : bot.sendMessage(chatId, emptyMsg, { parse_mode: 'HTML', reply_markup: replyMarkup });
        }

        const text = '<b>👇 Select Range:</b>';
        if (messageId) {
            return bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            });
        } else {
            return bot.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            });
        }

    } catch (error) {
        console.error("API Error:", error.message);
        const errorMsg = '❌ Failed to fetch ranges from API.';
        if (messageId) {
            return bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        } else {
            return bot.sendMessage(chatId, errorMsg, { parse_mode: 'HTML' });
        }
    }
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const data = query.data;

    if (data === 'verify_join') {
        const isMember = await checkMembership(chatId);
        if (isMember) {
            bot.answerCallbackQuery(query.id, { text: "✅ Verified successfully! Welcome.", show_alert: true });
            bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
            getUser(chatId);
            bot.sendMessage(chatId, `💠 <b>Welcome to ${botName}</b>\n👇 Select an option from the menu:`, { parse_mode: 'HTML', ...mainKeyboard });
        } else {
            bot.answerCallbackQuery(query.id, { text: "❌ You haven't joined the channel yet! Join first.", show_alert: true });
        }
        return;
    }

    if (!(await checkMembership(chatId))) {
        bot.answerCallbackQuery(query.id, { text: "Join Channel First!", show_alert: true });
        return;
    }

    if (data === 'with_cancel') {
        delete userStates[chatId];
        bot.editMessageText('❌ Withdrawal Request Cancelled.', { chat_id: chatId, message_id: query.message.message_id }).catch(()=>{});
        return;
    }

    if (data.startsWith('with_')) {
        const method = data.replace('with_', '');
        userStates[chatId] = { step: 'withdraw_number', method: method };
        bot.editMessageText(`🏦 <b>Method:</b> ${method}\n\n✏️ Please enter your <b>${method} Account Number</b>:`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }).catch(()=>{});
        return;
    }

    if (data === 'back_srv') return showServices(chatId, query.message.message_id);

if (data.startsWith('srv_')) {
    const serviceCode = data.replace('srv_', '');
    const messageId = query.message.message_id;
    return showRanges(chatId, serviceCode, messageId);
}

    if (data.startsWith('buy_') || data.startsWith('getmore_')) {
        const prefix = data.startsWith('buy_') ? 'buy_' : 'getmore_';
        const parts = data.replace(prefix, '').split('_');
        const srvCode = parts[0]; const range = parts.slice(1).join('_');
        getTwoNumbers(chatId, range, srvCode, query.message.message_id);
    }
});

const extractNum = (res) => { let n = res?.data?.data?.full_number || res?.data?.data?.copy || null; return n ? n.toString().replace(/[\s\+\-]/g, '') : null; };

async function getTwoNumbers(chatId, range, srvCodeFromBtn = null, editMsgId = null) {
    let targetMsgId = editMsgId;
    if (editMsgId) bot.editMessageText(`⏳ <i>Searching for new numbers from ${range}...</i>`, { chat_id: chatId, message_id: targetMsgId, parse_mode: 'HTML' }).catch(()=>{});
    else { const loadingMsg = await bot.sendMessage(chatId, `⏳ <i>Searching for numbers from ${range}...</i>`, { parse_mode: 'HTML' }); targetMsgId = loadingMsg.message_id; }

    try {
        const req1 = await fetchWithTimeout(apiClient.post('/getnum', { range, is_national: false, remove_plus: false }), 8000).catch(e=>e.response);
        await new Promise(r => setTimeout(r, 1500));
        const req2 = await fetchWithTimeout(apiClient.post('/getnum', { range, is_national: false, remove_plus: false }), 8000).catch(e=>e.response);

        let num1 = extractNum(req1), num2 = extractNum(req2);
        let findRangeObj = rangesDB.find(r => r.range === range.toUpperCase());
        let srvCode = srvCodeFromBtn || (findRangeObj ? findRangeObj.serviceCode : 'unknown');

        let countFound = 0;
        const now = Date.now();
        if(num1) { countFound++; pendingNumbersDB.push({ userId: chatId, number: num1, serviceCode: srvCode, date: now }); }
        if(num2) { countFound++; pendingNumbersDB.push({ userId: chatId, number: num2, serviceCode: srvCode, date: now }); }

        if (countFound > 0) {
            const u = getUser(chatId);
            u.todayNumbersTaken += countFound;

            const countryName = getFullCountryName(range);
            let text = `🌟 <b>𝗡𝗨𝗠𝗕𝗘𝗥𝗦 𝗔𝗟𝗟𝗢𝗖𝗔𝗧𝗘𝗗</b> 🌟\n━━━━━━━━━━━━━━━━━━\n 🌍 <b>Country:</b> ${countryName}\n\n`;
            if(num1) text += `1️⃣ <b>Number:</b> <code>${num1}</code>\n`;
            if(num2) text += `2️⃣ <b>Number:</b> <code>${num2}</code>\n`;
            text += `━━━━━━━━━━━━━━━━━━\n<i>⏳ Waiting for OTP... (Timeout: 20m)</i>`;

            bot.editMessageText(text, { chat_id: chatId, message_id: targetMsgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [ [{ text: `🔄 Get More Numbers`, callback_data: `getmore_${srvCode}_${range}` }], [{ text: `⬅️ Back`, callback_data: `back_srv` }], [{ text: `👀 View OTP Group`, url: otpGroupLink }] ] } });
        } else {
            bot.editMessageText(`❌ No numbers available in <b>${range}</b>.`, { chat_id: chatId, message_id: targetMsgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [ [{ text: `🔄 Try Again`, callback_data: `getmore_${srvCode}_${range}` }], [{ text: `⬅️ Back`, callback_data: `back_srv` }] ] } });
        }
    } catch (e) {}
}

// ================= GLOBAL OTP CATCHER ================= //
setInterval(async () => {
    try {
        const response = await fetchWithTimeout(apiClient.get('/numsuccess/info'), 10000);
        const otps = response.data?.data?.otps || [];
        for (let item of otps) {
            let rawNum = item.number || item.phone || item.full_number || "";
            let rawOtp = item.otp || item.code || item.sms || "";
            const apiNumCleaned = rawNum.toString().replace(/[\s\+\-]/g, '');
            const otpStr = rawOtp.toString();

            const matchCode = otpStr.match(/\b\d{5,8}\b/);
            const finalOtpToShow = matchCode ? matchCode[0] : otpStr;

            const alreadyDone = otpRecordsDB.find(o => o.number === apiNumCleaned && o.otp === otpStr);
            if (alreadyDone) continue;

            let pending = pendingNumbersDB.find(p => apiNumCleaned.endsWith(p.number) || p.number.endsWith(apiNumCleaned));
            if (!pending) continue;

            otpRecordsDB.push({ userId: pending.userId, number: apiNumCleaned, otp: otpStr, date: Date.now() });

            const serviceObj = servicesDB.find(s => s.code === pending.serviceCode);
            let platformName = serviceObj ? serviceObj.name : 'Auto Detected';

            const rewardRate = settingsDB.rate || 0.50;

            const u = getUser(pending.userId);
            u.balance += rewardRate;
            u.totalOtps += 1;
            u.todayOtps += 1;

            const userFlag = getCountryFlag(apiNumCleaned);

            bot.sendMessage(pending.userId, `🎉 <b>SUCCESS! OTP RECEIVED</b> 🎉\n━━━━━━━━━━━━━━━━━━\n📲 <b>App:</b> ${platformName}\n 🌍 <b>Region:</b> ${userFlag}\n📞 <b>Number:</b> <code>${apiNumCleaned}</code>\n💬 <b>Code:</b> <code>${finalOtpToShow}</code>\n━━━━━━━━━━━━━━━━━━\n💰 <b>Added: +${rewardRate.toFixed(2)} TK</b>`, { parse_mode: 'HTML' });

            let groupPlatformName = platformName;
            if (/Facebook PC Clone/i.test(groupPlatformName)) groupPlatformName = 'Facebook Clone';
            else if (/Facebook New Account/i.test(groupPlatformName)) groupPlatformName = 'Facebook New';

            const fullCountryName = getFullCountryName(apiNumCleaned);
            const maskedNumber = apiNumCleaned.length > 8 ? apiNumCleaned.substring(0, 5) + '***' + apiNumCleaned.substring(apiNumCleaned.length - 3) : apiNumCleaned;

            const proofText = `💠 <b>${botName.toUpperCase()} SUCCESS</b> 💠\n━━━━━━━━━━━━━━━━━━\n📲 <b>Platform:</b> ${groupPlatformName}\n🌍 <b>Country:</b> ${fullCountryName}\n 📞 <b>Number:</b> <code>${maskedNumber}</code>\n💬 <b>Code:</b> <code>${finalOtpToShow}</code>\n💰 <b>Earned:</b> +${rewardRate.toFixed(2)} TK\n━━━━━━━━━━━━━━━━━━\n⚡ <b>Provider: ZENEX NETWORK</b>`;
            if(proofGroupId) bot.sendMessage(proofGroupId, proofText, { parse_mode: 'HTML' }).catch(e => {});
        }
    } catch (e) {}
}, 5000);

setInterval(async () => {
    try {
        const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);
        const twentyMinsAgo = Date.now() - (20 * 60 * 1000);

        otpRecordsDB = otpRecordsDB.filter(o => o.date >= twoDaysAgo);
        pendingNumbersDB = pendingNumbersDB.filter(p => p.date >= twentyMinsAgo);

        const today = new Date().toDateString();
        if (settingsDB.dailyReset !== today) {
            Object.keys(usersDB).forEach(id => {
                usersDB[id].todayNumbersTaken = 0;
                usersDB[id].todayOtps = 0;
            });
            settingsDB.dailyReset = today;
        }
    } catch (e) {}
}, 60 * 60 * 1000);

// ================= ADMIN COMMANDS ================= //
bot.onText(/\/withoff/, async (msg) => { if(msg.chat.id.toString()!==adminId) return; settingsDB.withdrawStatus = 'off'; bot.sendMessage(adminId, "🛑 Withdraw System OFF"); });
bot.onText(/\/withon/, async (msg) => { if(msg.chat.id.toString()!==adminId) return; settingsDB.withdrawStatus = 'on'; bot.sendMessage(adminId, "✅ Withdraw System ON"); });
bot.onText(/\/setmin (.+)/, async (msg, match) => { if(msg.chat.id.toString()!==adminId) return; settingsDB.minWithdraw = parseFloat(match[1]); bot.sendMessage(adminId, `✅ Minimum Withdraw set to ${match[1]} TK`); });
bot.onText(/\/setmethods (.+)/, async (msg, match) => { if(msg.chat.id.toString()!==adminId) return; settingsDB.paymentMethods = match[1]; bot.sendMessage(adminId, ` ✅ Payment Methods set to: ${match[1]}`); });

bot.onText(/\/testgroup/, async (msg) => {
    if (msg.chat.id.toString() !== adminId) return;
    try {
        await bot.sendMessage(proofGroupId, "✅ <b>Proof Group Connected Successfully!</b>", { parse_mode: 'HTML' });
        bot.sendMessage(adminId, "✅ <b>Success! Group connected.</b>", { parse_mode: 'HTML' });
    } catch (error) { bot.sendMessage(adminId, `❌ <b>Error:</b> ${error.message}`); }
});
bot.onText(/\/pending/, async (msg) => { if(msg.chat.id.toString()===adminId) { bot.sendMessage(adminId, `⏳ Pending Numbers: ${pendingNumbersDB.length}`); }});
bot.onText(/\/testotp/, async (msg) => { if(msg.chat.id.toString()===adminId) bot.sendMessage(adminId, "⏳ API OK"); });

bot.onText(/\/addservice (.+)\|(.+)\|(.+)\|(.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const code = match[1].trim(); const apiService = match[2].trim(); const apiTag = match[3].trim(); const name = match[4].trim();

    const existingIndex = servicesDB.findIndex(s => s.code === code);
    if(existingIndex !== -1) servicesDB[existingIndex] = { code, apiService, apiTag, name };
    else servicesDB.push({ code, apiService, apiTag, name });

    bot.sendMessage(adminId, `✅ Service Added: ${name}`);
});

bot.onText(/\/addrange (.+) (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const srvCode = match[1].trim(); const range = match[2].trim().toUpperCase();

    const existingIndex = rangesDB.findIndex(r => r.range === range);
    if(existingIndex !== -1) rangesDB[existingIndex] = { serviceCode: srvCode, range: range };
    else rangesDB.push({ serviceCode: srvCode, range: range });

    bot.sendMessage(adminId, `✅ Range Added!`);
});

bot.onText(/\/delservice (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const code = match[1].trim().toLowerCase();

    let initialLen = servicesDB.length;
    for (let i = servicesDB.length - 1; i >= 0; i--) {
        if (servicesDB[i].code.trim().toLowerCase() === code) {
            const targetCode = servicesDB[i].code;
            servicesDB.splice(i, 1);
            for (let j = rangesDB.length - 1; j >= 0; j--) {
                if(rangesDB[j].serviceCode === targetCode) rangesDB.splice(j, 1);
            }
        }
    }
    if (servicesDB.length < initialLen) bot.sendMessage(adminId, ` ✅ Service Deleted.`);
    else bot.sendMessage(adminId, `❌ Service not found.`);
});

bot.onText(/\/delrange (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const targetRange = match[1].trim().toUpperCase();
    for (let i = rangesDB.length - 1; i >= 0; i--) {
        if (rangesDB[i].range === targetRange) rangesDB.splice(i, 1);
    }
    bot.sendMessage(adminId, `✅ Range Deleted.`);
});

bot.onText(/\/setrate (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    settingsDB.rate = parseFloat(match[1]);
    bot.sendMessage(adminId, `✅ Rate updated to ${match[1]} TK`);
});

bot.onText(/\/notice ([\s\S]+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const userIds = Object.keys(usersDB); let sent = 0;
    bot.sendMessage(adminId, `📢 Broadcasting notice...`);
    for (let id of userIds) { try { await bot.sendMessage(id, `📢 <b>NOTICE:</b>\n\n${match[1]}`, { parse_mode: 'HTML' }); sent++; } catch(e){} }
    bot.sendMessage(adminId, `✅ Notice sent to ${sent} users.`);
});
