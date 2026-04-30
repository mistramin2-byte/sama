// routes/users.js — إدارة المستخدمين (Admin)
const express = require('express');
const bcrypt  = require('bcryptjs');
const { query }  = require('../db');
const { authenticate, requireRole, logAudit } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/users — قائمة المستخدمين (admin only) ─────────────────────────
router.get('/', requireRole('admin'), async (req, res) => {
    try {
        const { role, search } = req.query;
        let sql = `SELECT id, registration_number, role, full_name_ar, email, faculty_code,
                          department, year_of_study, specialization, is_active, is_locked, created_at, last_login
                   FROM users WHERE 1=1`;
        const params = [];

        if (role && role !== 'all') { params.push(role); sql += ` AND role = $${params.length}`; }
        if (search) {
            params.push(`%${search.toLowerCase()}%`);
            sql += ` AND (LOWER(full_name_ar) LIKE $${params.length} OR LOWER(registration_number) LIKE $${params.length} OR LOWER(email) LIKE $${params.length})`;
        }
        sql += ' ORDER BY created_at DESC';

        const result = await query(sql, params);
        res.json({ users: result.rows.map(formatUser) });
    } catch (err) {
        console.error('[GET /users]', err);
        res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
    }
});

// ─── GET /api/users/professors — قائمة الأساتذة ────────────────────────────
router.get('/professors', requireRole('admin', 'professor'), async (req, res) => {
    try {
        const result = await query(
            `SELECT id, registration_number, full_name_ar, email, specialization, department
             FROM users WHERE role = 'professor' AND is_active = true ORDER BY full_name_ar`,
            []
        );
        res.json({ professors: result.rows.map(p => ({
            id: p.id,
            registrationNumber: p.registration_number,
            fullName: p.full_name_ar,
            email: p.email,
            specialty: p.specialization || p.department || ''
        })) });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في جلب الأساتذة' });
    }
});

// ─── GET /api/users/students — قائمة الطلاب مع إحصائيات الغياب ──────────────
router.get('/students', requireRole('admin'), async (req, res) => {
    try {
        const { search } = req.query;
        let sql = `
            SELECT u.id, u.registration_number, u.full_name_ar, u.email,
                   u.specialization, u.year_of_study, u.is_active,
                   COUNT(DISTINCT a.id) AS total_absences,
                   COUNT(DISTINCT j.id) AS total_justifications,
                   COUNT(DISTINCT CASE WHEN j.reviewed_at IS NOT NULL THEN j.id END) AS reviewed_justifications
            FROM users u
            LEFT JOIN absences a ON u.id = a.student_id
            LEFT JOIN justifications j ON a.id = j.absence_id
            WHERE u.role = 'student'`;
        const params = [];
        if (search) {
            params.push(`%${search.toLowerCase()}%`);
            sql += ` AND (LOWER(u.full_name_ar) LIKE $1 OR LOWER(u.registration_number) LIKE $1)`;
        }
        sql += ' GROUP BY u.id ORDER BY u.full_name_ar';

        const result = await query(sql, params);
        res.json({ students: result.rows.map(s => ({
            id: s.id,
            registrationNumber: s.registration_number,
            fullName: s.full_name_ar,
            email: s.email,
            specialty: s.specialization || '',
            year: s.year_of_study || 0,
            isActive: s.is_active,
            absences: parseInt(s.total_absences),
            justified: parseInt(s.total_justifications)
        })) });
    } catch (err) {
        console.error('[GET /users/students]', err);
        res.status(500).json({ error: 'خطأ في جلب الطلاب' });
    }
});

// ─── POST /api/users — إضافة مستخدم جديد (admin) ────────────────────────────
router.post('/', requireRole('admin'), async (req, res) => {
    const { firstname, lastname, email, role, specialty, year, password, faculty_code } = req.body;
    if (!firstname || !lastname || !role || !password)
        return res.status(400).json({ error: 'البيانات الأساسية مطلوبة' });

    try {
        const emailCheck = await query('SELECT id FROM users WHERE email = $1', [email?.toLowerCase()]);
        if (emailCheck.rows.length > 0) return res.status(409).json({ error: 'البريد الإلكتروني مستخدم' });

        const prefix = role === 'student' ? 'STU' : role === 'professor' ? 'PROF' : 'ADM';
        const yr     = new Date().getFullYear();
        const count  = await query('SELECT COUNT(*) FROM users WHERE role = $1', [role]);
        const seq    = String(parseInt(count.rows[0].count) + 1).padStart(4, '0');
        const regNum = `${prefix}${yr}${seq}`;

        const hash   = await bcrypt.hash(password, 12);
        const result = await query(
            `INSERT INTO users (registration_number, password_hash, role, full_name_ar, email, faculty_code, year_of_study, specialization)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [regNum, hash, role, `${firstname} ${lastname}`, email?.toLowerCase() || null,
             faculty_code || 'GEN', role === 'student' ? (year || null) : null, specialty || null]
        );

        await logAudit(req.user.id, 'USER_CREATED', 'users', result.rows[0].id, req, 201, { role, by: req.user.id });
        res.status(201).json({ user: formatUser(result.rows[0]), registration_number: regNum });
    } catch (err) {
        console.error('[POST /users]', err);
        res.status(500).json({ error: 'خطأ في إنشاء المستخدم' });
    }
});

// ─── PUT /api/users/:id — تعديل مستخدم ──────────────────────────────────────
router.put('/:id', requireRole('admin'), async (req, res) => {
    const { firstname, lastname, email, specialty, year, is_active, is_locked, password } = req.body;
    try {
        const existing = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });

        const u = existing.rows[0];
        const fullName  = (firstname && lastname) ? `${firstname} ${lastname}` : u.full_name_ar;
        const newEmail  = email?.toLowerCase() || u.email;
        const newSpec   = specialty !== undefined ? specialty : u.specialization;
        const newYear   = year !== undefined ? year : u.year_of_study;
        const newActive = is_active !== undefined ? is_active : u.is_active;
        const newLocked = is_locked !== undefined ? is_locked : u.is_locked;

        let sql, params;
        if (password && password.length >= 8) {
            const hash = await bcrypt.hash(password, 12);
            sql    = `UPDATE users SET full_name_ar=$1, email=$2, specialization=$3, year_of_study=$4, is_active=$5, is_locked=$6, password_hash=$7, failed_login_attempts=0 WHERE id=$8 RETURNING *`;
            params = [fullName, newEmail, newSpec, newYear, newActive, newLocked, hash, req.params.id];
        } else {
            sql    = `UPDATE users SET full_name_ar=$1, email=$2, specialization=$3, year_of_study=$4, is_active=$5, is_locked=$6 WHERE id=$7 RETURNING *`;
            params = [fullName, newEmail, newSpec, newYear, newActive, newLocked, req.params.id];
        }

        const result = await query(sql, params);
        await logAudit(req.user.id, 'USER_UPDATED', 'users', req.params.id, req, 200, {});
        res.json({ user: formatUser(result.rows[0]) });
    } catch (err) {
        console.error('[PUT /users]', err);
        res.status(500).json({ error: 'خطأ في تحديث المستخدم' });
    }
});

// ─── DELETE /api/users/:id — حذف مستخدم ─────────────────────────────────────
router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
        if (req.params.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
        await query('DELETE FROM users WHERE id = $1', [req.params.id]);
        await logAudit(req.user.id, 'USER_DELETED', 'users', req.params.id, req, 200, {});
        res.json({ message: 'تم حذف المستخدم' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في حذف المستخدم' });
    }
});

function formatUser(u) {
    return {
        id:                 u.id,
        registrationNumber: u.registration_number,
        fullName:           u.full_name_ar,
        role:               u.role,
        email:              u.email || '',
        specialty:          u.specialization || u.department || '',
        year:               u.year_of_study || 0,
        faculty:            u.faculty_code,
        isActive:           u.is_active,
        isLocked:           u.is_locked,
        createdAt:          u.created_at,
        lastLogin:          u.last_login
    };
}

module.exports = router;