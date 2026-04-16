// src/levels/index.js
const fs = require('fs');
const path = require('path');
const { Scenes } = require('telegraf');

const levelModules = [];
const allScenes = [];

// 1. Зчитуємо файли і збираємо всі сцени
const prepareLevels = () => {
    const files = fs.readdirSync(__dirname).filter(file => file.endsWith('.js') && file !== 'index.js' && file !== 'supervisors.js');
    
    for (const file of files) {
        const modulePath = path.join(__dirname, file);
        const levelModule = require(modulePath);
        
        // Додаємо тільки ті файли, які є рівнями (мають властивість level)
        if (levelModule.level !== undefined) {
            levelModules.push(levelModule);
        }
        
        if (levelModule.scenes && Array.isArray(levelModule.scenes)) {
            allScenes.push(...levelModule.scenes);
        }
    }
    levelModules.sort((a, b) => a.level - b.level);
};

// 2. Ініціалізуємо менеджер сцен
const getStage = () => {
    console.log(`🎭 Менеджер сцен: знайдено та зареєстровано ${allScenes.length} сцен.`);
    return new Scenes.Stage(allScenes);
};

// 3. Реєструємо кнопки в боті ПІСЛЯ підключення сесій
const setupBotActions = (bot) => {
    for (const mod of levelModules) {
        if (mod.setup) {
            mod.setup(bot);
        }
    }
    console.log(`📦 Автозавантаження: успішно підключено ${levelModules.length} модулів.`);
};

const getButtonsForAccessLevel = (userLevel) => {
    let buttons = [];
    for (const mod of levelModules) {
        // Ховаємо кнопки 0 рівня від тих, у кого рівень > 0
        if (mod.level === 0 && userLevel !== 0) continue; 
        
        if (userLevel >= mod.level && mod.getMenu) {
            // ВАЖЛИВО: Передаємо userLevel сюди!
            buttons.push(...mod.getMenu(userLevel));
        }
    }
    return buttons;
};

module.exports = { prepareLevels, getStage, setupBotActions, getButtonsForAccessLevel };