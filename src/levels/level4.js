// src/levels/level4.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const settings = require('../config/settings');

const addBalBizwarWizard = new Scenes.WizardScene(
    'ADD_BAL_BW_SCENE',
    // КРОК 0: Запит нікнейму отримувача
    async (ctx) => {
        await ctx.reply('👤 Введіть нікнейм адміністратора для нарахування балів за БВ:', 
            Markup.keyboard([['❌ Скасувати']]).oneTime().resize()
        );
        return ctx.wizard.next();
    },
    // КРОК 1: Перевірка нікнейму та запит кількості бізварів
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        if (ctx.message.text === '❌ Скасувати') {
            await ctx.reply('❌ Скасовано.', Markup.removeKeyboard());
            return ctx.scene.leave();
        }

        const nickname = ctx.message.text.trim();
        const target = await prisma.admin.findUnique({ where: { nickname: nickname } });

        if (!target) {
            await ctx.reply('❌ Такого адміністратора не знайдено в базі бота. Спробуйте ще раз або скасуйте.');
            return; 
        }

        ctx.wizard.state.targetAdmin = target;
        await ctx.reply(`✅ Адміна знайдено: ${target.nickname}\n\n🔢 Введіть кількість відіграних бізварів (БВ):`, Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    // КРОК 2: Розрахунок (1 БВ = 10 балів) та підтвердження
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const bizwars = parseInt(ctx.message.text);

        if (isNaN(bizwars) || bizwars <= 0) {
            await ctx.reply('❌ Будь ласка, введіть число (кількість БВ):');
            return;
        }

        const points = bizwars * 10;
        ctx.wizard.state.bizwars = bizwars;
        ctx.wizard.state.points = points;

        const text = `⚠️ <b>ПІДТВЕРДЖЕННЯ (БІЗВАРИ)</b>\n\n` +
                     `👤 Отримувач: <b>${ctx.wizard.state.targetAdmin.nickname}</b>\n` +
                     `⚔️ Кількість БВ: <b>${bizwars}</b>\n` +
                     `🪙 Балів до зарахування: <b>${points}</b>\n\n` +
                     `Нарахувати?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ ТАК', 'confirm_add_bal_bw')],
            [Markup.button.callback('❌ НІ', 'cancel_add_bal_bw')]
        ]);

        await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
        return ctx.wizard.next();
    },
    // КРОК 3: Виконання та лог
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const answer = ctx.callbackQuery.data;

        if (answer === 'confirm_add_bal_bw') {
            const { targetAdmin, points, bizwars } = ctx.wizard.state;

            try {
                // 1. Оновлюємо баланс
                const updatedAdmin = await prisma.admin.update({
                    where: { id: targetAdmin.id },
                    data: { bal: { increment: points } }
                });

                // 2. Хто нарахував
                const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
                const issuerNick = issuer?.nickname || ctx.from.first_name;

                // 3. Лог у нову групу (BAL_LOGS)
               // --- ЛОГ У НОВУ ГРУПУ (Тільки текст в один рядок) ---
                const logMsg = `👤 ${issuerNick} нарахував адміну ${targetAdmin.nickname} ${points} балів за: ${bizwars} бізварів`;

                await ctx.telegram.sendMessage(settings.CHATS.BAL_LOGS.ID, logMsg, {
                    message_thread_id: settings.CHATS.BAL_LOGS.THREAD ? Number(settings.CHATS.BAL_LOGS.THREAD) : undefined
                });

                // 4. Сповіщення адміну
                await ctx.telegram.sendMessage(targetAdmin.tgId.toString(), 
                    `✅ Вам було нараховано <b>${points} балів</b> за бізвари (БВ: ${bizwars} шт.)\n` +
                    `Ваш поточний баланс: <b>${updatedAdmin.bal} балів</b>.`, 
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                await ctx.editMessageText(`✅ Бали за бізвари успішно нараховані!`, 
                    Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
                );

            } catch (e) {
                console.error(e);
                await ctx.editMessageText('❌ Помилка БД.', 
                    Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
                );
            }
        } else {
            await ctx.editMessageText('❌ Нарахування скасовано.', 
                Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
            );
        }
        return ctx.scene.leave();
    }
);

module.exports = {
    level: 4, 
    scenes: [addBalBizwarWizard],
    getMenu: (userLevel) => {
        // Кнопка з'явиться ТІЛЬКИ у КНО (4 рівень)
        if (userLevel === 4) {
            return [[Markup.button.callback('⚔️ Нарахувати бали (БВ)', 'start_add_bal_bw')]];
        }
        return [];
    },
    setup: (bot) => {
        bot.action('start_add_bal_bw', async (ctx) => {
            // СУВОРА ПЕРЕВІРКА 4 РІВНЯ
            const admin = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            
            if (!admin || admin.accessLevel !== 4) {
                return ctx.answerCbQuery('⛔️ Ця функція доступна СУВОРО лише для КНО (4 рівень)!', { show_alert: true });
            }

            await ctx.answerCbQuery();
            await ctx.scene.enter('ADD_BAL_BW_SCENE');
        });
    }
};
