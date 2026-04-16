// src/levels/level6.js
const { Scenes, Markup } = require('telegraf');
const prisma = require('../config/db');
const { getAdminStats, updateAdminWarnings } = require('../services/sheets');
const settings = require('../config/settings');

// ==========================================
// ЛОГІКА ЗАЯВОК НА ВЕРИФІКАЦІЮ
// ==========================================
const showNextRequest = async (ctx) => {
    const req = await prisma.verificationRequest.findFirst({
        where: { status: 'Pending' },
        orderBy: { createdAt: 'asc' }
    });

    if (!req) {
        const text = '🎉 Немає нових заявок на верифікацію! Ви все перевірили.';
        const kb = Markup.inlineKeyboard([[Markup.button.callback('🔙 Закрити', 'close_panel')]]);
        if (ctx.callbackQuery) return ctx.editMessageText(text, kb);
        return ctx.reply(text, kb);
    }

    const text = `📝 <b>Нова заявка на верифікацію</b>\n\n` +
                 `🎮 Нікнейм: ${req.nickname}\n` +
                 `👤 Telegram: ${req.name} (@${req.username || 'приховано'})\n` +
                 `🆔 ID: ${req.tgId}\n\n` +
                 `Оберіть дію:`;

    const buttons = [
        [
            Markup.button.callback('✅ Схвалити', `approve_${req.id}`),
            Markup.button.callback('❌ Відхилити', `reject_${req.id}`)
        ]
    ];

    if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
    } else {
        await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }
};

// ==========================================
// ВІЗАРД: ВИДАЧА ДОГАН
// ==========================================
// ==========================================
// ВІЗАРД: ВИДАЧА ДОГАН
// ==========================================
const warningWizard = new Scenes.WizardScene(
    'WARNING_SCENE',
    async (ctx) => {
        const buttons = [
            [Markup.button.callback('Усна', 'type_verbal'), Markup.button.callback('Сувора', 'type_strict')],
            [Markup.button.callback('❌ Скасувати', 'warn_cancel')]
        ];
        await ctx.editMessageText('Оберіть тип догани:', Markup.inlineKeyboard(buttons));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.callbackQuery) return;
        if (ctx.callbackQuery.data === 'warn_cancel') {
            await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }
        ctx.wizard.state.warnType = ctx.callbackQuery.data === 'type_verbal' ? 'усну' : 'сувору';
        await ctx.editMessageText(`Введіть ігровий нікнейм адміністратора:`);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const targetNickname = ctx.message.text.trim();
        ctx.wizard.state.targetNickname = targetNickname;

        const waitMsg = await ctx.reply('⏳ Шукаю адміна в таблиці...');
        const stats = await getAdminStats(targetNickname);
        
        if (!stats) {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ Адміна не знайдено в таблиці.');
            return ctx.scene.leave();
        }

        ctx.wizard.state.currentStats = stats;
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, 
            `✅ Адміна знайдено!\nПоточні: Суворі ${stats.strictWarns}, Усні ${stats.verbalWarns}.\n\nВведіть причину:`
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        ctx.wizard.state.reason = ctx.message.text;
        const s = ctx.wizard.state;

        let verbalCount = parseInt(s.currentStats.verbalWarns.split('/')[0]) || 0;
        let strictCount = parseInt(s.currentStats.strictWarns.split('/')[0]) || 0;
        
        s.isUpgraded = false; // Прапорець для перетворення

        if (s.warnType === 'усну') {
            if (verbalCount + 1 >= 2) {
                // Має стати 2/2, тому перетворюємо в сувору
                s.isUpgraded = true;
                s.displayVerbal = "2/2"; 
                s.newVerbal = "0/2";     // В таблицю піде 0
                strictCount++;
            } else {
                verbalCount++;
                s.newVerbal = `${verbalCount}/2`;
                s.displayVerbal = s.newVerbal;
            }
        } else {
            strictCount++;
            s.newVerbal = s.currentStats.verbalWarns; // Усні не змінюються
        }

        s.newStrict = `${strictCount}/3`;

        let confirmText = `⚠️ <b>ПІДТВЕРДЖЕННЯ ПОКАРАННЯ</b>\n\n` +
                          `Адмін: <b>${s.targetNickname}</b>\n` +
                          `Тип: ${s.warnType}\n`;

        if (s.isUpgraded) {
            confirmText += `Результат: Усні <b>2/2</b> ➡️ Сувора <b>${s.newStrict}</b>\n`;
        } else {
            confirmText += `Стане: Суворі <b>${s.newStrict}</b>, Усні <b>${s.newVerbal}</b>\n`;
        }
        
        confirmText += `Причина: ${s.reason}`;

        const buttons = [];
        if (strictCount >= 3) {
            confirmText += `\n\n🚨 <b>УВАГА: Це третя сувора догана (3/3)!</b>`;
            buttons.push([Markup.button.callback('💥 ТАК, ЗНЯТИ АДМІНА', 'confirm_warn_and_demote')]);
            buttons.push([Markup.button.callback('⚠️ Тільки видати догану', 'confirm_warn_yes')]);
        } else {
            buttons.push([Markup.button.callback('✅ ПІДТВЕРДИТИ', 'confirm_warn_yes')]);
        }
        buttons.push([Markup.button.callback('❌ СКАСУВАТИ', 'confirm_warn_no')]);

        await ctx.reply(confirmText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.callbackQuery || ctx.callbackQuery.data === 'confirm_warn_no') {
            if (ctx.callbackQuery) await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }
        const action = ctx.callbackQuery.data;
        const s = ctx.wizard.state;
        await ctx.answerCbQuery();
        await ctx.editMessageText('⏳ Опрацювання...');

        try {
            // Оновлюємо таблицю (0/2 для усних, якщо було перетворення)
            await updateAdminWarnings(s.targetNickname, s.newStrict, s.newVerbal);
            
            const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            const issuerNick = issuer?.nickname || ctx.from.first_name;

            let groupMsg = "";
            if (s.warnType === 'усну') {
                if (s.isUpgraded) {
                    groupMsg = `<b>${s.targetNickname}</b> отримує <b>усну</b> догану! (2/2)\n` +
                               `⬆️ <b>Догана переростає у сувору (${s.newStrict})</b> у зв'язку з накопиченням 2/2 усних доган.\n` +
                               `<b>Причина:</b> ${s.reason}\n<b>Видав:</b> ${issuerNick}`;
                } else {
                    groupMsg = `<b>${s.targetNickname}</b> отримує <b>усну</b> догану! (${s.newVerbal})\n` +
                               `<b>Причина:</b> ${s.reason}\n<b>Видав:</b> ${issuerNick}`;
                }
            } else {
                groupMsg = `<b>${s.targetNickname}</b> отримує <b>сувору</b> догану! (${s.newStrict})\n` +
                           `<b>Причина:</b> ${s.reason}\n<b>Видав:</b> ${issuerNick}`;
            }

            await ctx.telegram.sendMessage(settings.CHATS.ALL_ADMINS.ID, groupMsg, {
                message_thread_id: Number(settings.CHATS.ALL_ADMINS.THREADS.PUNISHMENTS),
                parse_mode: 'HTML'
            });

            if (action === 'confirm_warn_and_demote') {
                const targetAdmin = await prisma.admin.findUnique({ where: { nickname: s.targetNickname } });
                return ctx.scene.enter('DEMOTE_ADMIN_SCENE', { 
                    targetNickname: s.targetNickname, 
                    targetAdmin, 
                    demoteReason: "Накопичення доган (3/3)" 
                });
            }

            await ctx.editMessageText(`✅ Покарання успішно видано та занесено в таблицю!`);
            return ctx.scene.leave();
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Помилка оновлення таблиці. Перевірте логи.');
            return ctx.scene.leave();
        }
    }
);

// ==========================================
// ВІЗАРД: ЗНЯТТЯ ДОГАН
// ==========================================
const removeWarningWizard = new Scenes.WizardScene(
    'REMOVE_WARNING_SCENE',
    async (ctx) => {
        const buttons = [
            [Markup.button.callback('Усна', 'rem_type_verbal'), Markup.button.callback('Сувора', 'rem_type_strict')], 
            [Markup.button.callback('❌ Скасувати', 'rem_cancel')]
        ];
        await ctx.editMessageText('Яку догану ви хочете ЗНЯТИ?', Markup.inlineKeyboard(buttons));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.callbackQuery || ctx.callbackQuery.data === 'rem_cancel') {
            if (ctx.callbackQuery) await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }
        ctx.wizard.state.warnType = ctx.callbackQuery.data === 'rem_type_verbal' ? 'усну' : 'сувору';
        await ctx.editMessageText(`Введіть нікнейм адміністратора:`);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const targetNickname = ctx.message.text.trim();
        ctx.wizard.state.targetNickname = targetNickname;
        const waitMsg = await ctx.reply('⏳ Перевірка...');
        const stats = await getAdminStats(targetNickname);
        if (!stats) {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ Не знайдено в таблиці.');
            return ctx.scene.leave();
        }
        ctx.wizard.state.currentStats = stats;
        const currentVal = ctx.wizard.state.warnType === 'усну' ? stats.verbalWarns : stats.strictWarns;
        if (parseInt(currentVal.split('/')[0]) === 0) {
            await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `❌ У адміна 0 ${ctx.wizard.state.warnType} доган. Знімати нічого.`);
            return ctx.scene.leave();
        }
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, 
            `✅ Знайдено!\nПоточні: Суворі ${stats.strictWarns}, Усні ${stats.verbalWarns}.\n\nПричина:`,
            Markup.inlineKeyboard([[Markup.button.callback('🌟 Активна робота', 'reason_active')], [Markup.button.callback('📝 Інша причина', 'reason_other')]])
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery) {
            if (ctx.callbackQuery.data === 'reason_active') {
                ctx.wizard.state.reason = 'Активна робота';
                ctx.wizard.cursor = 4; 
                return ctx.wizard.steps[4](ctx); 
            } else {
                await ctx.editMessageText('Введіть причину зняття догани:');
                return ctx.wizard.next();
            }
        }
        if (ctx.message && ctx.message.text) {
            ctx.wizard.state.reason = ctx.message.text;
            return ctx.wizard.next();
        }
    },
    async (ctx) => {
        const s = ctx.wizard.state;
        if (ctx.message && ctx.message.text) s.reason = ctx.message.text;

        let verbalCount = parseInt(s.currentStats.verbalWarns.split('/')[0]);
        let strictCount = parseInt(s.currentStats.strictWarns.split('/')[0]);

        if (s.warnType === 'усну') verbalCount--;
        else strictCount--;

        s.newVerbal = `${verbalCount}/2`;
        s.newStrict = `${strictCount}/3`;

        const confirmText = `⚠️ <b>ПІДТВЕРДІТЬ ЗНЯТТЯ:</b>\n\n` +
                            `Адмін: ${s.targetNickname}\n` +
                            `Знімаємо: ${s.warnType} догану\n` +
                            `Результат: Суворі <b>${s.newStrict}</b>, Усні <b>${s.newVerbal}</b>\n` +
                            `Причина: ${s.reason}`;

        const buttons = [[Markup.button.callback('✅ ПІДТВЕРДИТИ', 'confirm_rem_yes')], [Markup.button.callback('❌ СКАСУВАТИ', 'confirm_rem_no')]];

        if (ctx.callbackQuery) {
            await ctx.editMessageText(confirmText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(e => {
                if (!e.description.includes('message is not modified')) throw e;
            });
        } else {
            await ctx.reply(confirmText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        }
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.callbackQuery || ctx.callbackQuery.data === 'confirm_rem_no') {
            if (ctx.callbackQuery) await ctx.editMessageText('❌ Скасовано.');
            return ctx.scene.leave();
        }
        await ctx.editMessageText('⏳ Опрацювання...');
        const s = ctx.wizard.state;
        try {
            await updateAdminWarnings(s.targetNickname, s.newStrict, s.newVerbal);
            const issuer = await prisma.admin.findUnique({ where: { tgId: BigInt(ctx.from.id) } });
            const issuerNick = issuer?.nickname || ctx.from.first_name;

            const infoMsg = `<b>Адміністратор ${s.targetNickname} знімає ${s.warnType} догану (${s.warnType === 'усну' ? s.newVerbal : s.newStrict})</b>\n` +
                            `<b>Причина:</b> ${s.reason}\n` +
                            `<b>Зняв:</b> ${issuerNick}`;

            await ctx.telegram.sendMessage(settings.CHATS.ALL_ADMINS.ID, infoMsg, {
                message_thread_id: Number(settings.CHATS.ALL_ADMINS.THREADS.INFO),
                parse_mode: 'HTML'
            });
            await ctx.editMessageText(`✅ Догану успішно знято!`);
        } catch (e) {
            console.error(e);
            await ctx.editMessageText('❌ Помилка.');
        }
        return ctx.scene.leave();
    }
);

// ==========================================
// ЕКСПОРТ ТА SETUP
// ==========================================
module.exports = {
    level: 6,
    scenes: [warningWizard, removeWarningWizard],
    getMenu: () => [
        [Markup.button.callback('📝 Заявки на верифікацію', 'view_requests')],
        [Markup.button.callback('⚠️ Догани', 'manage_warnings')]
    ],
    setup: (bot) => {
        bot.action('view_requests', async (ctx) => {
            await ctx.answerCbQuery();
            await showNextRequest(ctx);
        });

        bot.action('manage_warnings', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageText('Оберіть дію з доганами:', Markup.inlineKeyboard([
                [Markup.button.callback('➕ Видати догану', 'enter_issue_warn')],
                [Markup.button.callback('➖ Зняти догану', 'enter_remove_warn')],
                [Markup.button.callback('🔙 Назад', 'close_panel')]
            ]));
        });

        bot.action('enter_issue_warn', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.scene.enter('WARNING_SCENE');
        });

        bot.action('enter_remove_warn', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.scene.enter('REMOVE_WARNING_SCENE');
        });

        bot.action('close_panel', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.deleteMessage().catch(() => {});
        });

                bot.action(/^approve_(\d+)$/, async (ctx) => {
            const reqId = parseInt(ctx.match[1]);
            const req = await prisma.verificationRequest.findUnique({ where: { id: reqId } });
            
            if (!req || req.status !== 'Pending') {
                return ctx.answerCbQuery('⚠️ Ця заявка вже була оброблена.');
            }
            
            // 1. Оновлюємо статус заявки та створюємо адміна в базі
            await prisma.verificationRequest.update({ 
                where: { id: reqId }, 
                data: { status: 'Approved' } 
            });

            await prisma.admin.create({
                data: { 
                    tgId: req.tgId, 
                    username: req.username, 
                    name: req.name, 
                    nickname: req.nickname, 
                    role: 'Адміністратор', 
                    accessLevel: 1,
                    status: 'Active'
                }
            });
            
            // 2. ГЕНЕРУЄМО ХИТРЕ ПОСИЛАННЯ (Join Request)
            try {
                const invite = await ctx.telegram.createChatInviteLink(settings.CHATS.ALL_ADMINS.ID, {
                    creates_join_request: true, // Включаємо "вишибалу"          
                });

                // 3. НАДСИЛАЄМО АДМІНУ В ОСОБИСТІ
                await ctx.telegram.sendMessage(req.tgId.toString(), 
                    `🎉 <b>Вітаємо! Вашу заявку на верифікацію схвалено.</b>\n\n` +
                    `Ваш ігровий нік: <code>${req.nickname}</code>\n\n` +
                    `Натисніть кнопку нижче, щоб подати запит на вступ до загального адмін-чату. Бот прийме вас автоматично.`, 
                    { 
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [Markup.button.url('🔗 Подати заявку в чат', invite.invite_link)]
                        ])
                    }
                );
            } catch (e) {
                console.error('Не вдалося надіслати посилання новому адміну:', e.message);
            }

            await ctx.answerCbQuery('✅ Адміна схвалено!');
            await showNextRequest(ctx);
        });


        bot.action(/^reject_(\d+)$/, async (ctx) => {
            const reqId = parseInt(ctx.match[1]);
            await prisma.verificationRequest.delete({ where: { id: reqId } }).catch(() => {});
            await showNextRequest(ctx);
        });
    }
};
