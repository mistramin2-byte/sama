// db.js — اتصال PostgreSQL
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'uniabsence',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err);
});

// دالة مساعدة لتنفيذ الاستعلامات
async function query(text, params) {
    const start = Date.now();
    const res   = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
        console.log('[DB]', { query: text.slice(0, 80), duration: duration + 'ms', rows: res.rowCount });
    }
    return res;
}

// دالة للحصول على client (للمعاملات)
async function getClient() {
    const client = await pool.connect();
    const release = client.release.bind(client);
    let released = false;
    client.release = () => {
        if (!released) {
            released = true;
            return release();
        }
    };
    return client;
}

module.exports = { query, getClient, pool };