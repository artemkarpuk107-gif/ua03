// src/levels/level9.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');

const grantAccessWizard = new Scenes.WizardScene(
    'GRANT_ACCESS_SCENE',
    // КРОК 0: Запит нікнейму
    async (ctx) => {
        await ctx.reply('🔍 Введіть ігровий нікнейм гравця (точно як у базі):', 
            Markup.keyboard([['❌ Скасувати']]).oneTime().resize()
        );
        return ctx.wizard.next();
    },
    // КРОК 1: Перевірка ніка та вибір рівня
    async (ctx) => {
        if (ctx.message.text === '❌ Скасувати') {
            await ctx.reply('❌ Операцію скасовано.', Markup.removeKeyboard());
            return ctx.scene.leave();
        }
        
        const nickname = ctx.message.text.trim();
        const target = await prisma.admin.findUnique({ where: { nickname: nickname } });
        
        if (!target) {
            await ctx.reply('❌ Гравець не знайдений у системі верифікації.', Markup.removeKeyboard());
            return ctx.scene.leave();
        }

        ctx.wizard.state.targetAdmin = target;

        // Оновлений список рівнів: ЗГС замінено на ГІМ
        const levelButtons = [
            [Markup.button.callback('1: Адмін / СА', 'set_lvl_1')],
            [Markup.button.callback('2: ГІМ', 'set_lvl_2')], // <--- Перейменовано
            [Markup.button.callback('3: ГС', 'set_lvl_3')],
            [Markup.button.callback('4: КНО', 'set_lvl_4')],
            [Markup.button.callback('5: КДО', 'set_lvl_5')],
            [Markup.button.callback('6: КСА', 'set_lvl_6')],
            [Markup.button.callback('7: ЗКА', 'set_lvl_7')],
            [Markup.button.callback('8: КА / ЗГА / ГА', 'set_lvl_8')]
        ];

        await ctx.reply(`Знайдено: ${target.nickname}\nПоточний рівень: ${target.accessLevel}\nОберіть новий рівень прав:`, 
            Markup.inlineKeyboard(levelButtons)
        );
        return ctx.wizard.next();
    },
    // КРОК 2: Фінальне підтвердження
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const level = parseInt(ctx.callbackQuery.data.replace('set_lvl_', ''));
        ctx.wizard.state.selectedLevel = level;
        
        const { targetAdmin } = ctx.wizard.state;

        const text = `⚠️ <b>ПІДТВЕРДЖЕННЯ</b>\n\n` +
                     `Ви хочете видати <b>${level} рівень</b> для:\n` +
                     `👤 Нік: <code>${targetAdmin.nickname}</code>\n` +
                     `🆔 TG: <code>${targetAdmin.tgId}</code>\n\n` +
                     `Дія незворотна. Продовжити?`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ ТАК, ВИДАТИ', 'confirm_grant')],
            [Markup.button.callback('❌ СКАСУВАТИ', 'cancel_grant')]
        ]);

        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
        return ctx.wizard.next();
    },
    // КРОК 3: Запис у базу
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const answer = ctx.callbackQuery.data;

        if (answer === 'confirm_grant') {
            const { targetAdmin, selectedLevel } = ctx.wizard.state;
            
            try {
                await prisma.admin.update({
                    where: { id: targetAdmin.id },
                    data: { accessLevel: selectedLevel }
                });

                // Додаємо кнопку повернення в меню
                await ctx.editMessageText(`✅ Права успішно оновлені для <b>${targetAdmin.nickname}</b>!`, { 
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
                });
            } catch (e) {
                await ctx.editMessageText('❌ Помилка при оновленні бази даних.', 
                    Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
                );
            }
        } else {
            await ctx.editMessageText('❌ Операцію скасовано.', 
                Markup.inlineKeyboard([[Markup.button.callback('🔙 Повернутись в кабінет', 'back_to_menu')]])
            );
        }
        return ctx.scene.leave();
    }
);

module.exports = {
    level: 9,
    scenes: [grantAccessWizard],
    getMenu: () => [[Markup.button.callback('🔐 Бот-адмінка (Видача прав)', 'open_bot_admin')]],
    setup: (bot) => {
        bot.action('open_bot_admin', async (ctx) => {
            await ctx.answerCbQuery();
            const manageButtons = [
                [Markup.button.callback('➕ Видати права', 'start_grant')],
                [Markup.button.callback('➖ Зняти права (в розробці)', 'start_revoke')],
                [Markup.button.callback('🔙 Назад', 'back_to_menu')]
            ];
            await ctx.editMessageText('Керування правами бота:', Markup.inlineKeyboard(manageButtons));
        });

        bot.action('start_grant', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.scene.enter('GRANT_ACCESS_SCENE');
        });
    }
};
