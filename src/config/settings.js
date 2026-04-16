// src/config/settings.js
require('dotenv').config();

module.exports = {
    SHEET_ID: process.env.SPREADSHEET_ID,
    WEBHOOK_URL: process.env.GOOGLE_WEBHOOK_URL,
    
    CHATS: {
        ALL_ADMINS: {
            ID: process.env.GROUP_ALL_ID,
            THREADS: {
                REPORTS: process.env.THREAD_REPORT_JUNIOR,
                PUNISHMENTS: process.env.THREAD_PUNISHMENTS,
                INFO: process.env.THREAD_INFO
            }
        },
        SENIOR_ADMINS: {
            ID: process.env.GROUP_SENIOR_ID,
            THREADS: {
                REPORTS: process.env.THREAD_REPORT_SENIOR
            }
        },
        // НОВА ГРУПА ДЛЯ БАЛІВ ТА ЛОГІВ
        BAL_LOGS: {
            ID: process.env.GROUP_BAL_ID, // ID нової групи
            THREAD: process.env.THREAD_BAL_LOGS, // ID конкретної гілки (Topic ID)
            // Додай у THREADS загальної групи
PROMOTION_REQUESTS: process.env.THREAD_PROMOTION_REQUESTS

        }
    }
};
