const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const settings = require('../config/settings');

// Для 3 рівня тільки одна ціна
const REPORT_PRICE = 10;

const addBalGsWizard = new Scenes.WizardScene(
    'ADD_BAL_GS_SCENE',
    // КРОК 0: Запит нікнейму
    async (ctx) => {
        await ctx.reply('👤 Введіть нікнейм слідкуючого для нарахування балів за звіти:', 
            Markup.keyboard([['❌ Скасувати']]).oneTime().resize()
        );
        return ctx.wizard.next();
    },
    // КРОК 1: Перевірка нікнейму
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        if (ctx.message.text === '❌ Скасувати') {
            await ctx.reply('❌ Скасовано.', Markup.removeKeyboard());
            return ctx.scene.leave();
        }

        const nickname = ctx.message.text.trim();
        const target = await prisma.admin.findUnique({ where: { nickname: nickname } });

        if (!target) {
            await ctx.reply('❌ Адміна не знайдено в базі бота. Спробуйте ще раз або скасуйте:');
            return; 
        }

        ctx.wizard.state.targetAdmin = target;
        await ctx.reply(`✅ Знайдено: ${target.nickname}\n\n🔢 Введіть кількість перевірених звітів:`, Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    // КРОК 2: Розрахунок та підтвердження
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const count = parseInt(ctx.message.text);

        if (isNaN(count) || count <= 0) {
            await ctx.reply('❌ Введіть коректне число (кількість звітів):');
            return;
        }

        const points = count * REPORT_PRICE;
        ctx.wizard.state.count = count;
        ctx.wizard.state.points = points;

        const text = `⚠️ <b>ПІДТВЕРДЖЕННЯ (ГС)</b>\n\n` +
                     `👤 Слідкуючий: <b>${ctx.wizard.state.targetAdmin.nickname}</b>\n` +
                     `📑 Кількість звітів: <b>${count}</b>\n` +
                     `🪙 Балів до зарахування: <b>${points}</b>\n\n` +
                     `Нарахувати?`;

        await ctx.reply(text, { 
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ТАК', 'confirm_gs_bal')],
                [Markup.button.callback('❌ НІ', 'cancel_gs_bal')]
            ])
        });
        return ctx.wizard.next();
    },
    // КРОК 3: Виконання та лог
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const action = ctx.callbackQuery.data;

        if (action !== 'confirm_gs_bal') {
            await ctx.editMessageText('❌ Нарахування скасовано.');
            return ctx.scene.leave();
        }

        // Захист від дублів
        if (ctx.callbackQuery.message.text.includes('⌛️')) return ctx.answerCbQuery();

        const s = ctx.wizard.state;
        await ctx.answerCbQuery('⏳ Опрацювання...');
        await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n⌛️ <b>Опрацювання...</b>', { parse_mode: 'HTML' });

        try {
            const updated = await prisma.admin.update({
                where: { id: s.targetAdmin.id },
                data: { bal: { increment: s.points } }
            });

            const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            const issuerNick = issuer?.nickname || ctx.from.first_name;

            // --- ЛОГ У ГРУПУ (В один рядок як просив) ---
            const logMsg = `👤 ${issuerNick} нарахував адміну ${s.targetAdmin.nickname} ${s.points} балів за: ${s.count} звітів слід.`;

            await ctx.telegram.sendMessage(settings.CHATS.BAL_LOGS.ID, logMsg, {
                message_thread_id: settings.CHATS.BAL_LOGS.THREAD ? Number(settings.CHATS.BAL_LOGS.THREAD) : undefined
            });

            // Сповіщення отримувачу
            await ctx.telegram.sendMessage(s.targetAdmin.tgId.toString(), 
                `✅ Вам нараховано <b>${s.points} балів</b> за перевірені звіти (${s.count} шт.)\n` +
                `Ваш баланс: <b>${updated.bal} балів</b>.`, { parse_mode: 'HTML' }
            ).catch(() => {});

            await ctx.editMessageText(`✅ Бали успішно нараховані!`, 
                Markup.inlineKeyboard([[Markup.button.callback('🔙 В кабінет', 'back_to_menu')]])
            );

        } catch (e) {
            console.error(e);
            await ctx.editMessageText('❌ Помилка БД.');
        }
        return ctx.scene.leave();
    }
);

module.exports = {
    level: 3,
    scenes: [addBalGsWizard],
    getMenu: (userLevel) => {
        if (userLevel === 3) {
            return [
                [Markup.button.callback('🕵️ Керування Слідкуючими', 'open_supervisors')],
                [Markup.button.callback('📑 Нарахувати за звіти', 'start_add_bal_gs')]
            ];
        }
        return [];
    },
    setup: (bot) => {
        bot.action('open_supervisors', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.scene.enter('SUPERVISORS_SCENE');
        });

        bot.action('start_add_bal_gs', async (ctx) => {
            const admin = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            if (!admin || admin.accessLevel !== 3) {
                return ctx.answerCbQuery('⛔️ Доступно тільки для ГС (3 рівень)!', { show_alert: true });
            }
            await ctx.answerCbQuery();
            await ctx.scene.enter('ADD_BAL_GS_SCENE');
        });
    }
};
