const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const dbManager = require('./db_manager');

const app = express();
const PORT = 5001; // Chạy trên cổng 5001 để tránh xung đột với ProfileManager (cổng 5000)

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'static')));

// --- HÀM GỬI LOG VỀ BẢNG TRẠNG THÁI HOẠT ĐỘNG Ở SERVER CHÍNH ---
async function sendLogToMainServer(level, message) {
    try {
        const payload = { level, message };
        // Gửi POST tới server chính ở cổng 5000 để ghi log hiển thị trên GUI chính
        const options = {
            hostname: '127.0.0.1',
            port: 5000,
            path: '/api/logs',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 2000
        };
        
        const req = http.request(options);
        req.on('error', () => {}); // Bỏ qua lỗi kết nối nếu server chính chưa bật
        req.write(JSON.stringify(payload));
        req.end();
    } catch (e) {
        // Bỏ qua lỗi
    }
}

// Khởi chạy cơ sở dữ liệu
dbManager.initDatabase()
    .then(async () => {
        console.log('[Mail Server] Khởi tạo cơ sở dữ liệu thành công.');
        sendLogToMainServer('INFO', 'Khởi tạo cơ sở dữ liệu mail.db thành công.');

        // Tự động kết nối lại Cloudflare Tunnel nếu phiên trước đó đã được bật
        try {
            const autoTunnel = await dbManager.getSetting('tunnel_enabled');
            if (autoTunnel === '1') {
                console.log('[Mail Server] Phát hiện trạng thái Tunnel đã bật ở phiên trước. Đang tự động kết nối lại...');
                setTimeout(() => {
                    startCloudflareTunnel().catch(err => {
                        console.error('[Mail Server Error] Lỗi tự động bật Cloudflare Tunnel:', err.message);
                    });
                }, 3000); // Chờ 3 giây để đảm bảo mọi dịch vụ khác đã khởi động xong
            }
        } catch (e) {
            console.error('[Mail Server Error] Lỗi kiểm tra cấu hình tự động bật tunnel:', e);
        }
    })
    .catch(err => {
        console.error('[Mail Server Error] Lỗi khởi tạo cơ sở dữ liệu:', err);
        sendLogToMainServer('ERROR', `Lỗi khởi tạo cơ sở dữ liệu mail.db: ${err.message}`);
    });

// Phục vụ giao diện chính
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// --- BIẾN TOÀN CỤC QUẢN LÝ CLOUDFLARE TUNNEL ---
let cloudflaredProcess = null;
let cloudflaredUrl = "";
let tunnelStatus = "disconnected"; // disconnected, downloading, connecting, connected, error
let tunnelError = "";

// Hàm tải cloudflared.exe từ Github
function downloadCloudflared() {
    const dest = path.join(__dirname, 'cloudflared.exe');
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    
    return new Promise((resolve, reject) => {
        if (fs.existsSync(dest)) {
            return resolve(); // Tệp đã tồn tại
        }
        
        console.log('[Mail Server] Không tìm thấy cloudflared.exe. Đang bắt đầu tải tự động từ Cloudflare Github...');
        sendLogToMainServer('WARNING', 'Không tìm thấy tệp cloudflared.exe phục vụ Tunnel. Đang tự động tải từ Github (khoảng 30MB)...');
        tunnelStatus = "downloading";
        
        function download(downloadUrl) {
            https.get(downloadUrl, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    // Xử lý chuyển hướng HTTP redirect
                    download(response.headers.location);
                    return;
                }
                
                if (response.statusCode !== 200) {
                    const err = new Error(`Tải file thất bại, HTTP Status: ${response.statusCode}`);
                    sendLogToMainServer('ERROR', `Tải tệp cloudflared.exe thất bại: HTTP Status ${response.statusCode}`);
                    reject(err);
                    return;
                }
                
                const file = fs.createWriteStream(dest);
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    console.log('[Mail Server] Đã tải xong tệp cloudflared.exe thành công.');
                    sendLogToMainServer('INFO', 'Tải tệp cloudflared.exe phục vụ kết nối đường hầm thành công!');
                    resolve();
                });
                
                file.on('error', (err) => {
                    fs.unlink(dest, () => {});
                    sendLogToMainServer('ERROR', `Lỗi ghi tệp cloudflared.exe: ${err.message}`);
                    reject(err);
                });
            }).on('error', (err) => {
                sendLogToMainServer('ERROR', `Lỗi kết nối tải cloudflared.exe: ${err.message}`);
                reject(err);
            });
        }
        
        download(url);
    });
}

// --- API QUẢN LÝ EMAIL ---

// Lấy danh sách email
app.get('/api/emails', async (req, res) => {
    try {
        const emails = await dbManager.getEmails();
        res.json({ success: true, data: emails });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Tạo email mới (cho phép tự chọn tên hoặc sinh ngẫu nhiên)
app.post('/api/emails/create', async (req, res) => {
    const { address, expires_in, locked_by } = req.body;
    let emailAddress = address;

    try {
        const settings = await dbManager.getAllSettings();
        const domain = settings.domain || 'yourdomain.com';

        // Nếu không cung cấp địa chỉ, tự động sinh ngẫu nhiên
        if (!emailAddress) {
            const randomString = Math.random().toString(36).substring(2, 12);
            emailAddress = `${randomString}@${domain}`;
        } else if (!emailAddress.includes('@')) {
            // Nếu chỉ truyền phần tên trước @, tự ghép với domain cấu hình
            emailAddress = `${emailAddress}@${domain}`;
        }

        // Kiểm tra xem email đã tồn tại chưa
        const existingEmail = await dbManager.getEmail(emailAddress);
        if (existingEmail) {
            // Nếu đã tồn tại và đang hoạt động, trả về thông tin cũ
            return res.json({ 
                success: true, 
                address: emailAddress, 
                message: 'Email đã tồn tại và đang hoạt động.',
                id: existingEmail.id
            });
        }

        const expiresIn = expires_in ? parseInt(expires_in) : 3600; // Mặc định 1 giờ
        const id = await dbManager.addEmail(emailAddress, expiresIn, locked_by || null);

        sendLogToMainServer('INFO', `Đã khởi tạo hòm thư tạm mới: ${emailAddress}${locked_by ? ` (Sử dụng bởi luồng: ${locked_by})` : ''}`);

        res.json({
            success: true,
            id: id,
            address: emailAddress,
            expires_in: expiresIn,
            message: 'Tạo email tạm thời thành công!'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Xóa email và tin nhắn liên quan
app.post('/api/emails/delete', async (req, res) => {
    const { address } = req.body;
    if (!address) {
        return res.status(400).json({ success: false, error: 'Địa chỉ email là bắt buộc.' });
    }

    try {
        await dbManager.deleteEmail(address);
        sendLogToMainServer('WARNING', `Đã xóa hòm thư và toàn bộ tin nhắn của: ${address}`);
        res.json({ success: true, message: 'Đã xóa email thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Cập nhật trạng thái email (active, inactive, keep)
app.post('/api/emails/update-status', async (req, res) => {
    const { address, status } = req.body;
    if (!address || !status) {
        return res.status(400).json({ success: false, error: 'Thiếu thông tin địa chỉ email hoặc trạng thái.' });
    }

    try {
        await dbManager.updateEmailStatus(address, status);
        let vietnameseStatus = 'Hoạt động';
        if (status === 'inactive') vietnameseStatus = 'Tắt kích hoạt';
        else if (status === 'keep') vietnameseStatus = 'Giữ mail lâu dài';
        
        sendLogToMainServer('INFO', `Thay đổi trạng thái hòm thư ${address} thành: [${vietnameseStatus}]`);
        res.json({ success: true, message: `Đã cập nhật trạng thái email sang: ${status}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Lấy danh sách tin nhắn của một email cụ thể
app.get('/api/emails/:address/messages', async (req, res) => {
    const address = req.params.address;
    try {
        const messages = await dbManager.getMessages(address);
        res.json({ success: true, data: messages });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- API WEBHOOK NHẬN THƯ (TỪ CLOUDFLARE WORKER) ---

app.post('/api/webhook/receive-email', async (req, res) => {
    const { from, to, subject, html, text } = req.body;
    
    if (!to || !from) {
        return res.status(400).json({ success: false, error: 'Dữ liệu người gửi và người nhận là bắt buộc.' });
    }

    try {
        // Chuẩn hóa địa chỉ email nhận thư về chữ thường
        const recipient = to.toLowerCase().trim();
        const result = await dbManager.addMessage(recipient, from, subject || '', html || '', text || '');
        
        if (result) {
            console.log(`[Mail Server] Nhận email mới thành công từ: ${from} tới: ${recipient}. OTP: ${result.otpCode || 'Không có'}`);
            sendLogToMainServer('INFO', `Nhận thư thành công từ: ${from} gửi tới: ${recipient}. Mã OTP trích xuất: [${result.otpCode || 'Không tìm thấy'}]`);
            res.json({ success: true, message: 'Nhận thư thành công.', otp_code: result.otpCode });
        } else {
            sendLogToMainServer('WARNING', `Bỏ qua thư từ ${from} gửi tới ${recipient} do hòm thư này đã tắt kích hoạt hoặc không tồn tại.`);
            res.json({ success: true, message: 'Bỏ qua thư do hộp thư này đã dừng hoạt động.' });
        }
    } catch (err) {
        console.error('[Mail Server Error] Lỗi ghi nhận email mới từ Webhook:', err.message);
        sendLogToMainServer('ERROR', `Lỗi nhận thư từ Webhook gửi tới ${to}: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- API TRUY VẤN OTP TỰ ĐỘNG (DÀNH CHO ĐA LUỒNG) ---

app.get('/api/otp', async (req, res) => {
    const { email, sender } = req.query;

    if (!email) {
        return res.status(400).json({ success: false, error: 'Thiếu tham số email để tra cứu.' });
    }

    try {
        const otpCode = await dbManager.getOtp(email.toLowerCase().trim(), sender || null);
        if (otpCode) {
            sendLogToMainServer('INFO', `[API Auto] Luồng tự động đã lấy thành công OTP của mail ${email}: [${otpCode}]`);
            res.json({ success: true, otp: otpCode });
        } else {
            res.json({ success: false, message: 'Chưa có mã OTP mới hoặc OTP đã quá hạn (3 phút).' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- API GỬI EMAIL ĐI (SỬ DỤNG SMTP CẤU HÌNH) ---

app.post('/api/emails/send', async (req, res) => {
    const { from, to, subject, text, html } = req.body;

    if (!from || !to || !subject || (!text && !html)) {
        return res.status(400).json({ success: false, error: 'Thiếu thông tin gửi thư (người nhận, tiêu đề hoặc nội dung).' });
    }

    try {
        const settings = await dbManager.getAllSettings();
        
        if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
            return res.status(400).json({ success: false, error: 'Cấu hình SMTP gửi thư chưa được cài đặt trong phần Cấu hình.' });
        }

        // Tạo bộ vận chuyển nodemailer (transporter)
        const transporter = nodemailer.createTransport({
            host: settings.smtp_host,
            port: parseInt(settings.smtp_port || 587),
            secure: parseInt(settings.smtp_port) === 465, // true nếu là cổng 465, false cho các cổng khác
            auth: {
                user: settings.smtp_user,
                pass: settings.smtp_pass
            }
        });

        const info = await transporter.sendMail({
            from: `"${from.split('@')[0]}" <${settings.smtp_user}>`, // Đổi tên hiển thị từ tên email phụ, gửi bằng tài khoản SMTP chính
            to,
            subject,
            text,
            html,
            headers: {
                'Reply-To': from // Khách hàng rep lại sẽ gửi về email phụ này
            }
        });

        console.log(`[Mail Server] Đã gửi email thành công từ ${from} tới ${to}. ID: ${info.messageId}`);
        sendLogToMainServer('INFO', `Đã gửi thành công email từ hòm thư phụ ${from} tới: ${to}. Tiêu đề: "${subject}"`);
        res.json({ success: true, message: 'Gửi thư thành công!', messageId: info.messageId });
    } catch (err) {
        console.error('[Mail Server Error] Lỗi khi gửi email SMTP:', err.message);
        sendLogToMainServer('ERROR', `Lỗi gửi thư SMTP từ ${from} tới ${to}: ${err.message}`);
        res.status(500).json({ success: false, error: `Lỗi gửi thư: ${err.message}` });
    }
});

// --- API CẤU HÌNH HỆ THỐNG ---

app.get('/api/settings', async (req, res) => {
    try {
        const settings = await dbManager.getAllSettings();
        res.json({ success: true, data: settings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
    const data = req.body || {};
    try {
        for (const [k, v] of Object.entries(data)) {
            const val = typeof v === 'string' ? v.trim() : v;
            await dbManager.setSetting(k, val);
        }
        sendLogToMainServer('INFO', 'Cấu hình hệ thống MailManager đã được cập nhật.');
        res.json({ success: true, message: 'Lưu cấu hình hệ thống thành công!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- API CLOUDFLARE TUNNEL TỰ ĐỘNG ---

// Lấy trạng thái hiện tại của Tunnel
app.get('/api/tunnel/status', (req, res) => {
    res.json({
        success: true,
        status: tunnelStatus,
        url: cloudflaredUrl,
        error: tunnelError
    });
});

// Hàm tự động cập nhật và deploy mã nguồn lên Cloudflare Worker qua API
async function updateCloudflareWorkerWebhook(webhookUrl) {
    try {
        const settings = await dbManager.getAllSettings();
        const cfEmail = settings.cf_email ? settings.cf_email.trim() : "";
        const cfToken = settings.cf_token ? settings.cf_token.trim() : "";
        const cfAccountId = settings.cf_account_id ? settings.cf_account_id.trim() : "";
        const cfWorkerName = (settings.cf_worker_name || "mail-webhook").trim();

        if (!cfToken || !cfAccountId) {
            console.log('[Mail Server] Bỏ qua tự động đồng bộ Cloudflare Worker do thiếu cấu hình Token/Account ID.');
            return;
        }

        console.log(`[Mail Server] Đang tự động triển khai mã nguồn lên Cloudflare Worker '${cfWorkerName}'...`);
        sendLogToMainServer('INFO', `Đang kết nối Cloudflare API để triển khai mã nguồn lên Worker: ${cfWorkerName}...`);

        // Đọc mã nguồn Worker từ tệp cloudflare_worker.js
        const workerFilePath = path.join(__dirname, 'cloudflare_worker.js');
        if (!fs.existsSync(workerFilePath)) {
            throw new Error("Không tìm thấy tệp cloudflare_worker.js trong thư mục MailManager.");
        }

        let workerCode = fs.readFileSync(workerFilePath, 'utf8');
        
        // Thay thế URL Webhook động bằng regex
        const webhookRegex = /const\s+WEBHOOK_URL\s*=\s*["'][^"']*["']/g;
        if (webhookRegex.test(workerCode)) {
            workerCode = workerCode.replace(webhookRegex, `const WEBHOOK_URL = "${webhookUrl}"`);
        } else {
            // Nếu không khớp regex, chèn thêm vào đầu file
            workerCode = `const WEBHOOK_URL = "${webhookUrl}";\n` + workerCode;
        }

        const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${cfWorkerName}`;
        
        const headers = {};
        if (cfToken.startsWith('cfut_') || cfToken.length > 40) {
            headers["Authorization"] = `Bearer ${cfToken}`;
        } else if (cfEmail) {
            headers["X-Auth-Email"] = cfEmail;
            headers["X-Auth-Key"] = cfToken;
        } else {
            headers["Authorization"] = `Bearer ${cfToken}`;
        }

        // Đóng gói dạng multipart/form-data để Cloudflare hiểu đây là ES Module Worker
        const formData = new FormData();
        const metadata = {
            main_module: "worker.js"
        };
        formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
        formData.append("worker.js", new Blob([workerCode], { type: "application/javascript+module" }), "worker.js");

        // Đọc và đóng gói kèm theo thư viện postal-mime cục bộ
        const postalMimeFilePath = path.join(__dirname, 'postal_mime_esm.js');
        if (fs.existsSync(postalMimeFilePath)) {
            const postalMimeCode = fs.readFileSync(postalMimeFilePath, 'utf8');
            formData.append("postal_mime_esm.js", new Blob([postalMimeCode], { type: "application/javascript+module" }), "postal_mime_esm.js");
        } else {
            console.error('[Mail Server Error] Không tìm thấy file postal_mime_esm.js cục bộ!');
        }

        const response = await fetch(url, {
            method: "PUT",
            headers: headers,
            body: formData
        });

        const resJson = await response.json();
        if (resJson.success) {
            console.log('[Mail Server] Triển khai Cloudflare Worker thành công!');
            sendLogToMainServer('INFO', `Đồng bộ Cloudflare Worker thành công! Worker '${cfWorkerName}' đã được tạo/cập nhật tự động và trỏ về link tunnel: ${webhookUrl}`);
        } else {
            const errs = resJson.errors ? resJson.errors.map(e => e.message).join(', ') : 'Lỗi không xác định';
            throw new Error(errs);
        }
    } catch (err) {
        console.error('[Mail Server Error] Lỗi khi triển khai Cloudflare Worker:', err.message);
        sendLogToMainServer('WARNING', `Triển khai Cloudflare Worker thất bại: ${err.message}. Bạn cần cập nhật URL Webhook thủ công.`);
    }
}

// Hàm khởi chạy kết nối Cloudflare Tunnel
async function startCloudflareTunnel() {
    if (cloudflaredProcess) return;
    
    tunnelError = "";
    tunnelStatus = "connecting";
    
    // Bước 1: Đảm bảo đã có cloudflared.exe (tự tải nếu chưa có)
    await downloadCloudflared();
    
    // Bước 2: Chạy tiến trình ngầm tạo Quick Tunnel
    console.log('[Mail Server] Bật kết nối Cloudflare Tunnel ngầm...');
    sendLogToMainServer('INFO', 'Đang khởi chạy tiến trình ngầm Cloudflare Tunnel để tạo đường hầm public...');
    
    const cloudflaredExePath = path.join(__dirname, 'cloudflared.exe');
    // Chạy lệnh: cloudflared.exe tunnel --url http://127.0.0.1:5001
    cloudflaredProcess = spawn(cloudflaredExePath, ['tunnel', '--url', `http://127.0.0.1:${PORT}`]);
    
    let detectedUrl = false;

    // Đọc log xuất ra của tiến trình để lọc link .trycloudflare.com
    const handleData = (data) => {
        const dataStr = data.toString();
        
        // Regex tìm kiếm đường link trycloudflare
        const match = dataStr.match(/https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com/);
        if (match && !detectedUrl) {
            detectedUrl = true;
            cloudflaredUrl = match[0];
            tunnelStatus = "connected";
            
            // Chỉ tự động cập nhật tên miền nếu tên miền hiện tại chưa được cài đặt (để trống, mặc định hoặc là link tunnel cũ)
            const domainOnly = cloudflaredUrl.replace('https://', '');
            dbManager.getSetting('domain')
                .then(currentDomain => {
                    if (!currentDomain || currentDomain === 'yourdomain.com' || currentDomain.includes('trycloudflare.com')) {
                        dbManager.setSetting('domain', domainOnly)
                            .then(() => {
                                console.log(`[Mail Server] Đã tự động cập nhật tên miền hệ thống thành: ${domainOnly}`);
                                sendLogToMainServer('INFO', `Tên miền nhận mail phụ được tự động cập nhật thành: ${domainOnly}`);
                            });
                    } else {
                        console.log(`[Mail Server] Giữ nguyên tên miền riêng của người dùng: ${currentDomain}`);
                    }
                })
                .catch(e => console.error('[Mail Server Error] Lỗi tự động lưu domain:', e.message));
                
            // Gọi hàm tự động cập nhật biến môi trường trên Cloudflare Worker
            updateCloudflareWorkerWebhook(`${cloudflaredUrl}/api/webhook/receive-email`);

            console.log(`[Mail Server] Kết nối Cloudflare Tunnel thành công! Địa chỉ công khai: ${cloudflaredUrl}`);
            sendLogToMainServer('INFO', `Kết nối Cloudflare Tunnel thành công! Đường dẫn nhận mail công khai: ${cloudflaredUrl}`);
        }
    };

    cloudflaredProcess.stdout.on('data', handleData);
    cloudflaredProcess.stderr.on('data', handleData);

    cloudflaredProcess.on('close', (code) => {
        console.log(`[Mail Server] Tiến trình Cloudflare Tunnel đóng với mã exit: ${code}`);
        cloudflaredProcess = null;
        cloudflaredUrl = "";
        if (tunnelStatus !== "disconnected") {
            tunnelStatus = "error";
            tunnelError = `Đường hầm bị đóng đột ngột (Mã lỗi: ${code})`;
            sendLogToMainServer('ERROR', `Cloudflare Tunnel bị ngắt kết nối đột ngột (Mã lỗi: ${code})`);
        }
    });

    cloudflaredProcess.on('error', (err) => {
        console.error('[Mail Server Error] Lỗi khởi chạy tiến trình cloudflared:', err.message);
        sendLogToMainServer('ERROR', `Lỗi khởi chạy tiến trình cloudflared.exe: ${err.message}`);
        cloudflaredProcess = null;
        cloudflaredUrl = "";
        tunnelStatus = "error";
        tunnelError = `Lỗi hệ thống: ${err.message}`;
    });

    // Chờ tối đa 20 giây để lấy URL, nếu không coi như timeout kết nối lỗi
    setTimeout(() => {
        if (tunnelStatus === "connecting") {
            tunnelStatus = "error";
            tunnelError = "Kết nối hết hạn (Timeout). Vui lòng thử lại.";
            sendLogToMainServer('ERROR', 'Khởi chạy Cloudflare Tunnel thất bại: Kết nối hết hạn (Timeout 20 giây).');
            if (cloudflaredProcess) {
                cloudflaredProcess.kill();
                cloudflaredProcess = null;
            }
        }
    }, 20000);
}

// Bật hoặc Tắt Tunnel
app.post('/api/tunnel/toggle', async (req, res) => {
    const { enable } = req.body;

    if (enable) {
        if (cloudflaredProcess) {
            return res.json({ success: true, status: tunnelStatus, url: cloudflaredUrl, message: 'Đường hầm đang chạy.' });
        }

        try {
            await dbManager.setSetting('tunnel_enabled', '1');
            await startCloudflareTunnel();
            res.json({ success: true, status: 'connecting', message: 'Đang khởi chạy đường hầm kết nối...' });
        } catch (err) {
            console.error('[Mail Server Error] Không thể khởi chạy Tunnel:', err.message);
            tunnelStatus = "error";
            tunnelError = err.message;
            sendLogToMainServer('ERROR', `Khởi chạy Tunnel thất bại: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        }
    } else {
        if (!cloudflaredProcess) {
            tunnelStatus = "disconnected";
            cloudflaredUrl = "";
            await dbManager.setSetting('tunnel_enabled', '0');
            return res.json({ success: true, status: 'disconnected', message: 'Đường hầm đã ở trạng thái tắt.' });
        }

        try {
            console.log('[Mail Server] Tắt kết nối Cloudflare Tunnel...');
            tunnelStatus = "disconnected";
            cloudflaredUrl = "";
            await dbManager.setSetting('tunnel_enabled', '0');
            cloudflaredProcess.kill('SIGINT'); // Gửi lệnh ngắt tiến trình
            cloudflaredProcess = null;
            
            sendLogToMainServer('INFO', 'Đã ngắt kết nối và giải phóng đường hầm Cloudflare Tunnel thành công.');
            res.json({ success: true, status: 'disconnected', message: 'Đã tắt đường hầm kết nối.' });
        } catch (err) {
            sendLogToMainServer('ERROR', `Lỗi khi ngắt kết nối Cloudflare Tunnel: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        }
    }
});

// Khởi chạy server
app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Mail Server] Hệ thống Mail tạm thời đang hoạt động tại: http://127.0.0.1:${PORT}`);
    // Đợi 2 giây cho server chính sẵn sàng rồi gửi log
    setTimeout(() => {
        sendLogToMainServer('INFO', 'Máy chủ MailManager đã được khởi động và đang lắng nghe ở cổng 5001.');
    }, 2000);
});
