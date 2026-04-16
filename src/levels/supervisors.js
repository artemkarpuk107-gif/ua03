// src/levels/supervisors.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const { updateAdminRoleInSheets, getAdminForPromotion } = require('../services/sheets');
const settings = require('../config/settings');

// Карти посад
const L3_MAP = {
    'ГС МВС': ['НПУ Д', 'НПУ К', 'НПУ Л'],
    'ГС МВП': ['ВРУ', 'ТСН'],
    'ГС МДБ': ['СБУ К', 'СБУ Д', 'СБУ Л'],
    'ГС МОЗ': ['МОЗ Д', 'МОЗ К', 'МОЗ Л'],
    'ГС МО': ['ЗСУ', 'ТЦК']
};

const L5_CATEGORIES = {
    'СБУ': ['СБУ Д', 'СБУ К', 'СБУ Л'],
    'МОЗ': ['МОЗ Д', 'МОЗ К', 'МОЗ Л'],
    'НПУ': ['НПУ Д', 'НПУ К', 'НПУ Л'],
    'ВРУ': ['ВРУ'],
    'ТСН': ['ТСН'],
    'ЗСУ': ['ЗСУ'],
    'ТЦК': ['ТЦК']
};

const L5_GS_ROLES = ['ГС МВС', 'ГС МВП', 'ГС МДБ', 'ГС МОЗ', 'ГС МО'];

const supervisorsWizard = new Scenes.WizardScene(
    'SUPERVISORS_SCENE',
    // 1. Вибір дії
    async (ctx) => {
        await ctx.reply('Оберіть дію зі Слідкуючими:', Markup.inlineKeyboard([
            [Markup.button.callback('✅ Призначити', 'act_assign'), Markup.button.callback('❌ Зняти', 'act_remove')],
            [Markup.button.callback('🔙 Скасувати', 'cancel_sup')]
        ]));
        return ctx.wizard.next();
    },
    // 2. Введення нікнейму
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        if (ctx.callbackQuery.data === 'cancel_sup') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }
        ctx.wizard.state.action = ctx.callbackQuery.data === 'act_assign' ? 'assign' : 'remove';
        await ctx.editMessageText(`Введіть ігровий нікнейм адміністратора:`);
        return ctx.wizard.next();
    },
    // 3. Аналіз того, хто призначає
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        ctx.wizard.state.targetNickname = ctx.message.text.trim();

        const waitMsg = await ctx.reply('⏳ Аналізую ваші права...');
        
        const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
        const target = await prisma.admin.findUnique({ where: { nickname: ctx.wizard.state.targetNickname } });
        
        if (!target) {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ Цього адміністратора немає в базі бота.');
            return ctx.scene.leave();
        }

        ctx.wizard.state.issuer = issuer;
        ctx.wizard.state.target = target;

        // ЯКЩО ДІЯ "ЗНЯТИ"
        if (ctx.wizard.state.action === 'remove') {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `Ви впевнені, що хочете ЗНЯТИ посаду слідкуючого з ${target.nickname}?`, Markup.inlineKeyboard([
                [Markup.button.callback('💥 ТАК, ЗНЯТИ', 'confirm_remove')],
                [Markup.button.callback('❌ СКАСУВАТИ', 'cancel_sup')]
            ]));
            ctx.wizard.cursor = 4; 
            return;
        }

        // --- ЛОГІКА "ПРИЗНАЧИТИ" ---
        const lvl = issuer.accessLevel;
        let buttons = [];

        if (lvl === 3) {
            const factions = L3_MAP[issuer.role];
            if (!factions) {
                await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `❌ Ваша посада (${issuer.role}) не дозволяє призначати слідкуючих.`);
                return ctx.scene.leave();
            }
            factions.forEach(f => buttons.push([Markup.button.callback(f, `fac_${f}`)]));
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `Оберіть фракцію для ${target.nickname}:`, Markup.inlineKeyboard(buttons));
            
        } else if (lvl >= 5) {
            buttons = [
                [Markup.button.callback('👑 ГС-и', 'menu_gs'), Markup.button.callback('🕵️ Слідаки', 'menu_slid')]
            ];
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `Кого ви хочете призначити?`, Markup.inlineKeyboard(buttons));
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `❌ У вас немає доступу до цього меню.`);
            return ctx.scene.leave();
        }

        return ctx.wizard.next();
    },
    // 4. Динамічний роутер
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const data = ctx.callbackQuery.data;
        const s = ctx.wizard.state;

        if (data === 'cancel_sup') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }

        if (data === 'menu_gs') {
            const buttons = L5_GS_ROLES.map(role => [Markup.button.callback(role, `gsrole_${role}`)]);
            await ctx.editMessageText('Оберіть посаду ГС:', Markup.inlineKeyboard(buttons));
            return; 
        }

        if (data === 'menu_slid') {
            const buttons = Object.keys(L5_CATEGORIES).map(cat => Markup.button.callback(cat, `cat_${cat}`));
            const chunked = [];
            for (let i = 0; i < buttons.length; i += 3) chunked.push(buttons.slice(i, i + 3));
            await ctx.editMessageText('Оберіть структуру:', Markup.inlineKeyboard(chunked));
            return;
        }

        if (data.startsWith('cat_')) {
            const cat = data.replace('cat_', '');
            const factions = L5_CATEGORIES[cat];
            
            if (factions.length === 1) {
                s.assignType = 'slid';
                s.selectedRole = factions[0];
                return goToConfirm(ctx, s);
            }

            const buttons = factions.map(f => [Markup.button.callback(f, `fac_${f}`)]);
            await ctx.editMessageText(`Оберіть конкретну фракцію (${cat}):`, Markup.inlineKeyboard(buttons));
            return;
        }

        if (data.startsWith('fac_')) {
            s.assignType = 'slid';
            s.selectedRole = data.replace('fac_', '');
            return goToConfirm(ctx, s);
        }

        if (data.startsWith('gsrole_')) {
            s.assignType = 'gs';
            s.selectedRole = data.replace('gsrole_', '');
            return goToConfirm(ctx, s);
        }
    },
    // 5. Виконання
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const s = ctx.wizard.state;

        if (ctx.callbackQuery.data === 'cancel_sup') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }

        await ctx.editMessageText('⏳ Опрацювання даних...');

        try {
            const issuerNick = s.issuer.nickname || ctx.from.first_name;
            let infoMsg = '';
            let newSheetRole = '';

            // ==========================================
            // ЛОГІКА ЗНЯТТЯ (З ПЕРЕВІРКОЮ КОЛОНКИ O)
            // ==========================================
            if (s.action === 'remove') {
                // 1. "Заглядаємо" в Гугл Таблицю і читаємо Колонку O (Індекс 14)
                const sheetData = await getAdminForPromotion(s.targetNickname);
                
                // Якщо знайшли рівень в таблиці — беремо його, якщо ні — з бази бота
                const actualLevel = sheetData ? sheetData.currentLevel : s.target.accessLevel;

                const baseRoles = {
                    1: 'Молодший Модератор',
                    2: 'Модератор',
                    3: 'Старший Модератор',
                    4: 'Адміністратор',
                    5: 'Куратор'
                };

                // Підставляємо посаду згідно з цифрою з Колонки O
                newSheetRole = baseRoles[actualLevel] || 'Адміністратор';

                infoMsg = `<b>🛑 ЗНЯТТЯ З ПОСАДИ СЛІДКУЮЧОГО</b>\n\n` +
                          `👤 Адміністратор <b>${s.targetNickname}</b> знятий з посади Слідкуючого/ГС.\n` +
                          `💼 Повернуто на посаду: <b>${newSheetRole}</b>\n` +
                          `👤 Зняв: ${issuerNick}`;
                
                // Синхронізуємо базу бота, щоб там теж був правильний рівень та посада
                await prisma.admin.update({ 
                    where: { nickname: s.targetNickname }, 
                    data: { role: newSheetRole, accessLevel: actualLevel } 
                });
            } 
            // ==========================================
            // ЛОГІКА ПРИЗНАЧЕННЯ
            // ==========================================
            else {
                if (s.assignType === 'gs') {
                    newSheetRole = s.selectedRole; 
                    infoMsg = `<b>👑 ПРИЗНАЧЕННЯ КЕРІВНИЦТВА</b>\n\n` +
                              `👤 Адміністратор <b>${s.targetNickname}</b> призначений на посаду <b>${s.selectedRole}</b>.\n` +
                              `👤 Призначив: ${issuerNick}`;
                    
                    await prisma.admin.update({ 
                        where: { nickname: s.targetNickname }, 
                        data: { role: newSheetRole, accessLevel: 3 } 
                    });
                } else {
                    newSheetRole = 'Слід ДО'; 
                    infoMsg = `<b>🕵️ ПРИЗНАЧЕННЯ СЛІДКУЮЧОГО</b>\n\n` +
                              `👤 Адміністратор <b>${s.targetNickname}</b> призначений на посаду <b>Слідкуючий за ${s.selectedRole}</b>.\n` +
                              `👤 Призначив: ${issuerNick}`;
                    
                    await prisma.admin.update({ 
                        where: { nickname: s.targetNickname }, 
                        data: { role: `Слід. ${s.selectedRole}` } 
                    });
                }
            }

            // 1. Оновлюємо Таблицю
            await updateAdminRoleInSheets(s.targetNickname, newSheetRole);

            // 2. Відправляємо в гілку Інфо
            await ctx.telegram.sendMessage(settings.CHATS.ALL_ADMINS.ID, infoMsg, {
                message_thread_id: Number(settings.CHATS.ALL_ADMINS.THREADS.INFO),
                parse_mode: 'HTML'
            });

            await ctx.editMessageText(`✅ Успішно опрацьовано!`);
        } catch (e) {
            console.error('Помилка в Supervisors:', e);
            await ctx.editMessageText('❌ Виникла помилка.');
        }

        return ctx.scene.leave();
    }
);

// Допоміжна функція переходу до підтвердження
async function goToConfirm(ctx, s) {
    const roleText = s.assignType === 'gs' ? s.selectedRole : `Слідкуючий за ${s.selectedRole}`;
    await ctx.editMessageText(`⚠️ Підтвердіть призначення:\n\nАдмін: ${s.targetNickname}\nПосада: ${roleText}`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ ПІДТВЕРДИТИ', 'confirm_exec')],
        [Markup.button.callback('❌ СКАСУВАТИ', 'cancel_sup')]
    ]));
    ctx.wizard.cursor = 4; 
    return;
}

module.exports = { supervisorsWizard };