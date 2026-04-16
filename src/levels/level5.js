const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const settings = require('../config/settings');
const { supervisorsWizard } = require('./supervisors'); 

// Налаштування цін за 1 одиницю
const RATES = {
    report_slid: { name: 'Звіт слід.', price: 10 },
    report_gs: { name: 'Звіт ГС-а', price: 30 },
    grp_watch: { name: 'Слідк. за ГРП', price: 25 },
    leader_meet: { name: 'Збір лідерів', price: 30 },
    obzvin: { name: 'Обзвін слід.', price: 20 }
};

const addBalKdoWizard = new Scenes.WizardScene(
    'ADD_BAL_KDO_SCENE',
    // КРОК 0: Запит нікнейму
    async (ctx) => {
        await ctx.reply('👤 Введіть нікнейм адміністратора для нарахування балів:', 
            Markup.keyboard([['❌ Скасувати']]).oneTime().resize()
        );
        return ctx.wizard.next();
    },
    // КРОК 1: Перевірка ніка та вибір категорії
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        if (ctx.message.text === '❌ Скасувати') {
            await ctx.reply('❌ Скасовано.', Markup.removeKeyboard());
            return ctx.scene.leave();
        }

        const nickname = ctx.message.text.trim();
        const target = await prisma.admin.findUnique({ where: { nickname: nickname } });

        if (!target) {
            await ctx.reply('❌ Адміна не знайдено. Спробуйте ще раз:');
            return; 
        }

        ctx.wizard.state.targetAdmin = target;

        const buttons = [
            [Markup.button.callback('📑 Звіт слід. (10)', 'type_report_slid')],
            [Markup.button.callback('📊 Звіт ГС-а (30)', 'type_report_gs')],
            [Markup.button.callback('🎭 Слідк. за ГРП (25)', 'type_grp_watch')],
            [Markup.button.callback('👥 Збір лідерів (30)', 'type_leader_meet')],
            [Markup.button.callback('📞 Обзвін слід. (20)', 'type_obzvin')],
            [Markup.button.callback('❌ Скасувати', 'cancel_bal')]
        ];

        await ctx.reply(`✅ Знайдено: ${target.nickname}\nОберіть категорію нарахування:`, 
            Markup.inlineKeyboard(buttons)
        );
        return ctx.wizard.next();
    },
    // КРОК 2: Вибір типу та запит кількості
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const data = ctx.callbackQuery.data;

        if (data === 'cancel_bal') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }

        const typeKey = data.replace('type_', '');
        ctx.wizard.state.selectedType = typeKey;

        await ctx.answerCbQuery();
        await ctx.editMessageText(`🔢 Введіть кількість [${RATES[typeKey].name}]:`);
        return ctx.wizard.next();
    },
    // КРОК 3: Розрахунок та підтвердження
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const count = parseInt(ctx.message.text);
        const s = ctx.wizard.state;

        if (isNaN(count) || count <= 0) {
            await ctx.reply('❌ Введіть коректне число:');
            return;
        }

        const totalPrice = count * RATES[s.selectedType].price;
        s.count = count;
        s.totalPrice = totalPrice;

        const text = `⚠️ <b>ПІДТВЕРДЖЕННЯ (КДО)</b>\n\n` +
                     `👤 Адмін: <b>${s.targetAdmin.nickname}</b>\n` +
                     `📌 Категорія: <b>${RATES[s.selectedType].name}</b>\n` +
                     `🔢 Кількість: <b>${count}</b>\n` +
                     `🪙 Разом: <b>${totalPrice} балів</b>\n\n` +
                     `Нарахувати?`;

        await ctx.reply(text, { 
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ ТАК', 'confirm_kdo_bal')],
                [Markup.button.callback('❌ НІ', 'cancel_kdo_bal')]
            ])
        });
        return ctx.wizard.next();
    },
    // КРОК 4: Запис та лог
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        if (ctx.callbackQuery.data !== 'confirm_kdo_bal') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }

        const s = ctx.wizard.state;
        try {
            const updated = await prisma.admin.update({
                where: { id: s.targetAdmin.id },
                data: { bal: { increment: s.totalPrice } }
            });

            const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            
            // Лог у групу BAL_LOGS
            // --- ЛОГ У ГРУПУ (В один рядок) ---
            const logMsg = `👤 ${issuer.nickname || ctx.from.first_name} нарахував адміну ${s.targetAdmin.nickname} ${s.totalPrice} балів за: ${s.count} ${RATES[s.selectedType].name}`;

            await ctx.telegram.sendMessage(settings.CHATS.BAL_LOGS.ID, logMsg, {
                message_thread_id: settings.CHATS.BAL_LOGS.THREAD ? Number(settings.CHATS.BAL_LOGS.THREAD) : undefined
            });

            // Сповіщення адміну
            await ctx.telegram.sendMessage(s.targetAdmin.tgId.toString(), 
                `✅ Вам нараховано <b>${s.totalPrice} балів</b> за <b>${RATES[s.selectedType].name}</b>\n` +
                `Баланс: <b>${updated.bal} балів</b>.`, { parse_mode: 'HTML' }
            ).catch(() => {});

            await ctx.editMessageText('✅ Бали успішно нараховані!', 
                Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
            );
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка БД.');
        }
        return ctx.scene.leave();
    }
);

module.exports = {
    level: 5,
    scenes: [supervisorsWizard, addBalKdoWizard],
    getMenu: (userLevel) => {
        // Кнопки бачить ТІЛЬКИ 5 рівень. 6, 7, 8, 9 — не бачать.
        if (userLevel === 5) {
            return [
                [Markup.button.callback('👑 Керування Слідкуючими та ГС', 'open_supervisors')],
                [Markup.button.callback('🪙 Нарахувати бали (КДО)', 'start_add_bal_kdo')]
            ];
        }
        return [];
    },
    setup: (bot) => {
        bot.action('open_supervisors', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.scene.enter('SUPERVISORS_SCENE');
        });

        bot.action('start_add_bal_kdo', async (ctx) => {
            const admin = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            // Тут теж лишаємо сувору перевірку для безпеки
            if (!admin || admin.accessLevel !== 5) {
                return ctx.answerCbQuery('⛔️ Доступно тільки для КДО (5 рівень)!', { show_alert: true });
            }
            await ctx.answerCbQuery();
            await ctx.scene.enter('ADD_BAL_KDO_SCENE');
        });
    }
};
