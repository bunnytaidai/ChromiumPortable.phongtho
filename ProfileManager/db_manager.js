const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const pg = require('pg');

const DB_PATH = path.join(__dirname, 'profiles.db');
const db = new sqlite3.Database(DB_PATH);

let pgPool = null;
let pgEnabled = false;

const PG_CONFIG_PATH = path.join(__dirname, 'pg_config.json');

function loadPgConfig() {
    if (fs.existsSync(PG_CONFIG_PATH)) {
        try {
            const config = JSON.parse(fs.readFileSync(PG_CONFIG_PATH, 'utf8'));
            if (config.pg_enabled === 1 || config.pg_enabled === true) {
                pgPool = new pg.Pool({
                    host: config.pg_host || 'localhost',
                    port: parseInt(config.pg_port) || 5432,
                    user: config.pg_user || 'postgres',
                    password: config.pg_password || '',
                    database: config.pg_database || 'antiprofile',
                    max: 20,
                    idleTimeoutMillis: 30000,
                    connectionTimeoutMillis: 2000
                });
                pgEnabled = true;
                console.log("[Database] Đã kích hoạt kết nối PostgreSQL.");
            } else {
                pgEnabled = false;
                if (pgPool) {
                    pgPool.end().catch(() => {});
                    pgPool = null;
                }
            }
        } catch (e) {
            console.error("[Database] Lỗi đọc cấu hình PostgreSQL:", e.message);
            pgEnabled = false;
        }
    } else {
        pgEnabled = false;
        pgPool = null;
    }
}
loadPgConfig();

function getPgStatus() {
    return {
        enabled: pgEnabled,
        connected: pgPool !== null
    };
}

function convertSql(sql) {
    let count = 1;
    // Replace SQLite AUTOINCREMENT with Postgres SERIAL
    let converted = sql.replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY');
    // Convert SQLite ? to Postgres $1, $2...
    converted = converted.replace(/\?/g, () => `$${count++}`);
    return converted;
}

async function pgRun(sql, params = []) {
    let pgSql = sql;
    const isInsert = sql.trim().toUpperCase().startsWith("INSERT");
    if (isInsert && !sql.toUpperCase().includes("RETURNING")) {
        pgSql = sql + " RETURNING id";
    }
    const convertedSql = convertSql(pgSql);
    const res = await pgPool.query(convertedSql, params);
    if (isInsert && res.rows && res.rows[0]) {
        return { lastID: res.rows[0].id || res.rows[0].lastid || null, changes: res.rowCount };
    }
    return { lastID: null, changes: res.rowCount };
}

async function pgGet(sql, params = []) {
    const convertedSql = convertSql(sql);
    const res = await pgPool.query(convertedSql, params);
    return res.rows[0] || null;
}

async function pgAll(sql, params = []) {
    const convertedSql = convertSql(sql);
    const res = await pgPool.query(convertedSql, params);
    return res.rows;
}

// Helper functions for Promises (Hàm bổ trợ để chuyển đổi SQLite3 callback sang Promise/Async)
function run(sql, params = []) {
    if (pgEnabled && pgPool) {
        return pgRun(sql, params);
    }
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    if (pgEnabled && pgPool) {
        return pgGet(sql, params);
    }
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function all(sql, params = []) {
    if (pgEnabled && pgPool) {
        return pgAll(sql, params);
    }
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Khởi tạo cấu trúc cơ sở dữ liệu nếu chưa có (Initialize DB Tables)
async function initDb() {
    try {
        // 1. Bảng profiles (Thông tin cấu hình trình duyệt và vân tay giả lập)
        await run(`
            CREATE TABLE IF NOT EXISTS profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                user_agent TEXT,
                proxy_server TEXT,
                proxy_user TEXT,
                proxy_pass TEXT,
                timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
                latitude REAL,
                longitude REAL,
                screen_width INTEGER DEFAULT 1280,
                screen_height INTEGER DEFAULT 720,
                status TEXT DEFAULT 'Stopped',
                script_id INTEGER,
                use_proxy INTEGER DEFAULT 0,
                proxy_rotate_url TEXT,
                use_mcp INTEGER DEFAULT 0,
                fingerprint_json TEXT DEFAULT NULL,
                device_memory INTEGER DEFAULT 8,
                hardware_concurrency INTEGER DEFAULT 4,
                canvas_noise INTEGER DEFAULT 1,
                gpu_vendor TEXT DEFAULT NULL,
                gpu_renderer TEXT DEFAULT NULL,
                locale TEXT DEFAULT 'vi-VN',
                webrtc_mode TEXT DEFAULT 'spoof',
                fonts_mode INTEGER DEFAULT 1,
                media_devices INTEGER DEFAULT 1
            )
        `);

        // Nâng cấp DB: Thêm cột fingerprint_json nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN fingerprint_json TEXT DEFAULT NULL`);
            console.log("[Database] Da nang cap them cot fingerprint_json vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột use_mcp nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN use_mcp INTEGER DEFAULT 0`);
            console.log("[Database] Da nang cap them cot use_mcp vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột country vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN country TEXT DEFAULT NULL`);
            console.log("[Database] Da nang cap them cot country vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột device_memory vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN device_memory INTEGER DEFAULT 8`);
            console.log("[Database] Da nang cap them cot device_memory vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột hardware_concurrency vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN hardware_concurrency INTEGER DEFAULT 4`);
            console.log("[Database] Da nang cap them cot hardware_concurrency vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột canvas_noise vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN canvas_noise INTEGER DEFAULT 1`);
            console.log("[Database] Da nang cap them cot canvas_noise vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột gpu_vendor vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN gpu_vendor TEXT DEFAULT NULL`);
            console.log("[Database] Da nang cap them cot gpu_vendor vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột gpu_renderer vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN gpu_renderer TEXT DEFAULT NULL`);
            console.log("[Database] Da nang cap them cot gpu_renderer vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột locale vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN locale TEXT DEFAULT 'vi-VN'`);
            console.log("[Database] Da nang cap them cot locale vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột webrtc_mode vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN webrtc_mode TEXT DEFAULT 'spoof'`);
            console.log("[Database] Da nang cap them cot webrtc_mode vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột fonts_mode vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN fonts_mode INTEGER DEFAULT 1`);
            console.log("[Database] Da nang cap them cot fonts_mode vao bang profiles.");
        } catch (e) {}

        // Nâng cấp DB: Thêm cột media_devices vào bảng profiles nếu chưa có
        try {
            await run(`ALTER TABLE profiles ADD COLUMN media_devices INTEGER DEFAULT 1`);
            console.log("[Database] Da nang cap them cot media_devices vao bang profiles.");
        } catch (e) {}



        // 2. Bảng scripts (Các kịch bản tự động hóa - danh sách các bước)
        await run(`
            CREATE TABLE IF NOT EXISTS scripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                steps TEXT NOT NULL,
                capture_config TEXT DEFAULT NULL
            )
        `);

        // 3. Bảng campaigns (Các chiến dịch nuôi tài khoản hoặc đăng ký hàng loạt)
        await run(`
            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                concurrent_threads INTEGER DEFAULT 1,
                total_profiles INTEGER DEFAULT 10,
                proxies TEXT,
                script_id INTEGER,
                status TEXT DEFAULT 'Stopped',
                campaign_mode INTEGER DEFAULT 0,
                skip_dead INTEGER DEFAULT 0,
                replace_dead INTEGER DEFAULT 0
            )
        `);

        // 4. Bảng settings (Lưu trữ cấu hình chung như khóa API dịch vụ thuê OTP)
        await run(`
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key_name TEXT UNIQUE,
                key_value TEXT
            )
        `);

        // Nâng cấp DB: Thêm cột save_created_accounts vào bảng campaigns nếu chưa có
        try {
            await run(`ALTER TABLE campaigns ADD COLUMN save_created_accounts INTEGER DEFAULT 0`);
            console.log("[Database] Da nang cap them cot save_created_accounts vao bang campaigns.");
        } catch (e) {}

        // Nâng cấp DB: Thêm các cột cho cấu hình chiến dịch nâng cao
        try {
            await run(`ALTER TABLE campaigns ADD COLUMN profile_country TEXT`);
        } catch (e) {}
        try {
            await run(`ALTER TABLE campaigns ADD COLUMN use_api_proxy INTEGER DEFAULT 0`);
        } catch (e) {}
        try {
            await run(`ALTER TABLE campaigns ADD COLUMN api_proxy_type TEXT`);
        } catch (e) {}
        try {
            await run(`ALTER TABLE campaigns ADD COLUMN api_proxy_key TEXT`);
        } catch (e) {}
        try {
            await run(`ALTER TABLE campaigns ADD COLUMN use_gateway_router INTEGER DEFAULT 0`);
        } catch (e) {}
        try {
            await run(`ALTER TABLE campaigns ADD COLUMN gateway_router_url TEXT`);
        } catch (e) {}

        // Nâng cấp DB: Thêm cột capture_config vào bảng scripts
        try {
            await run(`ALTER TABLE scripts ADD COLUMN capture_config TEXT DEFAULT NULL`);
            console.log("[Database] Da nang cap them cot capture_config vao bang scripts.");
        } catch (e) {}

        // 5. Bảng backups (Lịch sử sao lưu cookie và thông tin tài khoản)
        await run(`
            CREATE TABLE IF NOT EXISTS backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id INTEGER,
                name TEXT NOT NULL,
                proxy_server TEXT,
                proxy_user TEXT,
                proxy_pass TEXT,
                cookie_data TEXT,
                account_info TEXT,
                filepath TEXT,
                status TEXT DEFAULT 'Unknown',
                created_at TEXT,
                country TEXT DEFAULT NULL
            )
        `);

        // Nâng cấp DB: Thêm cột country vào bảng backups nếu chưa có (cho các DB cũ)
        try {
            await run(`ALTER TABLE backups ADD COLUMN country TEXT DEFAULT NULL`);
            console.log("[Database] Da nang cap them cot country vao bang backups.");
        } catch (e) {}

        // 6. Bảng captured_resources (Tài nguyên thu lưu từ luồng chạy tự động hóa)
        await run(`
            CREATE TABLE IF NOT EXISTS captured_resources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id INTEGER,
                service_name TEXT,
                username TEXT,
                password TEXT,
                email TEXT,
                email_password TEXT,
                phone TEXT,
                cookie_data TEXT,
                created_at TEXT
            )
        `);

        // 7. Bảng extensions (Lưu trữ kho tiện ích)
        await run(`
            CREATE TABLE IF NOT EXISTS extensions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                version TEXT,
                path TEXT NOT NULL UNIQUE,
                auto_install INTEGER DEFAULT 0,
                global_config_json TEXT DEFAULT '{}'
            )
        `);

        // Cập nhật cấu trúc bảng cho phiên bản cũ nếu chưa có cột global_config_json
        try {
            await run("ALTER TABLE extensions ADD COLUMN global_config_json TEXT DEFAULT '{}'");
        } catch (e) {
            // Cột đã tồn tại, bỏ qua
        }

        // 8. Bảng profile_extensions (Cấu hình riêng tiện ích cho từng profile)
        await run(`
            CREATE TABLE IF NOT EXISTS profile_extensions (
                profile_id INTEGER,
                extension_id INTEGER,
                enabled INTEGER DEFAULT 0,
                config_json TEXT DEFAULT '{}',
                PRIMARY KEY (profile_id, extension_id)
            )
        `);

        // 9. Bảng automation_logs (Nhật ký tự động hóa cho SQLite cục bộ)
        await run(`
            CREATE TABLE IF NOT EXISTS automation_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id INTEGER,
                verification_type TEXT,
                identity_used TEXT,
                otp_received TEXT,
                status TEXT,
                details TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (err) {
        console.error("Lỗi khi tạo bảng trong SQLite:", err);
    }
}

// Khởi chạy tạo bảng ngay khi import module
initDb().catch(err => console.error("Lỗi khởi tạo Database:", err));

// --- SETTINGS CRUD (Các hàm đọc ghi thiết lập cấu hình) ---
async function getSetting(keyName, defaultValue = null) {
    try {
        const row = await get('SELECT key_value FROM settings WHERE key_name = ?', [keyName]);
        return row ? row.key_value : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}

async function setSetting(keyName, keyValue) {
    await run(`
        INSERT INTO settings (key_name, key_value) 
        VALUES (?, ?)
        ON CONFLICT(key_name) DO UPDATE SET key_value = excluded.key_value
    `, [keyName, keyValue]);
}

async function getAllSettings() {
    try {
        const rows = await all('SELECT key_name, key_value FROM settings');
        const settings = {};
        rows.forEach(row => {
            settings[row.key_name] = row.key_value;
        });
        return settings;
    } catch (e) {
        return {};
    }
}

// --- PROFILE CRUD (Các hàm thao tác với Hồ sơ trình duyệt) ---
async function addProfile(name, userAgent, proxyServer, proxyUser, proxyPass, timezone, latitude, longitude, screenWidth, screenHeight, scriptId = null, useProxy = 0, proxyRotateUrl = null, useMcp = 0, country = null, fingerprintJson = null, deviceMemory = 8, hardwareConcurrency = 4, canvasNoise = 1, gpuVendor = null, gpuRenderer = null, locale = 'vi-VN', webrtcMode = 'spoof', fontsMode = 1, mediaDevices = 1) {
    const info = await run(`
        INSERT INTO profiles (
            name, user_agent, proxy_server, proxy_user, proxy_pass, timezone, latitude, longitude, screen_width, screen_height, script_id, use_proxy, proxy_rotate_url, use_mcp, country, fingerprint_json, device_memory, hardware_concurrency, canvas_noise, gpu_vendor, gpu_renderer, locale, webrtc_mode, fonts_mode, media_devices
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, userAgent, proxyServer, proxyUser, proxyPass, timezone, latitude, longitude, screenWidth, screenHeight, scriptId, useProxy, proxyRotateUrl, useMcp, country, fingerprintJson, deviceMemory, hardwareConcurrency, canvasNoise, gpuVendor, gpuRenderer, locale, webrtcMode, fontsMode, mediaDevices]);
    return info.lastID;
}

async function getProfiles() {
    return await all('SELECT * FROM profiles ORDER BY id DESC');
}

async function getProfile(profileId) {
    return await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
}

async function updateProfile(profileId, name, userAgent, proxyServer, proxyUser, proxyPass, timezone, latitude, longitude, screenWidth, screenHeight, scriptId = null, useProxy = 0, proxyRotateUrl = null, useMcp = 0, country = null, fingerprintJson = null, deviceMemory = 8, hardwareConcurrency = 4, canvasNoise = 1, gpuVendor = null, gpuRenderer = null, locale = 'vi-VN', webrtcMode = 'spoof', fontsMode = 1, mediaDevices = 1) {
    await run(`
        UPDATE profiles SET
            name = ?,
            user_agent = ?,
            proxy_server = ?,
            proxy_user = ?,
            proxy_pass = ?,
            timezone = ?,
            latitude = ?,
            longitude = ?,
            screen_width = ?,
            screen_height = ?,
            script_id = ?,
            use_proxy = ?,
            proxy_rotate_url = ?,
            use_mcp = ?,
            country = ?,
            fingerprint_json = ?,
            device_memory = ?,
            hardware_concurrency = ?,
            canvas_noise = ?,
            gpu_vendor = ?,
            gpu_renderer = ?,
            locale = ?,
            webrtc_mode = ?,
            fonts_mode = ?,
            media_devices = ?
        WHERE id = ?
    `, [name, userAgent, proxyServer, proxyUser, proxyPass, timezone, latitude, longitude, screenWidth, screenHeight, scriptId, useProxy, proxyRotateUrl, useMcp, country, fingerprintJson, deviceMemory, hardwareConcurrency, canvasNoise, gpuVendor, gpuRenderer, locale, webrtcMode, fontsMode, mediaDevices, profileId]);
}

async function deleteProfile(profileId) {
    await run('DELETE FROM profiles WHERE id = ?', [profileId]);
    await run('DELETE FROM profile_extensions WHERE profile_id = ?', [profileId]);
}

async function updateStatus(profileId, status) {
    await run('UPDATE profiles SET status = ? WHERE id = ?', [status, profileId]);
}

// --- SCRIPT CRUD (Các hàm thao tác với Kịch bản) ---
async function addScript(name, steps, captureConfig = null) {
    const info = await run('INSERT INTO scripts (name, steps, capture_config) VALUES (?, ?, ?)', [name, steps, captureConfig]);
    return info.lastID;
}

async function getScripts() {
    return await all('SELECT * FROM scripts ORDER BY id DESC');
}

async function getScript(scriptId) {
    return await get('SELECT * FROM scripts WHERE id = ?', [scriptId]);
}

async function updateScript(scriptId, name, steps, captureConfig = null) {
    await run('UPDATE scripts SET name = ?, steps = ?, capture_config = ? WHERE id = ?', [name, steps, captureConfig, scriptId]);
}

async function deleteScript(scriptId) {
    await run('DELETE FROM scripts WHERE id = ?', [scriptId]);
    await run('UPDATE profiles SET script_id = NULL WHERE script_id = ?', [scriptId]);
}

// --- CAMPAIGN CRUD (Các hàm thao tác với Chiến dịch) ---
async function addCampaign(name, concurrentThreads, totalProfiles, proxies, scriptId, campaignMode = 0, skipDead = 0, replaceDead = 0, saveCreatedAccounts = 0, profileCountry = 'random', useApiProxy = 0, apiProxyType = 'minproxy', apiProxyKey = '', useGatewayRouter = 0, gatewayRouterUrl = 'http://127.0.0.1:8080') {
    const info = await run(`
        INSERT INTO campaigns (name, concurrent_threads, total_profiles, proxies, script_id, campaign_mode, skip_dead, replace_dead, save_created_accounts, profile_country, use_api_proxy, api_proxy_type, api_proxy_key, use_gateway_router, gateway_router_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, concurrentThreads, totalProfiles, proxies, scriptId, campaignMode, skipDead, replaceDead, saveCreatedAccounts, profileCountry, useApiProxy, apiProxyType, apiProxyKey, useGatewayRouter, gatewayRouterUrl]);
    return info.lastID;
}

async function getCampaigns() {
    return await all('SELECT * FROM campaigns ORDER BY id DESC');
}

async function getCampaign(campaignId) {
    return await get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
}

async function updateCampaignStatus(campaignId, status) {
    await run('UPDATE campaigns SET status = ? WHERE id = ?', [status, campaignId]);
}

async function deleteCampaign(campaignId) {
    await run('DELETE FROM campaigns WHERE id = ?', [campaignId]);
}

// --- BACKUP CRUD (Các hàm thao tác với Bản sao lưu) ---
async function addBackup(profileId, name, proxyServer, proxyUser, proxyPass, cookieData, accountInfo, filepath, createdAt, country = null) {
    const info = await run(`
        INSERT INTO backups (profile_id, name, proxy_server, proxy_user, proxy_pass, cookie_data, account_info, filepath, created_at, status, country)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Unknown', ?)
    `, [profileId, name, proxyServer, proxyUser, proxyPass, cookieData, accountInfo, filepath, createdAt, country]);
    return info.lastID;
}

async function getBackups() {
    return await all('SELECT * FROM backups ORDER BY id DESC');
}

async function getBackup(backupId) {
    return await get('SELECT * FROM backups WHERE id = ?', [backupId]);
}

async function deleteBackup(backupId) {
    await run('DELETE FROM backups WHERE id = ?', [backupId]);
}

async function updateBackupStatus(backupId, status) {
    await run('UPDATE backups SET status = ? WHERE id = ?', [status, backupId]);
}

// --- CAPTURED RESOURCES CRUD (Các hàm thao tác với tài nguyên thu lưu) ---
async function addCapturedResource(profileId, serviceName, username, password, email, emailPassword, phone, cookieData) {
    const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const info = await run(`
        INSERT INTO captured_resources (profile_id, service_name, username, password, email, email_password, phone, cookie_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [profileId, serviceName, username, password, email, emailPassword, phone, cookieData, createdAt]);
    return info.lastID;
}

async function getCapturedResources() {
    return await all('SELECT * FROM captured_resources ORDER BY id DESC');
}

async function deleteCapturedResource(id) {
    await run('DELETE FROM captured_resources WHERE id = ?', [id]);
}

async function updateProfileMcpStatus(profileId, useMcp) {
    return await run('UPDATE profiles SET use_mcp = ? WHERE id = ?', [useMcp, profileId]);
}

async function updateProfileCountry(profileId, country) {
    return await run('UPDATE profiles SET country = ? WHERE id = ?', [country, profileId]);
}

async function updateBackupCountry(backupId, country) {
    return await run('UPDATE backups SET country = ? WHERE id = ?', [country, backupId]);
}

// Ghi log kịch bản tự động hóa (PostgreSQL / SQLite fallback)
async function addAutomationLog(profileId, verificationType, identityUsed, otpReceived, status, details = "") {
    // 1. Lấy thông tin kết nối PostgreSQL từ SQLite settings
    const pgHost = await getSetting("api_pg_host");
    const pgPort = parseInt(await getSetting("api_pg_port")) || 5432;
    const pgUser = await getSetting("api_pg_user");
    const pgPass = await getSetting("api_pg_pass");
    const pgDb = await getSetting("api_pg_db");

    let savedToPg = false;

    if (pgHost && pgUser && pgDb) {
        try {
            const { Client } = require('pg');
            const client = new Client({
                host: pgHost,
                port: pgPort,
                user: pgUser,
                password: pgPass,
                database: pgDb,
                connectionTimeoutMillis: 5000
            });
            await client.connect();

            // Tự động tạo bảng nếu chưa có
            await client.query(`
                CREATE TABLE IF NOT EXISTS automation_logs (
                    id SERIAL PRIMARY KEY,
                    profile_id INT,
                    verification_type VARCHAR(50),
                    identity_used VARCHAR(255),
                    otp_received VARCHAR(50),
                    status VARCHAR(50),
                    details TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Thêm bản ghi
            await client.query(`
                INSERT INTO automation_logs (profile_id, verification_type, identity_used, otp_received, status, details)
                VALUES ($1, $2, $3, $4, $5, $6);
            `, [profileId, verificationType, identityUsed, otpReceived, status, details]);

            await client.end();
            savedToPg = true;
            console.log(`[Database] Đã ghi log tự động hóa thành công vào PostgreSQL cho Profile ID ${profileId}.`);
        } catch (pgErr) {
            const errMsg = pgErr.message || (typeof pgErr === 'string' ? pgErr : pgErr.toString()) || "Lỗi kết nối không xác định";
            console.error(`[Database Error] Lỗi kết nối PostgreSQL: ${errMsg}. Tự động chuyển sang SQLite fallback...`);
        }
    }

    // 2. Fallback sang SQLite cục bộ (bảng automation_logs) nếu PostgreSQL không được cấu hình hoặc lỗi kết nối
    if (!savedToPg) {
        try {
            const createdAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
            await run(`
                INSERT INTO automation_logs (profile_id, verification_type, identity_used, otp_received, status, details, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [profileId, verificationType, identityUsed, otpReceived, status, details, createdAt]);
            console.log(`[Database] Đã ghi log tự động hóa thành công vào SQLite cục bộ cho Profile ID ${profileId}.`);
        } catch (sqliteErr) {
            console.error(`[Database Error] Lỗi ghi log SQLite: ${sqliteErr.message}`);
        }
    }
}

async function getExtensions() {
    return await all('SELECT * FROM extensions ORDER BY name ASC');
}

async function addExtension(name, version, path, autoInstall = 0) {
    return await run(`
        INSERT INTO extensions (name, version, path, auto_install)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET name = excluded.name, version = excluded.version
    `, [name, version, path, autoInstall]);
}

async function updateExtensionAutoInstall(id, autoInstall) {
    return await run('UPDATE extensions SET auto_install = ? WHERE id = ?', [autoInstall, id]);
}

async function getProfileExtensions(profileId) {
    return await all(`
        SELECT e.*, COALESCE(pe.enabled, 0) as enabled, COALESCE(pe.config_json, '{}') as config_json 
        FROM extensions e
        LEFT JOIN profile_extensions pe ON e.id = pe.extension_id AND pe.profile_id = ?
        ORDER BY e.name ASC
    `, [profileId]);
}

async function saveProfileExtensionConfig(profileId, extensionId, enabled, configJson) {
    return await run(`
        INSERT INTO profile_extensions (profile_id, extension_id, enabled, config_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, extension_id) DO UPDATE SET 
            enabled = excluded.enabled,
            config_json = excluded.config_json
    `, [profileId, extensionId, enabled, configJson]);
}

async function getEnabledExtensionsForProfile(profileId) {
    return await all(`
        SELECT e.*, pe.config_json 
        FROM extensions e
        INNER JOIN profile_extensions pe ON e.id = pe.extension_id
        WHERE pe.profile_id = ? AND pe.enabled = 1
    `, [profileId]);
}

async function updateExtensionGlobalConfig(id, globalConfigJson) {
    return await run('UPDATE extensions SET global_config_json = ? WHERE id = ?', [globalConfigJson, id]);
}

async function getExtensionProfilesMapping(extensionId) {
    return await all(`
        SELECT 
            p.id as profile_id, 
            p.name as profile_name,
            COALESCE(pe.enabled, 0) as enabled,
            COALESCE(pe.config_json, '{}') as config_json
        FROM profiles p
        LEFT JOIN profile_extensions pe ON p.id = pe.profile_id AND pe.extension_id = ?
        ORDER BY p.name ASC
    `, [extensionId]);
}

async function saveBulkProfileExtensionConfig(extensionId, mappings) {
    for (const item of mappings) {
        const enabled = parseInt(item.enabled) ? 1 : 0;
        const configJson = item.config_json || '{}';
        await run(`
            INSERT INTO profile_extensions (profile_id, extension_id, enabled, config_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(profile_id, extension_id) DO UPDATE SET 
                enabled = excluded.enabled,
                config_json = excluded.config_json
        `, [item.profile_id, extensionId, enabled, configJson]);
    }
    return true;
}

async function getProfileResourceStats(profileId) {
    const emailRes = await all("SELECT COUNT(*) as count FROM captured_resources WHERE profile_id = ? AND email IS NOT NULL AND email != ''", [profileId]);
    const phoneRes = await all("SELECT COUNT(*) as count FROM captured_resources WHERE profile_id = ? AND phone IS NOT NULL AND phone != ''", [profileId]);
    
    const captchaSolved = await all("SELECT COUNT(*) as count FROM automation_logs WHERE profile_id = ? AND details LIKE '%giải captcha thành công%'", [profileId]);
    const captchaFailed = await all("SELECT COUNT(*) as count FROM automation_logs WHERE profile_id = ? AND details LIKE '%giải captcha thất bại%'", [profileId]);
    
    return {
        emails: emailRes[0]?.count || 0,
        phones: phoneRes[0]?.count || 0,
        captcha_solved: captchaSolved[0]?.count || 0,
        captcha_failed: captchaFailed[0]?.count || 0
    };
}

module.exports = {
    getProfileResourceStats,
    getSetting,
    setSetting,
    getAllSettings,
    addProfile,
    getProfiles,
    getProfile,
    updateProfile,
    deleteProfile,
    updateStatus,
    addScript,
    getScripts,
    getScript,
    updateScript,
    deleteScript,
    addCampaign,
    getCampaigns,
    getCampaign,
    updateCampaignStatus,
    deleteCampaign,
    addBackup,
    getBackups,
    getBackup,
    deleteBackup,
    updateBackupStatus,
    addCapturedResource,
    getCapturedResources,
    deleteCapturedResource,
    addAutomationLog,
    updateProfileMcpStatus,
    updateProfileCountry,
    updateBackupCountry,
    getExtensions,
    addExtension,
    updateExtensionAutoInstall,
    getProfileExtensions,
    saveProfileExtensionConfig,
    getEnabledExtensionsForProfile,
    updateExtensionGlobalConfig,
    getExtensionProfilesMapping,
    saveBulkProfileExtensionConfig,
    loadPgConfig,
    getPgStatus
};

