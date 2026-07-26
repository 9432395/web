// ============================================================================
//  Servidor de licencias — alquiler mensual de indicadores NinjaTrader 8
//
//  - Activacion y renovacion por machine ID con "leases" firmados RSA-SHA256
//    que el indicador verifica offline (dias de gracia incluidos).
//  - Endpoints de administracion protegidos por token (crear, extender,
//    desactivar, resetear maquina, listar).
//  - Webhook de Stripe: el pago activa/extiende la licencia solo; la
//    cancelacion o impago la corta solo.
//
//  Variables de entorno (ver README):
//    PORT               puerto (por defecto 8787)
//    ADMIN_TOKEN        token secreto para los endpoints /admin
//    PRIVATE_KEY_PATH   ruta a keys/private.pem (por defecto ./keys/private.pem)
//    DB_PATH            ruta a la base de datos (por defecto ./data/licenses.db)
//    LEASE_DAYS         validez de cada lease en dias (por defecto 7)
//    GRACE_DAYS         gracia tras vencer el pago, en dias (por defecto 3)
//    STRIPE_SECRET_KEY      sk_live_... (solo si usas Stripe)
//    STRIPE_WEBHOOK_SECRET  whsec_...   (solo si usas Stripe)
//    PRICE_PRODUCT_MAP  JSON precio->productos, p. ej.
//                       {"price_ABC":"SUITE_FULL","price_DEF":"AVP,DAILY_VWAP"}
// ============================================================================
'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Base de datos SQLite INTEGRADA en Node (>= 22.5): sin modulos nativos que
// compilar, sin Python ni build tools — despliega igual en cualquier maquina.
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '8787', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LEASE_DAYS = parseInt(process.env.LEASE_DAYS || '7', 10);
const GRACE_DAYS = parseInt(process.env.GRACE_DAYS || '3', 10);
const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || path.join(__dirname, 'keys', 'private.pem');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'licenses.db');

if (!ADMIN_TOKEN) { console.error('FALTA la variable de entorno ADMIN_TOKEN.'); process.exit(1); }
// La clave privada puede venir pegada en la variable PRIVATE_KEY_PEM (ideal
// en hostings tipo Railway) o como archivo en PRIVATE_KEY_PATH.
let PRIVATE_KEY;
if (process.env.PRIVATE_KEY_PEM && process.env.PRIVATE_KEY_PEM.indexOf('PRIVATE KEY') >= 0) {
	PRIVATE_KEY = process.env.PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
} else if (fs.existsSync(PRIVATE_KEY_PATH)) {
	PRIVATE_KEY = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
} else {
	console.error('Falta la clave privada: define PRIVATE_KEY_PEM o coloca ' + PRIVATE_KEY_PATH + ' (ejecuta node genkeys.js).');
	process.exit(1);
}

// ---------------------------- base de datos ----------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  key             TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  products        TEXT NOT NULL,          -- CSV de productos, o * para todo
  status          TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  machine_id      TEXT,
  paid_until      INTEGER NOT NULL,       -- unix seconds
  stripe_customer TEXT,
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  key TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_lic_email ON licenses(email);
CREATE INDEX IF NOT EXISTS idx_lic_customer ON licenses(stripe_customer);
CREATE TABLE IF NOT EXISTS trial_machines (
  machine_id TEXT PRIMARY KEY,   -- un trial POR MAQUINA, para siempre
  key        TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
`);
// migracion suave: columna is_trial en bases creadas antes de esta version
try { db.exec('ALTER TABLE licenses ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0'); } catch (e) { }
try { db.exec('ALTER TABLE licenses ADD COLUMN welcome_sent INTEGER NOT NULL DEFAULT 0'); } catch (e) { }

// ---------------------------- email de bienvenida ----------------------------
// Enviado desde el buzon de la marca (Private Email) cuando Stripe crea la
// licencia: la clave llega por pantalla (thanks.html) Y por correo. Si las
// variables SMTP no estan configuradas, el envio se omite en silencio.
let mailer = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
	const nodemailer = require('nodemailer');
	mailer = nodemailer.createTransport({
		host: process.env.SMTP_HOST || 'smtp.privateemail.com',
		port: parseInt(process.env.SMTP_PORT || '465', 10),
		secure: (process.env.SMTP_PORT || '465') === '465',
		auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
	});
}

function welcomeHtml(key) {
	const orange = '#FFA500', blue = '#5E9FD8', bg = '#05070B', panel = '#0C111A', text = '#EBF0F7', muted = '#7E8A9C';
	return '<div style="background:' + bg + ';padding:32px 16px;font-family:Arial,Helvetica,sans-serif">'
	+ '<div style="max-width:560px;margin:0 auto;background:' + panel + ';border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:36px 32px;color:' + text + '">'
	+ '<div style="font-size:22px;font-weight:bold;letter-spacing:6px;margin-bottom:24px"><span style="color:' + blue + '">M</span>ATE</div>'
	+ '<h1 style="font-size:20px;margin:0 0 8px">Welcome to MATE — your license is ready</h1>'
	+ '<p style="color:' + muted + ';font-size:14px;margin:0 0 24px">Bienvenido a MATE — tu licencia está lista.</p>'
	+ '<div style="border:1px dashed ' + orange + ';border-radius:10px;padding:18px;text-align:center;margin-bottom:8px">'
	+ '<div style="font-size:11px;letter-spacing:3px;color:' + muted + '">YOUR LICENSE KEY · TU CLAVE</div>'
	+ '<div style="font-size:24px;font-weight:bold;color:' + orange + ';letter-spacing:2px;margin-top:8px;font-family:Consolas,monospace">' + key + '</div></div>'
	+ '<p style="color:' + muted + ';font-size:12px;margin:0 0 24px;text-align:center">One computer per license · Una licencia por ordenador</p>'
	+ '<a href="https://matetrading.com/downloads/MateSuite.zip" style="display:block;background:#4682B4;color:#fff;text-decoration:none;border-radius:10px;padding:14px;text-align:center;font-weight:bold;margin-bottom:28px">Download MATE Suite · Descargar</a>'
	+ '<div style="font-size:14px;line-height:1.7;color:' + text + '">'
	+ '<b>Activate in 3 steps · Activa en 3 pasos</b><br>'
	+ '1&nbsp;·&nbsp;NinjaTrader 8: <b>Tools &rarr; Import &rarr; NinjaScript Add-On…</b> (select the ZIP · selecciona el ZIP)<br>'
	+ '2&nbsp;·&nbsp;Add a MATE indicator to a chart &rarr; settings &rarr; <b>License</b> &rarr; paste your key · pega tu clave<br>'
	+ '3&nbsp;·&nbsp;Done — it unlocks all 20 indicators · desbloquea los 20 indicadores</div>'
	+ '<p style="color:' + muted + ';font-size:12px;margin:28px 0 0">Questions · Dudas: <a href="mailto:support@matetrading.com" style="color:' + blue + '">support@matetrading.com</a><br>MATE · Order Flow Tools · matetrading.com</p>'
	+ '</div></div>';
}

function sendWelcomeEmail(key, email) {
	if (!email || email.indexOf('@') < 1 || email === 'pending@stripe') return;
	const subject = 'Welcome to MATE — Your license key · Tu clave de licencia';
	const fromAddr = process.env.MAIL_FROM || 'MATE Trading <support@matetrading.com>';

	// Via preferida: API HTTP de Resend (los hostings no pueden bloquearla,
	// viaja como trafico web normal). Requiere RESEND_API_KEY y el dominio
	// verificado en resend.com.
	if (process.env.RESEND_API_KEY) {
		fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ from: fromAddr, to: [email], subject: subject, html: welcomeHtml(key) })
		}).then(async r => {
			if (r.ok) {
				db.prepare('UPDATE licenses SET welcome_sent = 1 WHERE key = ?').run(key);
				logEvent('welcome_email_sent', key, email);
			} else {
				const t = await r.text();
				logEvent('welcome_email_error', key, ('resend ' + r.status + ' ' + t).slice(0, 200));
			}
		}).catch(err => {
			logEvent('welcome_email_error', key, ('resend ' + String(err && err.message)).slice(0, 200));
		});
		return;
	}

	// Respaldo: SMTP clasico (solo funciona si el hosting no lo bloquea)
	if (!mailer) return;
	mailer.sendMail({
		from: '"MATE Trading" <' + process.env.SMTP_USER + '>',
		to: email,
		subject: subject,
		html: welcomeHtml(key)
	}).then(() => {
		db.prepare('UPDATE licenses SET welcome_sent = 1 WHERE key = ?').run(key);
		logEvent('welcome_email_sent', key, email);
	}).catch(err => {
		logEvent('welcome_email_error', key, String(err && err.message).slice(0, 200));
	});
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

function logEvent(type, key, detail) {
	db.prepare('INSERT INTO events (ts, type, key, detail) VALUES (?, ?, ?, ?)')
		.run(now(), type, key || null, detail ? String(detail).slice(0, 500) : null);
}

function newKey() {
	// XXXX-XXXX-XXXX-XXXX sin caracteres ambiguos (0/O, 1/I)
	const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const b = crypto.randomBytes(16);
	let s = '';
	for (let i = 0; i < 16; i++) {
		s += A[b[i] % A.length];
		if (i % 4 === 3 && i < 15) s += '-';
	}
	return s;
}

// Lease firmado que el indicador verifica offline:
//   payload = "key|machineId|products|leaseExp"  (texto plano, UTF-8)
//   token   = base64(payload) + "." + base64(firma RSA-SHA256 del payload)
function signLease(lic) {
	const leaseExp = Math.min(now() + LEASE_DAYS * DAY, lic.paid_until + GRACE_DAYS * DAY);
	const payload = [lic.key, lic.machine_id, lic.products, String(leaseExp)].join('|');
	const sig = crypto.createSign('RSA-SHA256').update(payload, 'utf8').sign(PRIVATE_KEY);
	return {
		lease: Buffer.from(payload, 'utf8').toString('base64') + '.' + sig.toString('base64'),
		leaseExp: leaseExp,
		paidUntil: lic.paid_until
	};
}

// ---------------------------- app ----------------------------
const app = express();
app.set('trust proxy', true);

// El webhook de Stripe necesita el cuerpo CRUDO para verificar la firma;
// se monta ANTES del json() global.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
	stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
	const priceMap = JSON.parse(process.env.PRICE_PRODUCT_MAP || '{}');

	app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
		let ev;
		try {
			ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
		} catch (e) {
			logEvent('stripe_bad_sig', null, e.message);
			return res.status(400).send('bad signature');
		}
		try {
			handleStripeEvent(ev, priceMap);
			res.json({ received: true });
		} catch (e) {
			logEvent('stripe_error', null, ev.type + ': ' + e.message);
			res.status(500).send('error');
		}
	});
}

function productsForPrices(priceIds, priceMap) {
	const set = new Set();
	for (const p of priceIds) {
		const mapped = priceMap[p];
		if (mapped) mapped.split(',').forEach(x => set.add(x.trim()));
	}
	return Array.from(set).join(',');
}

function handleStripeEvent(ev, priceMap) {
	const obj = ev.data.object;

	if (ev.type === 'checkout.session.completed') {
		// Primer pago de la suscripcion: crear (o reutilizar) la licencia.
		const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || '';
		const customer = obj.customer || '';
		if (!email) { logEvent('stripe_no_email', null, obj.id); return; }
		const existing = db.prepare('SELECT * FROM licenses WHERE stripe_customer = ?').get(customer);
		if (existing) return;   // renovaciones llegan por invoice.paid
		// paid_until inicial corto y seguro: el invoice.paid que acompaña a la
		// compra (o al trial) fija inmediatamente el periodo REAL pagado.
		const lic = {
			key: newKey(),
			email: email.toLowerCase(),
			products: '*',   // se ajusta en invoice.paid con los precios reales
			paid_until: now() + 8 * DAY,
			stripe_customer: customer
		};
		db.prepare('INSERT INTO licenses (key, email, products, status, paid_until, stripe_customer, created_at) VALUES (?, ?, ?, \'active\', ?, ?, ?)')
			.run(lic.key, lic.email, lic.products, lic.paid_until, lic.stripe_customer, now());
		logEvent('license_created_stripe', lic.key, email);
		sendWelcomeEmail(lic.key, lic.email);
	}
	else if (ev.type === 'invoice.paid') {
		// Cada cobro (mensual, trimestral, anual o trial de 0): fija el periodo
		// REAL pagado que declara Stripe y los productos del precio comprado.
		const customer = obj.customer || '';
		let lic = db.prepare('SELECT * FROM licenses WHERE stripe_customer = ?').get(customer);
		if (!lic) {
			// blindaje de orden: si este aviso llega ANTES que el del checkout,
			// la licencia se crea aqui mismo (idempotente con el otro camino)
			const email = (obj.customer_email || '').toLowerCase();
			lic = { key: newKey(), email: email || 'pending@stripe', products: '*' };
			db.prepare('INSERT INTO licenses (key, email, products, status, paid_until, stripe_customer, created_at) VALUES (?, ?, ?, \'active\', ?, ?, ?)')
				.run(lic.key, lic.email, lic.products, now() + 8 * DAY, customer, now());
			logEvent('license_created_stripe_invoice', lic.key, email);
			sendWelcomeEmail(lic.key, lic.email);
		}
		let end = 0;
		const prices = [];
		const lines = (obj.lines && obj.lines.data) || [];
		for (const ln of lines) {
			if (ln.period && ln.period.end > end) end = ln.period.end;
			if (ln.price && ln.price.id) prices.push(ln.price.id);
		}
		const products = productsForPrices(prices, priceMap) || lic.products;
		// el periodo de Stripe MANDA (7 dias de trial son 7 dias; un pack anual
		// es un año); respaldo de 31 dias solo si no llego periodo alguno
		const paidUntil = end > now() ? end : now() + 31 * DAY;
		// factura de 0 = trial (marca la licencia); un cobro REAL la desmarca
		const isTrial = (obj.amount_paid || 0) === 0 ? 1 : 0;
		db.prepare('UPDATE licenses SET paid_until = ?, products = ?, status = \'active\', is_trial = ? WHERE key = ?')
			.run(paidUntil, products, isTrial, lic.key);
		logEvent(isTrial ? 'trial_started_stripe' : 'license_extended_stripe',
			lic.key, 'until ' + new Date(paidUntil * 1000).toISOString());
	}
	else if (ev.type === 'customer.subscription.deleted') {
		// Cancelacion definitiva: la licencia muere cuando venza lo ya pagado.
		const customer = obj.customer || '';
		const lic = db.prepare('SELECT * FROM licenses WHERE stripe_customer = ?').get(customer);
		if (lic) logEvent('subscription_cancelled', lic.key, customer);
		// No se corta antes de tiempo: el cliente disfruta lo que pago.
	}
	else if (ev.type === 'invoice.payment_failed') {
		const customer = obj.customer || '';
		const lic = db.prepare('SELECT * FROM licenses WHERE stripe_customer = ?').get(customer);
		if (lic) logEvent('payment_failed', lic.key, customer);
		// Sin accion: al no llegar invoice.paid, paid_until vence solo.
	}
}

app.use(express.json({ limit: '64kb' }));

// ---------------------------- API del indicador ----------------------------
// Activa (primer uso: vincula la maquina) o renueva el lease. Idempotente.
app.post('/api/v1/activate', (req, res) => {
	const key = String(req.body.key || '').trim().toUpperCase();
	const machineId = String(req.body.machineId || '').trim();
	if (!key || !machineId || machineId.length > 128)
		return res.json({ ok: false, code: 'bad_request', message: 'Missing license key or machine id.' });

	const lic = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
	if (!lic)
		return res.json({ ok: false, code: 'not_found', message: 'License key not found.' });
	if (lic.status !== 'active')
		return res.json({ ok: false, code: 'disabled', message: 'License disabled. Contact support.' });
	if (now() > lic.paid_until + GRACE_DAYS * DAY)
		return res.json({ ok: false, code: 'expired', message: 'Subscription expired. Renew to continue.' });

	// candado anti-abuso de trials: UNA prueba gratis por maquina, para siempre.
	// Da igual cuantos emails o tarjetas nuevas use: el mismo ordenador no
	// consume un segundo trial.
	if (lic.is_trial) {
		const t = db.prepare('SELECT key FROM trial_machines WHERE machine_id = ?').get(machineId);
		if (t && t.key !== key) {
			logEvent('trial_repeat_blocked', key, machineId);
			return res.json({ ok: false, code: 'trial_used', message: 'The free trial was already used on this machine. Subscribe to continue.' });
		}
		if (!t)
			db.prepare('INSERT INTO trial_machines (machine_id, key, ts) VALUES (?, ?, ?)').run(machineId, key, now());
	}

	if (!lic.machine_id) {
		db.prepare('UPDATE licenses SET machine_id = ? WHERE key = ?').run(machineId, key);
		lic.machine_id = machineId;
		logEvent('machine_bound', key, machineId);
	} else if (lic.machine_id !== machineId) {
		logEvent('machine_mismatch', key, machineId);
		return res.json({ ok: false, code: 'machine_mismatch', message: 'License is active on another machine. Contact support to move it.' });
	}

	db.prepare('UPDATE licenses SET last_seen = ? WHERE key = ?').run(now(), key);
	const lease = signLease(lic);
	res.json({ ok: true, products: lic.products, lease: lease.lease, leaseExp: lease.leaseExp, paidUntil: lease.paidUntil });
});

// Pagina de exito de Stripe: muestra la clave al cliente tras el checkout.
// CORS abierto SOLO en este endpoint de lectura (lo llama matetrading.com).
app.get('/api/v1/checkout-key', (req, res) => {
	res.set('Access-Control-Allow-Origin', '*');
	if (!stripe) return res.status(404).json({ ok: false });
	const sessionId = String(req.query.session_id || '');
	if (!sessionId) return res.json({ ok: false });
	stripe.checkout.sessions.retrieve(sessionId).then(s => {
		const lic = db.prepare('SELECT key, email, paid_until FROM licenses WHERE stripe_customer = ?').get(s.customer || '');
		if (!lic) return res.json({ ok: false, pending: true });
		res.json({ ok: true, key: lic.key, email: lic.email });
	}).catch(() => res.json({ ok: false }));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Panel de administracion (pagina estatica; todos sus datos exigen el token)
app.get('/panel', (req, res) => {
	const p = path.join(__dirname, 'panel.html');
	if (fs.existsSync(p)) res.sendFile(p);
	else res.status(404).send('panel.html no esta desplegado');
});

// ---------------------------- administracion ----------------------------
function admin(req, res, next) {
	if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({ ok: false });
	next();
}

// Crear licencia manual: { email, products: "AVP,DAILY_VWAP" | "*", months: 1 }
app.post('/admin/licenses', admin, (req, res) => {
	const email = String(req.body.email || '').trim().toLowerCase();
	const products = String(req.body.products || '*').trim();
	const months = Math.max(1, parseInt(req.body.months || '1', 10));
	if (!email) return res.status(400).json({ ok: false, message: 'email required' });
	const key = newKey();
	const paidUntil = now() + months * 31 * DAY;
	db.prepare('INSERT INTO licenses (key, email, products, status, paid_until, created_at) VALUES (?, ?, ?, \'active\', ?, ?)')
		.run(key, email, products, paidUntil, now());
	logEvent('license_created_admin', key, email);
	res.json({ ok: true, key: key, email: email, products: products, paidUntil: paidUntil });
});

app.get('/admin/licenses', admin, (req, res) => {
	const rows = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500').all();
	res.json({ ok: true, licenses: rows, now: now() });
});

app.post('/admin/licenses/:key/extend', admin, (req, res) => {
	const months = Math.max(1, parseInt(req.body.months || '1', 10));
	const lic = db.prepare('SELECT * FROM licenses WHERE key = ?').get(req.params.key);
	if (!lic) return res.status(404).json({ ok: false });
	const base = Math.max(lic.paid_until, now());
	const paidUntil = base + months * 31 * DAY;
	db.prepare('UPDATE licenses SET paid_until = ?, status = \'active\' WHERE key = ?').run(paidUntil, lic.key);
	logEvent('license_extended_admin', lic.key, months + 'm');
	res.json({ ok: true, paidUntil: paidUntil });
});

app.post('/admin/licenses/:key/deactivate', admin, (req, res) => {
	const r = db.prepare('UPDATE licenses SET status = \'disabled\' WHERE key = ?').run(req.params.key);
	logEvent('license_disabled', req.params.key, null);
	res.json({ ok: r.changes > 0 });
});

// El cliente cambio de ordenador: liberar la maquina para que reactive.
app.post('/admin/licenses/:key/reset-machine', admin, (req, res) => {
	const r = db.prepare('UPDATE licenses SET machine_id = NULL WHERE key = ?').run(req.params.key);
	logEvent('machine_reset', req.params.key, null);
	res.json({ ok: r.changes > 0 });
});

app.get('/admin/events', admin, (req, res) => {
	const rows = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all();
	res.json({ ok: true, events: rows });
});

app.listen(PORT, () => console.log('License server on :' + PORT));
