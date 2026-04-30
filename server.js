// server.js — نقطة دخول الخادم
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
const { pool }     = require('./db');

// مسارات API
const authRouter           = require('./routes/auth');
const usersRouter          = require('./routes/users');
const specialtiesRouter    = require('./routes/specialties');
const justificationsRouter = require('./routes/justifications');
const appealsRouter        = require('./routes/appeals');
const statsRouter          = require('./routes/stats');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
    origin:      process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ─── تسجيل الطلبات (development) ─────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
        next();
    });
}

// ─── مسارات API ───────────────────────────────────────────────────────────────
app.use('/api/auth',           authRouter);
app.use('/api/users',          usersRouter);
app.use('/api/specialties',    specialtiesRouter);
app.use('/api/justifications', justificationsRouter);
app.use('/api/appeals',        appealsRouter);
app.use('/api/stats',          statsRouter);

// ─── تقديم ملفات الـ Frontend ─────────────────────────────────────────────────
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// مسارات API غير موجودة → 404 صريح
app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'المسار غير موجود' });
});

// باقي المسارات → صفحة الـ Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ─── معالجة الأخطاء العامة ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[Error]', err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'حجم الملف كبير جداً (5MB max)' });
    res.status(500).json({ error: 'خطأ في الخادم' });
});

// ─── تشغيل الخادم ─────────────────────────────────────────────────────────────
async function startServer() {
    try {
        // اختبار الاتصال بقاعدة البيانات
        await pool.query('SELECT NOW()');
        console.log('✅ قاعدة البيانات متصلة بنجاح');

        app.listen(PORT, () => {
            console.log(`\n🚀 UniAbsence API يعمل على المنفذ ${PORT}`);
            console.log(`📡 http://localhost:${PORT}`);
            console.log(`📂 API: http://localhost:${PORT}/api`);
            console.log(`\nالمستخدم الافتراضي: FAC-INFO-01 / Admin@123456\n`);
        });
    } catch (err) {
        console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
        console.error('تأكد من إعدادات .env وأن PostgreSQL يعمل');
        process.exit(1);
    }
}

startServer();