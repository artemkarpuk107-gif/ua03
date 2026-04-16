// src/levels/level1.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const settings = require('../config/settings');
const { getAdminStats, updateAdminPromotionInSheets } = require('../services/sheets');

// --- НАЛАШТУВАННЯ ЦІН ТА РОЛЕЙ ---
const PROMO_COSTS = {
    1: { standard: 950, express: 1000 },
    2: { standard: 2300, express: 2800 },
    3: { standard: 3900, express: 4300 }
};

const PROMOTION_MAP = {
    1: { role: 'Молодший Модератор', nextRole: 'Модератор' },
    2: { role: 'Модератор', nextRole: 'Старший Модератор' },
    3: { role: 'Старший Модератор', nextRole: 'Адміністратор' },
    4: { role: 'Адміністратор', nextRole: 'Куратор' }
};

// ==========================================
// ВІЗАРД: ЗАЯВКА НА ПІДВИЩЕННЯ
// ==========================================
const promotionRequestWizard = new Scenes.WizardScene(
    'PROMOTION_REQUEST_SCENE',
    // КРОК 0: Перевірка ігрового рівня та доган
    async (ctx) => {
        try {
            const admin = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            const stats = await getAdminStats(admin.nickname);

            if (!stats || stats.adminLevel === 'Невідомо') {
                await ctx.reply('❌ Вас не знайдено в реєстрі адміністрації. Подати заявку неможливо.');
                return ctx.scene.leave();
            }

            // ПЕРЕВІРКА НА ДОГАНИ (Має бути 0)
            const strictWarns = parseInt(stats.strictWarns) || 0;
            const verbalWarns = parseInt(stats.verbalWarns) || 0;

            if (strictWarns > 0 || verbalWarns > 0) {
                await ctx.reply(
                    `❌ <b>Подача неможлива!</b>\n\n` +
                    `У вас є активні догани:\n` +
                    `🛑 Суворі: ${strictWarns}\n` +
                    `⚠️ Усні: ${verbalWarns}\n\n` +
                    `Спочатку зніміть догани, а потім повертайтесь за підвищенням.`, 
                    { parse_mode: 'HTML' }
                );
                return ctx.scene.leave();
            }

            const gameLvl = parseInt(stats.adminLevel);

            // Перевірка: тільки для 1, 2 та 3 адмін-рівнів
            if (gameLvl >= 4) {
                await ctx.reply(`❌ Автоматичне підвищення через бали доступне тільки для 1-3 рівнів. Ваш рівень: ${gameLvl}`);
                return ctx.scene.leave();
            }

            // Зберігаємо дані в state
            ctx.wizard.state.adminId = admin.id;
            ctx.wizard.state.adminNickname = admin.nickname;
            ctx.wizard.state.adminBal = admin.bal;
            ctx.wizard.state.gameLvl = gameLvl;
            ctx.wizard.state.lastPromo = stats.lastPromo || 'Невідомо';
            ctx.wizard.state.rowIndex = stats.rowIndex;

            const buttons = [
                [Markup.button.callback('📜 Стандарт', 'promo_standard')],
                [Markup.button.callback('⚡️ Експрес', 'promo_express')],
                [Markup.button.callback('❌ Скасувати', 'cancel_promo_req')]
            ];

            await ctx.reply(`Ваш рівень адмін-прав: <b>${gameLvl}</b>\nОберіть систему підвищення:`, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard(buttons)
            });
            return ctx.wizard.next();
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка при отриманні статистики.');
            return ctx.scene.leave();
        }
    },
    // КРОК 1: Вибір типу та перевірка балів
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        await ctx.answerCbQuery(); // Знімаємо "світіння" кнопки

        const action = ctx.callbackQuery.data;
        if (action === 'cancel_promo_req') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }

        const type = action === 'promo_standard' ? 'standard' : 'express';
        const s = ctx.wizard.state;
        const required = PROMO_COSTS[s.gameLvl][type];

        const text = `📊 <b>Заявка на підвищення</b>\n\n` +
                     `👤 Нік: ${s.adminNickname}\n` +
                     `📈 Рівень: ${s.gameLvl} ➡️ <b>${s.gameLvl + 1}</b>\n` +
                     `🪙 Ваші бали: <b>${s.adminBal}</b>\n` +
                     `💰 Вартість: <b>${required}</b> (${type === 'standard' ? 'Стандарт' : 'Експрес'})\n\n` +
                     (s.adminBal >= required 
                        ? `✅ Балів достатньо!` 
                        : `❌ Балів недостатньо (бракує ${required - s.adminBal})`);

        const buttons = [];
        if (s.adminBal >= required) {
            buttons.push([Markup.button.callback('📤 Подати заявку', 'submit_promo_req')]);
        }
        buttons.push([Markup.button.callback('🔙 Назад', 'back_to_promo_type')]);

        ctx.wizard.state.selectedType = type;
        ctx.wizard.state.requiredAmount = required;

        await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        return ctx.wizard.next();
    },
    // КРОК 2: Відправка заявки
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        await ctx.answerCbQuery(); // Знімаємо "світіння"

        const action = ctx.callbackQuery.data;

        if (action === 'back_to_promo_type') {
            ctx.wizard.selectStep(0);
            return ctx.wizard.steps[0](ctx);
        }

        if (action === 'submit_promo_req') {
            const s = ctx.wizard.state;

            const logMsg = `📝 <b>ЗАЯВКА НА ПІДВИЩЕННЯ</b>\n\n` +
                           `👤 Адмін: <b>${s.adminNickname}</b>\n` +
                           `📈 Рівень: ${s.gameLvl} ➡️ <b>${s.gameLvl + 1}</b>\n` +
                           `🪙 Списання: <b>${s.requiredAmount} балів</b>\n` +
                           `📅 Останнє підвищення: ${s.lastPromo}\n` +
                           `⚙️ Система: ${s.selectedType === 'standard' ? 'Стандарт' : 'Експрес'}`;

            // Гілка 9061 у групі логів
            const targetChat = "-1003735229726";
            const targetThread = "9061";

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Схвалити', `approve_pr_${s.adminId}_${s.requiredAmount}_${s.gameLvl + 1}`)],
                [Markup.button.callback('❌ Відхилити', `reject_pr_${s.adminId}`)]
            ]);

            await ctx.telegram.sendMessage(targetChat, logMsg, {
                message_thread_id: Number(targetThread),
                parse_mode: 'HTML',
                ...keyboard
            });

            await ctx.editMessageText('✅ Заявку надіслано керівництву!');
            return ctx.scene.leave();
        }
    }
);

// ==========================================
// ВІЗАРД: ПОДАЧА ЗВІТУ (ОРИГІНАЛЬНИЙ)
// ==========================================
const reportWizard = new Scenes.WizardScene('REPORT_SCENE',
    async (ctx) => {
        const buttons = [[Markup.button.callback('📅 Сьогодні', 'date_today')], [Markup.button.callback('✍️ Інша дата', 'date_other')], [Markup.button.callback('❌ Скасувати', 'cancel_report')]];
        await ctx.reply('Оберіть дату, за яку подаєте звіт:', Markup.inlineKeyboard(buttons));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
            const action = ctx.callbackQuery.data;
            if (action === 'cancel_report') { await ctx.editMessageText('❌ Скасовано.'); return ctx.scene.leave(); }
            if (action === 'date_today') { 
                ctx.wizard.state.reportDate = new Date().toLocaleDateString('uk-UA'); 
                await ctx.editMessageText(`✅ Дата: ${ctx.wizard.state.reportDate}\n\n📸 Надішліть скріншот:`); 
                return ctx.wizard.next(); 
            }
            if (action === 'date_other') { await ctx.editMessageText('✍️ Введіть дату (ДД.ММ.РРРР):'); return; }
        } else if (ctx.message?.text) {
            ctx.wizard.state.reportDate = ctx.message.text;
            await ctx.reply('📸 Тепер надішліть скріншот:');
            return ctx.wizard.next();
        }
    },
    async (ctx) => {
        if (!ctx.message?.photo) return ctx.reply('❌ Потрібно фото.');
        ctx.wizard.state.reportPhotoId = ctx.message.photo.pop().file_id;
        await ctx.reply('Відправити звіт?', Markup.inlineKeyboard([[Markup.button.callback('🚀 НАДІСЛАТИ', 'send_report')], [Markup.button.callback('❌ СКАСУВАТИ', 'cancel_report')]]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        await ctx.answerCbQuery();
        if (ctx.callbackQuery.data === 'send_report') {
            const admin = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            await ctx.telegram.sendPhoto(settings.CHATS.ALL_ADMINS.ID, ctx.wizard.state.reportPhotoId, {
                caption: `${admin.nickname}\n${ctx.wizard.state.reportDate}`,
                message_thread_id: Number(settings.CHATS.ALL_ADMINS.THREADS.REPORTS)
            });
            await ctx.editMessageText('✅ Звіт надіслано!');
            return ctx.scene.leave();
        }
    }
);

module.exports = {
    level: 1,
    scenes: [reportWizard, promotionRequestWizard],
    getMenu: () => [
        [Markup.button.callback('📊 Подати звіт', 'start_report')],
        [Markup.button.callback('📈 Підвищення за бали', 'start_promo_req')]
    ],
        setup: (bot) => {
        bot.action('start_report', ctx => ctx.scene.enter('REPORT_SCENE'));
        bot.action('start_promo_req', ctx => ctx.scene.enter('PROMOTION_REQUEST_SCENE'));

        // --- ПРАВИЛЬНЕ СХВАЛЕННЯ (БЕЗ ДУБЛІВ) ---
        bot.action(/^approve_pr_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
            const approver = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            
            if (!approver || approver.accessLevel < 7) {
                return ctx.answerCbQuery('⛔️ Тільки 7+!', { show_alert: true });
            }

            // ЗАХИСТ ВІД ДУБЛІВ: Якщо текст вже містить Опрацювання або Схвалено - виходимо
            const msgText = ctx.callbackQuery.message.text;
            if (msgText.includes('⌛️') || msgText.includes('✅ СХВАЛЕНО')) {
                return ctx.answerCbQuery('⚠️ Заявка вже опрацьовується!');
            }

            // Відповідаємо телеграму, щоб кнопка не "світилася"
            await ctx.answerCbQuery('⏳ Починаю підвищення...');
            // Міняємо текст, щоб кнопки зникли
            await ctx.editMessageText(msgText + '\n\n⌛️ <b>Опрацювання... зачекайте.</b>', { parse_mode: 'HTML' });

            const targetId = parseInt(ctx.match[1]);
            const cost = parseInt(ctx.match[2]);
            const nextLvl = parseInt(ctx.match[3]);

            // У блоці bot.action(/^approve_pr_.../) файлу level1.js

try {
    const target = await prisma.admin.findUnique({ where: { id: targetId } });

    // 1. Визначаємо нову роль
    let nextRole = target.role;
    const currentLvl = nextLvl - 1;
    if (PROMOTION_MAP[currentLvl] && target.role.trim() === PROMOTION_MAP[currentLvl].role) {
        nextRole = PROMOTION_MAP[currentLvl].nextRole;
    }

    // 2. Оновлюємо Базу бота (щоб змінився рівень в /start та правах)
    await prisma.admin.update({
        where: { id: targetId },
        data: { 
            bal: { decrement: cost }, 
            role: nextRole
        }
    });

    // 3. Оновлюємо тільки Реєстр (викликаємо нову функцію)
    await updateAdminPromotionInSheets(target.nickname, nextLvl, nextRole);

    // 4. Лог в Інфо (як було раніше)
    const infoMsg = `<b>📈 ПІДВИЩЕННЯ АДМІНІСТРАЦІЇ</b>\n\n` +
                    `👤 Адміністратор <b>${target.nickname}</b> підвищений на <b>${nextLvl}</b> рівень!\n` +
                    `💼 Посада: ${nextRole}\n` +
                    `👤 Підвищив: ${approver.nickname}`;

    await ctx.telegram.sendMessage(settings.CHATS.ALL_ADMINS.ID, infoMsg, {
        message_thread_id: Number(settings.CHATS.ALL_ADMINS.THREADS.INFO),
        parse_mode: 'HTML'
    });

    // ... далі відправка СМС та фінальний editMessageText


                // 4. СМС в лічку
                await ctx.telegram.sendMessage(target.tgId.toString(), 
                    `🎉 Вітаємо! Вашу заявку схвалено.\nВи підвищені до <b>${nextLvl} рівня</b>.\nСписано: <b>${cost} балів</b>.`, 
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                // 5. Фінальний статус повідомлення
                await ctx.editMessageText(msgText + `\n\n✅ <b>СХВАЛЕНО:</b> ${approver.nickname}`, { parse_mode: 'HTML' });

            } catch (e) {
                console.error(e);
                await ctx.editMessageText(msgText + '\n\n❌ <b>Помилка при оновленні таблиць!</b>');
            }
        });

        bot.action(/^reject_pr_(\d+)$/, async (ctx) => {
            const approver = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            if (!approver || approver.accessLevel < 7) return ctx.answerCbQuery('⛔️ Тільки 7+!', { show_alert: true });
            
            await ctx.answerCbQuery();
            await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n❌ <b>ВІДХИЛЕНО:</b> ${approver.nickname}`, { parse_mode: 'HTML' });
        });
    }

    

        
};
