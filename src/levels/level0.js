// src/levels/level0.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const { checkAdminByNickname } = require('../services/sheets');

const verificationWizard = new Scenes.WizardScene(
    'VERIFICATION_SCENE',
    // КРОК 1: Вибір ролі
    async (ctx) => {
        const buttons = [
            [Markup.button.callback('👨‍💼 Адміністратор', 'verify_admin')],
            [Markup.button.callback('👑 Лідер фракції', 'verify_reject')],
            [Markup.button.callback('👔 Зам. лідера фракції', 'verify_reject')],
            [Markup.button.callback('🛡 Лідер сім\'ї', 'verify_reject')]
        ];
        await ctx.reply('Ким ви хочете верифікуватись?', Markup.inlineKeyboard(buttons));
        return ctx.wizard.next();
    },
    // КРОК 2: Обробка вибору
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        const action = ctx.callbackQuery.data;

        if (action === 'verify_reject') {
            await ctx.editMessageText('❌ Тимчасово неактуально.');
            return ctx.scene.leave();
        }

        if (action === 'verify_admin') {
            await ctx.editMessageText('🔍 Введіть ваш ігровий нікнейм (точно як у таблиці):');
            return ctx.wizard.next();
        }
    },
    // КРОК 3: Перевірка в таблиці та запис у базу
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const nickname = ctx.message.text.trim();
        
        const waitMsg = await ctx.reply('⏳ Перевіряю таблицю, зачекайте...');

        try {
            // Йдемо в таблицю шукати нік
            const isFound = await checkAdminByNickname(nickname);

            if (!isFound) {
                await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, 
                    '❌ Вас не ідентифіковано як адміністратора. Спробуйте перевірити правильність нікнейму, або зверніться до куратора.'
                );
                return ctx.scene.leave();
            }

            // Перевіряємо, чи немає вже такої заявки від цього юзера
            const existingRequest = await prisma.verificationRequest.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            if (existingRequest) {
                await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '⏳ Ваша заявка вже розглядається керівництвом. Очікуйте.');
                return ctx.scene.leave();
            }

            // Записуємо заявку в базу даних (в чергу)
            await prisma.verificationRequest.create({
                data: {
                    tgId: BigInt(ctx.from.id),
                    username: ctx.from.username ? `@${ctx.from.username}` : 'Без ніка',
                    name: ctx.from.first_name || 'Без імені',
                    nickname: nickname,
                    status: 'Pending'
                }
            });

            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, 
                '✅ Ваш нікнейм знайдено в таблиці!\n\nЗаявку успішно створено. Очікуйте на підтвердження від старшої адміністрації.'
            );
            return ctx.scene.leave();

        } catch (error) {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ Виникла помилка підключення до бази або таблиці. Спробуйте пізніше.');
            return ctx.scene.leave();
        }
    }
);

module.exports = {
    level: 0,
    scenes: [verificationWizard],
    // Це меню побачать ті, хто не пройшов верифікацію
    getMenu: () => [
        [Markup.button.callback('✅ Пройти верифікацію', 'start_verification')]
    ],
    setup: (bot) => {
        bot.action('start_verification', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.scene.enter('VERIFICATION_SCENE');
        });
    }
};