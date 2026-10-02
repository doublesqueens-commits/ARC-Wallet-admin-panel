const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  });
}
const port = Number(process.env.PORT || 5000);
const root = __dirname;
const database = new DatabaseSync(process.env.DATABASE_PATH || path.join(root, 'orbit.db'));
const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const configuredGoogleClientId = process.env.GOOGLE_CLIENT_ID || '';
const googleClientId = configuredGoogleClientId.startsWith('YOUR_') ? '' : configuredGoogleClientId;
const xClientId = process.env.X_CLIENT_ID || '';
const xClientSecret = process.env.X_CLIENT_SECRET || '';
const vkClientId = process.env.VK_CLIENT_ID || '';
const vkClientSecret = process.env.VK_CLIENT_SECRET || '';
const oauthRedirectBase = process.env.OAUTH_REDIRECT_BASE || `http://localhost:${port}`;
const resendApiKey = process.env.RESEND_API_KEY || '';
const mailFrom = process.env.MAIL_FROM || 'ARC Wallet <onboarding@resend.dev>';
const allowDevOtp = process.env.ALLOW_DEV_OTP === 'true' && process.env.NODE_ENV !== 'production';
const otpMaxAttempts = 5;
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminUsername = 'arcwallet@admin';
const oauthStates = new Map();

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};
const verifyPassword = (password, stored) => {
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
};
const base64url = (value) => Buffer.from(value).toString('base64url');
const signJwt = (payload) => {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 }));
  const signature = crypto.createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
};
const verifyJwt = (token) => {
  const [header, body, signature] = String(token || '').split('.');
  if (!header || !body || !signature) throw new Error('Invalid session token.');
  const expected = crypto.createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Invalid session token.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Session expired.');
  return payload;
};

const seedDatabase = () => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT, role TEXT NOT NULL DEFAULT 'User', status TEXT NOT NULL DEFAULT 'Active', joined TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_name TEXT NOT NULL, pair TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL, date TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS otp_challenges (id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL DEFAULT 'login', name TEXT, password_hash TEXT);
    CREATE TABLE IF NOT EXISTS custody_deposit_addresses (user_id TEXT NOT NULL, asset TEXT NOT NULL, network TEXT NOT NULL, provider_url TEXT NOT NULL, address TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, asset, network, provider_url), UNIQUE (provider_url, asset, network, address));
    CREATE TABLE IF NOT EXISTS financial_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')), asset TEXT NOT NULL, network TEXT NOT NULL, amount_atoms TEXT NOT NULL, tx_hash TEXT, recipient TEXT, status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')), created_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT, review_note TEXT, payout_status TEXT, payout_reference TEXT, payout_error TEXT, payout_updated_at TEXT, payout_attempt_id TEXT);
    CREATE TABLE IF NOT EXISTS internal_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, asset TEXT NOT NULL, delta_atoms TEXT NOT NULL, entry_type TEXT NOT NULL, request_id TEXT, admin_id TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_user_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, admin_id TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  for (const statement of ['ALTER TABLE otp_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT \'login\'', 'ALTER TABLE otp_challenges ADD COLUMN name TEXT', 'ALTER TABLE otp_challenges ADD COLUMN password_hash TEXT']) { try { database.exec(statement); } catch {} }
  try { database.exec('ALTER TABLE users ADD COLUMN username TEXT'); } catch {}
  try { database.exec('ALTER TABLE users ADD COLUMN deleted_from_status TEXT'); } catch {}
  for (const statement of [
    'ALTER TABLE financial_requests ADD COLUMN payout_status TEXT',
    'ALTER TABLE financial_requests ADD COLUMN payout_reference TEXT',
    'ALTER TABLE financial_requests ADD COLUMN payout_error TEXT',
    'ALTER TABLE financial_requests ADD COLUMN payout_updated_at TEXT',
    'ALTER TABLE financial_requests ADD COLUMN payout_attempt_id TEXT',
  ]) { try { database.exec(statement); } catch {} }
  database.exec("UPDATE financial_requests SET payout_status = 'Awaiting payout' WHERE type = 'withdrawal' AND status = 'Approved' AND payout_status IS NULL");
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL');
  database.exec(`
    DROP INDEX IF EXISTS financial_deposit_hash_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS financial_deposit_asset_hash_unique ON financial_requests(asset, network, lower(tx_hash)) WHERE type = 'deposit';
    CREATE UNIQUE INDEX IF NOT EXISTS internal_ledger_request_unique ON internal_ledger(request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS financial_requests_user_date ON financial_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS internal_ledger_user_asset ON internal_ledger(user_id, asset);
  `);
  if (process.env.NODE_ENV !== 'test') {
    const userCount = database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    if (userCount === 0) {
      const insertUser = database.prepare('INSERT INTO users (id, name, email, password_hash, role, status, joined) VALUES (?, ?, ?, ?, ?, ?, ?)');
      insertUser.run('demo-user', 'Vitaliy', 'test@example.com', hashPassword('test123'), 'User', 'Active', '2026-09-01');
      insertUser.run('user-002', 'Maya Chen', 'maya@example.com', hashPassword('test123'), 'User', 'Active', '2026-08-28');
      insertUser.run('user-003', 'Noah Williams', 'noah@example.com', hashPassword('test123'), 'User', 'Suspended', '2026-08-19');
      insertUser.run('admin-user', 'ARC Admin', 'admin@orbit.local', hashPassword('admin123'), 'Admin', 'Active', '2026-09-01');
    }
    const transactionCount = database.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
    if (transactionCount === 0) {
      const insertTransaction = database.prepare('INSERT INTO transactions (id, user_name, pair, amount, status, date) VALUES (?, ?, ?, ?, ?, ?)');
      insertTransaction.run('TX-1048', 'Vitaliy', 'BNB - BTC', '0.0824 BTC', 'Pending', '2026-09-06');
      insertTransaction.run('TX-1047', 'Maya Chen', 'ETH - USDC', '0.006241 USDC', 'Success', '2026-09-05');
      insertTransaction.run('TX-1046', 'Noah Williams', 'BNB - BTC', '0.0824 BTC', 'Rejected', '2026-09-04');
    }
    const settingCount = database.prepare('SELECT COUNT(*) AS count FROM settings').get().count;
    if (settingCount === 0) {
      const insertSetting = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      insertSetting.run('maintenance', 'false');
      insertSetting.run('defaultNetwork', 'BNB Chain');
      insertSetting.run('supportEmail', 'support@orbit.local');
    }
  }
};
seedDatabase();
if (adminPassword) {
  database.prepare('UPDATE users SET password_hash = ? WHERE role = ?').run(hashPassword(adminPassword), 'Admin');
}
database.prepare('UPDATE users SET name = ? WHERE id = ?').run('ARC Admin', 'admin-user');
if (adminEmail) {
  database.prepare('UPDATE users SET username = NULL WHERE username = ? AND lower(email) != ?').run(adminUsername, adminEmail);
  database.prepare('UPDATE users SET username = ? WHERE lower(email) = ? AND role = ?').run(adminUsername, adminEmail, 'Admin');
}

const getSettings = () => Object.fromEntries(database.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, key === 'maintenance' ? value === 'true' : value]));
const validateSettingsPayload = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Settings payload must be a JSON object.';
  const requiredKeys = ['maintenance', 'defaultNetwork', 'supportEmail'];
  const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(body, key));
  if (missingKeys.length) return `Missing required settings: ${missingKeys.join(', ')}.`;
  const unexpectedKeys = Object.keys(body).filter((key) => !requiredKeys.includes(key));
  if (unexpectedKeys.length) return `Unexpected settings: ${unexpectedKeys.join(', ')}.`;
  if (typeof body.maintenance !== 'boolean') return 'Maintenance must be a boolean.';
  if (typeof body.defaultNetwork !== 'string' || !body.defaultNetwork.trim() || body.defaultNetwork.trim().length > 100) return 'Default network must be a non-empty string of at most 100 characters.';
  const supportEmail = typeof body.supportEmail === 'string' ? body.supportEmail.trim() : '';
  if (supportEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) return 'Support email must be a valid email address.';
  return null;
};
const saveSettings = (values) => {
  const statement = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  database.exec('BEGIN IMMEDIATE');
  try {
    Object.entries(values).forEach(([key, value]) => statement.run(key, String(value)));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};
const getTransactions = () => database.prepare('SELECT id, user_name AS user, pair, amount, status, date FROM transactions ORDER BY date DESC').all();
const ledgerPrecision = 18n;
const maxLedgerAtoms = 10n ** 33n;
const formatAtoms = (value) => {
  const atoms = BigInt(value);
  const negative = atoms < 0n;
  const absolute = negative ? -atoms : atoms;
  const whole = absolute / (10n ** ledgerPrecision);
  const fraction = (absolute % (10n ** ledgerPrecision)).toString().padStart(Number(ledgerPrecision), '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};
const parseAmountAtoms = (value) => {
  const amount = String(value ?? '').trim();
  if (amount.length > 35 || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount)) throw new HttpError(400, 'Enter a positive amount with at most 18 decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const atoms = BigInt(whole) * (10n ** ledgerPrecision) + BigInt(fraction.padEnd(Number(ledgerPrecision), '0'));
  if (atoms <= 0n || atoms > maxLedgerAtoms) throw new HttpError(400, 'Amount must be greater than zero and no more than 1,000,000,000,000,000.');
  return atoms;
};
const getLedgerBalanceAtoms = (userId, asset) => database.prepare('SELECT delta_atoms FROM internal_ledger WHERE user_id = ? AND asset = ?').all(userId, asset).reduce((total, entry) => total + BigInt(entry.delta_atoms), 0n);
const getPendingWithdrawalsAtoms = (userId, asset, exceptRequestId = null) => database.prepare("SELECT id, amount_atoms FROM financial_requests WHERE user_id = ? AND asset = ? AND type = 'withdrawal' AND status = 'Pending'").all(userId, asset).reduce((total, request) => request.id === exceptRequestId ? total : total + BigInt(request.amount_atoms), 0n);
const getInternalBalances = (userId) => {
  const balances = {};
  for (const entry of database.prepare('SELECT asset, delta_atoms FROM internal_ledger WHERE user_id = ?').all(userId)) {
    balances[entry.asset] = (BigInt(balances[entry.asset] || '0') + BigInt(entry.delta_atoms)).toString();
  }
  return Object.fromEntries(Object.entries(balances).map(([asset, atoms]) => [asset, formatAtoms(atoms)]).filter(([, amount]) => amount !== '0'));
};
const getUsers = () => database.prepare('SELECT id, name, email, role, status, joined FROM users ORDER BY joined DESC').all().map((user) => ({ ...user, internalBalances: getInternalBalances(user.id) }));
const getUserRequests = (userId) => database.prepare('SELECT id, type, asset, network, amount_atoms, tx_hash AS txHash, recipient, status, payout_status AS payoutStatus, payout_reference AS payoutReference, payout_error AS payoutError, created_at AS createdAt, reviewed_at AS reviewedAt, review_note AS reviewNote FROM financial_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 25').all(userId).map((request) => ({ ...request, amount: formatAtoms(request.amount_atoms) }));
const getAdminRequests = () => database.prepare(`SELECT r.id, r.user_id AS userId, COALESCE(u.name, 'Former user') AS user, COALESCE(u.email, '') AS email, r.type, r.asset, r.network, r.amount_atoms, r.tx_hash AS txHash, r.recipient, r.status, r.payout_status AS payoutStatus, r.payout_reference AS payoutReference, r.payout_error AS payoutError, r.payout_updated_at AS payoutUpdatedAt, r.created_at AS createdAt, r.reviewed_at AS reviewedAt, r.review_note AS reviewNote FROM financial_requests r LEFT JOIN users u ON u.id = r.user_id ORDER BY CASE r.status WHEN 'Pending' THEN 0 ELSE 1 END, r.created_at DESC`).all().map((request) => ({ ...request, amount: formatAtoms(request.amount_atoms) }));
const recordLedgerEntry = ({ userId, asset, deltaAtoms, entryType, requestId = null, adminId, note }) => database.prepare('INSERT INTO internal_ledger (id, user_id, asset, delta_atoms, entry_type, request_id, admin_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), userId, asset, String(deltaAtoms), entryType, requestId, adminId, note, new Date().toISOString());
const recordUserAudit = (userId, adminId, action, note = '') => database.prepare('INSERT INTO admin_user_audit (id, user_id, admin_id, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), userId, adminId, action, note, new Date().toISOString());

const market = { BTC: 68420.18, ETH: 3528.44, BNB: 612.77, USDC: 1, USDT: 1, XRP: 0.52, SOL: 148.25, ADA: 0.34, DOGE: 0.17, DOT: 4.12 };
const depositNetworks = { BTC: ['Bitcoin'], ETH: ['Ethereum Mainnet', 'Arbitrum', 'Polygon'], BNB: ['BEP 20'], USDC: ['ERC 20', 'Arbitrum', 'Polygon'], USDT: ['ERC 20', 'BEP 20'], XRP: ['XRP Ledger'], SOL: ['Solana'], ADA: ['Cardano'], DOGE: ['Dogecoin'], DOT: ['Polkadot'] };
const sharedDepositAddresses = {
  ETH: { 'Ethereum Mainnet': '0x45fa3421948a8a0372e0a172ab9a3725f785a1d2' },
  BTC: { Bitcoin: '17v1CRcS2JbZhYy24g7mJRth8uz1Um4QFq' },
};
const sharedDepositPairs = Object.entries(sharedDepositAddresses).flatMap(([asset, networks]) =>
  Object.keys(networks).map((network) => ({ asset, network })),
);
const custodyPaths = {
  health: process.env.CUSTODY_API_HEALTH_PATH || '/health',
  capabilities: process.env.CUSTODY_API_CAPABILITIES_PATH || '/v1/capabilities',
  address: process.env.CUSTODY_API_ADDRESS_PATH || '/v1/deposit-addresses',
  balance: process.env.CUSTODY_API_BALANCE_PATH || '/v1/balances',
  payout: process.env.CUSTODY_API_PAYOUT_PATH || '/v1/payouts',
};
const inFlightDepositAddresses = new Map();
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const getCustodyConfig = () => {
  const baseUrl = String(process.env.CUSTODY_API_BASE_URL || '').trim();
  const token = String(process.env.CUSTODY_API_TOKEN || '').trim();
  if (!baseUrl || !token) return null;
  try {
    const base = new URL(baseUrl);
    const localTestApi = process.env.NODE_ENV === 'test' && ['localhost', '127.0.0.1'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !localTestApi) || base.username || base.password || base.search || base.hash) return null;
    const paths = Object.values(custodyPaths);
    if (paths.some((value) => !value.startsWith('/') || value.startsWith('//') || value.includes('..') || value.includes('?') || value.includes('#'))) return null;
    return { baseUrl: base.origin, token };
  } catch {
    return null;
  }
};
const supportedDepositPair = (asset, network) => {
  const normalizedAsset = String(asset || '').trim().toUpperCase();
  const normalizedNetwork = String(network || '').trim();
  if (!market[normalizedAsset]) throw new HttpError(400, 'Unsupported asset.');
  if (!depositNetworks[normalizedAsset]?.includes(normalizedNetwork)) throw new HttpError(400, 'Unsupported asset and network combination.');
  return { asset: normalizedAsset, network: normalizedNetwork };
};
const custodyRequest = async (config, pathname, options = {}) => {
  let endpoint;
  try {
    endpoint = new URL(pathname, `${config.baseUrl}/`);
  } catch {
    throw new HttpError(503, 'Receiving is unavailable because the custody API configuration is invalid.');
  }
  if (endpoint.origin !== config.baseUrl) throw new HttpError(503, 'Receiving is unavailable because the custody API configuration is invalid.');
  let response;
  try {
    response = await fetch(endpoint, {
      method: options.method || 'GET',
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new HttpError(503, 'Receiving is unavailable because the custody API could not be reached.');
  }
  if (!response.ok) throw new HttpError(503, 'Receiving is unavailable because the custody API rejected or could not verify the request.');
  let result;
  try { result = await response.json(); } catch { throw new HttpError(503, 'Receiving is unavailable because the custody API returned an invalid response.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(503, 'Receiving is unavailable because the custody API returned an invalid response.');
  return result;
};
const verifyCustodyProvider = async (config) => {
  const result = await custodyRequest(config, custodyPaths.health);
  if (result.status !== 'ok') throw new HttpError(503, 'Receiving is unavailable because the custody provider could not be verified.');
  return typeof result.provider === 'string' && result.provider.trim() ? result.provider.trim().slice(0, 60) : 'Custody provider';
};
const getVerifiedCustodyCapabilities = async (config) => {
  const provider = await verifyCustodyProvider(config);
  const result = await custodyRequest(config, custodyPaths.capabilities);
  if (result.status !== 'verified' || !Array.isArray(result.pairs)) {
    throw new HttpError(503, 'Receiving is unavailable because the custody provider did not verify its supported asset and network pairs.');
  }
  const pairs = [];
  const seen = new Set();
  for (const entry of result.pairs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(503, 'Receiving is unavailable because the custody provider returned invalid supported asset and network pairs.');
    }
    let pair;
    try {
      pair = supportedDepositPair(entry.asset, entry.network);
    } catch {
      throw new HttpError(503, 'Receiving is unavailable because the custody provider returned an unsupported asset and network pair.');
    }
    const key = `${pair.asset}:${pair.network}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push(pair);
    }
  }
  return { provider, pairs };
};
const getSupportedCustodyPair = async (asset, network, config) => {
  const pair = supportedDepositPair(asset, network);
  if (!config) return { pair, provider: null };
  const capabilities = await getVerifiedCustodyCapabilities(config);
  if (!capabilities.pairs.some((candidate) => candidate.asset === pair.asset && candidate.network === pair.network)) {
    throw new HttpError(400, 'This asset and network combination is not supported by the configured custody provider.');
  }
  return { pair, provider: capabilities.provider };
};
const getCustodyReadiness = async () => {
  const hasBaseUrl = Boolean(String(process.env.CUSTODY_API_BASE_URL || '').trim());
  const hasToken = Boolean(String(process.env.CUSTODY_API_TOKEN || '').trim());
  if (!hasBaseUrl || !hasToken) {
    return { configured: false, status: 'not_configured', checkedAt: new Date().toISOString() };
  }
  const config = getCustodyConfig();
  if (!config) {
    return { configured: false, status: 'invalid_configuration', checkedAt: new Date().toISOString() };
  }
  try {
    await getVerifiedCustodyCapabilities(config);
    return { configured: true, status: 'verified', checkedAt: new Date().toISOString() };
  } catch {
    return { configured: true, status: 'verification_failed', checkedAt: new Date().toISOString() };
  }
};
const validProviderAddress = (address) => typeof address === 'string' && address.trim().length >= 8 && address.trim().length <= 250 && !/[\s<>]/.test(address);
const getOrCreateDepositAddress = async (userId, asset, network, config) => {
  const providerUrl = config.baseUrl;
  const key = `${providerUrl}:${userId}:${asset}:${network}`;
  const existing = database.prepare('SELECT address FROM custody_deposit_addresses WHERE user_id = ? AND asset = ? AND network = ? AND provider_url = ?').get(userId, asset, network, providerUrl);
  if (existing) return existing.address;
  if (inFlightDepositAddresses.has(key)) return inFlightDepositAddresses.get(key);
  const work = (async () => {
    const recheck = database.prepare('SELECT address FROM custody_deposit_addresses WHERE user_id = ? AND asset = ? AND network = ? AND provider_url = ?').get(userId, asset, network, providerUrl);
    if (recheck) return recheck.address;
    const requestId = crypto.randomUUID();
    const result = await custodyRequest(config, custodyPaths.address, {
      method: 'POST',
      body: { customerId: userId, asset, network, requestId },
    });
    if (result.status !== 'verified' || result.customerId !== userId || result.asset !== asset || result.network !== network || !validProviderAddress(result.address)) {
      throw new HttpError(503, 'Receiving is unavailable because the custody provider did not verify a unique address for this account and network.');
    }
    try {
      database.prepare('INSERT INTO custody_deposit_addresses (user_id, asset, network, provider_url, address, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, asset, network, providerUrl, result.address.trim(), new Date().toISOString());
    } catch {
      const saved = database.prepare('SELECT address FROM custody_deposit_addresses WHERE user_id = ? AND asset = ? AND network = ? AND provider_url = ?').get(userId, asset, network, providerUrl);
      if (saved) return saved.address;
      throw new HttpError(503, 'Receiving is unavailable because the custody provider returned an address already assigned to another account.');
    }
    return result.address.trim();
  })();
  inFlightDepositAddresses.set(key, work);
  try { return await work; } finally { inFlightDepositAddresses.delete(key); }
};
const getCustodyBalance = async (userId, asset, network, config) => {
  const addressRecord = database.prepare('SELECT address FROM custody_deposit_addresses WHERE user_id = ? AND asset = ? AND network = ? AND provider_url = ?').get(userId, asset, network, config.baseUrl);
  if (!addressRecord) throw new HttpError(404, 'No verified deposit address has been issued for this account and network yet.');
  const query = new URLSearchParams({ customerId: userId, asset, network, address: addressRecord.address });
  const result = await custodyRequest(config, `${custodyPaths.balance}?${query}`);
  const confirmedBalance = typeof result.confirmedBalance === 'string' ? result.confirmedBalance : '';
  if (result.status !== 'verified' || result.customerId !== userId || result.asset !== asset || result.network !== network || result.address !== addressRecord.address || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(confirmedBalance)) {
    throw new HttpError(503, 'Balance is unavailable because the custody provider did not verify this account, asset, and network.');
  }
  return confirmedBalance;
};
const validProviderTransactionReference = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 256 && !/[\s<>]/.test(value.trim());
const getPayoutRequest = (requestId) => {
  const request = getAdminRequests().find((item) => item.id === requestId);
  if (!request) throw new HttpError(404, 'Withdrawal request not found.');
  return request;
};
const getFallbackMarket = () => Object.fromEntries(Object.entries(market).map(([symbol, price]) => {
  const change = symbol === 'USDC' ? 0 : (Math.random() - 0.48) * 0.16;
  const next = Number((price * (1 + change / 100)).toFixed(2));
  market[symbol] = next;
  return [symbol, { price: next, change: Number(change.toFixed(2)), updatedAt: new Date().toISOString() }];
}));
const getMarket = async () => {
  const symbols = Object.keys(market);
  const results = await Promise.all(symbols.map(async (symbol) => {
    try {
      const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
      if (!response.ok) throw new Error('Quote unavailable.');
      const quote = await response.json();
      return [symbol, { price: Number(quote.lastPrice), change: Number(Number(quote.priceChangePercent).toFixed(2)), updatedAt: new Date().toISOString() }];
    } catch {
      return [symbol, getFallbackMarket()[symbol]];
    }
  }));
  const usedFallback = results.some(([symbol, quote]) => quote.price === market[symbol]);
  return { source: usedFallback ? 'Binance + fallback for unavailable pairs' : 'Binance', updatedAt: new Date().toISOString(), quotes: Object.fromEntries(results) };
};
const getMarketChart = async (symbol) => {
  const allowed = Object.keys(market);
  if (!allowed.includes(symbol)) throw new Error('Unsupported market symbol.');
  const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1m&limit=60`);
  if (!response.ok) throw new Error('Live chart provider unavailable.');
  const candles = await response.json();
  return { source: 'Binance', symbol, candles: candles.map((candle) => ({ time: candle[0], open: Number(candle[1]), high: Number(candle[2]), low: Number(candle[3]), close: Number(candle[4]), volume: Number(candle[5]) })) };
};

const send = (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' }); response.end(JSON.stringify(data)); };
const readBody = (request) => new Promise((resolve, reject) => { let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON body.')); } }); request.on('error', reject); });
const publicFiles = new Set(['/index.html', '/admin.html', '/app.js', '/admin.js', '/styles.css', '/admin.css', '/sw.js', '/manifest.webmanifest']);
const serveFile = (response, pathname) => {
  if (pathname === '/admin.html') { response.writeHead(404); response.end('Not found'); return; }
  const requested = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  if (!publicFiles.has(requested)) { response.writeHead(404); response.end('Not found'); return; }
  const filePath = path.join(root, requested);
  if (!fs.existsSync(filePath)) { response.writeHead(404); response.end('Not found'); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
};
const adminOnly = (request, response) => { try { const [scheme, token] = String(request.headers.authorization || '').split(' '); const payload = verifyJwt(scheme === 'Bearer' ? token : ''); if (payload.role !== 'Admin') throw new Error('Admin role required.'); const account = database.prepare('SELECT role, status FROM users WHERE id = ?').get(payload.sub); if (!account || account.role !== 'Admin' || account.status !== 'Active') throw new Error('Admin role required.'); return payload; } catch (error) { send(response, 401, { error: error.message }); return null; } };
const signedInOnly = (request, response) => { try { const [scheme, token] = String(request.headers.authorization || '').split(' '); return verifyJwt(scheme === 'Bearer' ? token : ''); } catch (error) { send(response, 401, { error: error.message }); return null; } };
const verifyGoogleCredential = async (credential) => { if (!googleClientId) throw new Error('Set GOOGLE_CLIENT_ID before using Google sign-in.'); const result = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`); if (!result.ok) throw new Error('Google credential verification failed.'); const profile = await result.json(); if (profile.aud !== googleClientId) throw new Error('Google credential was issued for another app.'); return { id: profile.sub, name: profile.name || profile.email, email: profile.email }; };
const createOauthState = (provider, verifier = '') => { const state = crypto.randomBytes(24).toString('hex'); oauthStates.set(state, { provider, verifier, expiresAt: Date.now() + 10 * 60 * 1000 }); return state; };
const consumeOauthState = (state, provider) => { const item = oauthStates.get(state); oauthStates.delete(state); if (!item || item.provider !== provider || item.expiresAt < Date.now()) throw new Error('OAuth state expired.'); return item; };
const createSocialChallenge = async (profile) => { let user = database.prepare('SELECT * FROM users WHERE email = ?').get(profile.email); if (!user) { user = { id: `${profile.provider}-${profile.id}`, name: profile.name, email: profile.email, role: 'User', status: 'Pending' }; database.prepare('INSERT INTO users (id, name, email, role, status, joined) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, user.name, user.email, user.role, user.status, new Date().toISOString().slice(0, 10)); } const challenge = await createOtp(user.email); return `/?oauthChallenge=${encodeURIComponent(challenge.challengeId)}&email=${encodeURIComponent(user.email)}&name=${encodeURIComponent(user.name)}&mailConfigured=${challenge.delivered}`; };
const exchangeXCode = async (code, verifier) => { const response = await fetch('https://api.twitter.com/2/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${xClientId}:${xClientSecret}`).toString('base64')}` }, body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: `${oauthRedirectBase}/auth/x/callback`, code_verifier: verifier }) }); if (!response.ok) throw new Error('X token exchange failed.'); const token = await response.json(); const profileResponse = await fetch('https://api.twitter.com/2/users/me?user.fields=name,username', { headers: { Authorization: `Bearer ${token.access_token}` } }); const profile = await profileResponse.json(); throw new Error(`X authenticated ${profile.data?.name || 'account'}, but X did not provide a verified email for OTP.`); };
const exchangeVkCode = async (code) => { const tokenResponse = await fetch(`https://oauth.vk.com/access_token?client_id=${encodeURIComponent(vkClientId)}&client_secret=${encodeURIComponent(vkClientSecret)}&redirect_uri=${encodeURIComponent(`${oauthRedirectBase}/auth/vk/callback`)}&code=${encodeURIComponent(code)}`); if (!tokenResponse.ok) throw new Error('VK token exchange failed.'); const token = await tokenResponse.json(); const profileResponse = await fetch(`https://api.vk.com/method/users.get?access_token=${encodeURIComponent(token.access_token)}&v=5.199&fields=photo_100`); const profile = await profileResponse.json(); const user = profile.response?.[0]; if (!user || !token.email) throw new Error('VK did not return an email address.'); return { id: String(user.id), name: `${user.first_name} ${user.last_name}`, email: token.email, provider: 'vk' }; };
const sendOtpEmail = async (email, code) => {
  if (process.env.NODE_ENV === 'test') return false;
  const message = { from: mailFrom, to: [email], subject: 'Your ARC Wallet verification code', html: `<p>Your ARC Wallet verification code is <strong>${code}</strong>.</p><p>This code expires in 10 minutes.</p>` };
  let response;
  if (process.env.REPLIT_CONNECTORS_HOSTNAME) {
    const { ReplitConnectors } = await import('@replit/connectors-sdk');
    response = await new ReplitConnectors().proxy('resend', '/emails', { method: 'POST', body: JSON.stringify(message), headers: { 'Content-Type': 'application/json' } });
  } else if (resendApiKey) {
    response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  } else {
    if (allowDevOtp) console.log(`[OTP DEVELOPMENT ONLY] ${email}: ${code}`);
    return false;
  }
  if (!response.ok) {
    const details = await response.text();
    console.error(`[RESEND ERROR ${response.status}] ${details}`);
    if (allowDevOtp) console.log(`[OTP DEVELOPMENT FALLBACK] ${email}: ${code}`);
    return false;
  }
  return true;
};
const createOtp = async (email, purpose = 'login', name = null, passwordHash = null) => {
  const code = String(crypto.randomInt(100000, 1000000));
  const challengeId = crypto.randomUUID();
  const codeHash = hashPassword(code);
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE otp_challenges SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0').run(email, purpose);
    database.prepare('INSERT INTO otp_challenges (id, email, code_hash, expires_at, purpose, name, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(challengeId, email, codeHash, Date.now() + 10 * 60 * 1000, purpose, name, passwordHash);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const delivered = await sendOtpEmail(email, code);
  return { challengeId, delivered, devCode: !delivered && allowDevOtp ? code : null };
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'OPTIONS') { send(response, 204, {}); return; }
  try {
    if (request.method === 'GET' && url.pathname === '/api/config') {
      send(response, 200, { googleClientId, providers: { google: Boolean(googleClientId), apple: false, x: Boolean(xClientId && xClientSecret), vk: Boolean(vkClientId && vkClientSecret) }, sharedDepositPairs });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/auth/x/start') {
      if (!xClientId || !xClientSecret) { response.writeHead(302, { Location: '/?authError=X OAuth is not configured on the server.' }); response.end(); return; }
      const verifier = crypto.randomBytes(32).toString('base64url'); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url'); const state = createOauthState('x', verifier);
      const authorization = new URL('https://twitter.com/i/oauth2/authorize'); authorization.search = new URLSearchParams({ response_type: 'code', client_id: xClientId, redirect_uri: `${oauthRedirectBase}/auth/x/callback`, scope: 'users.read tweet.read offline.access', state, code_challenge: challenge, code_challenge_method: 'S256' }); response.writeHead(302, { Location: authorization.toString() }); response.end(); return;
    }
    if (request.method === 'GET' && url.pathname === '/auth/x/callback') { const oauth = consumeOauthState(url.searchParams.get('state'), 'x'); const profile = await exchangeXCode(url.searchParams.get('code'), oauth.verifier); response.writeHead(302, { Location: await createSocialChallenge(profile) }); response.end(); return; }
    if (request.method === 'GET' && url.pathname === '/auth/vk/start') {
      if (!vkClientId || !vkClientSecret) { response.writeHead(302, { Location: '/?authError=VK OAuth is not configured on the server.' }); response.end(); return; }
      const state = createOauthState('vk'); const authorization = new URL('https://oauth.vk.com/authorize'); authorization.search = new URLSearchParams({ client_id: vkClientId, redirect_uri: `${oauthRedirectBase}/auth/vk/callback`, response_type: 'code', scope: 'email', state }); response.writeHead(302, { Location: authorization.toString() }); response.end(); return;
    }
    if (request.method === 'GET' && url.pathname === '/auth/vk/callback') { consumeOauthState(url.searchParams.get('state'), 'vk'); const profile = await exchangeVkCode(url.searchParams.get('code')); response.writeHead(302, { Location: await createSocialChallenge(profile) }); response.end(); return; }
    if (request.method === 'POST' && url.pathname === '/auth/login') {
      const body = await readBody(request); const user = database.prepare('SELECT * FROM users WHERE email = ?').get(body.email);
      if (user?.status === 'Pending' && user.password_hash && verifyPassword(body.password || '', user.password_hash)) { send(response, 403, { error: 'Your account is pending admin approval.' }); return; }
      if (!user || user.status !== 'Active' || !user.password_hash || !verifyPassword(body.password || '', user.password_hash)) { send(response, 401, { error: 'Invalid email or password.' }); return; }
      const challenge = await createOtp(user.email); send(response, 200, { requiresOtp: true, challengeId: challenge.challengeId, email: user.email, name: user.name, mailConfigured: challenge.delivered, devCode: challenge.devCode }); return;
    }
    if (request.method === 'POST' && url.pathname === '/auth/register') {
      const body = await readBody(request); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) { send(response, 400, { error: 'Enter a valid email and a password with at least 8 characters.' }); return; }
      if (database.prepare('SELECT id FROM users WHERE email = ?').get(email)) { send(response, 409, { error: 'An account with this email already exists.' }); return; }
      const challenge = await createOtp(email, 'register', email.split('@')[0], hashPassword(password)); send(response, 200, { requiresOtp: true, challengeId: challenge.challengeId, email, mailConfigured: challenge.delivered, devCode: challenge.devCode }); return;
    }
    if (request.method === 'POST' && url.pathname === '/auth/verify-otp') {
      const body = await readBody(request); const now = Date.now(); const challenge = database.prepare('SELECT * FROM otp_challenges WHERE id = ? AND consumed = 0').get(body.challengeId);
      if (!challenge || challenge.expires_at <= now || challenge.attempts >= otpMaxAttempts) { send(response, 401, { error: 'Invalid or expired verification code.' }); return; }
      if (!verifyPassword(String(body.code || ''), challenge.code_hash)) {
        database.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed = 0 AND expires_at > ? AND attempts < ?').run(challenge.id, now, otpMaxAttempts);
        send(response, 401, { error: 'Invalid or expired verification code.' }); return;
      }
      const consumed = database.prepare('UPDATE otp_challenges SET consumed = 1 WHERE id = ? AND consumed = 0 AND expires_at > ? AND attempts < ?').run(challenge.id, now, otpMaxAttempts);
      if (!consumed.changes) { send(response, 401, { error: 'Invalid or expired verification code.' }); return; }
      let user = database.prepare('SELECT * FROM users WHERE email = ?').get(challenge.email);
       if (challenge.purpose === 'register') { const id = `user-${crypto.randomUUID()}`; database.prepare('INSERT INTO users (id, name, email, password_hash, role, status, joined) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, challenge.name, challenge.email, challenge.password_hash, 'User', 'Pending', new Date().toISOString().slice(0, 10)); user = database.prepare('SELECT * FROM users WHERE id = ?').get(id); }
      if (!user) { send(response, 404, { error: 'Account not found.' }); return; }
       if (user.status === 'Pending') { send(response, 200, { user: { id: user.id, name: user.name, email: user.email, status: user.status }, pendingApproval: true }); return; }
       if (user.status !== 'Active') { send(response, 403, { error: 'This account is not available.' }); return; }
       send(response, 200, { user: { id: user.id, name: user.name, email: user.email, status: user.status }, token: signJwt({ sub: user.id, role: user.role, email: user.email }) }); return;
    }
    if (request.method === 'POST' && url.pathname === '/auth/google') {
      const body = await readBody(request);
      let profile;
      try {
        profile = await verifyGoogleCredential(body.credential);
      } catch (error) {
        send(response, 401, { error: error.message });
        return;
      }
      let user = database.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);
      if (!user) {
         user = { id: `google-${profile.id}`, name: profile.name, email: profile.email, role: 'User', status: 'Pending' };
        database.prepare('INSERT INTO users (id, name, email, role, status, joined) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, user.name, user.email, user.role, user.status, new Date().toISOString().slice(0, 10));
      }
      const challenge = await createOtp(profile.email);
      send(response, 200, { requiresOtp: true, challengeId: challenge.challengeId, email: profile.email, name: profile.name, mailConfigured: challenge.delivered, devCode: challenge.devCode });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/admin/login') {
      if (!adminPassword) { send(response, 503, { error: 'Admin password is not configured. Set ADMIN_PASSWORD in Replit Secrets.' }); return; }
      const body = await readBody(request); const identifier = String(body.identifier || body.email || '').trim().toLowerCase(); const user = database.prepare('SELECT * FROM users WHERE (lower(email) = ? OR lower(username) = ?) AND role = ?').get(identifier, identifier, 'Admin');
      if (!user || !verifyPassword(body.password || '', user.password_hash)) { send(response, 401, { error: 'Invalid admin credentials.' }); return; }
      send(response, 200, { token: signJwt({ sub: user.id, role: 'Admin', email: user.email }), admin: { name: user.name, email: user.email } }); return;
    }
    const adminSession = url.pathname.startsWith('/api/admin') ? adminOnly(request, response) : null;
    if (url.pathname.startsWith('/api/admin') && !adminSession) return;
    if (request.method === 'GET' && url.pathname === '/api/admin/custody-readiness') { send(response, 200, await getCustodyReadiness()); return; }
    if (request.method === 'GET' && url.pathname === '/api/admin/overview') { const transactions = getTransactions(); const users = getUsers(); const pendingRequests = database.prepare("SELECT COUNT(*) AS count FROM financial_requests WHERE status = 'Pending'").get().count; send(response, 200, { metrics: { users: users.length, activeUsers: users.filter((user) => user.status === 'Active').length, volume: '12,480.20 USDC', pending: transactions.filter((transaction) => transaction.status === 'Pending').length + pendingRequests + users.filter((user) => user.status === 'Pending').length }, transactions: transactions.slice(0, 5), settings: getSettings() }); return; }
    if (request.method === 'GET' && url.pathname === '/api/admin/users') { send(response, 200, getUsers()); return; }
    if (request.method === 'GET' && url.pathname === '/api/admin/transactions') { send(response, 200, getTransactions()); return; }
    if (request.method === 'GET' && url.pathname === '/api/admin/requests') { send(response, 200, getAdminRequests()); return; }
    if (request.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/approve$/.test(url.pathname)) {
      const userId = decodeURIComponent(url.pathname.split('/')[4]);
      database.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = database.prepare("UPDATE users SET status = 'Active' WHERE id = ? AND role = 'User' AND status = 'Pending'").run(userId);
        if (result.changes) recordUserAudit(userId, adminSession.sub, 'approved', 'Pending customer registration approved.');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      if (!result.changes) { send(response, 409, { error: 'Only a pending customer account can be approved.' }); return; }
      send(response, 200, getUsers().find((user) => user.id === userId)); return;
    }
    if (request.method === 'PATCH' && /^\/api\/admin\/users\/[^/]+\/status$/.test(url.pathname)) {
      const userId = decodeURIComponent(url.pathname.split('/')[4]);
      const body = await readBody(request);
      if (!['Active', 'Suspended'].includes(body.status)) { send(response, 400, { error: 'Choose Active or Suspended.' }); return; }
      database.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = database.prepare("UPDATE users SET status = ? WHERE id = ? AND role = 'User' AND status IN ('Active', 'Suspended')").run(body.status, userId);
        if (result.changes) recordUserAudit(userId, adminSession.sub, body.status.toLowerCase(), `Account status changed to ${body.status}.`);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      if (!result.changes) { send(response, 409, { error: 'This customer account cannot be changed to that status.' }); return; }
      send(response, 200, getUsers().find((user) => user.id === userId)); return;
    }
    if (request.method === 'DELETE' && /^\/api\/admin\/users\/[^/]+$/.test(url.pathname)) {
      const userId = decodeURIComponent(url.pathname.split('/')[4]);
      const target = database.prepare('SELECT id, role, status FROM users WHERE id = ?').get(userId);
      if (!target) { send(response, 404, { error: 'User not found.' }); return; }
      if (target.role === 'Admin' || target.id === adminSession.sub) { send(response, 403, { error: 'Admin accounts cannot be deleted from this customer workflow.' }); return; }
      if (target.status === 'Deleted') { send(response, 409, { error: 'This user is already deleted.' }); return; }
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare("UPDATE users SET status = 'Deleted', deleted_from_status = status WHERE id = ?").run(userId);
        recordUserAudit(userId, adminSession.sub, 'deleted', 'Account deactivated; financial history retained.');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      send(response, 200, { id: userId, status: 'Deleted' }); return;
    }
    if (request.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/restore$/.test(url.pathname)) {
      const userId = decodeURIComponent(url.pathname.split('/')[4]);
      database.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = database.prepare("UPDATE users SET status = CASE WHEN deleted_from_status IN ('Active', 'Suspended', 'Pending') THEN deleted_from_status ELSE 'Pending' END, deleted_from_status = NULL WHERE id = ? AND role = 'User' AND status = 'Deleted'").run(userId);
        if (result.changes) recordUserAudit(userId, adminSession.sub, 'restored', 'Previously deleted account restored to its prior status.');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      if (!result.changes) { send(response, 409, { error: 'This user cannot be restored.' }); return; }
      send(response, 200, getUsers().find((user) => user.id === userId)); return;
    }
    if (request.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/adjustments$/.test(url.pathname)) {
      const userId = decodeURIComponent(url.pathname.split('/')[4]);
      const body = await readBody(request);
      const operation = String(body.operation || '');
      const asset = String(body.asset || '').trim().toUpperCase();
      const note = String(body.note || '').trim();
      if (!['add', 'withdraw'].includes(operation)) { send(response, 400, { error: 'Choose Add funds or Withdraw funds.' }); return; }
      if (!Object.hasOwn(market, asset)) { send(response, 400, { error: 'Choose a supported asset.' }); return; }
      if (note.length < 3 || note.length > 300) { send(response, 400, { error: 'Enter a reason between 3 and 300 characters.' }); return; }
      const amountAtoms = parseAmountAtoms(body.amount);
      const target = database.prepare("SELECT id, role, status FROM users WHERE id = ?").get(userId);
      if (!target || target.role !== 'User' || target.status !== 'Active') { send(response, 404, { error: 'Active customer account not found.' }); return; }
      database.exec('BEGIN IMMEDIATE');
      try {
        const balance = getLedgerBalanceAtoms(userId, asset);
        const reserved = getPendingWithdrawalsAtoms(userId, asset);
        if (operation === 'withdraw' && amountAtoms > balance - reserved) throw new HttpError(409, `Insufficient available ${asset} internal-ledger balance.`);
        recordLedgerEntry({ userId, asset, deltaAtoms: operation === 'add' ? amountAtoms : -amountAtoms, entryType: `admin_${operation}`, adminId: adminSession.sub, note });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      send(response, 201, { id: userId, internalBalances: getInternalBalances(userId) }); return;
    }
    if (request.method === 'POST' && /^\/api\/admin\/requests\/[^/]+\/settle$/.test(url.pathname)) {
      const requestId = decodeURIComponent(url.pathname.split('/')[4]);
      const attemptId = crypto.randomUUID();
      let completedAlready = false;
      let payout;
      database.exec('BEGIN IMMEDIATE');
      try {
        payout = database.prepare("SELECT * FROM financial_requests WHERE id = ? AND type = 'withdrawal'").get(requestId);
        if (!payout) {
          const exists = database.prepare('SELECT id FROM financial_requests WHERE id = ?').get(requestId);
          throw new HttpError(exists ? 409 : 404, exists ? 'Only approved withdrawal requests can be settled.' : 'Withdrawal request not found.');
        }
        if (payout.status !== 'Approved') throw new HttpError(409, 'Only approved withdrawal requests can be settled.');
        if (payout.payout_status === 'Completed') {
          completedAlready = true;
        } else {
          if (payout.payout_status === 'Processing') {
            const lastUpdate = Date.parse(payout.payout_updated_at || '');
            if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < 60000) {
              throw new HttpError(409, 'This payout is already being processed. Refresh the request list before retrying.');
            }
          } else if (!['Awaiting payout', 'Failed'].includes(payout.payout_status)) {
            throw new HttpError(409, 'This withdrawal is not ready for payout.');
          }
          const updated = database.prepare("UPDATE financial_requests SET payout_status = 'Processing', payout_error = NULL, payout_updated_at = ?, payout_attempt_id = ? WHERE id = ? AND status = 'Approved' AND type = 'withdrawal'").run(new Date().toISOString(), attemptId, requestId);
          if (!updated.changes) throw new HttpError(409, 'This withdrawal is not ready for payout.');
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      if (completedAlready) { send(response, 200, getPayoutRequest(requestId)); return; }

      try {
        const config = getCustodyConfig();
        if (!config) throw new HttpError(503, 'Payout is unavailable because no valid custody provider is configured.');
        const { pair } = await getSupportedCustodyPair(payout.asset, payout.network, config);
        const amount = formatAtoms(payout.amount_atoms);
        const result = await custodyRequest(config, custodyPaths.payout, {
          method: 'POST',
          body: {
            requestId: payout.id,
            customerId: payout.user_id,
            asset: pair.asset,
            network: pair.network,
            amount,
            recipient: payout.recipient,
          },
        });
        if (result.status !== 'completed'
          || result.requestId !== payout.id
          || result.customerId !== payout.user_id
          || result.asset !== pair.asset
          || result.network !== pair.network
          || result.amount !== amount
          || result.recipient !== payout.recipient
          || !validProviderTransactionReference(result.transactionReference)) {
          throw new HttpError(502, 'Payout provider did not verify the completed transfer and its transaction reference.');
        }
        const completed = database.prepare("UPDATE financial_requests SET payout_status = 'Completed', payout_reference = ?, payout_error = NULL, payout_updated_at = ? WHERE id = ? AND payout_status = 'Processing' AND payout_attempt_id = ?").run(result.transactionReference.trim(), new Date().toISOString(), requestId, attemptId);
        if (!completed.changes) throw new HttpError(409, 'The payout attempt changed while the provider was responding. Retry with the same request to verify its result.');
        send(response, 200, getPayoutRequest(requestId));
      } catch (error) {
        const failure = error instanceof HttpError
          ? error.message
          : 'Payout could not be verified or confirmed. Retrying will reuse the same provider request ID.';
        database.prepare("UPDATE financial_requests SET payout_status = 'Failed', payout_error = ?, payout_updated_at = ? WHERE id = ? AND payout_status = 'Processing' AND payout_attempt_id = ?").run(failure.slice(0, 500), new Date().toISOString(), requestId, attemptId);
        send(response, error instanceof HttpError ? error.status : 502, { error: failure, request: getPayoutRequest(requestId) });
      }
      return;
    }
    if (request.method === 'POST' && /^\/api\/admin\/requests\/[^/]+\/review$/.test(url.pathname)) {
      const requestId = decodeURIComponent(url.pathname.split('/')[4]);
      const body = await readBody(request);
      const decision = String(body.decision || '');
      const reviewNote = String(body.note || '').trim();
      if (!['approve', 'reject'].includes(decision)) { send(response, 400, { error: 'Choose approve or reject.' }); return; }
      if (reviewNote.length > 300) { send(response, 400, { error: 'Review notes must be 300 characters or fewer.' }); return; }
      database.exec('BEGIN IMMEDIATE');
      try {
        const pending = database.prepare("SELECT * FROM financial_requests WHERE id = ? AND status = 'Pending'").get(requestId);
        if (!pending) throw new HttpError(409, 'This request is no longer pending.');
        const reviewedAt = new Date().toISOString();
        if (decision === 'approve') {
          const owner = database.prepare('SELECT status FROM users WHERE id = ?').get(pending.user_id);
          if (!owner || owner.status !== 'Active') throw new HttpError(409, 'Only requests from an active account can be approved.');
          const amountAtoms = BigInt(pending.amount_atoms);
          if (pending.type === 'withdrawal') {
            const balance = getLedgerBalanceAtoms(pending.user_id, pending.asset);
            const reserved = getPendingWithdrawalsAtoms(pending.user_id, pending.asset, pending.id);
            if (amountAtoms > balance - reserved) throw new HttpError(409, `Insufficient available ${pending.asset} internal-ledger balance to approve this withdrawal.`);
            recordLedgerEntry({ userId: pending.user_id, asset: pending.asset, deltaAtoms: -amountAtoms, entryType: 'withdrawal_approved', requestId: pending.id, adminId: adminSession.sub, note: reviewNote || 'Withdrawal request approved; no blockchain transfer was initiated.' });
          } else {
            recordLedgerEntry({ userId: pending.user_id, asset: pending.asset, deltaAtoms: amountAtoms, entryType: 'deposit_approved', requestId: pending.id, adminId: adminSession.sub, note: reviewNote || 'Deposit claim approved after manual review.' });
          }
        }
        const status = decision === 'approve' ? 'Approved' : 'Rejected';
        const updated = database.prepare("UPDATE financial_requests SET status = ?, payout_status = CASE WHEN type = 'withdrawal' AND ? = 'Approved' THEN 'Awaiting payout' ELSE payout_status END, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'Pending'").run(status, status, reviewedAt, adminSession.sub, reviewNote, requestId);
        if (!updated.changes) throw new HttpError(409, 'This request is no longer pending.');
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      send(response, 200, getAdminRequests().find((item) => item.id === requestId)); return;
    }
    if (request.method === 'PATCH' && url.pathname === '/api/admin/settings') {
      let body;
      try {
        body = await readBody(request);
      } catch {
        send(response, 400, { error: 'Settings request must contain valid JSON.' });
        return;
      }
      const validationError = validateSettingsPayload(body);
      if (validationError) { send(response, 400, { error: validationError }); return; }
      saveSettings({
        maintenance: body.maintenance,
        defaultNetwork: body.defaultNetwork.trim(),
        supportEmail: body.supportEmail.trim(),
      });
      send(response, 200, getSettings());
      return;
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/admin/transactions/')) { const id = url.pathname.split('/').pop(); const body = await readBody(request); if (!['Pending', 'Success', 'Rejected'].includes(body.status)) { send(response, 400, { error: 'Invalid transaction status.' }); return; } const result = database.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(body.status, id); if (!result.changes) { send(response, 404, { error: 'Transaction not found.' }); return; } send(response, 200, getTransactions().find((transaction) => transaction.id === id)); return; }
    if (url.pathname.startsWith('/api/wallet')) {
      const session = signedInOnly(request, response);
      if (!session) return;
      const user = database.prepare('SELECT * FROM users WHERE id = ?').get(session.sub);
       if (!user) { send(response, 404, { error: 'Account not found.' }); return; }
       if (user.status !== 'Active') { send(response, 403, { error: user.status === 'Pending' ? 'Your account is pending admin approval.' : 'This account is not available.' }); return; }
       if (request.method === 'GET' && url.pathname === '/api/wallet') { send(response, 200, { walletMode: getCustodyConfig() ? 'provider' : 'demo', address: null, balance: null, asset: null, user: { id: user.id, name: user.name, email: user.email, role: user.role }, settings: getSettings(), transactions: [], internalBalances: getInternalBalances(user.id), requests: getUserRequests(user.id) }); return; }
       if (request.method === 'GET' && url.pathname === '/api/wallet/capabilities') {
         const config = getCustodyConfig();
         if (!config) { send(response, 200, { verified: false, pairs: [] }); return; }
         const capabilities = await getVerifiedCustodyCapabilities(config);
         send(response, 200, { verified: true, provider: capabilities.provider, pairs: capabilities.pairs }); return;
       }
       if (request.method === 'GET' && url.pathname === '/api/wallet/requests') { send(response, 200, { internalBalances: getInternalBalances(user.id), requests: getUserRequests(user.id) }); return; }
       if (request.method === 'POST' && url.pathname === '/api/wallet/deposit-requests') {
         const body = await readBody(request);
         const { pair } = await getSupportedCustodyPair(body.asset, body.network, getCustodyConfig());
         const amountAtoms = parseAmountAtoms(body.amount);
         const txHash = String(body.txHash || '').trim();
         if (!/^[A-Za-z0-9_-]{10,256}$/.test(txHash)) { send(response, 400, { error: 'Enter a valid transaction hash.' }); return; }
         if (database.prepare("SELECT id FROM financial_requests WHERE type = 'deposit' AND asset = ? AND network = ? AND lower(tx_hash) = lower(?)").get(pair.asset, pair.network, txHash)) { send(response, 409, { error: 'This transaction hash has already been submitted for review.' }); return; }
         const id = crypto.randomUUID();
         database.prepare("INSERT INTO financial_requests (id, user_id, type, asset, network, amount_atoms, tx_hash, status, created_at) VALUES (?, ?, 'deposit', ?, ?, ?, ?, 'Pending', ?)").run(id, user.id, pair.asset, pair.network, amountAtoms.toString(), txHash, new Date().toISOString());
         send(response, 201, { id, type: 'deposit', asset: pair.asset, network: pair.network, amount: formatAtoms(amountAtoms), txHash, status: 'Pending' }); return;
       }
       if (request.method === 'POST' && url.pathname === '/api/wallet/withdrawal-requests') {
         const body = await readBody(request);
         const { pair } = await getSupportedCustodyPair(body.asset, body.network, getCustodyConfig());
         const amountAtoms = parseAmountAtoms(body.amount);
         const recipient = String(body.recipient || '').trim();
         if (recipient.length < 10 || recipient.length > 250 || /\s/.test(recipient)) { send(response, 400, { error: 'Enter a valid destination address.' }); return; }
         const balance = getLedgerBalanceAtoms(user.id, pair.asset);
         const reserved = getPendingWithdrawalsAtoms(user.id, pair.asset);
         if (amountAtoms > balance - reserved) { send(response, 409, { error: `Insufficient available ${pair.asset} internal-ledger balance.` }); return; }
         const id = crypto.randomUUID();
         database.prepare("INSERT INTO financial_requests (id, user_id, type, asset, network, amount_atoms, recipient, status, created_at) VALUES (?, ?, 'withdrawal', ?, ?, ?, ?, 'Pending', ?)").run(id, user.id, pair.asset, pair.network, amountAtoms.toString(), recipient, new Date().toISOString());
         send(response, 201, { id, type: 'withdrawal', asset: pair.asset, network: pair.network, amount: formatAtoms(amountAtoms), status: 'Pending' }); return;
       }
      if (request.method === 'GET' && url.pathname.startsWith('/api/wallet/receive/')) {
        const symbol = url.pathname.split('/').pop().toUpperCase();
        const config = getCustodyConfig();
        const { pair, provider } = await getSupportedCustodyPair(symbol, url.searchParams.get('network') || depositNetworks[symbol]?.[0], config);
        if (url.searchParams.get('shared') === 'true') {
          const address = sharedDepositAddresses[pair.asset]?.[pair.network];
          if (!address) { send(response, 404, { error: 'No shared deposit address is configured for this asset and network.' }); return; }
          send(response, 200, { verified: false, shared: true, asset: pair.asset, network: pair.network, address });
          return;
        }
        if (!config) { send(response, 503, { error: 'Receiving is unavailable: no verified wallet provider or account-specific custody API is configured.' }); return; }
        const address = await getOrCreateDepositAddress(user.id, pair.asset, pair.network, config);
        send(response, 200, { verified: true, provider, asset: pair.asset, network: pair.network, address }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/wallet/balance') {
        const asset = url.searchParams.get('asset') || 'ETH';
        const config = getCustodyConfig();
        if (!config) { send(response, 503, { error: 'Balance is unavailable: no verified, account-specific custody API is configured.' }); return; }
        const { pair, provider } = await getSupportedCustodyPair(asset, url.searchParams.get('network') || depositNetworks[String(asset).toUpperCase()]?.[0], config);
        const balance = await getCustodyBalance(user.id, pair.asset, pair.network, config);
        send(response, 200, { verified: true, provider, asset: pair.asset, network: pair.network, balance }); return;
      }
      if (request.method === 'PATCH' && url.pathname === '/api/wallet/profile') {
        const body = await readBody(request); const name = String(body.name || '').trim();
        if (name.length < 2 || name.length > 60) { send(response, 400, { error: 'Display name must be 2–60 characters.' }); return; }
        database.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id); send(response, 200, { user: { name, email: user.email, role: user.role } }); return;
      }
      if (request.method === 'PATCH' && url.pathname === '/api/wallet/password') {
        const body = await readBody(request); const next = String(body.newPassword || '');
        if (!user.password_hash || !verifyPassword(String(body.currentPassword || ''), user.password_hash)) { send(response, 401, { error: 'Current password is incorrect or unavailable for social-login accounts.' }); return; }
        if (next.length < 8) { send(response, 400, { error: 'New password must contain at least 8 characters.' }); return; }
        database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id); send(response, 200, { ok: true }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/wallet/transactions') {
        send(response, 503, { error: 'Transaction recording is unavailable until a verified wallet provider confirms on-chain status.' }); return;
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/market') { send(response, 200, await getMarket()); return; }
    if (request.method === 'GET' && url.pathname.startsWith('/api/market/chart/')) { send(response, 200, await getMarketChart(url.pathname.split('/').pop().toUpperCase())); return; }
    if (request.method === 'GET' && url.pathname === '/api/health') { send(response, 200, { ok: true, database: 'sqlite', auth: 'jwt' }); return; }
    if (request.method === 'GET') { serveFile(response, url.pathname); return; }
    send(response, 404, { error: 'Route not found.' });
  } catch (error) { send(response, error instanceof HttpError ? error.status : 500, { error: error.message }); }
});

server.listen(port, '0.0.0.0', () => console.log(`ARC Wallet is running at http://0.0.0.0:${port}`));
