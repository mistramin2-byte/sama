// middleware/auth.js — مصادقة JWT وصلاحيات الأدوار
const jwt   = require('jsonwebtoken');
const { query } = require('../db');

// ─── Authenticate — يتحقق من الـ JWT ويضع req.user ───────────────────────────
async function authenticate(req, res, next) {
    const token = req.cookies?.access_token;

    if (!token) {
        return res.status(401).json({ error: 'غير مصرح، يرجى تسجيل الدخول', code: 'NO_TOKEN' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const result = await query(
            'SELECT * FROM users WHERE id = $1 AND is_active = true',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'المستخدم غير موجود أو الحساب معطّل', code: 'USER_NOT_FOUND' });
        }

        req.user = result.rows[0];
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'انتهت صلاحية الجلسة', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: 'رمز المصادقة غير صالح', code: 'TOKEN_INVALID' });
    }
}

// ─── requireRole — يتحقق من دور المستخدم ────────────────────────────────────
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'غير مصرح' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'ليس لديك صلاحية للوصول لهذا المورد' });
        }
        next();
    };
}

// ─── logAudit — تسجيل الأحداث في جدول audit_logs ───────────────────────────
async function logAudit(userId, action, resource, resourceId, req, _status, metadata = {}) {
    try {
        const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        await query(
            `INSERT INTO audit_logs (user_id, action, resource, resource_id, ip, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, action, resource, String(resourceId), ip, JSON.stringify(metadata)]
        );
    } catch (err) {
        // لا نوقف الطلب بسبب خطأ في التسجيل
        console.error('[logAudit]', err.message);
    }
}

module.exports = { authenticate, requireRole, logAudit };