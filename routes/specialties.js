// routes/specialties.js — إدارة التخصصات والمواد
const express = require('express');
const { query }  = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/specialties/list — قائمة مبسّطة للتسجيل (بدون مصادقة) ──────────
// يجب أن يكون قبل router.use(authenticate) حتى يعمل أثناء التسجيل
router.get('/list', async (req, res) => {
    try {
        const result = await query(
            `SELECT id, name FROM specialties WHERE is_active = true ORDER BY name`,
            []
        );
        res.json({ specialties: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في جلب التخصصات' });
    }
});

router.use(authenticate);

// ─── GET /api/specialties — كل التخصصات مع مواداها ──────────────────────────
router.get('/', async (req, res) => {
    try {
        // جلب كل التخصصات من جدولها المستقل
        const specsResult = await query(
            `SELECT id, name, faculty_code, is_active FROM specialties WHERE is_active = true ORDER BY name`,
            []
        );

        // جلب كل المواد النشطة مع أساتذتها
        const subsResult = await query(
            `SELECT s.id, s.name_ar AS name, s.department, s.academic_year, s.faculty_code,
                    u.id AS professor_id, u.full_name_ar AS professor_name
             FROM subjects s
             LEFT JOIN users u ON s.professor_id = u.id
             WHERE s.is_active = true
             ORDER BY s.name_ar`,
            []
        );

        // تجميع المواد تحت تخصصاتها
        const specialties = specsResult.rows.map(spec => ({
            id:       spec.id,
            name:     spec.name,
            faculty:  spec.faculty_code,
            subjects: subsResult.rows
                .filter(s => s.department === spec.name)
                .map(s => ({
                    id:          s.id,
                    name:        s.name,
                    teacherId:   s.professor_id,
                    teacherName: s.professor_name,
                    year:        parseInt(s.academic_year) || null,
                    faculty:     s.faculty_code
                }))
        }));

        const departments = specsResult.rows.map(s => s.name);

        res.json({ specialties, departments });
    } catch (err) {
        console.error('[GET /specialties]', err);
        res.status(500).json({ error: 'خطأ في جلب التخصصات' });
    }
});

// ─── POST /api/specialties — إضافة تخصص ────────────────────────────────────
router.post('/', requireRole('admin'), async (req, res) => {
    const { name, faculty_code } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'اسم التخصص مطلوب' });

    try {
        const result = await query(
            `INSERT INTO specialties (name, faculty_code)
             VALUES ($1, $2)
             RETURNING id, name, faculty_code`,
            [name.trim(), faculty_code || 'GEN']
        );

        res.status(201).json({
            specialty: {
                id:       result.rows[0].id,
                name:     result.rows[0].name,
                faculty:  result.rows[0].faculty_code,
                subjects: []
            },
            message: 'تمت إضافة التخصص'
        });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'هذا التخصص موجود بالفعل' });
        console.error('[POST /specialties]', err);
        res.status(500).json({ error: 'خطأ في إضافة التخصص' });
    }
});

// ─── POST /api/specialties/subjects — إضافة مادة ────────────────────────────
router.post('/subjects', requireRole('admin'), async (req, res) => {
    const { name, department, professor_id, year, faculty_code } = req.body;
    if (!name?.trim() || !department?.trim())
        return res.status(400).json({ error: 'اسم المادة والتخصص مطلوبان' });

    try {
        // التحقق من أن التخصص موجود
        const specCheck = await query(
            'SELECT id FROM specialties WHERE name = $1 AND is_active = true',
            [department.trim()]
        );
        if (specCheck.rows.length === 0)
            return res.status(404).json({ error: 'التخصص غير موجود' });

        const code = `${department.slice(0,3).toUpperCase()}_${name.slice(0,4).toUpperCase()}_${Date.now().toString().slice(-4)}`;
        const result = await query(
            `INSERT INTO subjects (code, name_ar, professor_id, faculty_code, department, semester, academic_year)
             VALUES ($1, $2, $3, $4, $5, '1', $6)
             RETURNING id, code, name_ar AS name, professor_id, faculty_code, department, academic_year`,
            [code, name.trim(), professor_id || null, faculty_code || 'GEN', department.trim(), String(year || 1)]
        );

        const sub = result.rows[0];
        let teacherName = null;
        if (sub.professor_id) {
            const prof = await query('SELECT full_name_ar FROM users WHERE id = $1', [sub.professor_id]);
            teacherName = prof.rows[0]?.full_name_ar || null;
        }

        res.status(201).json({
            subject: {
                id:          sub.id,
                name:        sub.name,
                teacherId:   sub.professor_id,
                teacherName,
                year:        parseInt(sub.academic_year) || null,
                faculty:     sub.faculty_code
            },
            message: 'تمت إضافة المادة'
        });
    } catch (err) {
        console.error('[POST /specialties/subjects]', err);
        res.status(500).json({ error: 'خطأ في إضافة المادة' });
    }
});

// ─── PUT /api/specialties/:id — تعديل تخصص ──────────────────────────────────
router.put('/:id', requireRole('admin'), async (req, res) => {
    const { name, faculty_code } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'اسم التخصص مطلوب' });

    try {
        const oldSpec = await query('SELECT name FROM specialties WHERE id = $1', [req.params.id]);
        if (oldSpec.rows.length === 0) return res.status(404).json({ error: 'التخصص غير موجود' });

        const result = await query(
            `UPDATE specialties SET name = $1, faculty_code = COALESCE($2, faculty_code)
             WHERE id = $3 RETURNING id, name, faculty_code`,
            [name.trim(), faculty_code || null, req.params.id]
        );

        // تحديث department في المواد المرتبطة
        await query(
            'UPDATE subjects SET department = $1 WHERE department = $2',
            [name.trim(), oldSpec.rows[0].name]
        );

        res.json({ message: 'تم تحديث التخصص', specialty: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'اسم التخصص مستخدم بالفعل' });
        res.status(500).json({ error: 'خطأ في تحديث التخصص' });
    }
});

// ─── PUT /api/specialties/subjects/:id — تعديل مادة ─────────────────────────
router.put('/subjects/:id', requireRole('admin'), async (req, res) => {
    const { name, professor_id, year, department } = req.body;
    try {
        const result = await query(
            `UPDATE subjects SET
                name_ar      = COALESCE($1, name_ar),
                professor_id = $2,
                academic_year = COALESCE($3, academic_year),
                department   = COALESCE($4, department)
             WHERE id = $5 RETURNING *`,
            [name || null, professor_id || null, year ? String(year) : null, department || null, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'المادة غير موجودة' });
        res.json({ message: 'تم تحديث المادة', subject: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في تحديث المادة' });
    }
});

// ─── DELETE /api/specialties/subjects/:id — حذف مادة ────────────────────────
router.delete('/subjects/:id', requireRole('admin'), async (req, res) => {
    try {
        await query('UPDATE subjects SET is_active = false WHERE id = $1', [req.params.id]);
        res.json({ message: 'تم حذف المادة' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في حذف المادة' });
    }
});

// ─── DELETE /api/specialties/:id — حذف تخصص ─────────────────────────────────
router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
        const spec = await query('SELECT name FROM specialties WHERE id = $1', [req.params.id]);
        if (spec.rows.length === 0) return res.status(404).json({ error: 'التخصص غير موجود' });

        // إلغاء تفعيل المواد المرتبطة
        await query('UPDATE subjects SET is_active = false WHERE department = $1', [spec.rows[0].name]);
        // إلغاء تفعيل التخصص
        await query('UPDATE specialties SET is_active = false WHERE id = $1', [req.params.id]);

        res.json({ message: 'تم حذف التخصص' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في حذف التخصص' });
    }
});

module.exports = router;