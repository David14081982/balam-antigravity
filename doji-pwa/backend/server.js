require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── JWT Secret ────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET missing from .env — add it and restart.');
  process.exit(1);
}

// ─── Supabase setup ────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_KEY missing from .env — add them and restart.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Local dirs (avatars only — catalog/logos/showcase → Supabase Storage) ────
const uploadsDir = path.join(__dirname, 'uploads');
const resultsDir = path.join(__dirname, 'results');
[uploadsDir, resultsDir].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

app.use('/uploads', express.static(uploadsDir));
app.use('/results', express.static(resultsDir));

// ─── Supabase Storage helpers ──────────────────────────────────────────────────
function getStorageUrl(bucket, filename) {
  if (!filename) return null;
  if (filename.startsWith('http')) return filename; // already full URL
  const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
  return data.publicUrl;
}

async function uploadToStorage(bucket, buffer, filename, mimetype) {
  const { error } = await supabase.storage.from(bucket).upload(filename, buffer, {
    contentType: mimetype,
    upsert: true
  });
  if (error) throw new Error(`Storage upload error (${bucket}): ${error.message}`);
  return getStorageUrl(bucket, filename);
}

async function removeFromStorage(bucket, filename) {
  if (!filename || filename.startsWith('http')) return;
  await supabase.storage.from(bucket).remove([filename]);
}

// ─── Multer config ─────────────────────────────────────────────────────────────
// Avatars: still disk-based (tryon reads the file from disk)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/.test(file.mimetype))
});

// Catalog, logos, showcase: memory → Supabase Storage
const memStorage = multer.memoryStorage();
const uploadCatalog = multer({
  storage: memStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/.test(file.mimetype))
});
const uploadLogo = multer({
  storage: memStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/.test(file.mimetype))
});
const uploadShowcase = multer({
  storage: memStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/.test(file.mimetype))
});

// ─── Auth middleware ───────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}


function verifySuperadmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (payload.role !== 'superadmin') {
      return res.status(403).json({ error: 'Superadmin access required' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Accepts superadmin token OR company token
function verifyAdminAccess(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (payload.role !== 'superadmin' && !payload.company_id) {
      return res.status(403).json({ error: 'Admin or company token required' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function verifyCompanyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (!payload.company_id) {
      return res.status(403).json({ error: 'Company token required' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Referral & Usage Helpers ──────────────────────────────────────────────────
function generateReferralCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function getUserGenerationLimit(userId) {
  try {
    // 1. Get settings
    const { data: baseSet } = await supabase.from('app_settings').select('value').eq('key', 'base_daily_limit').maybeSingle();
    const { data: rewardSet } = await supabase.from('app_settings').select('value').eq('key', 'referral_reward').maybeSingle();
    const { data: maxSet } = await supabase.from('app_settings').select('value').eq('key', 'max_daily_limit').maybeSingle();
    
    const baseLimit = baseSet?.value?.limit || 3;
    const rewardPerReferral = rewardSet?.value?.reward || 1;
    const maxLimit = maxSet?.value?.limit || 50;

    // 2. Count successful referrals
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('referred_by_id', userId)
      .eq('is_verified', true);

    const calculated = baseLimit + ((count || 0) * rewardPerReferral);
    return Math.min(calculated, maxLimit);
  } catch (e) {
    return 3; // Fallback
  }
}

async function checkDailyUsage(userId) {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('generations_log')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gt('created_at', twentyFourHoursAgo);
  
  const limit = await getUserGenerationLimit(userId);
  return { used: count || 0, limit, canGenerate: (count || 0) < limit };
}

// ─── Email verification helper ────────────────────────────────────────────────
async function sendVerificationCode(userId, email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  // Invalidar códigos anteriores no usados
  await supabase.from('verification_codes')
    .update({ used: true }).eq('user_id', userId).eq('used', false);
  await supabase.from('verification_codes').insert({
    user_id: userId, code, channel: 'email',
    expires_at, created_at: new Date().toISOString()
  });
  await resend.emails.send({
    from: 'Balam <onboarding@resend.dev>',
    to: email,
    subject: 'Tu código de verificación Balam',
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-family:Georgia,serif;font-weight:300;font-size:32px;color:#1a1a18;margin:0 0 8px;">Balam</h1>
      <p style="color:#8a8880;font-size:13px;margin:0 0 32px;">Probador virtual de moda</p>
      <p style="font-size:15px;color:#4a4a45;margin:0 0 16px;">Tu código de verificación:</p>
      <div style="background:#f2efe9;border-radius:14px;padding:24px;text-align:center;margin:0 0 24px;">
        <span style="font-size:42px;font-weight:700;letter-spacing:12px;color:#1a1a18;font-family:monospace;">${code}</span>
      </div>
      <p style="font-size:13px;color:#8a8880;">Válido por 10 minutos. No lo compartas.</p>
    </div>`
  });
}

// ─── Email reset password helper ──────────────────────────────────────────────
async function sendPasswordResetCode(email, code) {
  await resend.emails.send({
    from: 'Balam <onboarding@resend.dev>',
    to: email,
    subject: 'Restablece tu contraseña - Balam',
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-family:Georgia,serif;font-weight:300;font-size:32px;color:#1a1a18;margin:0 0 8px;">Balam</h1>
      <p style="color:#8a8880;font-size:13px;margin:0 0 32px;">Probador virtual de moda</p>
      <p style="font-size:15px;color:#4a4a45;margin:0 0 16px;">Tu código para restablecer tu contraseña:</p>
      <div style="background:#f2efe9;border-radius:14px;padding:24px;text-align:center;margin:0 0 24px;">
        <span style="font-size:42px;font-weight:700;letter-spacing:12px;color:#1a1a18;font-family:monospace;">${code}</span>
      </div>
      <p style="font-size:13px;color:#8a8880;">Válido por 15 minutos. Si no fuiste tú, ignora este correo.</p>
    </div>`
  });
}

// ─── Event tracking (fire-and-forget) ─────────────────────────────────────────
async function logEvent(sb, userId, companyId, eventName, properties = {}) {
  try {
    await sb.from('events').insert({
      user_id:    userId    || null,
      company_id: companyId || null,
      event_name: eventName,
      properties,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    // fire-and-forget — never throw
    console.error(`logEvent(${eventName}) failed:`, e.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../index.html'));
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../../admin.html'));
});

// Serve company dashboard
app.get('/empresa', (req, res) => {
  res.sendFile(path.join(__dirname, '../../company-dashboard.html'));
});

// Serve tienda pública
app.get('/tienda', (req, res) => {
  res.sendFile(path.join(__dirname, '../../tienda.html'));
});

// Health check (public)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString(), db: 'supabase' });
});

// Register a new company + owner user (public)
app.post('/api/company/register', (req, res) => {
  uploadLogo.single('logo')(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ error: `Error al procesar logo: ${multerErr.message}` });
    try {
    const { name, slug, email, password, website, instagram, facebook, tiktok } = req.body;
    if (!name || !slug || !email || !password) {
      return res.status(400).json({ error: 'name, slug, email y password son requeridos' });
    }

    const { data: slugTaken } = await supabase.from('companies').select('id').eq('slug', slug).maybeSingle();
    if (slugTaken) return res.status(409).json({ error: 'El slug ya está en uso' });

    const { data: emailTaken } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (emailTaken) return res.status(409).json({ error: 'El email ya está registrado' });

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    const { error: userErr } = await supabase.from('users').insert({
      id: userId, email, password_hash: passwordHash, created_at: new Date().toISOString()
    });
    if (userErr) throw userErr;

    let logoFile = null;
    let logoUrl  = null;
    if (req.file) {
      logoFile = `${uuidv4()}${path.extname(req.file.originalname)}`;
      logoUrl  = await uploadToStorage('logos', req.file.buffer, logoFile, req.file.mimetype);
    }

    const { data: company, error: companyErr } = await supabase
      .from('companies')
      .insert({
        name, slug, contact_email: email, status: 'active',
        logo_url: logoUrl, logo_file: logoFile,
        website: website || null,
        instagram: instagram || null,
        facebook: facebook || null,
        tiktok: tiktok || null
      })
      .select('id')
      .single();
    if (companyErr) throw companyErr;

    const { error: linkErr } = await supabase.from('company_users').insert({
      company_id: company.id, user_id: userId, role: 'owner'
    });
    if (linkErr) throw linkErr;

    const token = jwt.sign(
      { sub: userId, company_id: company.id, role: 'owner' },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.status(201).json({ token, company_id: company.id, user_id: userId });
    } catch (err) {
      console.error('Company register error:', err);
      res.status(500).json({ error: err.message || 'Failed to register company' });
    }
  });
});

// Company login (public)
app.post('/api/company/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email y password son requeridos' });
    }

    const { data: user } = await supabase
      .from('users').select('id, password_hash').eq('email', email).maybeSingle();
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Credenciales inválidas' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const { data: cu } = await supabase
      .from('company_users').select('company_id, role').eq('user_id', user.id).maybeSingle();
    if (!cu) return res.status(403).json({ error: 'Usuario no asociado a ninguna empresa' });

    const token = jwt.sign(
      { sub: user.id, company_id: cu.company_id, role: cu.role },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token, company_id: cu.company_id, role: cu.role });
  } catch (err) {
    console.error('Company login error:', err);
    res.status(500).json({ error: err.message || 'Failed to login' });
  }
});

// Create anonymous session — returns signed JWT (public)
app.post('/api/session', async (req, res) => {
  try {
    const id = uuidv4();
    const { error } = await supabase.from('users').insert({ id, created_at: new Date().toISOString() });
    if (error) throw error;
    const token = jwt.sign({ sub: id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    console.error('Session error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── POST /api/user/register-with-token ─────────────────────────────────────────
// Convierte usuario anónimo en registrado — conserva el mismo userId
app.post('/api/user/register-with-token', verifyToken, async (req, res) => {
  try {
    const { email, password, name, phone, referral_code: friendCode } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: 'Nombre, correo y contraseña son requeridos' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Correo electrónico inválido' });
    if (password.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    if (phone && !/^\d{10}$/.test(phone))
      return res.status(400).json({ error: 'El teléfono debe tener exactamente 10 dígitos' });

    const { data: taken } = await supabase.from('users')
      .select('id').eq('email', email).neq('id', req.user.sub).maybeSingle();
    if (taken) return res.status(409).json({ error: 'Este correo ya está registrado' });

    // ── Referral Logic ──
    let referredById = null;
    if (friendCode) {
      const { data: friend } = await supabase.from('users')
        .select('id').eq('referral_code', friendCode.toUpperCase()).maybeSingle();
      if (friend) referredById = friend.id;
    }

    let myCode = generateReferralCode();
    // Hasta 5 reintentos en caso de colisión
    for (let i = 0; i < 5; i++) {
      const { data: clash } = await supabase.from('users').select('id').eq('referral_code', myCode).maybeSingle();
      if (!clash) break;
      myCode = generateReferralCode();
    }

    const password_hash = await bcrypt.hash(password, 10);
    
    // Intenta actualizar con el campo 'phone', 'referral_code' y 'referred_by_id'
    let updateRes = await supabase.from('users')
      .update({ 
        email, 
        password_hash, 
        name, 
        phone, 
        is_registered: true,
        referral_code: myCode,
        referred_by_id: referredById
      })
      .eq('id', req.user.sub)
      .select();
      
    // Respaldo por si no existen las columnas de referidos aún
    if (updateRes.error && (
      updateRes.error.message.includes('referral_code') ||
      updateRes.error.message.includes('referred_by_id') ||
      updateRes.error.message.includes('column') ||
      updateRes.error.code === '42703'
    )) {
      console.warn('Columnas de referidos no encontradas, ignorando por ahora');
      updateRes = await supabase.from('users')
        .update({ email, password_hash, name, phone, is_registered: true })
        .eq('id', req.user.sub)
        .select();
    }
    
    if (updateRes.error) throw updateRes.error;
    
    // Comprobamos si el token de verdad ligó al usuario (0 filas afectadas significa que fue borrado/no existe)
    if (!updateRes.data || updateRes.data.length === 0) {
      return res.status(401).json({ error: 'Sesión anónima inválida o no encontrada. Por favor recarga la página.' });
    }

    await sendVerificationCode(req.user.sub, email);
    res.json({ success: true, message: 'Código enviado a tu correo' });
  } catch (err) {
    console.error('register-with-token error:', err);
    // Extraer mejor el error real (ya sea por Resend, Supabase, etc.) para que "d.error" sí tenga texto
    const msg = err.message || err.details || err.hint || (typeof err === 'string' ? err : 'Error interno al registrar');
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/user/verify-code ─────────────────────────────────────────────────
app.post('/api/user/verify-code', verifyToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Código requerido' });

    const { data: found } = await supabase.from('verification_codes')
      .select('*').eq('user_id', req.user.sub).eq('code', code.toString())
      .eq('used', false).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (!found) return res.status(400).json({ error: 'Código inválido o expirado' });

    await supabase.from('users').update({ is_verified: true }).eq('id', req.user.sub);
    await supabase.from('verification_codes').update({ used: true }).eq('id', found.id);

    const newToken = jwt.sign(
      { sub: req.user.sub, is_registered: true, verified: true },
      JWT_SECRET, { expiresIn: '30d' }
    );
    
    const { data: user } = await supabase.from('users')
      .select('id, referral_code').eq('id', req.user.sub).single();
    
    const { count: referrals } = await supabase.from('users')
      .select('*', { count: 'exact', head: true }).eq('referred_by_id', req.user.sub).eq('is_verified', true);

    const usage = await checkDailyUsage(req.user.sub);

    res.json({ 
      success: true, 
      token: newToken,
      avatarUrl: user?.avatar_url ? `${BASE_URL}${user.avatar_url}` : null,
      referralCode: user?.referral_code,
      referrals: referrals || 0,
      usage
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al verificar' });
  }
});

// ── GET /api/user/me ───────────────────────────────────────────────────────────
app.get('/api/user/me', verifyToken, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users')
      .select('id, referral_code, avatar_url').eq('id', req.user.sub).single();
    const { count: referrals } = await supabase.from('users')
      .select('*', { count: 'exact', head: true })
      .eq('referred_by_id', req.user.sub).eq('is_verified', true);
    const usage = await checkDailyUsage(req.user.sub);
    res.json({
      referralCode: user?.referral_code,
      referrals: referrals || 0,
      usage
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/user/resend-code ─────────────────────────────────────────────────
app.post('/api/user/resend-code', verifyToken, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users')
      .select('email').eq('id', req.user.sub).single();
    if (!user?.email) return res.status(400).json({ error: 'Completa tu registro primero' });
    await sendVerificationCode(req.user.sub, user.email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al reenviar' });
  }
});

// ── POST /api/user/login ───────────────────────────────────────────────────────
app.post('/api/user/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });

    const { data: user } = await supabase.from('users')
      .select('*').eq('email', email).maybeSingle();
    if (!user || !user.is_registered || !user.password_hash)
      return res.status(401).json({ error: 'Credenciales inválidas' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const newToken = jwt.sign(
      { sub: user.id, is_registered: true, verified: user.is_verified },
      JWT_SECRET, { expiresIn: '30d' }
    );
    const { count: referrals } = await supabase.from('users')
      .select('*', { count: 'exact', head: true }).eq('referred_by_id', user.id).eq('is_verified', true);
    
    const usage = await checkDailyUsage(user.id);

    res.json({ 
      token: newToken,
      userId: user.id,
      avatarUrl: user.avatar_url ? `${BASE_URL}${user.avatar_url}` : null,
      referralCode: user.referral_code,
      referrals: referrals || 0,
      usage
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al iniciar sesión' });
  }
});

// ── POST /api/user/forgot-password ─────────────────────────────────────────────
app.post('/api/user/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Correo es requerido' });

    const { data: user } = await supabase
      .from('users').select('id, is_registered').eq('email', email).maybeSingle();
    
    // Respuesta genérica para no revelar si el email existe
    if (!user || !user.is_registered) return res.json({ success: true });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await supabase.from('reset_tokens').insert({ email, token: code, expires_at });

    if (process.env.RESEND_API_KEY) {
      await sendPasswordResetCode(email, code);
    } else {
      console.log(`🔑 [Dev] Reset token for ${email}: ${code} (expires ${expires_at})`);
    }

    res.json({ success: true, _dev_token: process.env.RESEND_API_KEY ? undefined : code });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al iniciar recuperación' });
  }
});

// ── POST /api/user/reset-password ──────────────────────────────────────────────
app.post('/api/user/reset-password', async (req, res) => {
  try {
    const { email, token, new_password } = req.body;
    if (!email || !token || !new_password) {
      return res.status(400).json({ error: 'Correo, código y nueva contraseña requeridos' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const { data: record } = await supabase
      .from('reset_tokens')
      .select('id, expires_at, used')
      .eq('email', email)
      .eq('token', token)
      .maybeSingle();

    if (!record) return res.status(400).json({ error: 'Código inválido' });
    if (record.used) return res.status(400).json({ error: 'El código ya fue utilizado' });
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'El código ha expirado. Solicita uno nuevo' });
    }

    const { data: user } = await supabase
      .from('users').select('id').eq('email', email).maybeSingle();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const password_hash = await bcrypt.hash(new_password, 10);
    const { error } = await supabase
      .from('users').update({ password_hash }).eq('id', user.id);
    if (error) throw error;

    await supabase.from('reset_tokens').update({ used: true }).eq('id', record.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al restablecer la contraseña' });
  }
});

// Get all garments (public)
app.get('/api/garments', async (req, res) => {
  try {
    const { category, limit = 50 } = req.query;

    let query = supabase.from('catalog_garments').select('*, companies(slug, logo_url, name)').eq('hidden', false).order('created_at', { ascending: false });
    if (category && category !== 'all') query = query.eq('category', category);

    let { data: rows, error } = await query.limit(parseInt(limit));
    if (error && error.code === '42703') {
      // hidden column not yet migrated — retry without filter
      let q2 = supabase.from('catalog_garments').select('*, companies(slug, logo_url, name)').order('created_at', { ascending: false });
      if (category && category !== 'all') q2 = q2.eq('category', category);
      ({ data: rows, error } = await q2.limit(parseInt(limit)));
    }
    if (error) throw error;

    const garments = (rows || []).map(g => ({
      id: g.id, brand: g.brand, name: g.name, price: g.price,
      category: g.category, description: g.description || '',
      fashn_category: g.fashn_category || 'tops',
      image: getStorageUrl('catalog', g.image_file),
      colors: [], sizes: g.sizes || [], productUrl: '#',
      company_slug: g.companies?.slug || null,
      company_logo: g.companies?.logo_url || null,
      company_name: g.companies?.name || null,
    }));

    res.json({ garments, total: garments.length });
  } catch (err) {
    console.error('Garments error:', err);
    res.status(500).json({ error: 'Failed to fetch garments' });
  }
});

// Get single garment (public)
app.get('/api/garments/:id', async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('catalog_garments').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Garment not found' });
    res.json({ ...row, image: getStorageUrl('catalog', row.image_file) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch garment' });
  }
});

// Upload user photos for avatar creation (protected)
app.post('/api/avatar/upload', verifyToken, upload.array('photos', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

    const userId = req.user.sub;
    const photoUrls = req.files.map(f => `/uploads/${f.filename}`);
    const avatarUrl = photoUrls[0];

    await new Promise(resolve => setTimeout(resolve, 2000));

    const { error } = await supabase
      .from('users')
      .update({ avatar_url: avatarUrl })
      .eq('id', userId);
    if (error) throw error;

    res.json({
      status: 'ready',
      avatarUrl: `${BASE_URL}${avatarUrl}`,
      photoCount: photoUrls.length
    });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Failed to process photos' });
  }
});

// Get avatar status (protected)
app.get('/api/avatar/:userId', verifyToken, async (req, res) => {
  if (req.user.sub !== req.params.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.params.userId)
      .single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      avatarUrl: user.avatar_url ? `${BASE_URL}${user.avatar_url}` : null,
      createdAt: user.created_at
    });
  } catch (err) {
    console.error('Avatar status error:', err);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// ─── Admin: Catalog management ────────────────────────────────────────────────

// List custom garments (admin — company-scoped or superadmin sees all)
app.get('/api/admin/garments', verifyAdminAccess, async (req, res) => {
  try {
    let query = supabase.from('catalog_garments').select('*').order('created_at', { ascending: false });
    if (req.user.role !== 'superadmin') query = query.eq('company_id', req.user.company_id);
    const { data: rows, error } = await query;
    if (error) throw error;
    const garments = (rows || []).map(g => ({
      ...g,
      image: getStorageUrl('catalog', g.image_file)
    }));
    res.json({ garments });
  } catch (err) {
    console.error('Admin garments error:', err);
    res.status(500).json({ error: 'Failed to fetch garments' });
  }
});

// Add custom garment (admin — company-scoped or superadmin)
app.post('/api/admin/garments', verifyAdminAccess, (req, res) => {
  uploadCatalog.single('image')(req, res, async (multerErr) => {
    if (multerErr) {
      console.error('Multer error:', multerErr);
      return res.status(400).json({ error: `Error al procesar imagen: ${multerErr.message}` });
    }
    try {
      if (!req.file) return res.status(400).json({ error: 'Imagen requerida (JPG, PNG o WEBP)' });
      const { brand, name, price, category, description, fashn_category, sizes } = req.body;
      if (!brand || !name || !category) {
        return res.status(400).json({ error: 'brand, name y category son requeridos' });
      }
      const validFashnCategories = ['tops', 'bottoms', 'one-pieces', 'accessory'];
      const fashnCat = validFashnCategories.includes(fashn_category) ? fashn_category : 'tops';
      let sizesArr = [];
      try { sizesArr = sizes ? JSON.parse(sizes) : []; } catch { sizesArr = []; }

      const imageFilename = `${uuidv4()}${path.extname(req.file.originalname)}`;
      const imageUrl = await uploadToStorage('catalog', req.file.buffer, imageFilename, req.file.mimetype);

      const id = 'c' + uuidv4().replace(/-/g, '').slice(0, 7);
      const { error } = await supabase.from('catalog_garments').insert({
        id, brand, name,
        price: parseInt(price) || 0,
        category,
        image_file: imageFilename,
        description: description || '',
        fashn_category: fashnCat,
        sizes: sizesArr,
        company_id: req.user.company_id || null,
        created_at: new Date().toISOString()
      });
      if (error) throw error;

      logEvent(supabase, req.user.sub, req.user.company_id, 'garment_added', { garment_id: id, brand, name, category: fashnCat });
      console.log(`✓ Prenda agregada al catálogo: ${brand} ${name} (${id}) [${fashnCat}]`);
      res.json({
        success: true,
        garment: {
          id, brand, name, price: parseInt(price) || 0, category,
          fashn_category: fashnCat, description,
          image: imageUrl
        }
      });
    } catch (err) {
      console.error('Admin garment upload error:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

// Edit garment (admin — company-scoped or superadmin)
app.patch('/api/admin/garments/:id', verifyAdminAccess, async (req, res) => {
  try {
    const { data: row, error: fetchErr } = await supabase
      .from('catalog_garments').select('*').eq('id', req.params.id).single();
    if (fetchErr || !row) return res.status(404).json({ error: 'Prenda no encontrada' });
    if (req.user.role !== 'superadmin' && row.company_id !== req.user.company_id) {
      return res.status(403).json({ error: 'No tienes permiso para editar esta prenda' });
    }
    const allowed = ['brand', 'name', 'price', 'category', 'fashn_category', 'description', 'sizes', 'hidden'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (updates.price !== undefined) updates.price = parseInt(updates.price) || 0;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada que actualizar' });
    const { data, error } = await supabase
      .from('catalog_garments').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ garment: { ...data, image: getStorageUrl('catalog', data.image_file) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete custom garment (admin — company-scoped or superadmin)
app.delete('/api/admin/garments/:id', verifyAdminAccess, async (req, res) => {
  try {
    const { data: row, error: fetchErr } = await supabase
      .from('catalog_garments')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: 'Prenda no encontrada' });

    if (req.user.role !== 'superadmin' && row.company_id !== req.user.company_id) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar esta prenda' });
    }

    await removeFromStorage('catalog', row.image_file);

    const { error } = await supabase.from('catalog_garments').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete garment error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fashn.ai helpers ─────────────────────────────────────────────────────────

function garmentCategoryToFashn(category) {
  if (['tshirt-premium', 'linen-shirt', 'guayabera', 'polo'].includes(category)) return 'tops';
  if (['pants', 'shorts', 'jeans'].includes(category)) return 'bottoms';
  if (['dress', 'jumpsuit'].includes(category)) return 'one-pieces';
  return 'auto';
}

function accessoryPrompt(garmentCategory) {
  if (['hat', 'sombrero', 'cap', 'gorra'].includes(garmentCategory)) {
    return 'Add this hat to the person, placing it naturally on their head';
  }
  if (['necklace', 'collar'].includes(garmentCategory)) {
    return 'Add this necklace to the person, placing it naturally around their neck';
  }
  return 'Add this jewelry piece to the person naturally';
}

async function callFashnAI(modelImageB64, garmentImageB64, fashnCategory, garmentCategory) {
  const FASHN_KEY = process.env.FASHN_API_KEY;
  if (!FASHN_KEY) throw new Error('FASHN_API_KEY not set in .env');

  const isAccessory = fashnCategory === 'accessory';
  const requestBody = isAccessory
    ? {
        model_name: 'edit',
        inputs: {
          image: modelImageB64,
          image_context: garmentImageB64,
          prompt: accessoryPrompt(garmentCategory)
        }
      }
    : {
        model_name: 'tryon-v1.6',
        inputs: {
          model_image: modelImageB64,
          garment_image: garmentImageB64,
          category: fashnCategory
        }
      };

  const runResp = await fetch('https://api.fashn.ai/v1/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${FASHN_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!runResp.ok) {
    const err = await runResp.text();
    throw new Error(`Fashn.ai /run error ${runResp.status}: ${err}`);
  }

  const runData = await runResp.json();
  const predictionId = runData.id;
  if (!predictionId) throw new Error('Fashn.ai did not return a prediction id');

  console.log(`  Fashn.ai job started: ${predictionId}`);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));

    const statusResp = await fetch(`https://api.fashn.ai/v1/status/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${FASHN_KEY}` }
    });

    if (!statusResp.ok) continue;

    const statusData = await statusResp.json();
    console.log(`  Fashn.ai status [${i + 1}]: ${statusData.status}`);

    if (statusData.status === 'completed') {
      const output = statusData.output;
      if (Array.isArray(output) && output.length > 0) return output[0];
      throw new Error('Fashn.ai completed but output is empty');
    }

    if (statusData.status === 'failed') {
      const errDetail = typeof statusData.error === 'object'
        ? JSON.stringify(statusData.error)
        : (statusData.error || 'unknown error');
      throw new Error(`Fashn.ai job failed: ${errDetail}`);
    }
  }

  throw new Error('Fashn.ai timed out after 60 seconds');
}

// Probador virtual (protected)
app.post('/api/tryon', verifyToken, async (req, res) => {
  try {
    const userId = req.user.sub;
    
    // ── Check Daily Limit ──
    const usage = await checkDailyUsage(userId);
    if (!usage.canGenerate) {
      return res.status(429).json({ 
        error: `Has alcanzado tu límite diario de ${usage.limit} generaciones. ¡Invita amigos para ganar más!`,
        usage 
      });
    }

    const { garmentId, colorIndex = 0 } = req.body;

    if (!garmentId) {
      return res.status(400).json({ error: 'garmentId required' });
    }

    let { data: user } = await supabase.from('users').select('*').eq('id', userId).single();

    if (user && !user.avatar_url && req.body.avatarUrl) {
      const match = req.body.avatarUrl.match(/\/uploads\/[^?#]+/);
      if (match && fs.existsSync(path.join(__dirname, match[0]))) {
        await supabase.from('users').update({ avatar_url: match[0] }).eq('id', userId);
        const { data: updated } = await supabase.from('users').select('*').eq('id', userId).single();
        user = updated;
      }
    }

    if (!user || !user.avatar_url) {
      return res.status(400).json({ error: 'No avatar found for this session' });
    }

    const { data: row } = await supabase.from('catalog_garments').select('*').eq('id', garmentId).single();
    const garment = row ? { ...row, image: getStorageUrl('catalog', row.image_file) } : null;
    if (!garment) {
      return res.status(404).json({ error: 'Garment not found' });
    }

    const cacheKey = `${userId}_${garmentId}_${colorIndex}`;
    const { data: cached } = await supabase
      .from('tryon_cache')
      .select('result_url')
      .eq('cache_key', cacheKey)
      .single();
    if (cached) {
      return res.json({ resultUrl: cached.result_url, cached: true, garment });
    }

    const fashnCategory = garment.fashn_category || garmentCategoryToFashn(garment.category);
    const t0 = Date.now();

    const avatarLocalPath = path.join(__dirname, user.avatar_url);
    if (!fs.existsSync(avatarLocalPath)) {
      return res.status(400).json({ error: 'Avatar file not found on disk' });
    }
    const avatarBuffer = fs.readFileSync(avatarLocalPath);
    const ext = path.extname(avatarLocalPath).toLowerCase().replace('.', '');
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const modelImageB64 = `data:${mime};base64,${avatarBuffer.toString('base64')}`;

    console.log(`\n→ Fashn.ai try-on | user=${userId} garment=${garmentId} fashn_category=${fashnCategory} category=${garment.category}`);

    const garmentResp = await fetch(garment.image);
    if (!garmentResp.ok) throw new Error(`No se pudo descargar imagen de prenda: ${garmentResp.status}`);
    const garmentBuffer = Buffer.from(await garmentResp.arrayBuffer());
    const garmentMime = garmentResp.headers.get('content-type') || 'image/jpeg';
    const garmentImageB64 = `data:${garmentMime};base64,${garmentBuffer.toString('base64')}`;

    const resultUrl = await callFashnAI(modelImageB64, garmentImageB64, fashnCategory, garment.category);
    
    // ── Log successful generation ──
    await supabase.from('generations_log').insert({ user_id: userId });

    await supabase.from('tryon_cache').upsert(
      { cache_key: cacheKey, result_url: resultUrl, created_at: new Date().toISOString() },
      { onConflict: 'cache_key' }
    );

    logEvent(supabase, userId, garment.company_id || null, 'tryon_completed', {
      garment_id: garmentId, fashn_category: fashnCategory, processing_ms: Date.now() - t0
    });
    res.json({
      resultUrl,
      garment,
      generatedAt: new Date().toISOString(),
      processingTime: Date.now() - t0
    });
  } catch (err) {
    console.error('Probador error:', err);
    res.status(500).json({ error: err.message || 'Error al procesar' });
  }
});

// Save to wardrobe (protected)
app.post('/api/wardrobe', verifyToken, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { garmentId, resultUrl } = req.body;

    const item = {
      id: uuidv4(), user_id: userId, garment_id: garmentId,
      result_url: resultUrl, saved_at: new Date().toISOString()
    };
    const { error } = await supabase.from('wardrobe').insert(item);
    if (error) throw error;
    logEvent(supabase, userId, null, 'look_saved', { garment_id: garmentId });
    res.json({ success: true, item });
  } catch (err) {
    console.error('Wardrobe save error:', err);
    res.status(500).json({ error: 'Failed to save to wardrobe' });
  }
});

// Get wardrobe (protected, ownership enforced)
app.get('/api/wardrobe/:userId', verifyToken, async (req, res) => {
  if (req.user.sub !== req.params.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { data: items, error } = await supabase
      .from('wardrobe')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('saved_at', { ascending: false });
    if (error) throw error;
    res.json({ wardrobe: items || [] });
  } catch (err) {
    console.error('Wardrobe fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch wardrobe' });
  }
});

// Forgot password — genera token de 6 dígitos, lo guarda con expiración 15 min
app.post('/api/company/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email es requerido' });

    const { data: user } = await supabase
      .from('users').select('id').eq('email', email).maybeSingle();
    // Respuesta genérica para no revelar si el email existe
    if (!user) return res.json({ success: true });

    const token = String(Math.floor(100000 + Math.random() * 900000));
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await supabase.from('reset_tokens').insert({ email, token, expires_at });

    // TODO: enviar token por email. Por ahora se retorna en la respuesta (solo dev)
    console.log(`🔑 Reset token for ${email}: ${token} (expires ${expires_at})`);
    res.json({ success: true, _dev_token: token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password — valida token antes de cambiar contraseña
app.post('/api/company/reset-password', async (req, res) => {
  try {
    const { email, token, new_password } = req.body;
    if (!email || !token || !new_password) {
      return res.status(400).json({ error: 'email, token y new_password son requeridos' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    const { data: record } = await supabase
      .from('reset_tokens')
      .select('id, expires_at, used')
      .eq('email', email)
      .eq('token', token)
      .maybeSingle();

    if (!record) return res.status(400).json({ error: 'Token inválido' });
    if (record.used) return res.status(400).json({ error: 'El token ya fue utilizado' });
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'El token ha expirado. Solicita uno nuevo' });
    }

    const { data: user } = await supabase
      .from('users').select('id').eq('email', email).maybeSingle();
    if (!user) return res.status(404).json({ error: 'No existe una cuenta con ese correo' });

    const password_hash = await bcrypt.hash(new_password, 10);
    const { error } = await supabase
      .from('users').update({ password_hash }).eq('id', user.id);
    if (error) throw error;

    // Marcar token como usado
    await supabase.from('reset_tokens').update({ used: true }).eq('id', record.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get own company info (company token)
app.get('/api/company/me', verifyCompanyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, slug, logo_url, logo_file, description, website, instagram, facebook, tiktok, status')
      .eq('id', req.user.company_id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json({ company: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update own company profile (company token)
app.patch('/api/company/me', verifyCompanyToken, (req, res) => {
  uploadLogo.single('logo')(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ error: `Error al procesar logo: ${multerErr.message}` });
    try {
      const allowed = ['name', 'description', 'website', 'instagram', 'facebook', 'tiktok'];
      const updates = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] || null; });
      if (req.file) {
        const logoFilename = `${uuidv4()}${path.extname(req.file.originalname)}`;
        const logoUrl = await uploadToStorage('logos', req.file.buffer, logoFilename, req.file.mimetype);
        updates.logo_file = logoFilename;
        updates.logo_url  = logoUrl;
      }
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada que actualizar' });
      const { data, error } = await supabase
        .from('companies').update(updates).eq('id', req.user.company_id)
        .select('id, name, slug, logo_url, description, website, instagram, facebook, tiktok, status').single();
      if (error) throw error;
      res.json({ company: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// ─── Super-admin endpoints ────────────────────────────────────────────────────

// Super-admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD no está configurado en .env' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ role: 'superadmin' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// List all companies (superadmin)
app.get('/api/admin/companies', verifySuperadmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, slug, contact_email, status, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ companies: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update company status (superadmin)
app.patch('/api/admin/companies/:id/status', verifySuperadmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'status debe ser: active, suspended o pending' });
    }
    const { data, error } = await supabase
      .from('companies')
      .update({ status })
      .eq('id', req.params.id)
      .select('id, name, status')
      .single();
    if (error) throw error;
    res.json({ company: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get garments by company slug (public)
app.get('/api/companies/:slug/garments', async (req, res) => {
  try {
    const { data: company, error: companyErr } = await supabase
      .from('companies')
      .select('id, name, slug, logo_url, description')
      .eq('slug', req.params.slug)
      .eq('status', 'active')
      .maybeSingle();
    if (companyErr || !company) return res.status(404).json({ error: 'Empresa no encontrada' });

    const { category, limit = 50 } = req.query;
    let query = supabase
      .from('catalog_garments')
      .select('*')
      .eq('company_id', company.id)
      .eq('hidden', false)
      .order('created_at', { ascending: false });
    if (category && category !== 'all') query = query.eq('category', category);

    let { data: rows, error } = await query.limit(parseInt(limit));
    if (error && error.code === '42703') {
      // hidden column not yet migrated — retry without filter
      let q2 = supabase.from('catalog_garments').select('*').eq('company_id', company.id).order('created_at', { ascending: false });
      if (category && category !== 'all') q2 = q2.eq('category', category);
      ({ data: rows, error } = await q2.limit(parseInt(limit)));
    }
    if (error) throw error;

    const garments = (rows || []).map(g => ({
      id: g.id, brand: g.brand, name: g.name, price: g.price,
      category: g.category, description: g.description || '',
      fashn_category: g.fashn_category || 'tops',
      image: getStorageUrl('catalog', g.image_file),
      colors: [], sizes: g.sizes || [], productUrl: '#'
    }));

    res.json({ company, garments, total: garments.length });
  } catch (err) {
    console.error('Company garments error:', err);
    res.status(500).json({ error: 'Failed to fetch company garments' });
  }
});

// ─── Showcase endpoints ───────────────────────────────────────────────────────

// Get all active showcase images (public)
app.get('/api/config/showcase', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('showcase_images')
      .select('slot, url');
    if (error) throw error;
    const result = { main: null, left: null, right: null, face: null };
    (data || []).forEach(r => { result[r.slot] = r.url; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload/replace showcase image for a slot (superadmin)
app.post('/api/admin/showcase/:slot', verifySuperadmin, (req, res) => {
  const validSlots = ['main', 'left', 'right', 'face'];
  if (!validSlots.includes(req.params.slot)) {
    return res.status(400).json({ error: 'Slot inválido. Usa: main, left, right, face' });
  }
  uploadShowcase.single('image')(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ error: multerErr.message });
    if (!req.file)  return res.status(400).json({ error: 'Imagen requerida' });
    try {
      const slot = req.params.slot;
      // Delete old file from storage if exists
      const { data: existing } = await supabase
        .from('showcase_images').select('filename').eq('slot', slot).maybeSingle();
      if (existing?.filename) {
        await removeFromStorage('showcase', existing.filename);
      }
      const filename = `${uuidv4()}${path.extname(req.file.originalname)}`;
      const url = await uploadToStorage('showcase', req.file.buffer, filename, req.file.mimetype);
      const { error: upsertErr } = await supabase.from('showcase_images').upsert(
        { slot, filename, url, created_at: new Date().toISOString() },
        { onConflict: 'slot' }
      );
      if (upsertErr) throw upsertErr;
      res.json({ slot, url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// Delete showcase image for a slot (superadmin)
app.delete('/api/admin/showcase/:slot', verifySuperadmin, async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from('showcase_images').select('filename').eq('slot', req.params.slot).maybeSingle();
    if (existing?.filename) {
      await removeFromStorage('showcase', existing.filename);
    }
    await supabase.from('showcase_images').delete().eq('slot', req.params.slot);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Looks sharing ────────────────────────────────────────────────────────────

// Share a look — guarda en shared_looks y retorna URL pública
app.post('/api/looks/share', verifyToken, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { garmentId, resultUrl } = req.body;
    if (!resultUrl) return res.status(400).json({ error: 'resultUrl es requerido' });

    // Obtener info de la prenda para los meta tags
    let garmentName = null, garmentBrand = null, companyName = null;
    if (garmentId) {
      const { data: g } = await supabase
        .from('catalog_garments')
        .select('name, brand, companies(name)')
        .eq('id', garmentId)
        .maybeSingle();
      if (g) {
        garmentName  = g.name;
        garmentBrand = g.brand;
        companyName  = g.companies?.name || null;
      }
    }

    const { data: look, error } = await supabase
      .from('shared_looks')
      .insert({ user_id: userId, garment_id: garmentId, result_url: resultUrl, garment_name: garmentName, garment_brand: garmentBrand, company_name: companyName })
      .select('id')
      .single();
    if (error) throw error;

    const shareUrl = `${BASE_URL}/look/${look.id}`;
    logEvent(supabase, userId, null, 'look_shared', { look_id: look.id, garment_id: garmentId });
    res.json({ success: true, shareUrl, lookId: look.id });
  } catch (err) {
    console.error('Share look error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Public look page — HTML con OG meta tags para WhatsApp/Instagram
app.get('/look/:id', async (req, res) => {
  try {
    const { data: look, error } = await supabase
      .from('shared_looks')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !look) return res.status(404).send('<h1>Look no encontrado</h1>');

    const title       = look.garment_name
      ? `${look.garment_brand || ''} ${look.garment_name}`.trim()
      : 'Mi look en Balam';
    const description = look.company_name
      ? `Mira este look de ${look.company_name} — pruébatelo con IA en Balam`
      : 'Mira este look generado con IA — pruébatelo tú mismo en Balam';
    const appUrl      = BASE_URL;

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Balam</title>
  <meta property="og:title"       content="${title} — Balam">
  <meta property="og:description" content="${description}">
  <meta property="og:image"       content="${look.result_url}">
  <meta property="og:url"         content="${BASE_URL}/look/${look.id}">
  <meta property="og:type"        content="website">
  <meta name="twitter:card"       content="summary_large_image">
  <meta name="twitter:title"      content="${title} — Balam">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image"      content="${look.result_url}">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#1a1a18;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
    img{max-width:380px;width:100%;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    h1{font-family:Georgia,serif;font-size:28px;font-weight:300;margin:24px 0 8px;text-align:center}
    p{font-size:14px;color:#aaa;text-align:center;margin-bottom:24px}
    a{display:inline-block;background:#c8a96e;color:#1a1a18;padding:14px 32px;border-radius:50px;font-weight:600;text-decoration:none;font-size:15px}
  </style>
</head>
<body>
  <img src="${look.result_url}" alt="${title}">
  <h1>${title}</h1>
  <p>${description}</p>
  <a href="${appUrl}/?start=avatar">Pruébatelo tú mismo →</a>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('<h1>Error al cargar el look</h1>');
  }
});

// ─── Start server ──────────────────────────────────────────────────────────────
// ── Admin Settings Routes ──────────────────────────────────────────────────
app.get('/api/admin/settings', verifyAdminAccess, async (req, res) => {
  try {
    const { data, error } = await supabase.from('app_settings').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings', verifyAdminAccess, async (req, res) => {
  try {
    const { key, value } = req.body;
    const { error } = await supabase.from('app_settings').upsert({ key, value });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Balam Backend running at ${BASE_URL}`);
  console.log(`   DB: Supabase (${SUPABASE_URL})`);
  console.log(`   API Health: ${BASE_URL}/api/health`);
  console.log(`   Garments:   ${BASE_URL}/api/garments\n`);
});
