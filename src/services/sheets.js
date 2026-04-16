// src/services/sheets.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const settings = require('../config/settings');

// Авторизація через сервісний акаунт
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Замінюємо \n на реальні переноси рядків (обов'язково для ключів Google)
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(settings.SHEET_ID, serviceAccountAuth);

// Функція перевірки нікнейму в Колонці D
async function checkAdminByNickname(nickname) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Список адміністрації']; 
        if (!sheet) throw new Error('Аркуш не знайдено!');

        // Отримуємо реальну кількість рядків у таблиці
        const rowCount = sheet.rowCount; 
        
        // Завантажуємо тільки ті клітинки, які реально існують
        await sheet.loadCells(`D1:D${rowCount}`); 

        for (let i = 0; i < rowCount; i++) {
            const cell = sheet.getCell(i, 3);
            const cellNick = cell.formattedValue || cell.value?.toString();
            
            if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error('❌ Помилка Google Sheets:', error);
        throw error;
    }
}
// Функція для перетворення дати (з додатковою перевіркою формату)
function parseDate(dateStr) {
    // Якщо дата пуста або це не текст (наприклад, число) - повертаємо null
    if (!dateStr || typeof dateStr !== 'string') return null;
    
    const parts = dateStr.trim().split('.');
    if (parts.length === 3) {
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // Місяці в JS починаються з 0
        let year = parseInt(parts[2], 10);
        if (year < 100) year += 2000; // на випадок якщо напишуть 24 замість 2024
        return new Date(year, month, day);
    }
    return null;
}

// Функція розрахунку днів від дати до сьогодні
function calculateDays(fromDate) {
    if (!fromDate) return '?';
    const now = new Date();
    // Скидаємо години, щоб рахувало рівно по днях
    now.setHours(0, 0, 0, 0);
    fromDate.setHours(0, 0, 0, 0);
    const diffTime = Math.abs(now - fromDate);
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

// Головна функція отримання повної статистики адміна
// Головна функція отримання повної статистики адміна
// --- ОНОВЛЕНА ФУНКЦІЯ СТАТИСТИКИ ---
// --- ОНОВЛЕНА ФУНКЦІЯ СТАТИСТИКИ (ШВИДКА) ---
async function getAdminStats(nickname) {
    try {
        await doc.loadInfo();
        const mainSheet = doc.sheetsByTitle['Список адміністрації']; 
        const successSheet = doc.sheetsByTitle['Успішність адміністрації 3.0 v2 '];
        
        if (!mainSheet) return null;

        // ⚡️ ОПТИМІЗАЦІЯ: Вантажимо ТІЛЬКИ потрібні стовпчики (Нік, Посада/Рівень, Догани)
        await mainSheet.loadCells([
            `D1:D${mainSheet.rowCount}`, 
            `F1:G${mainSheet.rowCount}`, 
            `M1:O${mainSheet.rowCount}`
        ]); 
        
        let stats = null;

        for (let i = 0; i < mainSheet.rowCount; i++) {
            const cellNick = mainSheet.getCell(i, 3).formattedValue || mainSheet.getCell(i, 3).value?.toString(); 
            
            if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                stats = { 
                    rowIndex: i, 
                    role: mainSheet.getCell(i, 5).formattedValue || 'Не вказано', 
                    adminLevel: mainSheet.getCell(i, 6).formattedValue || 'Не вказано', 
                    strictWarns: mainSheet.getCell(i, 12).formattedValue || '0/3', 
                    verbalWarns: mainSheet.getCell(i, 14).formattedValue || '0/2',
                    daysOnAdmin: '?', 
                    daysFromPromo: '?'
                };
                break;
            }
        }

        if (!stats) return null;

        if (successSheet) {
            // ⚡️ ОПТИМІЗАЦІЯ: Вантажимо ТІЛЬКИ Нікнейм (C) та Дні (AU, AV)
            await successSheet.loadCells([
                `C1:C${successSheet.rowCount}`,
                `AU1:AV${successSheet.rowCount}`
            ]);
            for (let i = 0; i < successSheet.rowCount; i++) {
                const cellNick = successSheet.getCell(i, 2).formattedValue || successSheet.getCell(i, 2).value?.toString();
                if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                    stats.daysOnAdmin = successSheet.getCell(i, 46).formattedValue || '0';
                    stats.daysFromPromo = successSheet.getCell(i, 47).formattedValue || '0';
                    break;
                }
            }
        }

        return stats;
    } catch (error) {
        console.error('Помилка статистики:', error);
        return null;
    }
}


// Функція оновлення доган в таблиці
// Функція оновлення доган в таблиці (ОПТИМІЗОВАНА)
async function updateAdminWarnings(nickname, newStrictStr, newVerbalStr) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Список адміністрації']; 
        if (!sheet) return false;

        const rowCount = sheet.rowCount;
        
        // 1. Завантажуємо ТІЛЬКИ колонку D (індекс 3), щоб швидко знайти нік
        await sheet.loadCells(`D1:D${rowCount}`); 

        let targetRow = -1;
        for (let i = 0; i < rowCount; i++) {
            const cellNick = sheet.getCell(i, 3).formattedValue || sheet.getCell(i, 3).value?.toString(); 
            
            if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                targetRow = i;
                break; // Знайшли рядок - зупиняємо пошук
            }
        }

        if (targetRow !== -1) {
            // 2. Завантажуємо ТІЛЬКИ клітинки з доганами (від M до O) для цього конкретного рядка
            await sheet.loadCells({
                startRowIndex: targetRow, endRowIndex: targetRow + 1,
                startColumnIndex: 12, endColumnIndex: 15 
            });

            // 3. Оновлюємо Суворі (M - 12) та Усні (O - 14)
            sheet.getCell(targetRow, 12).value = newStrictStr;
            sheet.getCell(targetRow, 14).value = newVerbalStr;
                
            // 4. Зберігаємо тільки ці дві клітинки
            await sheet.saveUpdatedCells(); 
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Помилка запису доган:', error);
        return false;
    }
}


// ==========================================
// ФУНКЦІЇ ДЛЯ ЗНЯТТЯ З ПОСАДИ ТА ЧСА
// ==========================================

// --- ХІРУРГІЧНЕ ОЧИЩЕННЯ АДМІНА З ТАБЛИЦЬ ---
async function demoteAdminInSheets(nickname) {
    try {
        await doc.loadInfo();
        const adminSheet = doc.sheetsByTitle['Список адміністрації'];
        const successSheet = doc.sheetsByTitle['Успішність адміністрації 3.0 v2 '];

        // 1. Очищення в "Список адміністрації" (Нікнейм, М, О)
        if (adminSheet) {
            // Завантажуємо колонки від A до O
            await adminSheet.loadCells(`A1:O${adminSheet.rowCount}`);
            for (let i = 0; i < adminSheet.rowCount; i++) {
                const cell = adminSheet.getCell(i, 3); // 3 = Колонка D (Нікнейм)
                const cellVal = cell.formattedValue || cell.value?.toString();
                
                if (cellVal && cellVal.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                    // Очищаємо потрібні клітинки
                    adminSheet.getCell(i, 3).value = '';  // D (Нікнейм)
                    adminSheet.getCell(i, 12).value = ''; // M
                    adminSheet.getCell(i, 14).value = ''; // O
                    
                    await adminSheet.saveUpdatedCells();
                    break; // Зупиняємо пошук після очищення
                }
            }
        }

        // 2. Очищення в "Успішність" (Нікнейм, G-M, O-U, Y-AA)
        if (successSheet) {
            // Завантажуємо колонки від A до AA
            await successSheet.loadCells(`A1:AA${successSheet.rowCount}`);
            for (let i = 0; i < successSheet.rowCount; i++) {
                const cell = successSheet.getCell(i, 2); // 2 = Колонка C (Нікнейм)
                const cellVal = cell.formattedValue || cell.value?.toString();
                
                if (cellVal && cellVal.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                    // Очищаємо нікнейм
                    successSheet.getCell(i, 2).value = ''; // C

                    // Очищаємо діапазон G-M (Індекси 6-12)
                    for (let col = 6; col <= 12; col++) {
                        successSheet.getCell(i, col).value = '';
                    }

                    // Очищаємо діапазон O-U (Індекси 14-20)
                    for (let col = 14; col <= 20; col++) {
                        successSheet.getCell(i, col).value = '';
                    }

                    // Очищаємо діапазон Y-AA (Індекси 24-26)
                    for (let col = 24; col <= 26; col++) {
                        successSheet.getCell(i, col).value = '';
                    }

                    await successSheet.saveUpdatedCells();
                    break; // Зупиняємо пошук після очищення
                }
            }
        }

        // 3. Звертаємося до Вебхуку Google для зафарбовування рядка в червоний (у "Реєстрі")
       // Замість const GOOGLE_SCRIPT_URL = 'https://...'; напиши:
       await fetch(settings.WEBHOOK_URL, {
        method: 'POST',
         body: JSON.stringify({ nickname: nickname })
       });
        
    } catch (e) {
        console.error('Помилка хірургічного очищення з таблиць:', e);
    }
}

// --- ДОДАВАННЯ ДО ЧСА ---
async function addAdminToChsa(nickname, reason, months) {
    try {
        await doc.loadInfo();
        const chsaSheet = doc.sheetsByTitle['Чорний Список Адміністрації'];
        if (!chsaSheet) return;

        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + parseInt(months));
        const formatDate = (date) => `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;

        // Старт з 10-го рядка (індекс 9)
        const startSearchRow = 9; 
        await chsaSheet.loadCells(`C10:C${chsaSheet.rowCount}`);
        
        let targetRow = -1;
        for (let i = startSearchRow; i < chsaSheet.rowCount; i++) {
            if (!chsaSheet.getCell(i, 2).value) { // 2 = Колонка C
                targetRow = i;
                break;
            }
        }

        if (targetRow !== -1) {
            // Завантажуємо ТІЛЬКИ потрібний діапазон C-K для цього рядка
            await chsaSheet.loadCells({
                startRowIndex: targetRow, endRowIndex: targetRow + 1,
                startColumnIndex: 2, endColumnIndex: 11
            });

            chsaSheet.getCell(targetRow, 2).value = nickname;                     // C
            chsaSheet.getCell(targetRow, 8).value = reason || 'Не вказана';       // I
            chsaSheet.getCell(targetRow, 9).value = formatDate(startDate);        // J
            chsaSheet.getCell(targetRow, 10).value = formatDate(endDate);         // K
            
            await chsaSheet.saveUpdatedCells();
        }
    } catch (e) {
        console.error('Помилка запису в ЧСА:', e);
    }
}

// --- ПЕРЕВІРКА НАЯВНОСТІ В ЧСА ---
async function checkAdminChsa(nickname) {
    try {
        await doc.loadInfo();
        const chsaSheet = doc.sheetsByTitle['Чорний Список Адміністрації'];
        if (!chsaSheet) return { isInChsa: false };

        const rows = await chsaSheet.getRows();
        for (let row of rows) {
            // Шукаємо по ніку
            const rowNick = row.get('Нікнейм') || row._rawData[2];
            if (rowNick && rowNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                const endDateStr = row.get('Дата закінчення') || row._rawData[10]; // Колонка K
                
                // Парсимо дату ДД.ММ.РРРР
                const parts = endDateStr.split('.');
                if (parts.length === 3) {
                    const endDate = new Date(parts[2], parts[1] - 1, parts[0]);
                    const today = new Date();
                    
                    if (endDate >= today) {
                        return { isInChsa: true, endDate: endDateStr }; // ЧСА досі діє
                    }
                }
            }
        }
        return { isInChsa: false };
    } catch (e) {
        console.error('Помилка перевірки ЧСА:', e);
        return { isInChsa: false };
    }
}

// --- ПОШУК ДЛЯ ПІДВИЩЕННЯ (Знизу вгору) ---
// --- ПОШУК ДЛЯ ПІДВИЩЕННЯ (ШВИДКИЙ) ---
async function getAdminForPromotion(nickname) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Реєстр та облік']; 
        if (!sheet) return null;

        // ⚡️ ОПТИМІЗАЦІЯ: Беремо ТІЛЬКИ Нік (B) та Посаду/Рівень (N-O)
        await sheet.loadCells([
            `B1:B${sheet.rowCount}`,
            `N1:O${sheet.rowCount}`
        ]);
        
        // Шукаємо знизу вгору
        for (let i = sheet.rowCount - 1; i >= 0; i--) {
            const cellNick = sheet.getCell(i, 1).value?.toString(); 
            
            if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                
                const levelVal = sheet.getCell(i, 14).value;
                
                if (levelVal !== null && levelVal !== undefined && levelVal !== '') {
                    return {
                        rowIndex: i,
                        currentRole: sheet.getCell(i, 13).value?.toString() || '', 
                        currentLevel: parseInt(levelVal) || 0,                     
                    };
                }
            }
        }
        return null; 
    } catch (e) {
        console.error('Помилка пошуку для підвищення:', e);
        return null;
    }
}


// --- ЗАПИС ПІДВИЩЕННЯ ТА ДАТИ ---
// --- ОНОВЛЕНА ФУНКЦІЯ ПІДВИЩЕННЯ (Оновлює дві вкладки одразу) ---
// src/services/sheets.js

async function updateAdminPromotionInSheets(nickname, nextLevel, nextRole) {
    try {
        await doc.loadInfo();
        const regSheet = doc.sheetsByTitle['Реєстр та облік'];
        if (!regSheet) throw new Error('Вкладку "Реєстр та облік" не знайдено');

        // Завантажуємо дані (стовпчики від A до O)
        await regSheet.loadCells(`A1:O${regSheet.rowCount}`);

        // Шукаємо останній рядок адміна в Реєстрі (стовпчик B, індекс 1)
        let targetRow = -1;
        for (let i = regSheet.rowCount - 1; i >= 0; i--) {
            const cellNick = regSheet.getCell(i, 1).value?.toString();
            if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                targetRow = i;
                break;
            }
        }

        if (targetRow === -1) {
            console.error(`❌ Адміна ${nickname} не знайдено в Реєстрі для оновлення.`);
            return false;
        }

        const today = new Date();
        const dateStr = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;

        // Записуємо дані по твоїх колонках:
        regSheet.getCell(targetRow, 11).value = dateStr;   // L (11) - Дата підвищення
        regSheet.getCell(targetRow, 13).value = nextRole;  // N (13) - Посада
        regSheet.getCell(targetRow, 14).value = nextLevel; // O (14) - Рівень

        await regSheet.saveUpdatedCells();
        return true;
    } catch (e) {
        console.error('Помилка оновлення Реєстру:', e);
        return false;
    }
}

// --- ЗМІНА ПОСАДИ (ДЛЯ СЛІДКУЮЧИХ) ---
async function updateAdminRoleInSheets(nickname, newRole) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Реєстр та облік'];
        if (!sheet) return false;

        await sheet.loadCells(`A1:O${sheet.rowCount}`);
        
        for (let i = sheet.rowCount - 1; i >= 0; i--) {
            const cellNick = sheet.getCell(i, 1).value?.toString(); // Колонка B (1)
            
            if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                // Міняємо колонку N (індекс 13). Якщо треба L, зміни на 11
                sheet.getCell(i, 13).value = newRole; 
                await sheet.saveUpdatedCells();
                return true;
            }
        }
        return false;
    } catch (e) {
        console.error('Помилка оновлення посади:', e);
        return false;
    }
}

// --- ОТРИМАННЯ DISCORD З РЕЄСТРУ ---
async function getAdminDiscord(nickname) {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['Реєстр та облік'];
        if (!sheet) return 'Не знайдено';

        // Завантажуємо від A (0) до H (7)
        await sheet.loadCells(`A1:H${sheet.rowCount}`); 
        
        // Шукаємо знизу вгору
        for (let i = sheet.rowCount - 1; i >= 0; i--) {
            const cellNick = sheet.getCell(i, 1).value?.toString(); // Колонка B (1)
            if (cellNick && cellNick.trim().toLowerCase() === nickname.trim().toLowerCase()) {
                return sheet.getCell(i, 7).value?.toString() || 'Не вказано'; // Колонка H (7)
            }
        }
        return 'Не знайдено в таблиці';
    } catch (e) {
        console.error('Помилка пошуку Discord:', e);
        return 'Помилка';
    }
}


module.exports = {
    checkAdminByNickname,
    getAdminStats,
    updateAdminWarnings,
    demoteAdminInSheets, // <--- Додаємо це
    addAdminToChsa,      // <--- Додаємо це
    checkAdminChsa,
     getAdminForPromotion,
     updateAdminPromotionInSheets,
     updateAdminRoleInSheets,
    getAdminDiscord
};
