// src/levels/level2.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const settings = require('../config/settings');

const addBalWizard = new Scenes.WizardScene(
    'ADD_BAL_SCENE',
    // КРОК 0: Запит нікнейму отримувача
    async (ctx) => {
        await ctx.reply('👤 Введіть ігровий нікнейм адміністратора, якому нараховуємо бали:', 
            Markup.keyboard([['❌ Скасувати']]).oneTime().resize()
        );
        return ctx.wizard.next();
    },
    // КРОК 1: Перевірка нікнейму та запит кількості івентів
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
        await ctx.reply(`✅ Адміна знайдено: ${target.nickname}\n\n🔢 Введіть кількість проведених івентів:`, Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    // КРОК 2: Розрахунок та підтвердження
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const events = parseInt(ctx.message.text);

        if (isNaN(events) || events <= 0) {
            await ctx.reply('❌ Будь ласка, введіть коректне число (кількість івентів):');
            return;
        }

        const points = events * 10;
        ctx.wizard.state.events = events;
        ctx.wizard.state.points = points;

        const text = `⚠️ <b>ПІДТВЕРДЖЕННЯ НАРАХУВАННЯ</b>\n\n` +
                     `👤 Отримувач: <b>${ctx.wizard.state.targetAdmin.nickname}</b>\n` +
                     `🎭 Кількість івентів: <b>${events}</b>\n` +
                     `🪙 Балів до зарахування: <b>${points}</b>\n\n` +
                     `Все вірно?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ ПІДТВЕРДИТИ', 'confirm_add_bal')],
            [Markup.button.callback('❌ ВІДХИЛИТИ', 'cancel_add_bal')]
        ]);

        await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
        return ctx.wizard.next();
    },
    // КРОК 3: Виконання нарахування та логування
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const answer = ctx.callbackQuery.data;

        if (answer === 'confirm_add_bal') {
            const { targetAdmin, points, events } = ctx.wizard.state;

            try {
                const updatedAdmin = await prisma.admin.update({
                    where: { id: targetAdmin.id },
                    data: { bal: { increment: points } }
                });

                const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
                const issuerNick = issuer?.nickname || ctx.from.first_name;

                // --- ЛОГ У НОВУ ГРУПУ ---
               // --- ЛОГ У НОВУ ГРУПУ ---
                const logMsg = `👤 ${issuerNick} нарахував адміну ${targetAdmin.nickname} ${points} балів за: ${events} івентів`;

                await ctx.telegram.sendMessage(settings.CHATS.BAL_LOGS.ID, logMsg, {
                    // message_thread_id: settings.CHATS.BAL_LOGS.THREAD ? Number(settings.CHATS.BAL_LOGS.THREAD) : undefined
                });

                // Сповіщення отримувачу
                await ctx.telegram.sendMessage(targetAdmin.tgId.toString(), 
                    `✅ Вам було нараховано <b>${points} балів</b> за проведений івент (${events} шт.)\n` +
                    `Ваш поточний баланс: <b>${updatedAdmin.bal} балів</b>.`, 
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                await ctx.editMessageText(`✅ Бали успішно нараховані!`, 
                    Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
                );

            } catch (e) {
                console.error(e);
                await ctx.editMessageText('❌ Помилка при роботі з базою даних.',
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
    level: 2, 
    scenes: [addBalWizard],
    getMenu: (userLevel) => {
        // Тепер кнопка ТІЛЬКИ для 2 рівня, на 9-му її не буде
        if (userLevel === 2) {
            return [[Markup.button.callback('🪙 Нарахувати бали', 'start_add_bal')]];
        }
        return [];
    },
    setup: (bot) => {
        bot.action('start_add_bal', async (ctx) => {
            // СУВОРА ПЕРЕВІРКА РІВНЯ
            const admin = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            
            if (!admin || admin.accessLevel !== 2) {
                return ctx.answerCbQuery('⛔️ Ця функція доступна СУВОРО лише для ГІМ (2 рівень)!', { show_alert: true });
            }

            await ctx.answerCbQuery();
            await ctx.scene.enter('ADD_BAL_SCENE');
        });
    }
};
