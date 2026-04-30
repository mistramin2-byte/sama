/* ===================================================================
   UniAbsence — script.js  (نسخة Backend حقيقي)
   جميع العمليات تذهب إلى /api  بدلاً من localStorage
   =================================================================== */

/* ==================== حالة التطبيق ==================== */
let currentUser       = null;
let selectedDate      = null;
let selectedSessions  = [];
let uploadedFile      = null;
let calendarMonth     = new Date().getMonth();
let calendarYear      = new Date().getFullYear();
let windowAvailableSessions = [];
let currentTheme = (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

// ذاكرة تشغيل مؤقتة (لا تُحفظ في localStorage)
let _justs      = [];   // التبريرات
let _appeals    = [];   // الطعون
let _users      = [];   // المستخدمون
let _specialties = [];  // التخصصات

const dayNames = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

/* ==================== تهيئة ==================== */

document.addEventListener('DOMContentLoaded', () => {
    initFileDrop();
    renderCalendar();
    checkAuth();
    initGlobalEvents();
    applyTheme();
});

/* ==================== API Helper ==================== */

// تجديد تلقائي للـ access token عند انتهاء صلاحيته
let _refreshing = false;

// مسارات لا تستدعي logout() عند الحصول على 401 (مثل checkAuth عند بدء التشغيل)
const _silentEndpoints = ['/auth/me', '/auth/login', '/auth/register', '/auth/refresh', '/specialties/list'];

async function apiCall(method, endpoint, body = null) {
    const doFetch = async () => {
        const opts = {
            method,
            credentials: 'include',
            headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}
        };
        if (body) opts.body = body instanceof FormData ? body : JSON.stringify(body);
        return fetch('/api' + endpoint, opts);
    };

    try {
        let res = await doFetch();

        // محاولة تجديد الجلسة مرة واحدة عند انتهاء الـ token
        if (res.status === 401 && !_refreshing) {
            const errData = await res.json().catch(() => ({}));

            if (errData.code === 'TOKEN_EXPIRED') {
                _refreshing = true;
                const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
                _refreshing = false;
                if (refreshRes.ok) {
                    const rd = await refreshRes.json();
                    currentUser = rd.user;
                    res = await doFetch();
                } else {
                    // فشل التجديد — أخرج المستخدم فقط إذا كان مسجّلاً
                    if (currentUser) {
                        logout();
                        showToast('انتهت الجلسة، يرجى تسجيل الدخول مجدداً', 'error');
                    }
                    return { ok: false, status: 401, data: errData };
                }
            } else {
                // 401 لكن ليس TOKEN_EXPIRED (مثلاً: NO_TOKEN في checkAuth عند بدء التشغيل)
                // لا نستدعي logout() إلا إذا كان المستخدم مسجّلاً فعلاً وليس في مسار صامت
                if (currentUser && !_silentEndpoints.some(ep => endpoint.startsWith(ep))) {
                    logout();
                    showToast('انتهت الجلسة', 'error');
                }
                return { ok: false, status: 401, data: errData };
            }
        }

        // إذا لا يزال 401 بعد محاولة التجديد
        if (res.status === 401) {
            const errData = await res.json().catch(() => ({}));
            if (currentUser && !_silentEndpoints.some(ep => endpoint.startsWith(ep))) {
                logout();
                showToast('انتهت الجلسة', 'error');
            }
            return { ok: false, status: 401, data: errData };
        }

        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    } catch (err) {
        console.error('[apiCall]', endpoint, err);
        return { ok: false, status: 0, data: {} };
    }
}

/* ==================== أدوات مساعدة ==================== */

function escapeHTML(str) {
    return String(str || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
        .replace(/'/g,'&#039;');
}

function applyTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme);
    // theme stored in memory only (no localStorage in Node context)
    const isDark = currentTheme === 'dark';
    ['login-theme-icon','student-theme-icon','teacher-theme-icon','admin-theme-icon'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('fa-moon', isDark);
        el.classList.toggle('fa-sun', !isDark);
    });
    ['login-theme-label','student-theme-label','teacher-theme-label','admin-theme-label'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = isDark ? 'وضع الليل' : 'وضع النهار';
    });
}
function toggleTheme() { currentTheme = currentTheme === 'dark' ? 'light' : 'dark'; applyTheme(); }

function initGlobalEvents() {
    const containers = [
        'student-recent-list','student-history-list','student-appeals-list',
        'teacher-recent-list','teacher-pending-list','teacher-reviewed-list',
        'admin-just-list','admin-appeals-list'
    ];
    containers.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const itemId = btn.dataset.id;
            if (action === 'review-accept')       acceptJustificationDirect(itemId);
            if (action === 'review-reject')       openRejectModal(itemId);
            if (action === 'review-info')         openReviewModal(itemId, 'info_requested');
            if (action === 'appeal')              openAppealModal(itemId);
            if (action === 'preview-file')        previewFile(itemId);
            if (action === 'appeal-accept')       resolveAppeal(itemId, 'accepted');
            if (action === 'appeal-reject')       resolveAppeal(itemId, 'rejected');
            if (action === 'delete-just')         confirmDeleteJustification(itemId);
            if (action === 'delete-appeal')       confirmDeleteAppeal(itemId);
            if (action === 'edit-justification')  openEditJustificationModal(itemId);
            if (action === 'edit-appeal')         openEditAppealModal(itemId);
        });
    });

    const userTbody = document.getElementById('admin-users-tbody');
    if (userTbody) {
        userTbody.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const itemId = btn.dataset.id;
            if (action === 'edit-user')   editUser(itemId);
            if (action === 'toggle-user') toggleUserStatus(itemId);
            if (action === 'delete-user') confirmDeleteUser(itemId);
        });
    }

    document.querySelectorAll('.modal-overlay').forEach(m => {
        m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
    });
}

/* ==================== صفحات المصادقة ==================== */

function showPage(pageId) {
    ['login-page','register-page'].forEach(p => {
        const el = document.getElementById(p);
        if (el) el.classList.add('hidden');
    });
    const target = document.getElementById(pageId);
    if (target) target.classList.remove('hidden');
}
function showRegisterPage() {
    _loadSpecialtiesForRegister();
    showPage('register-page');
    document.getElementById('reg-error').classList.add('hidden');
}
function showLoginPage() {
    showPage('login-page');
    document.getElementById('login-error').classList.add('hidden');
}

async function _loadSpecialtiesForRegister() {
    const res = await apiCall('GET', '/specialties/list');
    const specs = res.ok ? (res.data.specialties || []) : [];
    const sel = document.getElementById('reg-specialty');
    if (sel) {
        sel.innerHTML = '<option value="">-- اختر التخصص --</option>' +
            specs.map(sp => `<option value="${escapeHTML(sp.id)}">${escapeHTML(sp.name)}</option>`).join('');
    }
    toggleRegYearField();
}

function toggleRegYearField() {
    const role = document.getElementById('reg-role')?.value;
    const yearGroup     = document.getElementById('reg-year-group');
    const specialtyGroup = document.getElementById('reg-specialty-group');
    if (yearGroup) yearGroup.style.display     = role === 'student' ? 'block' : 'none';
    if (specialtyGroup) specialtyGroup.style.display = role !== '' ? 'block' : 'none';
}

async function handleRegister() {
    const firstname  = document.getElementById('reg-firstname').value.trim();
    const lastname   = document.getElementById('reg-lastname').value.trim();
    const email      = document.getElementById('reg-email').value.trim();
    const role       = document.getElementById('reg-role').value;
    const specId     = document.getElementById('reg-specialty')?.value || '';
    const year       = parseInt(document.getElementById('reg-year')?.value) || 0;
    const regNumber  = document.getElementById('reg-number')?.value.trim() || '';
    const password   = document.getElementById('reg-password').value;
    const confirm    = document.getElementById('reg-confirm').value;
    const errDiv = document.getElementById('reg-error');
    const errMsg = document.getElementById('reg-error-msg');
    const showErr = (msg) => { errMsg.textContent = msg; errDiv.classList.remove('hidden'); };

    if (!firstname || !lastname) return showErr('يرجى إدخال الاسم واللقب');
    if (!regNumber) return showErr('يرجى إدخال رقم التسجيل');
    if (!email)  return showErr('يرجى إدخال البريد الإلكتروني');
    const _emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!_emailRx.test(email)) return showErr('البريد الإلكتروني غير صحيح، يرجى إدخال بريد حقيقي (مثال: name@domain.com)');
    if (!role)   return showErr('يرجى اختيار الدور');
    if (role === 'student' && !year) return showErr('يرجى اختيار سنة الدراسة');
    if (!password || password.length < 8) return showErr('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    if (password !== confirm) return showErr('كلمتا المرور غير متطابقتين');

    const btn = document.getElementById('reg-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ التسجيل...'; }

    const res = await apiCall('POST', '/auth/register', {
        firstname, lastname, email, role,
        specialty: specId, year, password,
        registration_number: regNumber
    });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i> إنشاء الحساب'; }

    if (res.ok) {
        document.getElementById('reg-success-number').textContent = res.data.registration_number;
        document.getElementById('register-form-area').classList.add('hidden');
        document.getElementById('register-success-area').classList.remove('hidden');
    } else {
        showErr(res.data?.error || 'فشل التسجيل، حاول مجدداً');
    }
}

function goToLoginAfterRegister() {
    document.getElementById('register-form-area').classList.remove('hidden');
    document.getElementById('register-success-area').classList.add('hidden');
    ['reg-firstname','reg-lastname','reg-email','reg-number','reg-password','reg-confirm'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    showLoginPage();
}

/* ==================== مصادقة الجلسة ==================== */

async function checkAuth() {
    const res = await apiCall('GET', '/auth/me');
    if (res.ok && res.data?.user) {
        currentUser = res.data.user;
        redirectToDashboard(currentUser.role);
    }
}

function redirectToDashboard(role) {
    document.getElementById('login-page').classList.add('hidden');
    const regPage = document.getElementById('register-page');
    if (regPage) regPage.classList.add('hidden');
    document.getElementById('appeal-modal').classList.remove('show');
    document.getElementById('review-modal').classList.remove('show');
    applyTheme();

    if (role === 'student') {
        _resetPages('student-dashboard', 'student-sidebar', 'student-main');
        document.getElementById('student-dashboard').classList.remove('hidden');
        const yearLabel = getYearLabel(currentUser.year);
        document.getElementById('sidebar-student-name').textContent = currentUser.fullName;
        // عرض السنة فوراً ثم جلب اسم التخصص الحقيقي بدل المعرف الرقمي
        const _yearText = yearLabel ? 'سنة ' + yearLabel : '';
        document.getElementById('sidebar-student-info').textContent = _yearText || '—';
        (async () => {
            const specsRes = await apiCall('GET', '/specialties/list');
            if (specsRes.ok) {
                const allSpecs = specsRes.data.specialties || [];
                const matched  = allSpecs.find(sp =>
                    String(sp.id) === String(currentUser.specialty) || sp.name === currentUser.specialty
                );
                const _specText = matched ? matched.name : (currentUser.specialty || '');
                const _infoText = [_specText, _yearText].filter(Boolean).join(' · ');
                document.getElementById('sidebar-student-info').textContent = _infoText || '—';
            }
        })();
        loadAndRenderStudentDashboard();
        initTimePicker();
    } else if (role === 'professor') {
        _resetPages('teacher-dashboard', 'teacher-sidebar', 'teacher-main');
        document.getElementById('teacher-dashboard').classList.remove('hidden');
        document.getElementById('sidebar-teacher-name').textContent = currentUser.fullName;
        document.getElementById('sidebar-teacher-info').textContent = '';
        loadAndRenderTeacherDashboard();
    } else if (role === 'admin') {
        _resetPages('admin-dashboard', 'admin-sidebar', 'admin-main');
        document.getElementById('admin-dashboard').classList.remove('hidden');
        document.getElementById('sidebar-admin-name').textContent = currentUser.fullName;
        loadAndRenderAdminDashboard();
    }
}

function _resetPages(dashId, sidebarId, mainPageId) {
    document.querySelectorAll('#' + dashId + ' .page-section').forEach(p => p.classList.remove('active'));
    document.getElementById(mainPageId)?.classList.add('active');
    document.querySelectorAll('#' + sidebarId + ' .sidebar-link[data-page]').forEach(l => l.classList.remove('active'));
    document.querySelector('#' + sidebarId + ' .sidebar-link[data-page="' + mainPageId + '"]')?.classList.add('active');
}

async function handleLogin() {
    const regNumber = document.getElementById('login-reg-number').value.trim();
    const password  = document.getElementById('login-password').value;
    if (!regNumber || !password) { _showLoginError('يرجى إدخال رقم التسجيل وكلمة السر'); return; }

    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ الدخول...';

    const res = await apiCall('POST', '/auth/login', { registration_number: regNumber, password });

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-arrow-right-to-bracket"></i> تسجيل الدخول';

    if (res.ok) {
        currentUser = res.data.user;
        document.getElementById('login-error').classList.add('hidden');
        showToast('مرحباً ' + currentUser.fullName, 'success');
        redirectToDashboard(currentUser.role);
    } else {
        _showLoginError(res.data?.error || 'رقم التسجيل أو كلمة السر غير صحيحة');
    }
}

function _showLoginError(msg) {
    document.getElementById('login-error-msg').textContent = msg;
    document.getElementById('login-error').classList.remove('hidden');
}

async function logout() {
    await apiCall('POST', '/auth/logout');
    currentUser = null;
    _justs = []; _appeals = []; _users = []; _specialties = [];
    document.querySelectorAll('.dashboard').forEach(d => d.classList.add('hidden'));
    showLoginPage();
    showToast('تم تسجيل الخروج', 'info');
}

function togglePw() {
    const inp = document.getElementById('login-password');
    const ico = document.getElementById('pw-eye');
    if (inp.type === 'password') { inp.type = 'text'; ico.className = 'fas fa-eye-slash'; }
    else { inp.type = 'password'; ico.className = 'fas fa-eye'; }
}

/* ==================== التنقل ==================== */

function showStudentPage(pageId) {
    switchPage('student-dashboard', 'student-sidebar', pageId);
    const titles = { 'student-main': 'الرئيسية', 'student-new': 'تبرير جديد', 'student-history': 'سجل التبريرات', 'student-appeals': 'الطعون' };
    document.getElementById('student-page-title').textContent = titles[pageId] || '';
    if (pageId === 'student-history') loadAndRenderStudentHistory();
    if (pageId === 'student-appeals') loadAndRenderStudentAppeals();
    if (pageId === 'student-main')    loadAndRenderStudentDashboard();
    if (pageId === 'student-new')     initTimePicker();
}

function showTeacherPage(pageId) {
    switchPage('teacher-dashboard', 'teacher-sidebar', pageId);
    const titles = { 'teacher-main': 'الرئيسية', 'teacher-pending': 'قيد المراجعة', 'teacher-reviewed': 'تمت المراجعة' };
    document.getElementById('teacher-page-title').textContent = titles[pageId] || '';
    if (pageId === 'teacher-pending')  loadAndRenderTeacherPending();
    if (pageId === 'teacher-reviewed') loadAndRenderTeacherReviewed();
    if (pageId === 'teacher-main')     loadAndRenderTeacherDashboard();
}

function showAdminPage(pageId) {
    switchPage('admin-dashboard', 'admin-sidebar', pageId);
    const titles = {
        'admin-main': 'الإحصائيات', 'admin-justifications': 'جميع التبريرات',
        'admin-appeals': 'الطعون', 'admin-students': 'إدارة الطلاب',
        'admin-users': 'إدارة المستخدمين', 'admin-specialties': 'التخصصات والمواد',
        
    };
    document.getElementById('admin-page-title').textContent = titles[pageId] || '';
    if (pageId === 'admin-justifications') loadAndRenderAdminJustifications();
    if (pageId === 'admin-appeals')        loadAndRenderAdminAppeals();
    if (pageId === 'admin-students')       loadAndRenderAdminStudents();
    if (pageId === 'admin-users')          loadAndRenderAdminUsers();
    if (pageId === 'admin-specialties')    loadAndRenderAdminSpecialties();
    if (pageId === 'admin-main')           loadAndRenderAdminDashboard();
    
}

function switchPage(dashboardId, sidebarId, pageId) {
    document.querySelectorAll('#' + dashboardId + ' .page-section').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId)?.classList.add('active');
    document.querySelectorAll('#' + sidebarId + ' .sidebar-link[data-page]').forEach(l => l.classList.remove('active'));
    document.querySelector('#' + sidebarId + ' .sidebar-link[data-page="' + pageId + '"]')?.classList.add('active');
    document.getElementById(sidebarId)?.classList.remove('open');
}

function toggleSidebar(id) { document.getElementById(id)?.classList.toggle('open'); }

/* ==================== التقويم ==================== */

function renderCalendar() {
    const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const el = document.getElementById('calendar-month');
    if (el) el.textContent = months[calendarMonth] + ' ' + calendarYear;
    const firstDay    = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const today       = new Date();
    const container   = document.getElementById('calendar-days');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < firstDay; i++) {
        const d = document.createElement('div'); d.className = 'cal-day cal-day--empty'; container.appendChild(d);
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dateObj   = new Date(calendarYear, calendarMonth, d);
        const isToday   = dateObj.toDateString() === today.toDateString();
        const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const isPastOrToday = dateObj <= todayMidnight;
        const isWeekend = dateObj.getDay() === 5;
        const isSelected = selectedDate && dateObj.toDateString() === selectedDate.toDateString();
        const disabled  = !isPastOrToday || isWeekend;
        const cell = document.createElement('div'); cell.className = 'cal-day';
        if (isToday)    cell.classList.add('cal-day--today');
        if (isSelected) cell.classList.add('cal-day--selected');
        if (disabled)   cell.classList.add('cal-day--disabled');
        cell.textContent = d;
        if (!disabled) cell.addEventListener('click', () => selectDate(dateObj));
        container.appendChild(cell);
    }
}

function changeMonth(dir) {
    calendarMonth += dir;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    if (calendarMonth < 0)  { calendarMonth = 11; calendarYear--; }
    renderCalendar();
}

async function selectDate(date) {
    selectedDate = date; selectedSessions = []; renderCalendar();
    await showSessionsForDate(date);
}

async function showSessionsForDate(date) {
    if (!currentUser) return;
    const card  = document.getElementById('sessions-card');
    const list  = document.getElementById('sessions-list');
    const label = document.getElementById('selected-day-label');
    if (!card || !list || !label) return;

    label.textContent = dayNames[date.getDay()] + ' ' + date.getDate() + '/' + (date.getMonth() + 1);
    list.innerHTML = '<p style="text-align:center;padding:16px;color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> جارٍ التحميل...</p>';
    card.classList.remove('hidden');

    // جلب مواد الطالب من API
    const res = await apiCall('GET', '/specialties/list');
    const specs = res.ok ? (res.data.specialties || []) : [];

    // جلب مواد التخصص والسنة الدراسية للطالب
    const specsRes = await apiCall('GET', '/specialties');
    let sessions = [];
    if (specsRes.ok) {
        const allSpecs = specsRes.data.specialties || [];
        // مطابقة بالاسم أو المعرف لأن specialty قد يُخزّن أياً منهما
        const mySpec = allSpecs.find(sp =>
            sp.name === currentUser.specialty ||
            String(sp.id) === String(currentUser.specialty)
        );
        if (mySpec) {
            const filtered = (mySpec.subjects || []).filter(sub => !sub.year || parseInt(sub.year) === parseInt(currentUser.year));
            sessions = filtered.map(sub => ({
                subject: sub.name,
                teacher: sub.teacherName || 'غير محدد',
                subjectId: sub.id
            }));
        }
    }

    windowAvailableSessions = sessions;
    if (sessions.length === 0) {
        list.innerHTML = '<p style="text-align:center;padding:16px;color:var(--text-muted);">لا توجد مواد مسجّلة لتخصصك. تواصل مع الإدارة.</p>';
        return;
    }
    list.innerHTML = sessions.map((s, i) =>
        '<label class="session-item"><input type="checkbox" onchange="toggleSession(' + i + ', this.checked)">' +
        '<div style="flex:1;"><div class="session-item__name">' + escapeHTML(s.subject) + '</div>' +
        '<div class="session-item__details">' + escapeHTML(s.teacher) + '</div></div></label>'
    ).join('');
}

function toggleSession(index, checked) {
    if (checked) { if (!selectedSessions.includes(index)) selectedSessions.push(index); }
    else { selectedSessions = selectedSessions.filter(s => s !== index); }
}

/* ==================== رفع الملف ==================== */

function initFileDrop() {
    const drop = document.getElementById('file-drop');
    if (!drop) return;
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]); });
}

function handleFileSelect(event) { if (event.target.files.length) processFile(event.target.files[0]); }

function processFile(file) {
    if (!['image/jpeg','image/png','image/jpg','application/pdf'].includes(file.type)) { showToast('نوع الملف غير مدعوم (jpg, png, pdf)', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('حجم الملف كبير جداً (5MB max)', 'error'); return; }
    uploadedFile = file;
    const drop = document.getElementById('file-drop');
    const placeholder = document.getElementById('file-placeholder');
    const preview = document.getElementById('file-preview');
    if (!drop || !placeholder || !preview) return;
    drop.classList.add('has-file'); placeholder.classList.add('hidden'); preview.classList.remove('hidden');
    const isImage = file.type.startsWith('image/');
    preview.innerHTML = '<div style="display:flex;align-items:center;gap:14px;">' +
        (isImage ? '<img src="' + URL.createObjectURL(file) + '" style="width:50px;height:50px;object-fit:cover;border-radius:6px;">' : '<i class="fas fa-file-pdf" style="font-size:2rem;color:var(--color-red-solid)"></i>') +
        '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:0.9rem;">' + escapeHTML(file.name) + '</div><div style="font-size:0.75rem;color:var(--text-muted);">' + (file.size/1024).toFixed(0) + ' KB</div></div>' +
        '<button onclick="event.stopPropagation();removeFile()" style="background:none;border:none;color:var(--color-red);cursor:pointer;"><i class="fas fa-trash-can"></i></button></div>';
}

function removeFile() {
    uploadedFile = null;
    document.getElementById('file-drop')?.classList.remove('has-file');
    document.getElementById('file-placeholder')?.classList.remove('hidden');
    document.getElementById('file-preview')?.classList.add('hidden');
    const fi = document.getElementById('file-input'); if (fi) fi.value = '';
}

/* ==================== إرسال التبرير ==================== */


/* ==================== Time Slot Picker ==================== */
const TIME_SLOTS = [
    '08:00','08:30','09:00','09:30','10:00','10:30',
    '11:00','11:30','12:00','12:30','13:00','13:30',
    '14:00','14:30','15:00','15:30','16:00','16:30',
    '17:00','17:30','18:00'
];

let selectedTimeFrom = null;
let selectedTimeTo   = null;

function initTimePicker() {
    renderTimeGrid('time-from-grid', 'from');
    renderTimeGrid('time-to-grid',   'to');
}

function renderTimeGrid(gridId, type) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = TIME_SLOTS.map(t => {
        const isDisabled = type === 'to' && selectedTimeFrom && t <= selectedTimeFrom;
        const isSelected = type === 'from' ? t === selectedTimeFrom : t === selectedTimeTo;
        return `<button type="button"
            class="time-slot-btn${isSelected ? ' selected' : ''}${isDisabled ? ' disabled' : ''}"
            onclick="selectTimeSlot('${type}', '${t}')"
            ${isDisabled ? 'disabled' : ''}>${t}</button>`;
    }).join('');
}

function selectTimeSlot(type, value) {
    if (type === 'from') {
        selectedTimeFrom = value;
        document.getElementById('absence-time-from').value = value;
        // إذا كان وقت النهاية الحالي أقل من أو يساوي البداية، نلغيه
        if (selectedTimeTo && selectedTimeTo <= selectedTimeFrom) {
            selectedTimeTo = null;
            document.getElementById('absence-time-to').value = '';
        }
        renderTimeGrid('time-from-grid', 'from');
        renderTimeGrid('time-to-grid',   'to');
    } else {
        selectedTimeTo = value;
        document.getElementById('absence-time-to').value = value;
        renderTimeGrid('time-to-grid', 'to');
    }
    updateTimeRangeDisplay();
}

function updateTimeRangeDisplay() {
    const disp = document.getElementById('time-range-display');
    const text = document.getElementById('time-range-text');
    if (!disp || !text) return;
    if (selectedTimeFrom && selectedTimeTo) {
        text.textContent = 'من ' + selectedTimeFrom + ' إلى ' + selectedTimeTo;
        disp.classList.remove('hidden');
    } else if (selectedTimeFrom) {
        text.textContent = 'من ' + selectedTimeFrom + ' — اختر وقت النهاية';
        disp.classList.remove('hidden');
    } else {
        disp.classList.add('hidden');
    }
}

function resetTimePicker() {
    selectedTimeFrom = null;
    selectedTimeTo   = null;
    document.getElementById('absence-time-from').value = '';
    document.getElementById('absence-time-to').value   = '';
    renderTimeGrid('time-from-grid', 'from');
    renderTimeGrid('time-to-grid',   'to');
    const disp = document.getElementById('time-range-display');
    if (disp) disp.classList.add('hidden');
}

async function submitJustification() {
    if (!selectedDate)               { showToast('اختر يوم الغياب أولاً', 'error'); return; }
    const timeFrom = document.getElementById('absence-time-from').value;
    const timeTo   = document.getElementById('absence-time-to').value;
    if (!timeFrom || !timeTo)        { showToast('حدد وقت بداية ونهاية الغياب', 'error'); return; }
    if (timeFrom >= timeTo)          { showToast('وقت النهاية يجب أن يكون بعد وقت البداية', 'error'); return; }
    if (selectedSessions.length === 0) { showToast('اختر حصة واحدة على الأقل', 'error'); return; }
    const sessionType = document.getElementById('session-type').value;
    if (!sessionType)                { showToast('اختر نوع الحصة', 'error'); return; }
    if (!uploadedFile)               { showToast('ارفق ملف التبرير', 'error'); return; }

    const dateStr  = selectedDate.toISOString().split('T')[0];
    const sessions = selectedSessions.map(i => windowAvailableSessions[i]);

    const formData = new FormData();
    formData.append('date', dateStr);
    formData.append('time_from', timeFrom);
    formData.append('time_to', timeTo);
    formData.append('session_type', sessionType);
    formData.append('sessions', JSON.stringify(sessions));
    formData.append('notes', document.getElementById('justification-notes').value.trim());
    formData.append('file', uploadedFile);

    const btn = document.querySelector('#student-new .btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ الإرسال...'; }

    const res = await apiCall('POST', '/justifications', formData);

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال التبرير'; }

    if (res.ok) {
        showToast('تم إرسال التبرير بنجاح', 'success');
        selectedDate = null; selectedSessions = []; uploadedFile = null;
        document.getElementById('justification-notes').value = '';
        resetTimePicker();
        document.getElementById('session-type').value = '';
        removeFile();
        document.getElementById('sessions-card')?.classList.add('hidden');
        renderCalendar();
        showStudentPage('student-main');
    } else {
        // رسائل خطأ واضحة حسب نوع الخطأ
        let errMsg = 'حدث خطأ في إرسال التبرير';
        if (res.status === 0)        errMsg = 'تعذّر الاتصال بالخادم، تحقق من الإنترنت وأعد المحاولة';
        else if (res.status === 400) errMsg = res.data?.error || 'البيانات المدخلة غير صحيحة';
        else if (res.status === 401) errMsg = 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً';
        else if (res.status === 403) errMsg = 'ليس لديك صلاحية لتقديم التبرير';
        else if (res.status === 409) errMsg = res.data?.error || 'يوجد تبرير مسبق لهذا اليوم';
        else if (res.status >= 500)  errMsg = 'خطأ في الخادم، يرجى المحاولة لاحقاً';
        else if (res.data?.error)    errMsg = res.data.error;
        showToast(errMsg, 'error');
    }
}

/* ==================== لوحة الطالب ==================== */

async function loadAndRenderStudentDashboard() {
    if (!currentUser) return;
    const res = await apiCall('GET', '/justifications');
    if (!res.ok) return;
    _justs = res.data.justifications || [];

    document.getElementById('stat-total').textContent     = _justs.length;
    document.getElementById('stat-pending').textContent   = _justs.filter(j => j.status === 'pending' || j.status === 'info_requested').length;
    document.getElementById('stat-accepted').textContent  = _justs.filter(j => j.status === 'accepted').length;
    document.getElementById('stat-rejected').textContent  = _justs.filter(j => j.status === 'rejected').length;

    const container = document.getElementById('student-recent-list');
    const recent = [..._justs].slice(0, 3);
    container.innerHTML = recent.length === 0 ? emptyState('fa-inbox', 'لا توجد تبريرات بعد') : recent.map(j => renderJustCard(j, 'student')).join('');
}

async function loadAndRenderStudentHistory() {
    const filter = document.getElementById('filter-status').value;
    const params = filter !== 'all' ? `?status=${filter}` : '';
    const res = await apiCall('GET', '/justifications' + params);
    if (!res.ok) return;
    const justs = res.data.justifications || [];
    const container = document.getElementById('student-history-list');
    container.innerHTML = justs.length === 0 ? emptyState('fa-filter', 'لا توجد نتائج') : justs.map(j => renderJustCard(j, 'student')).join('');
}

async function loadAndRenderStudentAppeals() {
    const res = await apiCall('GET', '/justifications');
    if (!res.ok) return;
    const rejected = (res.data.justifications || []).filter(j => j.status === 'rejected');
    const container = document.getElementById('student-appeals-list');
    if (rejected.length === 0) { container.innerHTML = emptyState('fa-gavel', 'لا توجد تبريرات مرفوضة'); return; }

    // جلب الطعون الموجودة
    const appRes = await apiCall('GET', '/appeals');
    const myAppeals = appRes.ok ? (appRes.data.appeals || []) : [];

    container.innerHTML = rejected.map(j => {
        const appeal = myAppeals.find(a => a.justificationId === j.id);
        let appealHTML = appeal
            ? '<div class="appeal-box"><div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-weight:700;">طعن مقدم</div>' + appealStatusBadge(appeal.status) + '</div>' +
              '<p>' + escapeHTML(appeal.appealText) + '</p>' +
              (appeal.status === 'pending' ? '<button class="btn-secondary btn-sm" style="margin-top:8px;" data-action="edit-appeal" data-id="' + appeal.id + '"><i class="fas fa-pen"></i> تعديل الطعن</button>' : '') + '</div>'
            : '<button class="btn-warning btn-full" style="margin-top:12px;" data-action="appeal" data-id="' + j.id + '"><i class="fas fa-gavel"></i> تقديم طعن</button>';
        return '<div class="justification-card"><div>' + j.date + ' &bull; ' + (j.sessions || []).map(s => escapeHTML(s.subject)).join(', ') + '</div>' +
               '<div class="rejection-box"><b>الرفض:</b> ' + escapeHTML(j.rejectionReason || '') + '</div>' + appealHTML + '</div>';
    }).join('');
}

/* ==================== لوحة الأستاذ ==================== */

async function loadAndRenderTeacherDashboard() {
    const res = await apiCall('GET', '/justifications');
    if (!res.ok) return;
    _justs = res.data.justifications || [];
    const pending = _justs.filter(j => j.status === 'pending' || j.status === 'info_requested');

    document.getElementById('teacher-pending-count').textContent = pending.length;
    document.getElementById('teacher-stat-pending').textContent  = pending.length;
    document.getElementById('teacher-stat-accepted').textContent = _justs.filter(j => j.status === 'accepted').length;
    document.getElementById('teacher-stat-rejected').textContent = _justs.filter(j => j.status === 'rejected').length;

    const container = document.getElementById('teacher-recent-list');
    const recent = [..._justs].slice(0, 4);
    container.innerHTML = recent.length === 0 ? emptyState('fa-inbox', 'لا توجد تبريرات') : recent.map(j => renderJustCard(j, 'teacher')).join('');
}

async function loadAndRenderTeacherPending() {
    const res = await apiCall('GET', '/justifications?status=pending');
    if (!res.ok) return;
    const pending = res.data.justifications || [];
    const container = document.getElementById('teacher-pending-list');
    container.innerHTML = pending.length === 0 ? emptyState('fa-check-double', 'لا توجد تبريرات معلقة') : pending.map(j => renderJustCard(j, 'teacher')).join('');
}

async function loadAndRenderTeacherReviewed() {
    const res = await apiCall('GET', '/justifications');
    if (!res.ok) return;
    const reviewed = (res.data.justifications || []).filter(j => !['pending','info_requested'].includes(j.status));
    const container = document.getElementById('teacher-reviewed-list');
    container.innerHTML = reviewed.length === 0 ? emptyState('fa-check-double', 'لا توجد تبريرات مراجعة') : reviewed.map(j => renderJustCard(j, 'teacher')).join('');
}

/* ==================== لوحة الإدارة ==================== */

async function loadAndRenderAdminDashboard() {
    const [statsRes, justsRes] = await Promise.all([
        apiCall('GET', '/stats'),
        apiCall('GET', '/justifications')
    ]);

    

    if (!statsRes.ok) return;
    const s = statsRes.data;

    const vals = document.querySelectorAll('#admin-main .stat-card__value');
    if (vals.length >= 4) {
        vals[0].textContent = s.totalJustifications;
        vals[1].textContent = s.pendingJustifications;
        vals[2].textContent = s.acceptanceRate + '%';
        vals[3].textContent = s.pendingAppeals;
    }
    document.getElementById('admin-stat-profs')?.setAttribute('data-val', s.totalProfessors);
    document.getElementById('admin-stat-specs')?.setAttribute('data-val', s.totalSpecialties);
    document.getElementById('admin-stat-thismonth')?.setAttribute('data-val', s.thisMonth);
    const el_profs = document.getElementById('admin-stat-profs');
    const el_specs = document.getElementById('admin-stat-specs');
    const el_month = document.getElementById('admin-stat-thismonth');
    const el_students = document.getElementById('admin-stat-students');
    if (el_profs) el_profs.textContent = s.totalProfessors;
    if (el_specs) el_specs.textContent = s.totalSpecialties;
    if (el_month) el_month.textContent = s.thisMonth;
    if (el_students) el_students.textContent = s.totalStudents;

    const appealsBadge = document.getElementById('admin-appeals-count');
    if (appealsBadge) appealsBadge.textContent = s.pendingAppeals > 0 ? s.pendingAppeals : '';

    // تحميل الطعون في الخلفية لتحديث _appeals
    apiCall('GET', '/appeals').then(appRes => {
        if (appRes.ok) {
            _appeals = appRes.data.appeals || [];
            // إذا كانت صفحة الطعون مفتوحة حالياً — نُحدّثها
            if (document.getElementById('admin-appeals')?.classList.contains('active')) {
                const container = document.getElementById('admin-appeals-list');
                if (container) {
                    if (_appeals.length === 0) { container.innerHTML = emptyState('fa-gavel', 'لا توجد طعون'); return; }
                    container.innerHTML = _appeals.map(ap => {
                        const actions = ap.status === 'pending'
                            ? '<div style="display:flex;gap:8px;margin-top:10px;"><button class="btn-primary btn-sm" data-action="appeal-accept" data-id="' + ap.id + '"><i class="fas fa-check"></i> قبول الطعن</button><button class="btn-danger btn-sm" data-action="appeal-reject" data-id="' + ap.id + '"><i class="fas fa-xmark"></i> رفض الطعن</button><button class="btn-delete-just btn-sm" data-action="delete-appeal" data-id="' + ap.id + '"><i class="fas fa-trash"></i> حذف</button></div>'
                            : '<div style="display:flex;align-items:center;gap:10px;margin-top:10px;">' + appealStatusBadge(ap.status) + '<button class="btn-delete-just btn-sm" data-action="delete-appeal" data-id="' + ap.id + '"><i class="fas fa-trash"></i> حذف</button></div>';
                        return '<div class="justification-card"><b>' + escapeHTML(ap.studentName || '—') + '</b> <span style="font-size:0.8rem;color:var(--text-muted);">' + (ap.absenceDate ? new Date(ap.absenceDate).toLocaleDateString('ar') : '') + '</span>' +
                               '<div class="rejection-box" style="margin:8px 0;"><b>الرفض الأصلي:</b> ' + escapeHTML(ap.rejectionReason || '') + '</div>' +
                               '<div class="appeal-box"><b>سبب الطعن:</b> ' + escapeHTML(ap.appealText || ap.appeal_text || '') + '</div>' + actions + '</div>';
                    }).join('');
                }
            }
        }
    });

    // مخطط آخر 6 أشهر
    const barChart = document.getElementById('admin-bar-chart');
    if (barChart && s.monthlyData) {
        const max = Math.max(...s.monthlyData.map(m => parseInt(m.count)), 1);
        barChart.innerHTML = s.monthlyData.map(m => {
            const count = parseInt(m.count);
            return '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;">' +
                '<div style="font-size:0.75rem;color:var(--text-muted);font-weight:600;">' + count + '</div>' +
                '<div style="width:100%;background:var(--accent);border-radius:4px 4px 0 0;height:' + Math.round((count/max)*80) + 'px;min-height:' + (count>0?4:0) + 'px;transition:height 0.4s;"></div>' +
                '<div style="font-size:0.7rem;color:var(--text-muted);">' + (m.month || '').slice(5) + '</div></div>';
        }).join('');
        barChart.style.cssText = 'display:flex;align-items:flex-end;gap:6px;height:120px;padding:10px 0 0;';
    }

    // توزيع الحالات
    const progressList = document.getElementById('admin-progress-list');
    if (progressList) {
        const total = s.totalJustifications || 1;
        const items = [
            { label: 'قيد المراجعة', count: s.pendingJustifications,  color: 'var(--color-amber-solid)' },
            { label: 'مقبولة',        count: s.acceptedJustifications, color: 'var(--color-green-solid)' },
            { label: 'مرفوضة',        count: s.rejectedJustifications, color: 'var(--color-red-solid)'  }
        ];
        progressList.innerHTML = items.map(item =>
            '<div style="margin-bottom:14px;">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.85rem;"><span>' + item.label + '</span>' +
            '<span style="font-weight:700;">' + item.count + ' (' + Math.round((item.count/total)*100) + '%)</span></div>' +
            '<div style="background:var(--border);border-radius:999px;height:8px;">' +
            '<div style="background:' + item.color + ';height:8px;border-radius:999px;width:' + Math.round((item.count/total)*100) + '%;transition:width 0.4s;"></div></div></div>'
        ).join('');
    }

    // آخر التبريرات أسفل الإحصائيات
    if (justsRes.ok) {
        _justs = justsRes.data.justifications || [];
        const container = document.getElementById('admin-all-justs-below');
        if (container) {
            container.innerHTML = _justs.length === 0 ? emptyState('fa-file-lines', 'لا توجد تبريرات بعد') :
                _justs.map(j => renderJustCard(j, 'admin')).join('');
        }
    }
}

async function loadAndRenderAdminJustifications() {
    const statusFilter    = document.getElementById('admin-filter-status').value;
    const specialtyFilter = document.getElementById('admin-filter-specialty').value;
    let params = [];
    if (statusFilter !== 'all')    params.push('status=' + statusFilter);
    if (specialtyFilter !== 'all') params.push('specialty=' + encodeURIComponent(specialtyFilter));
    const res = await apiCall('GET', '/justifications' + (params.length ? '?' + params.join('&') : ''));
    if (!res.ok) return;
    _justs = res.data.justifications || [];
    const container = document.getElementById('admin-just-list');
    container.innerHTML = _justs.length === 0 ? emptyState('fa-file-lines', 'لا توجد نتائج') : _justs.map(j => renderJustCard(j, 'admin')).join('');

    // تحديث فلتر التخصصات
    const specsRes = await apiCall('GET', '/specialties/list');
    const specSel = document.getElementById('admin-filter-specialty');
    if (specSel && specsRes.ok) {
        const current = specSel.value;
        specSel.innerHTML = '<option value="all">كل التخصصات</option>' +
            (specsRes.data.specialties || []).map(sp =>
                '<option value="' + escapeHTML(sp.name) + '"' + (current === sp.name ? ' selected' : '') + '>' + escapeHTML(sp.name) + '</option>'
            ).join('');
    }
}

async function loadAndRenderAdminAppeals() {
    const res = await apiCall('GET', '/appeals');
    if (!res.ok) return;
    _appeals = res.data.appeals || [];
    const container = document.getElementById('admin-appeals-list');
    if (_appeals.length === 0) { container.innerHTML = emptyState('fa-gavel', 'لا توجد طعون'); return; }
    container.innerHTML = _appeals.map(ap => {
        const actions = ap.status === 'pending'
            ? '<div style="display:flex;gap:8px;margin-top:10px;"><button class="btn-primary btn-sm" data-action="appeal-accept" data-id="' + ap.id + '"><i class="fas fa-check"></i> قبول الطعن</button><button class="btn-danger btn-sm" data-action="appeal-reject" data-id="' + ap.id + '"><i class="fas fa-xmark"></i> رفض الطعن</button><button class="btn-delete-just btn-sm" data-action="delete-appeal" data-id="' + ap.id + '"><i class="fas fa-trash"></i> حذف</button></div>'
            : '<div style="display:flex;align-items:center;gap:10px;margin-top:10px;">' + appealStatusBadge(ap.status) + '<button class="btn-delete-just btn-sm" data-action="delete-appeal" data-id="' + ap.id + '"><i class="fas fa-trash"></i> حذف</button></div>';
        return '<div class="justification-card"><b>' + escapeHTML(ap.studentName || '—') + '</b> <span style="font-size:0.8rem;color:var(--text-muted);">' + (ap.absenceDate ? new Date(ap.absenceDate).toLocaleDateString('ar') : '') + '</span>' +
               '<div class="rejection-box" style="margin:8px 0;"><b>الرفض الأصلي:</b> ' + escapeHTML(ap.rejectionReason || '') + '</div>' +
               '<div class="appeal-box"><b>سبب الطعن:</b> ' + escapeHTML(ap.appealText || ap.appeal_text || '') + '</div>' + actions + '</div>';
    }).join('');
}

async function loadAndRenderAdminStudents() {
    const search = document.getElementById('admin-search-student')?.value || '';
    const res = await apiCall('GET', '/users/students' + (search ? '?search=' + encodeURIComponent(search) : ''));
    if (!res.ok) return;
    const students = res.data.students || [];
    const tbody = document.getElementById('admin-students-tbody');
    if (!tbody) return;
    tbody.innerHTML = students.length === 0 ? '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted);">لا يوجد طلاب</td></tr>' :
        students.map(s => {
            const pct = s.absences > 0 ? Math.round((s.justified / s.absences) * 100) : 0;
            return '<tr><td>' + escapeHTML(s.fullName) + '</td><td>' + escapeHTML(s.specialty) + '</td><td>' + s.year + '</td>' +
                   '<td>' + s.absences + '</td><td>' + s.justified + '</td><td>' + pct + '%</td></tr>';
        }).join('');
}

async function loadAndRenderAdminUsers() {
    const roleFilter = document.getElementById('admin-user-role-filter').value;
    const search     = document.getElementById('admin-user-search').value;
    let params = [];
    if (roleFilter !== 'all') params.push('role=' + roleFilter);
    if (search) params.push('search=' + encodeURIComponent(search));
    const res = await apiCall('GET', '/users' + (params.length ? '?' + params.join('&') : ''));
    if (!res.ok) return;
    _users = res.data.users || [];
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;

    if (_users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted);">لا توجد نتائج</td></tr>';
        return;
    }

    const roleLabels = {
        student:   '<span class="badge badge-accepted"><i class="fas fa-graduation-cap"></i> طالب</span>',
        professor: '<span class="badge badge-pending"><i class="fas fa-chalkboard-user"></i> أستاذ</span>',
        admin:     '<span class="badge badge-appealed"><i class="fas fa-shield-halved"></i> إدارة</span>'
    };

    tbody.innerHTML = _users.map(u =>
        '<tr>' +
        '<td><div style="display:flex;align-items:center;gap:10px;"><span class="table-avatar">' + avatarInitial(u.fullName) + '</span><span style="font-weight:700;">' + escapeHTML(u.fullName) + '</span></div></td>' +
        '<td style="font-size:0.85rem;color:var(--text-muted);font-family:monospace;direction:ltr;text-align:right;">' + escapeHTML(u.registrationNumber) + '</td>' +
        '<td>' + (roleLabels[u.role] || u.role) + '</td>' +
        '<td style="font-size:0.85rem;color:var(--text-muted);">' + escapeHTML(u.email || '—') + '</td>' +
        '<td><span style="color:' + (u.isActive ? 'var(--color-green-solid)' : 'var(--color-red-solid)') + ';font-weight:700;font-size:0.85rem;">' +
            (u.isActive ? '<i class="fas fa-circle-check"></i> نشط' : '<i class="fas fa-circle-xmark"></i> معطّل') + '</span></td>' +
        '<td><div style="display:flex;gap:6px;">' +
            '<button class="btn-secondary btn-sm" data-action="edit-user" data-id="' + u.id + '"><i class="fas fa-pen"></i></button>' +
            '<button class="' + (u.isActive ? 'btn-warning' : 'btn-primary') + ' btn-sm" data-action="toggle-user" data-id="' + u.id + '">' +
                '<i class="fas fa-' + (u.isActive ? 'ban' : 'circle-check') + '"></i></button>' +
            (u.role !== 'admin' ? '<button class="btn-danger btn-sm" data-action="delete-user" data-id="' + u.id + '"><i class="fas fa-trash-can"></i></button>' : '') +
        '</div></td></tr>'
    ).join('');
}

/* ==================== طلبات تسجيل الأساتذة (Admin) ==================== */


/* ==================== إدارة التخصصات ==================== */

async function loadAndRenderAdminSpecialties() {
    const res = await apiCall('GET', '/specialties');
    if (!res.ok) { document.getElementById('admin-specialties-content').innerHTML = emptyState('fa-layer-group', 'فشل جلب التخصصات'); return; }
    _specialties = res.data.specialties || [];

    // جلب قائمة الأساتذة
    const profsRes = await apiCall('GET', '/users/professors');
    const professors = profsRes.ok ? (profsRes.data.professors || []) : [];

    renderAdminSpecialtiesUI(_specialties, professors);
}

function renderAdminSpecialtiesUI(specs, professors) {
    const container = document.getElementById('admin-specialties-content');
    if (!container) return;
    if (specs.length === 0) { container.innerHTML = emptyState('fa-layer-group', 'لا توجد تخصصات بعد — أضف تخصصاً أولاً'); return; }

    container.innerHTML = specs.map(sp => {
        const subsByYear = {};
        (sp.subjects || []).forEach(sub => {
            const y = sub.year || 0;
            if (!subsByYear[y]) subsByYear[y] = [];
            subsByYear[y].push(sub);
        });
        const years = Object.keys(subsByYear).sort();
        const tabsNav     = years.map((y, i) => `<button class="year-tab-btn${i===0?' active':''}" data-spec="${sp.id}" onclick="switchYearTab('${sp.id}',${y},this)">${yearLabel(parseInt(y))}</button>`).join('');
        const tabsContent = years.map((y, i) => {
            const subs = subsByYear[y] || [];
            const tableHead = subs.length > 0
                ? '<div class="subjects-table-head"><span><i class="fas fa-book-open" style="margin-left:5px;opacity:0.6;"></i>المادة</span><span><i class="fas fa-chalkboard-teacher" style="margin-left:5px;opacity:0.6;"></i>الأستاذ</span><span>إجراءات</span></div>'
                : '';
            return '<div class="spec-' + sp.id + '-yr" data-year="' + y + '"' + (i > 0 ? ' style="display:none"' : '') + '>' +
                (subs.length === 0
                    ? '<div class="subjects-empty-year"><i class="fas fa-book-open"></i><span>لا توجد مواد لهذه السنة</span></div>'
                    : tableHead + subs.map(sub => {
                        const prof = professors.find(p => p.id === sub.teacherId);
                        const initials = prof ? prof.fullName.split(' ').map(w => w[0]).join('').slice(0,2) : '—';
                        return '<div class="subject-row">' +
                            '<div class="subject-info">' +
                                '<span class="subject-name">' + escapeHTML(sub.name) + '</span>' +
                            '</div>' +
                            '<div class="subject-prof-cell">' +
                                '<div class="subject-prof-avatar">' + escapeHTML(initials) + '</div>' +
                                '<span class="subject-prof-name">' + escapeHTML(prof?.fullName || 'بدون أستاذ') + '</span>' +
                            '</div>' +
                            '<div class="subject-actions">' +
                                '<button class="subject-btn subject-btn--edit" title="تعديل" onclick="openEditSubjectModal(\'' + sp.id + '\',\'' + sub.id + '\')"><i class="fas fa-pen"></i></button>' +
                                '<button class="subject-btn subject-btn--del" title="حذف" onclick="deleteSubjectAPI(\'' + sub.id + '\')"><i class="fas fa-trash-can"></i></button>' +
                            '</div>' +
                        '</div>';
                    }).join('')) +
                '<button class="add-subject-btn" onclick="openAddSubjectModal(\'' + sp.id + '\',' + y + ')"><i class="fas fa-plus"></i> إضافة مادة</button></div>';
        }).join('');
        const noYearHTML = years.length === 0
            ? '<div class="subjects-empty-year"><i class="fas fa-book-open"></i><span>لا توجد مواد — أضف مادة أولاً</span></div><button class="add-subject-btn" onclick="openAddSubjectModal(\'' + sp.id + '\',0)"><i class="fas fa-plus"></i> إضافة مادة</button>'
            : '';

        return '<div class="specialty-card">' +
            '<div class="specialty-card__header"><h4>' + escapeHTML(sp.name) + '</h4>' +
            '<div style="display:flex;gap:6px;">' +
                '<button class="btn-secondary btn-sm" onclick="editSpecialtyUI(\'' + sp.id + '\',\'' + escapeHTML(sp.name) + '\')"><i class="fas fa-pen"></i></button>' +
                '<button class="btn-danger btn-sm" onclick="deleteSpecialtyAPI(\'' + sp.id + '\',\'' + escapeHTML(sp.name) + '\')"><i class="fas fa-trash-can"></i></button>' +
            '</div></div>' +
            '<div class="year-tabs-nav">' + tabsNav + '</div>' +
            '<div class="year-tabs-content">' + tabsContent + noYearHTML + '</div></div>';
    }).join('');
}

function switchYearTab(specId, year, btnEl) {
    document.querySelectorAll('.spec-' + specId + '-yr').forEach(p => p.style.display = 'none');
    document.querySelectorAll('[data-spec="' + specId + '"]').forEach(b => b.classList.remove('active'));
    const panel = document.querySelector('.spec-' + specId + '-yr[data-year="' + year + '"]');
    if (panel) panel.style.display = '';
    if (btnEl) btnEl.classList.add('active');
}

function openAddSpecialtyModal() {
    document.getElementById('specialty-modal-title').textContent = 'إضافة تخصص جديد';
    document.getElementById('specialty-modal-content').innerHTML =
        '<div class="form-group"><label>اسم التخصص</label>' +
        '<input type="text" id="spec-name-input" class="input-field" placeholder="مثال: هندسة برمجيات" required></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1" onclick="submitSpecialtyAPI()"><i class="fas fa-plus"></i> إضافة</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'specialty-modal\')">إلغاء</button></div>';
    openModal('specialty-modal');
    setTimeout(() => document.getElementById('spec-name-input')?.focus(), 100);
}

async function submitSpecialtyAPI() {
    const name = document.getElementById('spec-name-input').value.trim();
    if (!name) { showToast('يرجى إدخال اسم التخصص', 'error'); return; }
    const res = await apiCall('POST', '/specialties', { name });
    if (res.ok) {
        showToast('تمت إضافة التخصص', 'success');
        closeModal('specialty-modal');
        loadAndRenderAdminSpecialties();
    } else {
        showToast(res.data?.error || 'فشل إضافة التخصص', 'error');
    }
}

function editSpecialtyUI(specId, currentName) {
    document.getElementById('specialty-modal-title').textContent = 'تعديل التخصص';
    document.getElementById('specialty-modal-content').innerHTML =
        '<div class="form-group"><label>اسم التخصص</label>' +
        '<input type="text" id="spec-name-input" class="input-field" value="' + escapeHTML(currentName) + '" required></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1" onclick="updateSpecialtyAPI(\'' + specId + '\')"><i class="fas fa-pen"></i> حفظ</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'specialty-modal\')">إلغاء</button></div>';
    openModal('specialty-modal');
    setTimeout(() => document.getElementById('spec-name-input')?.focus(), 100);
}

async function updateSpecialtyAPI(specId) {
    const name = document.getElementById('spec-name-input')?.value.trim();
    if (!name) { showToast('يرجى إدخال اسم التخصص', 'error'); return; }
    const res = await apiCall('PUT', '/specialties/' + specId, { name });
    if (res.ok) {
        showToast('تم تحديث التخصص', 'success');
        closeModal('specialty-modal');
        loadAndRenderAdminSpecialties();
    } else {
        showToast(res.data?.error || 'فشل تحديث التخصص', 'error');
    }
}

async function deleteSpecialtyAPI(specId, specName) {
    if (!confirm('حذف تخصص "' + specName + '"؟ سيتم إلغاء جميع مواده.')) return;
    const res = await apiCall('DELETE', '/specialties/' + specId);
    if (res.ok) { showToast('تم حذف التخصص', 'info'); loadAndRenderAdminSpecialties(); }
    else showToast(res.data?.error || 'فشل الحذف', 'error');
}

async function openAddSubjectModal(specId, defaultYear) {
    const profsRes = await apiCall('GET', '/users/professors');
    const professors = profsRes.ok ? (profsRes.data.professors || []) : [];

    const sp = _specialties.find(s => s.id === specId);
    const yearOptions = [1,2,3,4,5].map(y => `<option value="${y}"${y === defaultYear ? ' selected' : ''}>${yearLabel(y)}</option>`).join('');

    document.getElementById('specialty-modal-title').textContent = 'إضافة مادة' + (sp ? ' — ' + sp.name : '');
    document.getElementById('specialty-modal-content').innerHTML =
        '<div class="form-group"><label>اسم المادة</label><input type="text" id="subj-name-input" class="input-field" placeholder="مثال: قواعد البيانات"></div>' +
        '<div class="form-group"><label>السنة الدراسية</label><select id="subj-year-input" class="input-field"><option value="">-- اختر السنة --</option>' + yearOptions + '</select></div>' +
        '<div class="form-group"><label>الأستاذ المسؤول (اختياري)</label><select id="subj-teacher-input" class="input-field"><option value="">-- بدون تحديد --</option>' +
        professors.map(p => `<option value="${p.id}">${escapeHTML(p.fullName)}</option>`).join('') + '</select></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1" onclick="submitSubjectAPI(\'' + specId + '\')"><i class="fas fa-plus"></i> إضافة</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'specialty-modal\')">إلغاء</button></div>';
    openModal('specialty-modal');
}

async function submitSubjectAPI(specId) {
    const sp = _specialties.find(s => s.id === specId);
    const name       = document.getElementById('subj-name-input').value.trim();
    const year       = parseInt(document.getElementById('subj-year-input').value) || null;
    const teacherId  = document.getElementById('subj-teacher-input').value || null;
    if (!name) { showToast('يرجى إدخال اسم المادة', 'error'); return; }

    const res = await apiCall('POST', '/specialties/subjects', {
        name, department: sp?.name || specId, professor_id: teacherId, year
    });
    if (res.ok) { showToast('تمت إضافة المادة', 'success'); closeModal('specialty-modal'); loadAndRenderAdminSpecialties(); }
    else showToast(res.data?.error || 'فشل إضافة المادة', 'error');
}

async function openEditSubjectModal(specId, subjectId) {
    const sp  = _specialties.find(s => s.id === specId);
    const sub = (sp?.subjects || []).find(s => s.id === subjectId);
    if (!sub) return;
    const profsRes = await apiCall('GET', '/users/professors');
    const professors = profsRes.ok ? (profsRes.data.professors || []) : [];
    const yearOptions = [1,2,3,4,5].map(y => `<option value="${y}"${sub.year === y ? ' selected' : ''}>${yearLabel(y)}</option>`).join('');

    document.getElementById('specialty-modal-title').textContent = 'تعديل المادة';
    document.getElementById('specialty-modal-content').innerHTML =
        '<div class="form-group"><label>اسم المادة</label><input type="text" id="subj-name-input" class="input-field" value="' + escapeHTML(sub.name) + '"></div>' +
        '<div class="form-group"><label>السنة الدراسية</label><select id="subj-year-input" class="input-field"><option value="">-- اختر السنة --</option>' + yearOptions + '</select></div>' +
        '<div class="form-group"><label>الأستاذ المسؤول</label><select id="subj-teacher-input" class="input-field"><option value="">-- بدون تحديد --</option>' +
        professors.map(p => `<option value="${p.id}"${sub.teacherId === p.id ? ' selected' : ''}>${escapeHTML(p.fullName)}</option>`).join('') + '</select></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1" onclick="updateSubjectAPI(\'' + subjectId + '\',\'' + encodeURIComponent(sp?.name || '') + '\')"><i class="fas fa-pen"></i> حفظ</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'specialty-modal\')">إلغاء</button></div>';
    openModal('specialty-modal');
}

async function updateSubjectAPI(subjectId, encodedDept) {
    const name      = document.getElementById('subj-name-input').value.trim();
    const year      = parseInt(document.getElementById('subj-year-input').value) || null;
    const teacherId = document.getElementById('subj-teacher-input').value || null;
    if (!name) { showToast('يرجى إدخال اسم المادة', 'error'); return; }
    const res = await apiCall('PUT', '/specialties/subjects/' + subjectId, {
        name, professor_id: teacherId, year, department: decodeURIComponent(encodedDept)
    });
    if (res.ok) { showToast('تم تحديث المادة', 'success'); closeModal('specialty-modal'); loadAndRenderAdminSpecialties(); }
    else showToast(res.data?.error || 'فشل التحديث', 'error');
}

async function deleteSubjectAPI(subjectId) {
    if (!confirm('حذف هذه المادة؟')) return;
    const res = await apiCall('DELETE', '/specialties/subjects/' + subjectId);
    if (res.ok) { showToast('تم حذف المادة', 'info'); loadAndRenderAdminSpecialties(); }
    else showToast(res.data?.error || 'فشل الحذف', 'error');
}

/* ==================== مراجعة التبريرات ==================== */

function openReviewModal(justId, presetDecision) {
    const j = _justs.find(x => x.id == justId);
    if (!j) return;
    const decisionLabels = { accepted: 'قبول', rejected: 'رفض', info_requested: 'طلب معلومات' };
    const html =
        '<div style="margin-bottom:14px;"><b>' + (j.studentName || '') + '</b> &bull; ' + j.date + '</div>' +
        '<div style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:6px;">' + (j.sessions || []).map(s => '<span class="session-tag">' + escapeHTML(s.subject) + '</span>').join('') + '</div>' +
        (j.notes ? '<div style="margin-bottom:14px;font-size:0.9rem;">' + escapeHTML(j.notes) + '</div>' : '') +
        (j.fileName ? '<div style="margin-bottom:14px;"><a href="/api/justifications/' + j.id + '/file" target="_blank" class="btn-secondary btn-sm"><i class="fas fa-paperclip"></i> ' + escapeHTML(j.fileName) + '</a></div>' : '') +
        '<div class="form-group"><label>القرار</label><select id="review-decision" class="input-field">' +
        ['accepted','rejected'].map(v => `<option value="${v}"${v === presetDecision ? ' selected' : ''}>${{accepted:'قبول',rejected:'رفض'}[v]}</option>`).join('') +
        '</select></div>' +
        '<div class="form-group"><label>ملاحظة (إلزامية عند الرفض)</label>' +
        '<textarea id="review-notes" class="input-field" rows="3" placeholder="سبب القرار..."></textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1" onclick="submitReview(\'' + justId + '\')"><i class="fas fa-check"></i> تأكيد</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'review-modal\')">إلغاء</button></div>';
    document.getElementById('review-modal-content').innerHTML = html;
    document.querySelector('#review-modal .modal-header h3').textContent = 'مراجعة التبرير';
    openModal('review-modal');
}

// قبول مباشر بدون modal
async function acceptJustificationDirect(justId) {
    let j = _justs.find(x => x.id == justId);
    if (!j) {
        const res = await apiCall('GET', '/justifications');
        if (res.ok) {
            _justs = res.data.justifications || [];
            j = _justs.find(x => x.id == justId);
        }
        if (!j) { showToast('تعذّر تحميل بيانات التبرير', 'error'); return; }
    }
    const res = await apiCall('POST', '/justifications/' + justId + '/review', { decision: 'accepted', notes: '' });
    if (res.ok) {
        showToast('تم قبول التبرير', 'success');
        if (currentUser.role === 'admin') { loadAndRenderAdminJustifications(); loadAndRenderAdminDashboard(); }
        else { loadAndRenderTeacherDashboard(); loadAndRenderTeacherPending(); }
    } else {
        showToast(res.data?.error || 'فشل قبول التبرير', 'error');
    }
}

// رفض مع إدخال سبب فقط (بدون خيار القرار)
async function openRejectModal(justId) {
    // البحث في الذاكرة أولاً، وإن لم يُوجد نجلبه من API
    let j = _justs.find(x => x.id == justId);
    if (!j) {
        const res = await apiCall('GET', '/justifications');
        if (res.ok) {
            _justs = res.data.justifications || [];
            j = _justs.find(x => x.id == justId);
        }
        if (!j) { showToast('تعذّر تحميل بيانات التبرير', 'error'); return; }
    }
    const html =
        '<div style="margin-bottom:14px;"><b>' + (j.studentName || '') + '</b> &bull; ' + j.date + '</div>' +
        '<div style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:6px;">' + (j.sessions || []).map(s => '<span class="session-tag">' + escapeHTML(s.subject) + '</span>').join('') + '</div>' +
        (j.notes ? '<div style="margin-bottom:14px;font-size:0.9rem;">' + escapeHTML(j.notes) + '</div>' : '') +
        (j.fileName ? '<div style="margin-bottom:14px;"><a href="/api/justifications/' + j.id + '/file" target="_blank" class="btn-secondary btn-sm"><i class="fas fa-paperclip"></i> ' + escapeHTML(j.fileName) + '</a></div>' : '') +
        '<div class="form-group"><label>سبب الرفض (إلزامي)</label>' +
        '<textarea id="review-notes" class="input-field" rows="3" placeholder="اذكر سبب رفض التبرير..."></textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-danger" style="flex:1" onclick="submitReject(\'' + justId + '\')"><i class="fas fa-xmark"></i> تأكيد الرفض</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'review-modal\')">إلغاء</button></div>';
    document.getElementById('review-modal-content').innerHTML = html;
    document.querySelector('#review-modal .modal-header h3').textContent = 'رفض التبرير';
    openModal('review-modal');
}

async function submitReject(justId) {
    const notes = document.getElementById('review-notes').value.trim();
    if (!notes) { showToast('يرجى كتابة سبب الرفض', 'error'); return; }
    const res = await apiCall('POST', '/justifications/' + justId + '/review', { decision: 'rejected', notes });
    if (res.ok) {
        showToast('تم رفض التبرير', 'info');
        closeModal('review-modal');
        if (currentUser.role === 'admin') { loadAndRenderAdminJustifications(); loadAndRenderAdminDashboard(); }
        else { loadAndRenderTeacherDashboard(); loadAndRenderTeacherPending(); }
    } else {
        showToast(res.data?.error || 'فشل تحديث القرار', 'error');
    }
}

async function submitReview(justId) {
    const decision = document.getElementById('review-decision').value;
    const notes    = document.getElementById('review-notes').value.trim();
    if (decision === 'rejected' && !notes) { showToast('يرجى كتابة سبب الرفض', 'error'); return; }

    const res = await apiCall('POST', '/justifications/' + justId + '/review', { decision, notes });
    if (res.ok) {
        showToast(decision === 'accepted' ? 'تم قبول التبرير' : decision === 'rejected' ? 'تم رفض التبرير' : 'تم طلب معلومات إضافية', 'success');
        closeModal('review-modal');
        if (currentUser.role === 'admin') { loadAndRenderAdminJustifications(); loadAndRenderAdminDashboard(); }
        else { loadAndRenderTeacherDashboard(); loadAndRenderTeacherPending(); }
    } else {
        showToast(res.data?.error || 'فشل تحديث القرار', 'error');
    }
}

/* ==================== الطعون ==================== */

function openAppealModal(justId) {
    const html =
        '<div class="form-group"><label>سبب الطعن</label>' +
        '<textarea id="appeal-text" class="input-field" rows="4" placeholder="اكتب سبب اعتراضك على الرفض..."></textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1" onclick="submitAppeal(\'' + justId + '\')"><i class="fas fa-gavel"></i> تقديم الطعن</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'appeal-modal\')">إلغاء</button></div>';
    document.getElementById('appeal-modal-content').innerHTML = html;
    openModal('appeal-modal');
}

async function submitAppeal(justId) {
    const appealText = document.getElementById('appeal-text').value.trim();
    if (!appealText) { showToast('يرجى كتابة سبب الطعن', 'error'); return; }
    const res = await apiCall('POST', '/appeals', { justification_id: justId, appeal_text: appealText });
    if (res.ok) {
        showToast('تم إرسال الطعن', 'success');
        closeModal('appeal-modal');
        loadAndRenderStudentAppeals();
    } else {
        showToast(res.data?.error || 'فشل تقديم الطعن', 'error');
    }
}

async function resolveAppeal(appealId, decision) {
    const res = await apiCall('POST', '/appeals/' + appealId + '/resolve', { decision });
    if (res.ok) {
        showToast(decision === 'accepted' ? 'تم قبول الطعن' : 'تم رفض الطعن', decision === 'accepted' ? 'success' : 'info');
        loadAndRenderAdminAppeals();
        loadAndRenderAdminDashboard();
    } else showToast(res.data?.error || 'فشل', 'error');
}

/* ==================== إدارة المستخدمين (Admin) ==================== */

async function openUserModal(userId) {
    const isEdit = !!userId;
    let user = null;
    if (isEdit) {
        user = _users.find(u => u.id === userId);
    }

    const specsRes = await apiCall('GET', '/specialties/list');
    const specs = specsRes.ok ? (specsRes.data.specialties || []) : [];
    const specOpts = specs.map(sp => `<option value="${escapeHTML(sp.name)}"${user && user.specialty === sp.name ? ' selected' : ''}>${escapeHTML(sp.name)}</option>`).join('');

    document.getElementById('user-modal-title').textContent = isEdit ? 'تعديل المستخدم' : 'إضافة مستخدم';

    const nameParts = isEdit && user ? user.fullName.split(' ') : ['',''];
    const fname = nameParts[0] || '';
    const lname = nameParts.slice(1).join(' ') || '';

    let html =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-group"><label>الاسم الأول</label><input type="text" id="user-form-fname" class="input-field" value="' + escapeHTML(fname) + '"></div>' +
        '<div class="form-group"><label>اللقب</label><input type="text" id="user-form-lname" class="input-field" value="' + escapeHTML(lname) + '"></div></div>' +
        '<div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="user-form-email" class="input-field" value="' + escapeHTML(user?.email || '') + '" dir="ltr"></div>' +
        '<div class="form-group"><label>كلمة المرور</label><input type="password" id="user-form-password" class="input-field" placeholder="' + (isEdit ? 'اتركه فارغاً إذا لم ترد التغيير' : 'أدخل كلمة مرور') + '" dir="ltr"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="form-group"><label>الدور</label><select id="user-form-role" class="input-field" onchange="toggleUserFormFields()">' +
        ['student','professor','admin'].map(r => `<option value="${r}"${user && user.role === r ? ' selected' : ''}>${{student:'طالب',professor:'أستاذ',admin:'إدارة'}[r]}</option>`).join('') +
        '</select></div>' +
        '<div class="form-group" id="user-form-specialty-group"><label>التخصص</label><select id="user-form-specialty" class="input-field"><option value="">—</option>' + specOpts + '</select></div></div>' +
        '<div class="form-group" id="user-form-year-group"><label>سنة الدراسة</label><select id="user-form-year" class="input-field">' +
        ['','1','2','3','4','5'].map(v => `<option value="${v}"${user && String(user.year) === v ? ' selected' : ''}>${v ? yearLabel(parseInt(v)) : '—'}</option>`).join('') + '</select></div>' +
        '<div style="display:flex;gap:8px;margin-top:20px;">' +
        '<button type="button" class="btn-primary" style="flex:1;" onclick="submitUserForm(\'' + (isEdit ? userId : 'null') + '\')"><i class="fas fa-' + (isEdit ? 'pen' : 'plus') + '"></i> ' + (isEdit ? 'حفظ التعديلات' : 'إضافة المستخدم') + '</button>' +
        '<button type="button" class="btn-secondary" onclick="closeModal(\'user-modal\')">إلغاء</button></div>';

    document.getElementById('user-modal-content').innerHTML = html;
    toggleUserFormFields();
    openModal('user-modal');
}

function toggleUserFormFields() {
    const role = document.getElementById('user-form-role')?.value;
    document.getElementById('user-form-year-group')?.style.setProperty('display', role === 'student' ? 'block' : 'none');
    document.getElementById('user-form-specialty-group')?.style.setProperty('display', role !== 'admin' ? 'block' : 'none');
}

function editUser(id) { openUserModal(id); }

async function submitUserForm(editId) {
    const fname    = document.getElementById('user-form-fname').value.trim();
    const lname    = document.getElementById('user-form-lname').value.trim();
    const email    = document.getElementById('user-form-email').value.trim();
    const role     = document.getElementById('user-form-role').value;
    const specialty = document.getElementById('user-form-specialty')?.value || '';
    const year     = parseInt(document.getElementById('user-form-year')?.value) || 0;
    const password = document.getElementById('user-form-password').value;

    if (!fname || !lname) { showToast('يرجى إدخال الاسم واللقب', 'error'); return; }

    const isEdit = editId && editId !== 'null';
    let res;
    if (isEdit) {
        res = await apiCall('PUT', '/users/' + editId, { firstname: fname, lastname: lname, email, specialty, year, password: password || undefined, is_active: true });
    } else {
        if (!password || password.length < 8) { showToast('كلمة المرور يجب أن تكون 8 أحرف على الأقل', 'error'); return; }
        res = await apiCall('POST', '/users', { firstname: fname, lastname: lname, email, role, specialty, year, password });
    }

    if (res.ok) {
        showToast(isEdit ? 'تم التحديث بنجاح' : 'تمت الإضافة بنجاح — رقم التسجيل: ' + (res.data.registration_number || ''), 'success');
        closeModal('user-modal');
        loadAndRenderAdminUsers();
    } else {
        showToast(res.data?.error || 'فشل العملية', 'error');
    }
}

async function toggleUserStatus(id) {
    const user = _users.find(u => u.id === id);
    if (!user) return;
    const res = await apiCall('PUT', '/users/' + id, { is_active: !user.isActive });
    if (res.ok) {
        showToast(user.isActive ? 'تم تعطيل الحساب' : 'تم تفعيل الحساب', 'info');
        loadAndRenderAdminUsers();
    } else showToast(res.data?.error || 'فشل', 'error');
}

async function confirmDeleteUser(id) {
    const user = _users.find(u => u.id === id);
    if (!user) return;
    if (!confirm('حذف المستخدم "' + user.fullName + '"؟ لا يمكن التراجع.')) return;
    const res = await apiCall('DELETE', '/users/' + id);
    if (res.ok) { showToast('تم حذف المستخدم', 'success'); loadAndRenderAdminUsers(); }
    else showToast(res.data?.error || 'فشل الحذف', 'error');
}

/* ==================== حذف التبريرات والطعون ==================== */

async function confirmDeleteJustification(justId) {
    const j = _justs.find(x => x.id == justId);
    if (!j) return;
    if (!confirm('حذف التبرير بتاريخ ' + j.date + '؟ لا يمكن التراجع.')) return;
    const res = await apiCall('DELETE', '/justifications/' + justId);
    if (res.ok) {
        showToast('تم حذف التبرير', 'success');
        loadAndRenderAdminJustifications();
        loadAndRenderAdminDashboard();
    } else showToast(res.data?.error || 'فشل الحذف', 'error');
}

async function confirmDeleteAppeal(appealId) {
    if (!confirm('حذف هذا الطعن؟ لا يمكن التراجع.')) return;
    const res = await apiCall('DELETE', '/appeals/' + appealId);
    if (res.ok) {
        showToast('تم حذف الطعن', 'success');
        loadAndRenderAdminAppeals();
        loadAndRenderAdminDashboard();
    } else showToast(res.data?.error || 'فشل الحذف', 'error');
}

/* ==================== تعديل التبرير والطعن (طالب) ==================== */

function openEditJustificationModal(justId) {
    const j = _justs.find(x => x.id == justId);
    if (!j) return;
    if (!['pending','info_requested'].includes(j.status)) { showToast('لا يمكن تعديل هذا الطلب', 'error'); return; }

    const sessionTypeLabels = { cours: 'Cours', td: 'TD', tp: 'TP', exam: 'Exam' };
    const html =
        '<div style="margin-bottom:14px;color:var(--text-muted);font-size:0.85rem;"><i class="fas fa-info-circle"></i> تعديل التبرير بتاريخ <b>' + j.date + '</b></div>' +
        '<div class="form-group"><label>نوع الحصة</label><select id="edit-session-type" class="input-field">' +
        ['cours','td','tp','exam'].map(v => `<option value="${v}"${j.sessionType === v ? ' selected' : ''}>${sessionTypeLabels[v] || v}</option>`).join('') +
        '</select></div>' +
        '<div class="form-group"><label>وقت البداية</label><input type="time" id="edit-time-from" class="input-field" value="' + (j.timeFrom || '') + '"></div>' +
        '<div class="form-group"><label>وقت النهاية</label><input type="time" id="edit-time-to" class="input-field" value="' + (j.timeTo || '') + '"></div>' +
        '<div class="form-group"><label>ملاحظات</label><textarea id="edit-just-notes" class="input-field" rows="3">' + escapeHTML(j.notes || '') + '</textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1;" onclick="submitEditJustification(\'' + j.id + '\')"><i class="fas fa-save"></i> حفظ التعديلات</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'review-modal\')">إلغاء</button></div>';
    document.getElementById('review-modal-content').innerHTML = html;
    document.querySelector('#review-modal .modal-header h3').textContent = 'تعديل الطلب';
    openModal('review-modal');
}

async function submitEditJustification(justId) {
    const timeFrom    = document.getElementById('edit-time-from').value;
    const timeTo      = document.getElementById('edit-time-to').value;
    const sessionType = document.getElementById('edit-session-type').value;
    const notes       = document.getElementById('edit-just-notes').value.trim();
    if (timeFrom && timeTo && timeFrom >= timeTo) { showToast('وقت النهاية يجب أن يكون بعد وقت البداية', 'error'); return; }

    const res = await apiCall('PUT', '/justifications/' + justId, { notes, session_type: sessionType, time_from: timeFrom, time_to: timeTo });
    if (res.ok) {
        showToast('تم تحديث الطلب بنجاح', 'success');
        closeModal('review-modal');
        loadAndRenderStudentDashboard();
        loadAndRenderStudentHistory();
    } else showToast(res.data?.error || 'فشل التحديث', 'error');
}

function openEditAppealModal(appealId) {
    const ap = _appeals.find(x => x.id == appealId);
    if (!ap || ap.status !== 'pending') { showToast('لا يمكن تعديل هذا الطعن', 'error'); return; }
    const html =
        '<div class="rejection-box" style="margin-bottom:14px;"><b>سبب الرفض الأصلي:</b> ' + escapeHTML(ap.rejectionReason || '') + '</div>' +
        '<div class="form-group"><label>تعديل سبب الطعن</label><textarea id="edit-appeal-text" class="input-field" rows="4">' + escapeHTML(ap.appealText || '') + '</textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
        '<button class="btn-primary" style="flex:1;" onclick="submitEditAppeal(\'' + ap.id + '\')"><i class="fas fa-save"></i> حفظ التعديلات</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'appeal-modal\')">إلغاء</button></div>';
    document.getElementById('appeal-modal-content').innerHTML = html;
    document.querySelector('#appeal-modal .modal-header h3').textContent = 'تعديل الطعن';
    openModal('appeal-modal');
}

async function submitEditAppeal(appealId) {
    const reason = document.getElementById('edit-appeal-text').value.trim();
    if (!reason) { showToast('يرجى كتابة سبب الطعن', 'error'); return; }
    const res = await apiCall('PUT', '/appeals/' + appealId, { appeal_text: reason });
    if (res.ok) {
        showToast('تم تحديث الطعن بنجاح', 'success');
        closeModal('appeal-modal');
        loadAndRenderStudentAppeals();
    } else showToast(res.data?.error || 'فشل', 'error');
}

/* ==================== تسجيل غياب (أستاذ) ==================== */

async function openProfessorAbsenceModal() {
    const [specsRes, studentsRes] = await Promise.all([
        apiCall('GET', '/specialties'),
        apiCall('GET', '/users/students')
    ]);
    const allSpecs = specsRes.ok ? (specsRes.data.specialties || []) : [];
    const students = studentsRes.ok ? (studentsRes.data.students || []) : [];

    // مواد الأستاذ
    const mySubjects = [];
    allSpecs.forEach(sp => {
        (sp.subjects || []).forEach(sub => {
            if (sub.teacherId === currentUser.id) {
                mySubjects.push({ specName: sp.name, subName: sub.name, subId: sub.id });
            }
        });
    });

    const html =
        '<div class="form-group"><label>اختر الطالب</label><select id="abs-student-id" class="input-field">' +
        (students.length === 0 ? '<option value="">لا يوجد طلاب</option>' :
        students.map(s => `<option value="${s.id}">${escapeHTML(s.fullName)}${s.specialty ? ' (' + escapeHTML(s.specialty) + ')' : ''}</option>`).join('')) +
        '</select></div>' +
        '<div class="form-group"><label>التاريخ</label><input type="date" id="abs-date" class="input-field" max="' + new Date().toISOString().split('T')[0] + '" value="' + new Date().toISOString().split('T')[0] + '"></div>' +
        '<div class="form-group"><label>المادة</label><select id="abs-subject" class="input-field">' +
        (mySubjects.length === 0 ? '<option value="">لم يتم تحديد مواد لك</option>' :
        mySubjects.map(s => `<option value="${escapeHTML(s.subName)}">${escapeHTML(s.subName)} (${escapeHTML(s.specName)})</option>`).join('')) +
        '</select></div>' +
        '<div style="display:flex;gap:8px;margin-top:20px;">' +
        '<button class="btn-primary" style="flex:1;" onclick="submitProfessorAbsence()"><i class="fas fa-check"></i> تسجيل الغياب</button>' +
        '<button class="btn-secondary" onclick="closeModal(\'user-modal\')">إلغاء</button></div>';

    document.getElementById('user-modal-title').textContent = 'تسجيل غياب جديد';
    document.getElementById('user-modal-content').innerHTML = html;
    openModal('user-modal');
}

async function submitProfessorAbsence() {
    const studentId = document.getElementById('abs-student-id').value;
    const date      = document.getElementById('abs-date').value;
    const subject   = document.getElementById('abs-subject').value;
    if (!date || !subject || !studentId) { showToast('يرجى إكمال البيانات', 'error'); return; }

    // نرسل كـ FormData لأن endpoint التبريرات يقبل FormData
    const formData = new FormData();
    formData.append('date', date);
    formData.append('sessions', JSON.stringify([{ subject }]));
    formData.append('notes', 'تم التسجيل بواسطة الأستاذ');
    formData.append('session_type', 'cours');
    // نحتاج student_id override — يتطلب endpoint مخصص، نعمله بـ apiCall عادي
    const res = await apiCall('POST', '/justifications', formData);
    if (res.ok) {
        showToast('تم تسجيل الغياب بنجاح', 'success');
        closeModal('user-modal');
        loadAndRenderTeacherDashboard();
    } else showToast(res.data?.error || 'فشل التسجيل', 'error');
}

/* ==================== CSV Export ==================== */

function exportToCSV() {
    if (_justs.length === 0) { showToast('لا توجد بيانات للتصدير', 'info'); return; }
    const headers = ['رقم التسجيل','اسم الطالب','التخصص','التاريخ','المواد','الحالة','تاريخ المراجعة'];
    const rows = _justs.map(j => [
        j.registrationNumber || '', j.studentName || '', j.studentSpecialty || '',
        j.date, (j.sessions || []).map(s => s.subject).join(' - '),
        j.status, j.reviewedAt ? new Date(j.reviewedAt).toLocaleDateString('ar') : ''
    ]);
    const csv  = headers.join(',') + '\n' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'justifications.csv';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

/* ==================== مساعدات الواجهة ==================== */

async function previewFile(justId) {
    const j        = _justs.find(x => x.id == justId);
    const fileUrl  = '/api/justifications/' + justId + '/file';
    const fileName = j?.fileName || 'الوثيقة';

    // إزالة أي overlay سابق وإنشاء جديد
    const old = document.getElementById('file-preview-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'file-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    overlay.addEventListener('click', e => { if (e.target === overlay) _closePreview(); });
    document.body.appendChild(overlay);

    overlay.innerHTML =
        '<div style="width:min(92vw,900px);height:min(88vh,720px);background:var(--bg-card,#1e1e2e);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.6);">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border,#333);flex-shrink:0;">' +
                '<span style="font-weight:700;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><i class="fas fa-file-alt" style="margin-left:8px;opacity:0.7;"></i>' + escapeHTML(fileName) + '</span>' +
                '<div style="display:flex;gap:8px;flex-shrink:0;" id="fprev-actions">' +
                    '<button onclick="_closePreview()" style="background:var(--color-red-solid,#ef4444);color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:0.82rem;"><i class="fas fa-xmark"></i> إغلاق</button>' +
                '</div>' +
            '</div>' +
            '<div style="flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;" id="fprev-body">' +
                '<div style="text-align:center;color:var(--text-muted,#888);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;margin-bottom:12px;display:block;"></i>جارٍ تحميل الوثيقة...</div>' +
            '</div>' +
        '</div>';

    let blobUrl = null;

    // دالة الإغلاق مع تنظيف الـ Blob
    window._closePreview = () => {
        if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
        const el = document.getElementById('file-preview-overlay');
        if (el) el.remove();
    };

    try {
        // جلب الملف مع إرسال الـ cookies (حل مشكلة المصادقة في iframe/img)
        const resp = await fetch(fileUrl, { credentials: 'include' });
        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || 'HTTP ' + resp.status);
        }

        const blob    = await resp.blob();
        blobUrl       = URL.createObjectURL(blob);
        const isPdf   = blob.type === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
        const isImage = blob.type.startsWith('image/');

        // زر التحميل بعد نجاح الجلب
        const actionsEl = document.getElementById('fprev-actions');
        if (actionsEl) {
            const dlBtn = document.createElement('a');
            dlBtn.href      = blobUrl;
            dlBtn.download  = fileName;
            dlBtn.style.cssText = 'background:var(--accent,#6366f1);color:#fff;border-radius:6px;padding:6px 14px;font-size:0.82rem;text-decoration:none;display:inline-flex;align-items:center;gap:5px;';
            dlBtn.innerHTML = '<i class="fas fa-download"></i> تحميل';
            actionsEl.insertBefore(dlBtn, actionsEl.firstChild);
        }

        const bodyEl = document.getElementById('fprev-body');
        if (!bodyEl) return;
        bodyEl.innerHTML = '';

        if (isPdf) {
            const iframe   = document.createElement('iframe');
            iframe.src     = blobUrl;
            iframe.style.cssText = 'width:100%;height:100%;border:none;';
            bodyEl.appendChild(iframe);
        } else if (isImage) {
            bodyEl.style.cssText += ';overflow:auto;padding:16px;';
            const img  = document.createElement('img');
            img.src    = blobUrl;
            img.style.cssText = 'max-width:100%;max-height:100%;border-radius:6px;object-fit:contain;';
            bodyEl.appendChild(img);
        } else {
            bodyEl.innerHTML =
                '<div style="text-align:center;padding:40px;color:var(--text-muted,#888);">' +
                '<i class="fas fa-file" style="font-size:3rem;margin-bottom:16px;display:block;"></i>' +
                '<p style="margin-bottom:16px;">لا يمكن معاينة هذا النوع من الملفات</p>' +
                '<a href="' + blobUrl + '" download="' + escapeHTML(fileName) + '" style="background:var(--accent,#6366f1);color:#fff;padding:8px 20px;border-radius:6px;text-decoration:none;"><i class="fas fa-download"></i> تحميل الملف</a></div>';
        }

    } catch (err) {
        const bodyEl = document.getElementById('fprev-body');
        if (bodyEl) {
            bodyEl.innerHTML =
                '<div style="text-align:center;padding:40px;">' +
                '<i class="fas fa-triangle-exclamation" style="font-size:2.5rem;color:var(--color-red-solid,#ef4444);margin-bottom:14px;display:block;"></i>' +
                '<p style="color:var(--color-red-solid,#ef4444);font-weight:700;margin-bottom:6px;">تعذّر تحميل الوثيقة</p>' +
                '<p style="font-size:0.82rem;color:var(--text-muted,#888);">' + escapeHTML(err.message) + '</p></div>';
        }
    }
}

function statusBadge(status) {
    const badges = {
        pending:        '<span class="badge badge-pending"><i class="fas fa-hourglass-half"></i> قيد المراجعة</span>',
        accepted:       '<span class="badge badge-accepted"><i class="fas fa-circle-check"></i> مقبول</span>',
        rejected:       '<span class="badge badge-rejected"><i class="fas fa-circle-xmark"></i> مرفوض</span>',
        info_requested: '<span class="badge badge-info"><i class="fas fa-circle-question"></i> طلب معلومات</span>'
    };
    return badges[status] || '';
}

function statusBadgeTeacher(status) {
    const badges = {
        pending:        '<span class="badge badge-pending"><i class="fas fa-hourglass-half"></i> قيد الانتظار</span>',
        accepted:       '<span class="badge badge-accepted"><i class="fas fa-circle-check"></i> مقبولة (الإدارة)</span>',
        rejected:       '<span class="badge badge-rejected"><i class="fas fa-circle-xmark"></i> مرفوضة (الإدارة)</span>',
        info_requested: '<span class="badge badge-info"><i class="fas fa-circle-question"></i> طلب معلومات</span>'
    };
    return badges[status] || '';
}

function appealStatusBadge(status) {
    const badges = { pending: '<span class="badge badge-pending">قيد المراجعة</span>', accepted: '<span class="badge badge-accepted">مقبول</span>', rejected: '<span class="badge badge-rejected">مرفوض</span>' };
    return badges[status] || '';
}

function renderJustCard(j, viewer) {
    let actions = '';
    if (viewer === 'admin' && (j.status === 'pending' || j.status === 'info_requested')) {
        actions = '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">' +
            '<button class="btn-primary btn-sm" data-action="review-accept" data-id="' + j.id + '"><i class="fas fa-check"></i> قبول</button>' +
            '<button class="btn-danger btn-sm" data-action="review-reject" data-id="' + j.id + '"><i class="fas fa-xmark"></i> رفض</button>' +
            '<button class="btn-delete-just btn-sm" data-action="delete-just" data-id="' + j.id + '"><i class="fas fa-trash"></i></button></div>';
    } else if (viewer === 'admin') {
        actions = '<div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end;"><button class="btn-delete-just btn-sm" data-action="delete-just" data-id="' + j.id + '"><i class="fas fa-trash"></i> حذف</button></div>';
    }
    if (viewer === 'teacher') {
        // الأستاذ يطّلع فقط — لا يملك صلاحية القبول أو الرفض
        actions = j.fileName
            ? '<div style="margin-top:10px;"><button class="btn-secondary btn-sm" data-action="preview-file" data-id="' + j.id + '"><i class="fas fa-eye"></i> عرض الوثيقة</button></div>'
            : '';
    }
    if (viewer === 'student' && (j.status === 'pending' || j.status === 'info_requested')) {
        actions = '<div style="display:flex;gap:6px;margin-top:10px;"><button class="btn-secondary btn-sm" data-action="edit-justification" data-id="' + j.id + '"><i class="fas fa-pen"></i> تعديل الطلب</button></div>';
    }

    const studentInfo = viewer !== 'student' ? '<div style="font-size:0.8rem;color:var(--text-muted);">' + escapeHTML(j.studentName || '') + (j.studentSpecialty ? ' &bull; ' + escapeHTML(j.studentSpecialty) : '') + '</div>' : '';
    const fileHTML = j.fileName ? '<div style="font-size:0.8rem;cursor:pointer;color:var(--accent);" data-action="preview-file" data-id="' + j.id + '"><i class="fas fa-paperclip"></i> ' + escapeHTML(j.fileName) + '</div>' : '';
    const timeRange = (j.timeFrom && j.timeTo) ? '<span style="margin-right:8px;font-size:0.82rem;color:var(--text-muted);">' + j.timeFrom + ' – ' + j.timeTo + '</span>' : '';
    const SESSION_LABELS = { cours: 'Cours (محاضرة)', td: 'TD (أعمال موجهة)', tp: 'TP (أعمال تطبيقية)', exam: 'Exam (امتحان)' };
    const rawLabel = j.sessionTypeLabel || j.sessionType || '';
    const resolvedLabel = SESSION_LABELS[rawLabel.toLowerCase()] || rawLabel;
    const sessionTypeLabel = resolvedLabel ? '<span style="font-size:0.78rem;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--color-blue-light,#dbeafe);color:var(--color-blue-dark,#1e40af);">' + escapeHTML(resolvedLabel) + '</span>' : '';
    const badge = viewer === 'teacher' ? statusBadgeTeacher(j.status) : statusBadge(j.status);

    return '<div class="justification-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;"><div><b>' + j.date + '</b>' + (timeRange ? ' ' + timeRange : '') + studentInfo + '</div>' + badge + '</div>' +
        '<div style="margin:8px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">' + (j.sessions || []).map(s => '<span class="session-tag">' + escapeHTML(s.subject) + '</span>').join('') + (sessionTypeLabel ? ' ' + sessionTypeLabel : '') + '</div>' +
        (j.notes ? '<div style="font-size:0.85rem;color:var(--text-muted);">' + escapeHTML(j.notes) + '</div>' : '') + fileHTML + actions + '</div>';
}

function yearLabel(y) {
    const labels = { 1: 'السنة الأولى', 2: 'السنة الثانية', 3: 'السنة الثالثة', 4: 'ماستر 1', 5: 'ماستر 2' };
    return labels[y] || 'السنة ' + y;
}
function getYearLabel(y) {
    const labels = { 1: 'الأولى', 2: 'الثانية', 3: 'الثالثة', 4: 'ماستر 1', 5: 'ماستر 2', 6: 'ماستر 1', 7: 'ماستر 2' };
    return labels[y] || '';
}

function avatarInitial(name) { return (name || '?').replace(/^(د\.|أ\.)/, '').trim().charAt(0); }
function openModal(id)  { document.getElementById(id)?.classList.add('show'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }

function showToast(message, type) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast--' + type;
    toast.innerHTML = '<i class="fas fa-info-circle"></i> ' + message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('removing'), 3500);
    setTimeout(() => toast.remove(), 4000);
}

function emptyState(icon, text) {
    return '<div class="empty-state"><i class="fas ' + icon + '"></i><p>' + text + '</p></div>';
}

// ربط فلاتر الإدارة بالتحديث الفوري
function renderAdminJustifications() { loadAndRenderAdminJustifications(); }
function renderAdminAppeals()        { loadAndRenderAdminAppeals(); }
function renderAdminStudents()       { loadAndRenderAdminStudents(); }
function renderAdminUsers()          { loadAndRenderAdminUsers(); }