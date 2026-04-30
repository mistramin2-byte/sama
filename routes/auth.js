// routes/auth.js — مصادقة المستخدمين وإدارة التسجيل
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { query, getClient } = require('../db');
const { authenticate, requireRole, logAudit } = require('../middleware/auth');
const { sendRegistrationEmail } = require('../mailer');

const router = express.Router();

// ─── مساعدات توليد الـ Tokens ─────────────────────────────────────────────
function signAccessToken(userId, role) {
    return jwt.sign(
        { userId, role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES || '8h' }
    );
}

function signRefreshToken(userId) {
    return jwt.sign(
        { userId },
        process.env.REFRESH_SECRET,
        { expiresIn: process.env.REFRESH_EXPIRES_IN || '7d' }
    );
}

function setTokenCookies(res, accessToken, refreshToken) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('access_token', accessToken, {
        httpOnly: true,
        secure:   isProd,
        sameSite: 'lax',
        maxAge:   8 * 60 * 60 * 1000  // 8 ساعات
    });
    if (refreshToken) {
        res.cookie('refresh_token', refreshToken, {
            httpOnly: true,
            secure:   isProd,
            sameSite: 'lax',
            maxAge:   7 * 24 * 60 * 60 * 1000  // 7 أيام
        });
    }
}

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const { registration_number, password } = req.body;
    if (!registration_number || !password)
        return res.status(400).json({ error: 'رقم التسجيل وكلمة المرور مطلوبان' });

    try {
        const result = await query(
            'SELECT * FROM users WHERE registration_number = $1',
            [registration_number.trim()]
        );

        if (result.rows.length === 0)
            return res.status(401).json({ error: 'رقم التسجيل أو كلمة المرور غير صحيحة' });

        const user = result.rows[0];

        // التحقق من الحساب المعلق
        if (user.is_pending)
            return res.status(403).json({ error: 'طلب تسجيلك لا يزال قيد المراجعة من الإدارة' });

        if (!user.is_active)
            return res.status(403).json({ error: 'حسابك معطّل، تواصل مع الإدارة' });

        if (user.is_locked)
            return res.status(403).json({ error: 'حسابك مقفل بسبب محاولات دخول متعددة' });

        const match = await bcrypt.compare(password, user.password_hash);

        if (!match) {
            // زيادة عداد المحاولات الفاشلة
            const attempts = (user.failed_login_attempts || 0) + 1;
            const lock = attempts >= 5;
            await query(
                'UPDATE users SET failed_login_attempts=$1, is_locked=$2 WHERE id=$3',
                [attempts, lock, user.id]
            );
            if (lock) return res.status(403).json({ error: 'تم قفل حسابك بعد 5 محاولات فاشلة' });
            return res.status(401).json({ error: 'رقم التسجيل أو كلمة المرور غير صحيحة' });
        }

        // تصفير المحاولات الفاشلة وتحديث last_login
        await query(
            'UPDATE users SET failed_login_attempts=0, last_login=NOW() WHERE id=$1',
            [user.id]
        );

        const accessToken  = signAccessToken(user.id, user.role);
        const refreshToken = signRefreshToken(user.id);

        // حفظ refresh token مشفّراً
        const tokenHash = await bcrypt.hash(refreshToken, 8);
        const expires   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
            [user.id, tokenHash, expires]
        );

        setTokenCookies(res, accessToken, refreshToken);
        await logAudit(user.id, 'LOGIN', 'users', user.id, req, 200, {});

        res.json({
            user: formatUser(user),
            message: 'تم تسجيل الدخول بنجاح'
        });
    } catch (err) {
        console.error('[POST /auth/login]', err);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ─── POST /api/auth/register ─────────────────────────────────────────────────
router.post('/register', async (req, res) => {
    const { firstname, lastname, email, role, specialty, year, password, registration_number } = req.body;

    if (!firstname || !lastname || !role || !password || !registration_number)
        return res.status(400).json({ error: 'البيانات الأساسية مطلوبة' });

    if (!['student', 'professor'].includes(role))
        return res.status(400).json({ error: 'الدور يجب أن يكون طالب أو أستاذ' });

    if (password.length < 8)
        return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });

    try {
        // التحقق من عدم تكرار رقم التسجيل أو البريد
        const dupCheck = await query(
            'SELECT id FROM users WHERE registration_number=$1 OR (email=$2 AND email IS NOT NULL)',
            [registration_number.trim(), email?.toLowerCase() || null]
        );
        if (dupCheck.rows.length > 0)
            return res.status(409).json({ error: 'رقم التسجيل أو البريد الإلكتروني مستخدم بالفعل' });

        const hash = await bcrypt.hash(password, 12);

        // الطلاب يُفعَّلون مباشرة — الأساتذة يدخلون قائمة الانتظار
        const isPending  = role === 'professor';
        const isActive   = role === 'student';

        const result = await query(
            `INSERT INTO users
                (registration_number, password_hash, role, full_name_ar, email,
                 specialization, year_of_study, is_active, is_pending, faculty_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'GEN')
             RETURNING *`,
            [
                registration_number.trim(),
                hash, role,
                `${firstname.trim()} ${lastname.trim()}`,
                email?.toLowerCase() || null,
                specialty || null,
                role === 'student' ? (parseInt(year) || null) : null,
                isActive,
                isPending
            ]
        );

        const newUser = result.rows[0];
        await logAudit(newUser.id, 'REGISTER', 'users', newUser.id, req, 201, { role });

        res.status(201).json({
            message: isPending
                ? 'تم تقديم طلب التسجيل، سيتم إعلامك عبر البريد الإلكتروني بعد المراجعة'
                : 'تم إنشاء الحساب بنجاح، يمكنك تسجيل الدخول الآن',
            registration_number: newUser.registration_number,
            pending: isPending
        });
    } catch (err) {
        console.error('[POST /auth/register]', err);
        res.status(500).json({ error: 'خطأ في التسجيل' });
    }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
    res.json({ user: formatUser(req.user) });
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
    const refreshToken = req.cookies?.refresh_token;
    if (refreshToken) {
        // حذف كل الـ refresh tokens لهذا المستخدم (نظافة اختيارية)
        try {
            const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
            await query('DELETE FROM refresh_tokens WHERE user_id=$1', [decoded.userId]);
        } catch (_) { /* تجاهل خطأ الـ token المنتهي */ }
    }
    res.clearCookie('access_token');
    res.clearCookie('refresh_token');
    res.json({ message: 'تم تسجيل الخروج' });
});

// ─── POST /api/auth/refresh ──────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
    const refreshToken = req.cookies?.refresh_token;
    if (!refreshToken)
        return res.status(401).json({ error: 'لا يوجد refresh token', code: 'NO_REFRESH' });

    try {
        const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET);

        const userResult = await query(
            'SELECT * FROM users WHERE id=$1 AND is_active=true',
            [decoded.userId]
        );
        if (userResult.rows.length === 0)
            return res.status(401).json({ error: 'المستخدم غير موجود', code: 'USER_NOT_FOUND' });

        const user        = userResult.rows[0];
        const newAccess   = signAccessToken(user.id, user.role);
        setTokenCookies(res, newAccess, null);

        res.json({ user: formatUser(user), message: 'تم تجديد الجلسة' });
    } catch (err) {
        res.clearCookie('access_token');
        res.clearCookie('refresh_token');
        return res.status(401).json({ error: 'refresh token غير صالح', code: 'REFRESH_INVALID' });
    }
});

// ─── GET /api/auth/pending — طلبات التسجيل المعلقة (Admin) ──────────────────
router.get('/pending', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const result = await query(
            `SELECT id, registration_number, full_name_ar, email, specialization,
                    year_of_study, role, created_at
             FROM users
             WHERE is_pending = true
             ORDER BY created_at ASC`,
            []
        );
        res.json({ pending: result.rows });
    } catch (err) {
        console.error('[GET /auth/pending]', err);
        res.status(500).json({ error: 'خطأ في جلب طلبات التسجيل' });
    }
});

// ─── POST /api/auth/pending/:id/decide — قبول / رفض طلب تسجيل (Admin) ──────
router.post('/pending/:id/decide', authenticate, requireRole('admin'), async (req, res) => {
    const { decision, rejectionReason } = req.body;

    if (!['accepted', 'rejected'].includes(decision))
        return res.status(400).json({ error: 'القرار يجب أن يكون accepted أو rejected' });

    try {
        const userResult = await query(
            'SELECT * FROM users WHERE id=$1 AND is_pending=true',
            [req.params.id]
        );
        if (userResult.rows.length === 0)
            return res.status(404).json({ error: 'الطلب غير موجود' });

        const pendingUser = userResult.rows[0];

        if (decision === 'accepted') {
            await query(
                'UPDATE users SET is_pending=false, is_active=true WHERE id=$1',
                [req.params.id]
            );
        } else {
            // رفض: نحذف الحساب المعلق لإتاحة رقم التسجيل مجدداً
            await query('DELETE FROM users WHERE id=$1', [req.params.id]);
        }

        await logAudit(req.user.id, `REGISTRATION_${decision.toUpperCase()}`, 'users', req.params.id, req, 200, {});

        // إرسال بريد إلكتروني إذا كان متاحاً
        if (pendingUser.email) {
            sendRegistrationEmail({
                to:                 pendingUser.email,
                fullName:           pendingUser.full_name_ar,
                registrationNumber: pendingUser.registration_number,
                decision,
                rejectionReason:    rejectionReason || ''
            }).catch(e => console.error('[mailer]', e.message));
        }

        res.json({
            message: decision === 'accepted'
                ? 'تم قبول طلب التسجيل وتفعيل الحساب'
                : 'تم رفض طلب التسجيل'
        });
    } catch (err) {
        console.error('[POST /auth/pending/:id/decide]', err);
        res.status(500).json({ error: 'خطأ في معالجة الطلب' });
    }
});

// ─── دالة تنسيق بيانات المستخدم ──────────────────────────────────────────────
function formatUser(u) {
    return {
        id:                 u.id,
        registrationNumber: u.registration_number,
        fullName:           u.full_name_ar,
        role:               u.role,
        email:              u.email || '',
        specialty:          u.specialization || u.department || '',
        year:               u.year_of_study || 0,
        faculty:            u.faculty_code || 'GEN',
        isActive:           u.is_active,
        isLocked:           u.is_locked,
        createdAt:          u.created_at,
        lastLogin:          u.last_login
    };
}

module.exports = router;