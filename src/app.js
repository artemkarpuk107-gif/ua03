// src/app.js
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const prisma = require('./config/db');
const { getAdminStats } = require('./services/sheets');

const { prepareLevels, getStage, setupBotActions, getButtonsForAccessLevel } = require('./levels'); 

const bot = new Telegraf(process.env.BOT_TOKEN);

prepareLevels();
bot.use(session());

// --- 1. ГЛОБАЛЬНИЙ ЗАХИСТ ВІД ЗНЯТИХ АДМІНІВ ---
// --- 1. ГЛОБАЛЬНИЙ ЗАХИСТ (БЕЗПЕЧНИЙ) ---
bot.use(async (ctx, next) => {
    // 1. Пропускаємо команду /start
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start')) {
        return next();
    }

    // 2. Якщо це натискання кнопки
    if (ctx.callbackQuery) {
        const data = ctx.callbackQuery.data;

        // Дозволяємо кнопки верифікації (додай сюди всі коди кнопок, які мають працювати для новачків)
        if (data === 'verify_admin' || data === 'start_verification' || data.includes('level_0')) {
            return next();
        }

        // Дозволяємо, якщо людина вже всередині сцени
        if (ctx.session?.__scenes?.current) {
            return next();
        }

        try {
            const admin = await prisma.admin.findUnique({ 
                where: { tgId: BigInt(ctx.from.id) } 
            });

            if (!admin) {
                // Використовуємо .catch(() => {}) щоб бот не падав, якщо запит застарів
                return ctx.answerCbQuery('⛔️ ДОСТУП ЗАБОРОНЕНО!\nВас було знято з посади, старі кнопки більше не працюють.', { show_alert: true })
                          .catch(e => console.log("Ігноруємо застарілий callback query"));
            }
        } catch (e) {
            console.error('Помилка перевірки доступу:', e);
        }
    }

    return next();
});

const stage = getStage(); 
bot.use(stage.middleware());
setupBotActions(bot);

// Тепер кабінет відкривається і на /start, і на /menu
bot.command(['start', 'menu'], async (ctx) => {
    // --- ЗАХИСТ ВІД ВИКОРИСТАННЯ В ГРУПАХ ---
    if (ctx.chat.type !== 'private') {
        try {
            const msg = await ctx.reply('❌ <b>Особистий кабінет доступний лише в ПП!</b>', { parse_mode: 'HTML' });
            setTimeout(() => {
                ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
                ctx.deleteMessage().catch(() => {});
            }, 5000);
        } catch (e) {}
        return; 
    }

    // ==========================================
    // ДОДАЄМО ЦЕЙ БЛОК: ОЧИСТКА СТАРИХ КНОПОК
    // ==========================================
    try {
        const tempMsg = await ctx.reply('🔄 Завантаження...', Markup.removeKeyboard());
        await ctx.telegram.deleteMessage(ctx.chat.id, tempMsg.message_id).catch(() => {});
    } catch (e) {}
    // ==========================================

    const userId = BigInt(ctx.from.id); 

    try {
        let admin = await prisma.admin.findUnique({ where: { tgId: userId } });
        // ... і далі весь твій старий код без змін ...
        // ... ДАЛІ ЙДЕ ВЕСЬ ТВІЙ ІСНУЮЧИЙ КОД БЕЗ ЗМІН ...

        // ЯКЩО АДМІНА НЕМАЄ В БАЗІ (новий або знятий)
        if (!admin) {
            // ОЧИЩЕННЯ: Видаляємо стару заявку, щоб дозволити нову верифікацію
            await prisma.verificationRequest.deleteMany({ where: { tgId: userId } });

            const count = await prisma.admin.count();
            if (count === 0) {
                admin = await prisma.admin.create({
                    data: {
                        tgId: userId,
                        username: ctx.from.username ? `@${ctx.from.username}` : 'Без ніка',
                        name: ctx.from.first_name || 'Без імені',
                        nickname: 'Owner',
                        role: 'Власник',
                        accessLevel: 9,
                        status: 'Active'
                    }
                });
                ctx.reply('👑 Ініціалізація успішна! Ти отримав 9-й рівень доступу.');
            } else {
                // ПУНКТ: Новий вхід (після видалення старої заявки вище)
                const buttons = getButtonsForAccessLevel(0);
                const keyboard = Markup.inlineKeyboard(buttons);
                return ctx.reply('👋 Вітаю! Ви не верифіковані в системі або були зняті. Бажаєте подати заявку?', keyboard);
            }
        }

        // Якщо статус адміна вручну змінено на Fired (без видалення з бази)
        if (admin && admin.status === 'Fired') {
            return ctx.reply('❌ Ваш доступ призупинено керівництвом.');
        }

        // --- ГЕНЕРАЦІЯ КАБІНЕТУ ---
       // --- ГЕНЕРАЦІЯ КАБІНЕТУ ---
        const buttons = getButtonsForAccessLevel(admin.accessLevel);
        const keyboard = Markup.inlineKeyboard(buttons);
        
        const stats = admin.nickname ? await getAdminStats(admin.nickname) : null;
        
        // Авто-синхронізатор посади
        if (stats && stats.role && stats.role !== admin.role) {
            await prisma.admin.update({ 
                where: { id: admin.id }, 
                data: { role: stats.role } 
            });
            admin.role = stats.role; 
        }

        let text = `💼 <b>Особистий кабінет</b>\n\n`;
        text += `👤 Ім'я: ${admin.name}\n`;
        text += `🎮 Нікнейм: ${admin.nickname || 'Не вказано'}\n`;
        
        // === ДОДАЛИ ВИВІД БАЛІВ ===
        text += `🪙 Бали: <b>${admin.bal}</b>\n`; 
        // =========================
        
        if (stats) {
            text += `🔖 Посада: ${stats.role}\n`;
            text += `📈 Рівень прав: ${stats.adminLevel}\n`;
            text += `🗓 Днів на адмінці: ${stats.daysOnAdmin}\n`;
            text += `⬆️ Днів з підвищення: ${stats.daysFromPromo}\n`;
            text += `⚠️ Активні догани:\n`;
            text += `   ├ Суворі: ${stats.strictWarns}\n`;
            text += `   └ Усні: ${stats.verbalWarns}\n\n`;
        } else {
            text += `🔖 Посада: ${admin.role}\n\n`;
        }
        
        text += `Оберіть доступну дію:`;
        await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });

    } catch (error) {
        console.error('Помилка:', error);
        ctx.reply('Виникла помилка. Спробуйте /start ще раз.');
    }
});

// Авто-схвалення заявок ТІЛЬКИ для своїх
bot.on('chat_join_request', async (ctx) => {
    try {
        const userId = BigInt(ctx.from.id);
        
        // Шукаємо людину в базі адмінів
        const admin = await prisma.admin.findUnique({ where: { tgId: userId } });

        if (admin && admin.status === 'Active') {
            // Якщо свій - пускаємо!
            await ctx.approveChatJoinRequest(userId);
            console.log(`✅ Пустив адміна ${admin.nickname} в чат.`);
        } else {
            // Якщо чужий - видаляємо заявку
            await ctx.declineChatJoinRequest(userId);
            console.log(`🚫 Відхилив лівого юзера з ID: ${userId}`);
        }
    } catch (e) {
        console.error('Помилка авто-прийому:', e);
    }
});

// ==========================================
// СЕКРЕТНА КОМАНДА: ЗМІНА НІКНЕЙМУ (/nick Старий Новий)
// ==========================================
bot.hears(/^\/nick (.+) (.+)$/, async (ctx) => {
    try {
        // Перевіряємо, чи має людина права на це (наприклад, 8-9 рівень)
        const caller = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
        if (!caller || caller.accessLevel < 8) {
            return ctx.reply('⛔️ У вас немає прав для використання цієї команди.');
        }

        const oldNick = ctx.match[1].trim();
        const newNick = ctx.match[2].trim();

        // Оновлюємо нік в базі бота
        await prisma.admin.update({
            where: { nickname: oldNick },
            data: { nickname: newNick }
        });

        await ctx.reply(`✅ <b>Успішно!</b>\n\nНікнейм в базі бота змінено:\n❌ <code>${oldNick}</code> ➡️ ✅ <code>${newNick}</code>\n\n⚠️ <b>ВАЖЛИВО:</b> Тепер обов'язково піди і зміни цей нік в Гугл Таблицях (у всіх вкладках), інакше статистика злетить!`, { parse_mode: 'HTML' });

    } catch (e) {
        console.error('Помилка зміни ніка:', e);
        await ctx.reply(`❌ Помилка! Можливо, адміна " ${ctx.match[1]} " не існує в базі бота.`);
    }
});


// Запуск бота та встановлення меню
// Запуск бота та встановлення меню
bot.launch({ dropPendingUpdates: true }).then(() => { // <--- ДОДАЛИ НАЛАШТУВАННЯ ТУТ
    console.log('🚀 Бот запущений та захищений! Всі старі повідомлення проігноровано.');
    
    // Встановлюємо вбудовану кнопку "Меню"
    bot.telegram.setMyCommands([
        { command: 'menu', description: 'Відкрити особистий кабінет' },
        { command: 'start', description: 'Перезапустити бота' }
    ]).catch(e => console.error('Не вдалося встановити команди меню:', e));
});
