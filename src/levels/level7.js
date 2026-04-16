// src/levels/level7.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const { 
    getAdminStats, 
    demoteAdminInSheets, 
    addAdminToChsa, 
    getAdminForPromotion, 
    updateAdminPromotionInSheets, 
    getAdminDiscord 
} = require('../services/sheets');
const settings = require('../config/settings');

const demoteWizard = new Scenes.WizardScene(
    'DEMOTE_ADMIN_SCENE',
    // 1. ПЕРЕВІРКА ТА ЗАПИТ НІКНЕЙМУ
    async (ctx) => {
        // --- БЛОК ПЕРЕХОДУ З ДОГАН ---
        if (ctx.scene.state && ctx.scene.state.targetNickname) {
            // Копіюємо дані у внутрішній стан візарда
            ctx.wizard.state.targetNickname = ctx.scene.state.targetNickname;
            ctx.wizard.state.targetAdmin = ctx.scene.state.targetAdmin;
            ctx.wizard.state.demoteReason = ctx.scene.state.demoteReason;

            // Встановлюємо курсор на крок 3 (індекс 2)
            ctx.wizard.cursor = 2; 
            
            // Викликаємо функцію 3-го кроку напряму
            return ctx.wizard.steps[2](ctx);
        }
        // --- КІНЕЦЬ БЛОКУ ---

        await ctx.reply('⚠️ Введіть нікнейм адміністратора для ЗНЯТТЯ з посади:', Markup.keyboard([['❌ Скасувати']]).oneTime().resize());
        return ctx.wizard.next();
    },
    // 2. Пошук та запит причини (сюди ми потрапляємо, якщо вводили нік вручну)
    async (ctx) => {
        // ... твій існуючий код 2-го кроку
        if (ctx.message.text === '❌ Скасувати') return ctx.scene.leave();
        const targetNickname = ctx.message.text.trim();
        ctx.wizard.state.targetNickname = targetNickname;

        const target = await prisma.admin.findUnique({ where: { nickname: targetNickname } });
        if (!target) {
            await ctx.reply('❌ Адміністратора з таким ніком не знайдено в базі бота.');
            return ctx.scene.leave();
        }
        ctx.wizard.state.targetAdmin = target;

        await ctx.reply(`👤 Знайдено: ${targetNickname}.\nНапишіть причину зняття з посади:`);
        return ctx.wizard.next();
    },
    // 3. Перевірка 15 днів і запит ЧСА
    async (ctx) => {
        // Якщо причини ще немає (ми ввели нік вручну), то беремо її з тексту
        if (!ctx.wizard.state.demoteReason) {
            if (!ctx.message || !ctx.message.text) return;
            ctx.wizard.state.demoteReason = ctx.message.text;
        }

        const stats = await getAdminStats(ctx.wizard.state.targetNickname);
        let warning = '';
        
        if (stats && stats.daysOnAdmin !== 'Невідомо') {
            const days = parseInt(stats.daysOnAdmin);
            if (!isNaN(days) && days < 15) {
                warning = `\n\n❗️ <b>УВАГА:</b> Адміністратор не відстояв 15 днів (на посаді ${days} днів).\nРекомендується видача ЧСА на 30 днів згідно ПА 2.23.`;
            }
        }

        const text = `⚠️ Чи потрібне занесення до ЧСА?${warning}`;
        const kb = {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ТАК, потрібно', 'chsa_yes')],
                [Markup.button.callback('❌ НІ, не потрібно', 'chsa_no')]
            ])
        };

        // Замінюємо "Опрацювання..." на питання про ЧСА
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, kb).catch(() => ctx.reply(text, kb));
        } else {
            await ctx.reply(text, kb);
        }
        
        return ctx.wizard.next();
    },
    // 4. Обробка відповіді ЧСА
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const answer = ctx.callbackQuery.data;

        if (answer === 'chsa_no') {
            ctx.wizard.state.needChsa = false;
            ctx.wizard.selectStep(6); 
            return ctx.wizard.steps[6](ctx);
        } else {
            ctx.wizard.state.needChsa = true;
            await ctx.editMessageText('Скільки місяців ЧСА видати? (Напишіть число, наприклад: 1)');
            return ctx.wizard.next();
        }
    },
    // 5. Запит місяців ЧСА
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const months = parseInt(ctx.message.text);
        if (isNaN(months)) {
            await ctx.reply('❌ Будь ласка, введіть число (місяці).');
            return;
        }
        ctx.wizard.state.chsaMonths = months;

        await ctx.reply('Введіть причину ЧСА:', Markup.inlineKeyboard([
            [Markup.button.callback('⏭ Пропустити', 'skip_chsa_reason')]
        ]));
        return ctx.wizard.next();
    },
    // 6. Обробка причини ЧСА
    async (ctx) => {
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'skip_chsa_reason') {
            ctx.wizard.state.chsaReason = 'Не вказана';
        } else if (ctx.message && ctx.message.text) {
            ctx.wizard.state.chsaReason = ctx.message.text;
        } else return;

        ctx.wizard.selectStep(6);
        return ctx.wizard.steps[6](ctx);
    },
    // 7. ФІНАЛЬНЕ ПІДТВЕРДЖЕННЯ
    async (ctx) => {
        const s = ctx.wizard.state;
        let text = `🛑 <b>ПІДТВЕРДЖЕННЯ ЗНЯТТЯ</b>\n\n` +
                   `👤 <b>Нік:</b> ${s.targetNickname}\n` +
                   `📄 <b>Причина зняття:</b> ${s.demoteReason}\n`;

        if (s.needChsa) {
            text += `\n⛔️ <b>ЧСА:</b> Так, на ${s.chsaMonths} міс.\n` +
                    `📝 <b>Причина ЧСА:</b> ${s.chsaReason}\n`;
        } else {
            text += `\n⛔️ <b>ЧСА:</b> Ні\n`;
        }

        const buttons = [
            [Markup.button.callback('💥 ПІДТВЕРДИТИ ЗНЯТТЯ', 'confirm_demote')],
            [Markup.button.callback('❌ СКАСУВАТИ', 'cancel_demote')]
        ];

        if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        else await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        
        return ctx.wizard.next();
    },
    // 8. ВИКОНАННЯ ВСЬОГО ЕКШЕНУ
    async (ctx) => {
        if (!ctx.callbackQuery || ctx.callbackQuery.data === 'cancel_demote') {
            if (ctx.callbackQuery?.data === 'cancel_demote') await ctx.editMessageText('❌ Зняття скасовано.');
            return ctx.scene.leave();
        }

        await ctx.editMessageText('⏳ Опрацювання даних...'); 
        const s = ctx.wizard.state;
        const target = s.targetAdmin;

                try {
            // Отримуємо нікнейм того, хто знімає
            const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            const issuerNick = issuer?.nickname || ctx.from.first_name; 

            // --- ДОДАНО: Дістаємо Діскорд ПЕРЕД очищенням таблиць ---
            const discordTag = await getAdminDiscord(s.targetNickname);

            // 1. Формуємо текст для інфо-каналу
            let infoText = `<b>Адміністратор ${s.targetNickname} знятий з посади адміністратора.</b>\n` +
                           `<b>Причина:</b> ${s.demoteReason}\n` +
                           `<b>Зняв:</b> ${issuerNick}\n`;
            if (s.needChsa) {
                infoText += `\n⛔️ Внесено до ЧСА на ${s.chsaMonths} міс.\n📝 Причина ЧСА: ${s.chsaReason}`;
            }

            // 2. Відправка в інфо-гілку
            const chatId = settings.CHATS.ALL_ADMINS.ID;
            const threadId = settings.CHATS.ALL_ADMINS.THREADS.INFO;

            await ctx.telegram.sendMessage(chatId, infoText, {
                message_thread_id: threadId ? Number(threadId) : undefined, 
                parse_mode: 'HTML'
            }).catch(err => console.error("Помилка відправки в Інфо:", err));

            // --- ДОДАНО: Сповіщення ГМ-у Діскорду ---
            const gmId = process.env.DISCORD_GM_ID;
            if (gmId) {
                const gmMsg = `Адмін ${s.targetNickname} був знятий з посади. Його зняв ${issuerNick}\nДіскорд знятого: ${discordTag}`;
                await ctx.telegram.sendMessage(gmId, gmMsg).catch(err => console.error("Не вдалося відправити ГМ-у:", err));
            }

            // 3. Робота з таблицями
            await demoteAdminInSheets(s.targetNickname);
            if (s.needChsa) {
                await addAdminToChsa(s.targetNickname, s.chsaReason, s.chsaMonths);
            }

            // 4. Кік з групи
            const targetTgId = Number(target.tgId);
            try {
                await ctx.telegram.banChatMember(chatId, targetTgId);
                await ctx.telegram.unbanChatMember(chatId, targetTgId);
            } catch (kickErr) {}

            // 5. Повідомлення знятому адміну
            let pmText = `Вас було знято з посади Адміністратора.\nЗняв: ${issuerNick}.\nПричина: ${s.demoteReason}.`;
            if (s.needChsa) pmText += `\nВнесено в ЧСА на ${s.chsaMonths} міс. Причина: ${s.chsaReason}`;
            
            try { await ctx.telegram.sendMessage(targetTgId, pmText); } catch (pmErr) {}

            // 6. Видалення з БД
            await prisma.admin.delete({ where: { id: target.id } });

            await ctx.editMessageText(`✅ Адміністратора <b>${s.targetNickname}</b> успішно знято з посади.`, { parse_mode: 'HTML' });

        } catch (e) {
            console.error('Помилка під час зняття:', e);
            await ctx.editMessageText('❌ Виникла помилка під час зняття.');
        }


        return ctx.scene.leave();
    }
);

const managePointsWizard = new Scenes.WizardScene(
    'MANAGE_POINTS_SCENE',
    async (ctx) => {
        await ctx.reply('Оберіть дію з балами:', Markup.inlineKeyboard([
            [Markup.button.callback('➕ Нарахувати бали', 'points_add')],
            [Markup.button.callback('➖ Зняти бали', 'points_sub')],
            [Markup.button.callback('❌ Скасувати', 'points_cancel')]
        ]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        if (ctx.callbackQuery.data === 'points_cancel') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }
        ctx.wizard.state.action = ctx.callbackQuery.data === 'points_add' ? 'add' : 'sub';
        await ctx.answerCbQuery();
        await ctx.editMessageText(`👤 Введіть ігровий нікнейм адміністратора:`);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const nickname = ctx.message.text.trim();
        const target = await prisma.admin.findUnique({ where: { nickname: nickname } });

        if (!target) {
            await ctx.reply('❌ Адміна не знайдено в базі бота. Спробуйте ще раз:');
            return;
        }

        ctx.wizard.state.targetAdmin = target;
        await ctx.reply(`📊 Адмін: ${target.nickname} (Баланс: ${target.bal})\n\n💰 Введіть кількість балів:`);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const amount = parseInt(ctx.message.text);
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Введіть коректне число:');
            return;
        }
        ctx.wizard.state.amount = amount;
        const s = ctx.wizard.state;

        const text = `⚠️ <b>ПІДТВЕРДЖЕННЯ</b>\n\n` +
                     `Дія: <b>${s.action === 'add' ? 'Нарахування' : 'Зняття'}</b>\n` +
                     `Адмін: <b>${s.targetAdmin.nickname}</b>\n` +
                     `Кількість: <b>${amount} балів</b>\n\n` +
                     `Продовжити?`;

        await ctx.reply(text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ПІДТВЕРДИТИ', 'confirm_pts')],
                [Markup.button.callback('❌ СКАСУВАТИ', 'cancel_pts')]
            ])
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.callbackQuery || ctx.callbackQuery.data === 'cancel_pts') {
            if (ctx.callbackQuery) await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }

        const s = ctx.wizard.state;
        try {
            const updateData = s.action === 'add' 
                ? { bal: { increment: s.amount } } 
                : { bal: { decrement: s.amount } };

            const updated = await prisma.admin.update({
                where: { id: s.targetAdmin.id },
                data: updateData
            });

            const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            
            const logMsg = `${s.action === 'add' ? '🪙' : '📉'} <b>АДМІН-КЕРУВАННЯ БАЛАМИ</b>\n\n` +
                           `👤 <b>${issuer.nickname}</b> ${s.action === 'add' ? 'нарахував' : 'зняв'} у <b>${s.targetAdmin.nickname}</b>\n` +
                           `💰 Кількість: <b>${s.amount} балів</b>\n` +
                           `💳 Новий баланс: <b>${updated.bal}</b>`;

            await ctx.telegram.sendMessage(settings.CHATS.BAL_LOGS.ID, logMsg, {
                parse_mode: 'HTML',
                message_thread_id: settings.CHATS.BAL_LOGS.THREAD ? Number(settings.CHATS.BAL_LOGS.THREAD) : undefined
            });

            await ctx.editMessageText(`✅ Успішно! Новий баланс: <b>${updated.bal}</b>`, { 
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 В кабінет', 'back_to_menu')]])
            });
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка БД.');
        }
        return ctx.scene.leave();
    }
);

// ==========================================
// ВІЗАРД: ПІДВИЩЕННЯ АДМІНІСТРАТОРА
// ==========================================
const promoteWizard = new Scenes.WizardScene(
    'PROMOTE_ADMIN_SCENE',
    // 1. Запит нікнейму
    async (ctx) => {
        await ctx.reply('📈 Введіть нікнейм адміністратора для ПІДВИЩЕННЯ:', Markup.keyboard([['❌ Скасувати']]).oneTime().resize());
        return ctx.wizard.next();
    },
    // 2. Пошук та логіка рівнів
    async (ctx) => {
        if (ctx.message.text === '❌ Скасувати') return ctx.scene.leave();
        const nickname = ctx.message.text.trim();
        ctx.wizard.state.nickname = nickname;

        const waitMsg = await ctx.reply('⏳ Аналізую історію підвищень...');
        const data = await getAdminForPromotion(nickname);

        if (!data) {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ Адміна не знайдено в реєстрі.');
            return ctx.scene.leave();
        }

        const currentLvl = data.currentLevel;
        const currentRole = data.currentRole;
        const nextLvl = currentLvl + 1;

        // ЛОГІКА ПРИВ'ЯЗКИ ПОСАД
        const promotionMap = {
            1: { role: 'Молодший Модератор', nextRole: 'Модератор' },
            2: { role: 'Модератор', nextRole: 'Старший Модератор' },
            3: { role: 'Старший Модератор', nextRole: 'Адміністратор' },
            4: { role: 'Адміністратор', nextRole: 'Куратор' }
        };

        let nextRole = null; // По замовчуванню не чіпаємо посаду
        
        // Перевіряємо, чи співпадає поточна посада зі стандартною для цього рівня
        if (promotionMap[currentLvl] && currentRole.trim() === promotionMap[currentLvl].role) {
            nextRole = promotionMap[currentLvl].nextRole;
        }

        ctx.wizard.state.promoData = {
            rowIndex: data.rowIndex,
            nextLvl: nextLvl,
            nextRole: nextRole || currentRole // Якщо не співпало — лишаємо стару
        };

        const text = `📊 <b>Дані для підвищення:</b>\n\n` +
                     `👤 Адмін: ${nickname}\n` +
                     `📈 Рівень: ${currentLvl} -> <b>${nextLvl}</b>\n` +
                     `💼 Посада: ${currentRole} -> <b>${nextRole || 'без змін'}</b>\n\n` +
                     `Бажаєте підтвердити підвищення?`;

        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ПІДТВЕРДИТИ', 'confirm_promo')],
                [Markup.button.callback('❌ СКАСУВАТИ', 'cancel_promo')]
            ])
        });
        return ctx.wizard.next();
    },
    // 3. Виконання
    async (ctx) => {
        if (!ctx.callbackQuery || ctx.callbackQuery.data === 'cancel_promo') {
            if (ctx.callbackQuery) await ctx.editMessageText('❌ Підвищення скасовано.');
            return ctx.scene.leave();
        }

        const s = ctx.wizard.state;
        await ctx.editMessageText('⏳ Оновлюю таблиці та базу...');

        try {
            // 1. Оновлюємо Таблицю
            await updateAdminPromotionInSheets(s.promoData.rowIndex, s.promoData.nextLvl, s.promoData.nextRole);

            // 2. Оновлюємо Базу Даних бота (щоб права в боті теж виросли)
            await prisma.admin.update({
                where: { nickname: s.nickname },
                data: { 
                    role: s.promoData.nextRole,
                    // Можеш також збільшити accessLevel в боті, якщо вони пов'язані
                }
            }).catch(() => console.log("Адмін не знайден в БД бота, тільки в таблиці"));

            // 3. Хто підвищив
            const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            const issuerNick = issuer?.nickname || ctx.from.first_name;

            // 4. Повідомлення в Інфо
            const infoMsg = `<b>📈 ПІДВИЩЕННЯ АДМІНІСТРАЦІЇ</b>\n\n` +
                            `👤 Адміністратор <b>${s.nickname}</b> підвищений на <b>${s.promoData.nextLvl}</b> рівень!\n` +
                            `💼 Посада: ${s.promoData.nextRole}\n` +
                            `👤 Підвищив: ${issuerNick}`;

            await ctx.telegram.sendMessage(settings.CHATS.ALL_ADMINS.ID, infoMsg, {
                message_thread_id: Number(settings.CHATS.ALL_ADMINS.THREADS.INFO),
                parse_mode: 'HTML'
            });

            await ctx.editMessageText(`✅ Адміністратора <b>${s.nickname}</b> успішно підвищено!`, { parse_mode: 'HTML' });

        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка при підвищенні.');
        }
        return ctx.scene.leave();
    }
);

module.exports = {
    level: 7,
    scenes: [demoteWizard, promoteWizard, managePointsWizard], // <--- Додали managePointsWizard
    getMenu: () => [
        [Markup.button.callback('📈 Підвищити адміна', 'open_promote_scene')],
        [Markup.button.callback('🪙 Керувати балами', 'open_points_scene')], // <--- Нова кнопка
        [Markup.button.callback('💥 Зняти адміністратора', 'open_demote_scene')]
    ],
    setup: (bot) => {
        bot.action('open_demote_scene', ctx => ctx.scene.enter('DEMOTE_ADMIN_SCENE'));
        bot.action('open_promote_scene', ctx => ctx.scene.enter('PROMOTE_ADMIN_SCENE'));
        bot.action('open_points_scene', ctx => ctx.scene.enter('MANAGE_POINTS_SCENE')); // <--- Новий екшен
    }
};
