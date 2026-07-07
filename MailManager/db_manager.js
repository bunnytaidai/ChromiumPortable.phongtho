const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'mail.db');
const db = new sqlite3.Database(dbPath);

// Khởi tạo các bảng cơ sở dữ liệu
function initDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Bảng quản lý Email
            db.run(`
                CREATE TABLE IF NOT EXISTS emails (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    address TEXT UNIQUE,
                    status TEXT DEFAULT 'active', -- active (hoạt động), inactive (tạm dừng), keep (lưu giữ lâu dài)
                    locked_by TEXT DEFAULT NULL,  -- profile_id hoặc luồng đang giữ để tránh trùng lặp
                    expires_at DATETIME,          -- thời điểm hết hạn của mail tạm
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // Bảng lưu trữ nội dung thư nhận được
            db.run(`
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email_address TEXT,
                    sender TEXT,
                    subject TEXT,
                    body_html TEXT,
                    body_text TEXT,
                    otp_code TEXT,                -- mã OTP tự động bóc tách được
                    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // Bảng lưu cấu hình hệ thống
            db.run(`
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT UNIQUE PRIMARY KEY,
                    value TEXT
                )
            `, (err) => {
                if (err) return reject(err);
                
                // Thêm một số cấu hình mặc định nếu chưa có
                const defaultSettings = [
                    ['domain', 'yourdomain.com'],
                    ['use_api_fallback', '1'], // 1: Bật dùng API bên thứ 3 (Mail.tm), 0: Chỉ dùng tên miền riêng
                    ['smtp_host', ''],
                    ['smtp_port', '587'],
                    ['smtp_user', ''],
                    ['smtp_pass', '']
                ];
                
                const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
                defaultSettings.forEach(setting => stmt.run(setting));
                stmt.finalize();
                
                resolve();
            });
        });
    });
}

// Bóc tách mã OTP tự động bằng biểu thức chính quy (Regex)
function extractOtp(subject, bodyText) {
    if (!bodyText) bodyText = "";
    if (!subject) subject = "";
    
    // Ưu tiên quét trong tiêu đề trước vì tiêu đề thường chứa mã OTP trực tiếp
    const otpRegex = /\b\d{4,8}\b/; // Tìm chuỗi số có độ dài từ 4 đến 8 chữ số liên tục
    let match = subject.match(otpRegex);
    if (match) return match[0];

    // Nếu tiêu đề không có, quét trong nội dung văn bản
    const textToSearch = bodyText.toLowerCase();
    const keywords = ['code', 'otp', 'verification', 'xác nhận', 'xác minh', 'pin', 'mật khẩu', 'pwd'];
    const hasKeyword = keywords.some(keyword => textToSearch.includes(keyword));
    
    if (hasKeyword || true) { // Cứ quét lấy số 4-8 ký tự làm dự phòng
        const matches = bodyText.match(/\b\d{4,8}\b/g);
        if (matches && matches.length > 0) {
            // Lọc bỏ năm hiện tại (như 2026, 2025) để tránh nhận nhầm thông tin thời gian làm OTP
            const filtered = matches.filter(num => num !== '2026' && num !== '2025');
            if (filtered.length > 0) return filtered[0];
            return matches[0];
        }
    }
    return null;
}

// --- HÀM TƯƠNG TÁC VỚI BẢNG EMAILS ---

function addEmail(address, expiresInSeconds = 3600, lockedBy = null) {
    return new Promise((resolve, reject) => {
        const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
        db.run(
            `INSERT OR REPLACE INTO emails (address, status, expires_at, locked_by) VALUES (?, 'active', ?, ?)`,
            [address, expiresAt, lockedBy],
            function(err) {
                if (err) return reject(err);
                resolve(this.lastID);
            }
        );
    });
}

function deleteEmail(address) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`DELETE FROM emails WHERE address = ?`, [address], (err) => {
                if (err) return reject(err);
            });
            // Xóa luôn các thư liên quan để giải phóng bộ nhớ
            db.run(`DELETE FROM messages WHERE email_address = ?`, [address], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}

function updateEmailStatus(address, status) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE emails SET status = ? WHERE address = ?`,
            [status, address],
            (err) => {
                if (err) return reject(err);
                resolve();
            }
        );
    });
}

function lockEmail(address, lockedBy) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE emails SET locked_by = ? WHERE address = ?`,
            [lockedBy, address],
            (err) => {
                if (err) return reject(err);
                resolve();
            }
        );
    });
}

function getEmails() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM emails ORDER BY created_at DESC`, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getEmail(address) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM emails WHERE address = ?`, [address], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

// --- HÀM TƯƠNG TÁC VỚI BẢNG MESSAGES ---

function addMessage(emailAddress, sender, subject, bodyHtml, bodyText) {
    return new Promise((resolve, reject) => {
        // Kiểm tra xem email nhận thư có đang hoạt động (active hoặc keep) không
        db.get(`SELECT status FROM emails WHERE address = ?`, [emailAddress], (err, emailRow) => {
            if (err) return reject(err);
            
            // Nếu email không tồn tại hoặc ở trạng thái 'inactive' (tắt kích hoạt), ta bỏ qua không lưu
            if (!emailRow || emailRow.status === 'inactive') {
                console.log(`[Mail Server Warning] Bỏ qua thư gửi tới ${emailAddress} do email này đã tắt kích hoạt hoặc không tồn tại.`);
                return resolve(null);
            }

            const otpCode = extractOtp(subject, bodyText);
            db.run(
                `INSERT INTO messages (email_address, sender, subject, body_html, body_text, otp_code) VALUES (?, ?, ?, ?, ?, ?)`,
                [emailAddress, sender, subject, bodyHtml, bodyText, otpCode],
                function(err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID, otpCode });
                }
            );
        });
    });
}

function getMessages(emailAddress) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM messages WHERE email_address = ? ORDER BY received_at DESC`,
            [emailAddress],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            }
        );
    });
}

// Lấy mã OTP mới nhất cho một email cụ thể từ dịch vụ gửi thư chỉ định
function getOtp(emailAddress, senderDomain = null) {
    return new Promise((resolve, reject) => {
        let query = `SELECT otp_code, received_at FROM messages WHERE email_address = ? AND otp_code IS NOT NULL`;
        const params = [emailAddress];
        
        if (senderDomain) {
            query += ` AND (sender LIKE ? OR subject LIKE ?)`;
            params.push(`%${senderDomain}%`, `%${senderDomain}%`);
        }
        
        // Chỉ lấy OTP nhận được trong vòng 3 phút qua để tránh lấy loạn mã cũ
        query += ` AND received_at >= datetime('now', '-3 minutes') ORDER BY received_at DESC LIMIT 1`;
        
        db.get(query, params, (err, row) => {
            if (err) return reject(err);
            resolve(row ? row.otp_code : null);
        });
    });
}

function clearOldEmails() {
    return new Promise((resolve, reject) => {
        // Chỉ xóa các email có trạng thái 'active' đã hết hạn (status = 'keep' sẽ không bị xóa)
        db.serialize(() => {
            db.all(`SELECT address FROM emails WHERE expires_at < datetime('now') AND status = 'active'`, [], (err, rows) => {
                if (err) return reject(err);
                if (rows.length === 0) return resolve();
                
                const addresses = rows.map(r => r.address);
                const placeholders = addresses.map(() => '?').join(',');
                
                db.run(`DELETE FROM messages WHERE email_address IN (${placeholders})`, addresses, (err) => {
                    if (err) return reject(err);
                });
                
                db.run(`DELETE FROM emails WHERE expires_at < datetime('now') AND status = 'active'`, [], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        });
    });
}

// --- HÀM TƯƠNG TÁC VỚI BẢNG SETTINGS ---

function getSetting(key) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT value FROM settings WHERE key = ?`, [key], (err, row) => {
            if (err) return reject(err);
            resolve(row ? row.value : null);
        });
    });
}

function getAllSettings() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM settings`, [], (err, rows) => {
            if (err) return reject(err);
            const settingsObj = {};
            rows.forEach(row => {
                settingsObj[row.key] = row.value;
            });
            resolve(settingsObj);
        });
    });
}

function setSetting(key, value) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
            [key, value.toString()],
            (err) => {
                if (err) return reject(err);
                resolve();
            }
        );
    });
}

// Khởi chạy dọn dẹp email hết hạn định kỳ mỗi 1 phút
setInterval(() => {
    clearOldEmails().catch(err => console.error("Lỗi khi dọn dẹp email hết hạn:", err));
}, 60000);

module.exports = {
    initDatabase,
    addEmail,
    deleteEmail,
    updateEmailStatus,
    lockEmail,
    getEmails,
    getEmail,
    addMessage,
    getMessages,
    getOtp,
    getSetting,
    getAllSettings,
    setSetting
};
