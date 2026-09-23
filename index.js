require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');
const fs = require('fs');

const botName = process.env.BOT_NAME || 'OTP BOT';
const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_ID;
const apiKey = process.env.API_KEY;
const baseUrl = process.env.BASE_URL;
const mongoUri = process.env.MONGODB_URI;
const proofGroupId = process.env.PROOF_GROUP_ID;
const forceChannel = process.env.FORCE_JOIN_CHANNEL;
const otpGroupLink = process.env.VIEW_OTP_GROUP;

// ================= DATABASE ================= //
mongoose.connect(mongoUri).then(() => console.log(`✅ ${botName} DB Connected`)).catch(err => console.log('❌ DB Error:', err));

const userSchema = new mongoose.Schema({
    userId: String, balance: { type: Number, default: 0 }, totalOtps: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 }, withdrawTimes: { type: Number, default: 0 },
    todayNumbersTaken: { type: Number, default: 0 }, todayOtps: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);
const Range = mongoose.model('Range', new mongoose.Schema({ serviceCode: String, range: String }));
const Service = mongoose.model('Service', new mongoose.Schema({ code: String, name: String, apiService: String, apiTag: String }));
const Settings = mongoose.model('Settings', new mongoose.Schema({ type: String, value: Number, stringValue: String }));

const PendingNumber = mongoose.model('PendingNumber', new mongoose.Schema({ userId: String, number: String, serviceCode: String, date: { type: Date, default: Date.now, expires: 1200 } }));
const OtpRecord = mongoose.model('OtpRecord', new mongoose.Schema({ userId: String, number: String, otp: String, date: { type: Date, default: Date.now, expires: 172800 } }));

const bot = new TelegramBot(token, { polling: true });
const apiClient = axios.create({ baseURL: baseUrl, headers: { 'mapikey': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }});
const fetchWithTimeout = (requestPromise, timeoutMs) => Promise.race([ requestPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('HARD_TIMEOUT')), timeoutMs)) ]);

Settings.findOne({ type: 'rate' }).then(res => { if (!res) new Settings({ type: 'rate', value: 0.50 }).save(); });
Settings.findOne({ type: 'minWithdraw' }).then(res => { if (!res) new Settings({ type: 'minWithdraw', value: 50 }).save(); });
Settings.findOne({ type: 'withdrawStatus' }).then(res => { if (!res) new Settings({ type: 'withdrawStatus', stringValue: 'on' }).save(); });
Settings.findOne({ type: 'paymentMethods' }).then(res => { if (!res) new Settings({ type: 'paymentMethods', stringValue: 'bKash, Nagad' }).save(); });

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
    await User.findOneAndUpdate({ userId: chatId }, {}, { upsert: true });
    bot.sendMessage(chatId, `💠 <b>Welcome to ${botName}</b>\n👇 Select an option from the menu:`, { parse_mode: 'HTML', ...mainKeyboard });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    if(!text || text.startsWith('/')) return;

    if (!(await checkMembership(chatId))) return sendForceJoinMsg(chatId);

    try {
        const u = await User.findOne({ userId: chatId });
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
            const minW = (await Settings.findOne({ type: 'minWithdraw' }))?.value || 50;

            if (isNaN(amount) || amount <= 0 || amount > u.balance) {
                delete userStates[chatId];
                return bot.sendMessage(chatId, '❌ <b>Invalid Amount or Insufficient Balance!</b>\nWithdrawal request cancelled.', { parse_mode: 'HTML' });
            }
            if (amount < minW) {
                delete userStates[chatId];
                return bot.sendMessage(chatId, `❌ <b>Minimum withdrawal limit is ${minW} TK!</b>\nWithdrawal request cancelled.`, { parse_mode: 'HTML' });
            }

            await User.findOneAndUpdate({ userId: chatId }, { $inc: { balance: -amount, totalWithdrawn: amount, withdrawTimes: 1 } });
            bot.sendMessage(chatId, `✅ <b>Withdrawal Request Sent!</b>\n━━━━━━━━━━━━━━━━━━\n💰 <b>Amount:</b> ${amount} TK\n💳 <b>Method:</b> ${state.method}\n📞 <b>Account:</b> <code>${state.number}</code>\n━━━━━━━━━━━━━━━━━━\n⏳ Please wait for Admin approval.`, { parse_mode: 'HTML' });
            bot.sendMessage(adminId, `🚨 <b>NEW WITHDRAWAL REQUEST</b> 🚨\n━━━━━━━━━━━━━━━━━━\n👤 <b>User ID:</b> <code>${chatId}</code>\n💰 <b>Amount:</b> ${amount} TK\n💳 <b>Method:</b> ${state.method}\n📞 <b>Account:</b> <code>${state.number}</code>\n━━━━━━━━━━━━━━━━━━`, { parse_mode: 'HTML' });

            delete userStates[chatId]; return;
        }

        // Standard Menus
        if (text.includes('Wallet')) {
            bot.sendMessage(chatId, `💰 <b>Account Wallet:</b> ${u?.balance?.toFixed(2) || 0} TK\n🔥 <b>Total OTPs:</b> ${u?.totalOtps || 0}\n💳 <b>Total Withdrawn:</b> ${u?.totalWithdrawn?.toFixed(2) || 0} TK`, { parse_mode: 'HTML' });
        }
        else if (text.includes('Bot Info')) {
            const rateDoc = await Settings.findOne({ type: 'rate' });
            const rate = rateDoc && rateDoc.value ? rateDoc.value : 0.50;
            const aboutText = `💠 <b>${botName.toUpperCase()}</b> 💠\n━━━━━━━━━━━━━━━━━━\nPremium automated OTP system.\n\n🔹 <b>Rate:</b> ${rate.toFixed(2)} TK per OTP.\n🔹 <b>Speed:</b> 24/7 Fast Catching\n\n━━━━━━━━━━━━━━━━━━\n⚡ <b>Provider:</b> https://www.zenexnetwork.com/\n👨‍💻 <b>Developer:</b> @abdullah_124`;
            bot.sendMessage(chatId, aboutText, { parse_mode: 'HTML', disable_web_page_preview: true });
        }
        else if (text.includes('OTP History')) {
            const otps = await OtpRecord.find({ userId: chatId });
            if (otps.length === 0) return bot.sendMessage(chatId, '❌ No OTPs found in the last 48 hours.');
            let fileContent = ""; otps.forEach(o => { fileContent += `${o.number}|${o.otp}\n`; });
            const fileName = `OTPs_${Date.now()}.txt`;
            fs.writeFileSync(fileName, fileContent);
            await bot.sendDocument(chatId, fileName, { caption: `✅ Here are your <b>${otps.length}</b> successful OTPs.`, parse_mode: 'HTML' });
            fs.unlinkSync(fileName);
            await OtpRecord.deleteMany({ userId: chatId });
        }
        else if (text.includes('Withdraw')) {
            const wStatus = (await Settings.findOne({ type: 'withdrawStatus' }))?.stringValue || 'on';
            if (wStatus === 'off') return bot.sendMessage(chatId, '❌ <b>Withdrawals are currently CLOSED by the Admin.</b>\nPlease try again later.', { parse_mode: 'HTML' });

            const minW = (await Settings.findOne({ type: 'minWithdraw' }))?.value || 50;
            if (u.balance < minW) return bot.sendMessage(chatId, `❌ <b>Your balance is low!</b>\nMinimum withdrawal amount is <b>${minW} TK</b>.\n\n💰 Your Balance: ${u.balance.toFixed(2)} TK`, { parse_mode: 'HTML' });

            const methodsStr = (await Settings.findOne({ type: 'paymentMethods' }))?.stringValue || 'bKash, Nagad';
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

async function showServices(chatId, messageId = null) {
    const services = await Service.find({});
    if (services.length === 0) return bot.sendMessage(chatId, '❌ No services added yet.');
    const buttons = services.map(s => [{ text: s.name, callback_data: `srv_${s.code}` }]);
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } };
    if (messageId) bot.editMessageText('📌 <b>Select a service:</b>', { chat_id: chatId, message_id: messageId, ...opts }).catch(()=>{});
    else bot.sendMessage(chatId, '📌 <b>Select a service:</b>', opts);
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const data = query.data;

    if (data === 'verify_join') {
        const isMember = await checkMembership(chatId);
        if (isMember) {
            bot.answerCallbackQuery(query.id, { text: "✅ Verified successfully! Welcome.", show_alert: true });
            bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
            await User.findOneAndUpdate({ userId: chatId }, {}, { upsert: true });
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
        const srvCode = data.replace('srv_', '');
        const serviceData = await Service.findOne({ code: srvCode });
        if (!serviceData) return;

        bot.editMessageText(`🔍 Finding ranges for <b>${serviceData.name}</b>...`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }).catch(()=>{});
        try {
            const response = await fetchWithTimeout(apiClient.get('/active-ranges'), 8000).catch(() => null);
            let activeRanges = [];
            if (response?.data?.data?.active_ranges) {
                activeRanges = response.data.data.active_ranges.filter(item => item.service.toLowerCase() === serviceData.apiService.toLowerCase() && (serviceData.apiTag === 'none' || (item.tag && item.tag.toLowerCase() === serviceData.apiTag.toLowerCase())));
            }

            let keyboard = []; let addedRanges = new Set();
            activeRanges.forEach(r => { const flag = getCountryFlag(r.range); keyboard.push([{ text: `🟢 ${flag} | ${r.range} (${r.hits || 0})`, callback_data: `buy_${srvCode}_${r.range}` }]); addedRanges.add(r.range); });
            const localRanges = await Range.find({ serviceCode: srvCode });
            localRanges.forEach(r => { if (!addedRanges.has(r.range)) { const flag = getCountryFlag(r.range); keyboard.push([{ text: `🟡 ${flag} | ${r.range}`, callback_data: `buy_${srvCode}_${r.range}` }]); addedRanges.add(r.range); } });
            keyboard.push([{ text: `⬅️ Back`, callback_data: `back_srv` }]);

            if (keyboard.length > 1) bot.editMessageText(`👇 <b>Select Range:</b>`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML' });
            else bot.editMessageText(`❌ No ranges available.`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: `⬅️ Back`, callback_data: `back_srv` }]] } });
        } catch (error) {}
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
        let srvCode = srvCodeFromBtn || (await Range.findOne({ range: range.toUpperCase() }))?.serviceCode || 'unknown';

        let countFound = 0;
        if(num1) { countFound++; await new PendingNumber({ userId: chatId, number: num1, serviceCode: srvCode }).save(); }
        if(num2) { countFound++; await new PendingNumber({ userId: chatId, number: num2, serviceCode: srvCode }).save(); }

        if (countFound > 0) {
            await User.findOneAndUpdate({ userId: chatId }, { $inc: { todayNumbersTaken: countFound } }, { upsert: true });

            const countryName = getFullCountryName(range);
            let text = `🌟 <b>𝗡𝗨𝗠𝗕𝗘𝗥𝗦 𝗔𝗟𝗟𝗢𝗖𝗔𝗧𝗘𝗗</b> 🌟\n━━━━━━━━━━━━━━━━━━\n🌍 <b>Country:</b> ${countryName}\n\n`;
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

            const alreadyDone = await OtpRecord.findOne({ number: apiNumCleaned, otp: otpStr });
            if (alreadyDone) continue;

            const allPending = await PendingNumber.find({});
            let pending = allPending.find(p => apiNumCleaned.endsWith(p.number) || p.number.endsWith(apiNumCleaned));
            if (!pending) continue;

            await new OtpRecord({ userId: pending.userId, number: apiNumCleaned, otp: otpStr }).save();
            const serviceObj = await Service.findOne({ code: pending.serviceCode });
            let platformName = serviceObj ? serviceObj.name : 'Auto Detected';

            const dbRate = await Settings.findOne({ type: 'rate' });
            const rewardRate = dbRate ? parseFloat(dbRate.value) : 0.50;

            await User.findOneAndUpdate({ userId: pending.userId }, { $inc: { balance: rewardRate, totalOtps: 1, todayOtps: 1 } });

            const userFlag = getCountryFlag(apiNumCleaned);

            bot.sendMessage(pending.userId, `🎉 <b>SUCCESS! OTP RECEIVED</b> 🎉\n━━━━━━━━━━━━━━━━━━\n📲 <b>App:</b> ${platformName}\n🌍 <b>Region:</b> ${userFlag}\n📞 <b>Number:</b> <code>${apiNumCleaned}</code>\n💬 <b>Code:</b> <code>${finalOtpToShow}</code>\n━━━━━━━━━━━━━━━━━━\n💰 <b>Added: +${rewardRate.toFixed(2)} TK</b>`, { parse_mode: 'HTML' });

            let groupPlatformName = platformName;
            if (/Facebook PC Clone/i.test(groupPlatformName)) groupPlatformName = 'Facebook Clone';
            else if (/Facebook New Account/i.test(groupPlatformName)) groupPlatformName = 'Facebook New';

            const fullCountryName = getFullCountryName(apiNumCleaned);
            const maskedNumber = apiNumCleaned.length > 8 ? apiNumCleaned.substring(0, 5) + '***' + apiNumCleaned.substring(apiNumCleaned.length - 3) : apiNumCleaned;

            const proofText = `💠 <b>${botName.toUpperCase()} SUCCESS</b> 💠\n━━━━━━━━━━━━━━━━━━\n📲 <b>Platform:</b> ${groupPlatformName}\n🌍 <b>Country:</b> ${fullCountryName}\n📞 <b>Number:</b> <code>${maskedNumber}</code>\n💬 <b>Code:</b> <code>${finalOtpToShow}</code>\n💰 <b>Earned:</b> +${rewardRate.toFixed(2)} TK\n━━━━━━━━━━━━━━━━━━\n⚡ <b>Provider: ZENEX NETWORK</b>`;
            if(proofGroupId) bot.sendMessage(proofGroupId, proofText, { parse_mode: 'HTML' }).catch(e => {});
        }
    } catch (e) {}
}, 5000);

setInterval(async () => {
    try {
        await OtpRecord.deleteMany({ date: { $lt: new Date(Date.now() - 48 * 60 * 60 * 1000) } });
        await PendingNumber.deleteMany({ date: { $lt: new Date(Date.now() - 20 * 60 * 1000) } });

        const today = new Date().toDateString();
        const dbDate = await Settings.findOne({ type: 'dailyReset' });
        if (!dbDate || dbDate.stringValue !== today) {
            await User.updateMany({}, { todayNumbersTaken: 0, todayOtps: 0 });
            await Settings.findOneAndUpdate({ type: 'dailyReset' }, { stringValue: today }, { upsert: true });
        }
    } catch (e) {}
}, 60 * 60 * 1000);

// ================= ADMIN COMMANDS ================= //
bot.onText(/\/withoff/, async (msg) => { if(msg.chat.id.toString()!==adminId) return; await Settings.findOneAndUpdate({ type: 'withdrawStatus' }, { stringValue: 'off' }); bot.sendMessage(adminId, "🛑 Withdraw System OFF"); });
bot.onText(/\/withon/, async (msg) => { if(msg.chat.id.toString()!==adminId) return; await Settings.findOneAndUpdate({ type: 'withdrawStatus' }, { stringValue: 'on' }); bot.sendMessage(adminId, "✅ Withdraw System ON"); });
bot.onText(/\/setmin (.+)/, async (msg, match) => { if(msg.chat.id.toString()!==adminId) return; await Settings.findOneAndUpdate({ type: 'minWithdraw' }, { value: parseFloat(match[1]) }); bot.sendMessage(adminId, `✅ Minimum Withdraw set to ${match[1]} TK`); });
bot.onText(/\/setmethods (.+)/, async (msg, match) => { if(msg.chat.id.toString()!==adminId) return; await Settings.findOneAndUpdate({ type: 'paymentMethods' }, { stringValue: match[1] }); bot.sendMessage(adminId, `✅ Payment Methods set to: ${match[1]}`); });

bot.onText(/\/testgroup/, async (msg) => {
    if (msg.chat.id.toString() !== adminId) return;
    try {
        await bot.sendMessage(proofGroupId, "✅ <b>Proof Group Connected Successfully!</b>", { parse_mode: 'HTML' });
        bot.sendMessage(adminId, "✅ <b>Success! Group connected.</b>", { parse_mode: 'HTML' });
    } catch (error) { bot.sendMessage(adminId, `❌ <b>Error:</b> ${error.message}`); }
});
bot.onText(/\/pending/, async (msg) => { if(msg.chat.id.toString()===adminId) { const list = await PendingNumber.find({}); bot.sendMessage(adminId, `⏳ Pending Numbers: ${list.length}`); }});
bot.onText(/\/testotp/, async (msg) => { if(msg.chat.id.toString()===adminId) bot.sendMessage(adminId, "⏳ API OK"); });

bot.onText(/\/addservice (.+)\|(.+)\|(.+)\|(.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const code = match[1].trim(); const apiService = match[2].trim(); const apiTag = match[3].trim(); const name = match[4].trim();
    await Service.findOneAndUpdate({ code: code }, { code, apiService, apiTag, name }, { upsert: true });
    bot.sendMessage(adminId, `✅ Service Added: ${name}`);
});

bot.onText(/\/addrange (.+) (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const srvCode = match[1].trim(); const range = match[2].trim().toUpperCase();
    await Range.findOneAndUpdate({ range: range }, { serviceCode: srvCode, range: range }, { upsert: true });
    bot.sendMessage(adminId, `✅ Range Added!`);
});

bot.onText(/\/delservice (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const code = match[1].trim().toLowerCase();
    const services = await Service.find({});
    let deleted = false;
    for (let s of services) {
        if (s.code.trim().toLowerCase() === code) {
            await Service.deleteOne({ _id: s._id });
            await Range.deleteMany({ serviceCode: s.code });
            deleted = true;
        }
    }
    if (deleted) bot.sendMessage(adminId, `✅ Service Deleted.`);
    else bot.sendMessage(adminId, `❌ Service not found.`);
});

bot.onText(/\/delrange (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    await Range.deleteOne({ range: match[1].trim().toUpperCase() }); bot.sendMessage(adminId, `✅ Range Deleted.`);
});

bot.onText(/\/setrate (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    await Settings.findOneAndUpdate({ type: 'rate' }, { value: parseFloat(match[1]) }, { upsert: true }); bot.sendMessage(adminId, `✅ Rate updated to ${match[1]} TK`);
});

bot.onText(/\/notice ([\s\S]+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== adminId) return;
    const users = await User.find({}); let sent = 0;
    bot.sendMessage(adminId, `📢 Broadcasting notice...`);
    for (let u of users) { try { await bot.sendMessage(u.userId, `📢 <b>NOTICE:</b>\n\n${match[1]}`, { parse_mode: 'HTML' }); sent++; } catch(e){} }
    bot.sendMessage(adminId, `✅ Notice sent to ${sent} users.`);
});
