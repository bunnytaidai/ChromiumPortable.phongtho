const puppeteer = require('puppeteer-extra');
const { createCursor } = require('ghost-cursor');
const dbManager = require('./db_manager');
const browserLauncher = require('./browser_launcher');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Hàm bổ trợ gửi yêu cầu HTTP bằng curl (tránh lỗi thoát ký tự trên Windows bằng file tạm)
function makeHttpRequestWithCurl(url, method = "GET", data = null, headers = {}, proxyUrl = null, timeout = 10000) {
    return new Promise((resolve, reject) => {
        let cmd = `curl -s -S -X ${method}`;
        
        // Cấu hình Timeout
        cmd += ` --max-time ${Math.ceil(timeout / 1000)}`;
        
        // Cấu hình Proxy nếu có
        if (proxyUrl) {
            cmd += ` -x "${proxyUrl}"`;
        }
        
        // Cấu hình Headers
        const finalHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            ...headers
        };
        for (const [k, v] of Object.entries(finalHeaders)) {
            cmd += ` -H "${k}: ${v}"`;
        }
        
        // Cấu hình Post Data qua file tạm để tránh lỗi thoát ký tự đặc biệt trên Shell Windows
        let tempFilePath = null;
        if (data) {
            const bodyStr = typeof data === 'object' ? JSON.stringify(data) : data;
            const tempDir = path.join(__dirname, 'backups_data');
            try {
                fs.mkdirSync(tempDir, { recursive: true });
                tempFilePath = path.join(tempDir, `temp_curl_ae_${Date.now()}_${Math.floor(Math.random() * 10000)}.json`);
                fs.writeFileSync(tempFilePath, bodyStr, 'utf8');
                cmd += ` -d "@${tempFilePath}"`;
            } catch (errFile) {
                // Nếu không ghi được file, fallback sang truyền trực tiếp (dù có thể lỗi kí tự)
                cmd += ` -d "${bodyStr.replace(/"/g, '\\"')}"`;
            }
        }
        
        cmd += ` "${url}"`;
        
        exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            // Xóa file tạm
            if (tempFilePath) {
                try {
                    if (fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath);
                    }
                } catch (e) {}
            }
            
            if (error) {
                return reject(new Error(`Curl process error: ${error.message}. Stderr: ${stderr}`));
            }
            
            if (!stdout || !stdout.trim()) {
                return reject(new Error("Phản hồi rỗng từ curl (không có dữ liệu trả về)"));
            }
            
            try {
                const json = JSON.parse(stdout.trim());
                resolve(json);
            } catch (e) {
                // Nếu phản hồi không phải JSON, trả về nguyên bản chuỗi
                resolve({ raw_response: stdout });
            }
        });
    });
}

// Hàm bổ trợ gửi yêu cầu HTTP (có hỗ trợ Proxy và tự động fallback sang curl trên Windows)
async function makeHttpRequest(url, method = "GET", data = null, headers = {}, timeout = 10000, proxyUrl = null) {
    // Nếu có proxy, ưu tiên dùng curl để đi qua proxy ổn định
    if (proxyUrl) {
        try {
            return await makeHttpRequestWithCurl(url, method, data, headers, proxyUrl, timeout);
        } catch (e) {
            browserLauncher.logWarning(`[HTTP Proxy Warning] Yêu cầu qua proxy thất bại, thử lại trực tiếp: ${e.message}`);
        }
    }

    try {
        const options = {
            method,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                ...headers
            },
            signal: AbortSignal.timeout(timeout)
        };
        if (data) {
            if (typeof data === 'object') {
                options.body = JSON.stringify(data);
                options.headers["Content-Type"] = "application/json";
            } else {
                options.body = data;
            }
        }
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (e) {
        // Fallback sang curl trực tiếp nếu fetch lỗi (đặc biệt khi Node.js gặp lỗi DNS hoặc SSL trên Windows)
        try {
            browserLauncher.logWarning(`[HTTP Warning] Fetch trực tiếp thất bại: ${e.message}. Đang thử lại bằng curl trực tiếp...`);
            return await makeHttpRequestWithCurl(url, method, data, headers, null, timeout);
        } catch (curlErr) {
            browserLauncher.logError(`[HTTP Error] Yêu cầu tới ${url} thất bại hoàn toàn: ${curlErr.message}`);
            return null;
        }
    }
}

// Bản đồ ánh xạ mã quốc gia / mã điện thoại sang ID quốc gia chuẩn của SMSPool
const SMSPOOL_COUNTRY_MAP = {
    "VN": "13", "84": "13", "VIETNAM": "13",
    "US": "1", "1": "1", "USA": "1", "AMERICA": "1",
    "GB": "36", "44": "36", "UK": "36", "ENGLAND": "36",
    "CA": "5", "CANADA": "5",
    "JP": "11", "81": "11", "JAPAN": "11",
    "KR": "82", "KOREA": "82",
    "TH": "9", "66": "9", "THAILAND": "9",
    "RU": "7", "7": "7", "RUSSIA": "7",
    "PH": "4", "63": "4", "PHILIPPINES": "4",
    "ID": "6", "62": "6", "INDONESIA": "6",
    "FR": "12", "33": "12", "FRANCE": "12",
    "DE": "3", "49": "3", "GERMANY": "3"
};

// Phán đoán mã quốc gia và đầu số dựa trên múi giờ giả lập
function guessCountryFromTimezone(timezone) {
    if (!timezone) {
        return { countryCode: "VN", dialCode: "84" };
    }
    const tz = timezone.toLowerCase();
    if (tz.includes("vietnam") || tz.includes("ho_chi_minh") || tz.includes("saigon") || tz.includes("hanoi")) {
        return { countryCode: "VN", dialCode: "84" };
    }
    if (tz.includes("america") || tz.includes("new_york") || tz.includes("los_angeles") || tz.includes("chicago")) {
        return { countryCode: "US", dialCode: "1" };
    }
    if (tz.includes("london") || tz.includes("europe")) {
        return { countryCode: "GB", dialCode: "44" };
    }
    return { countryCode: "VN", dialCode: "84" };
}

async function checkCurrentProxyIp(page, timeout = 12000) {
    try {
        await page.setBypassCSP(true).catch(() => {});
        const ip = await page.evaluate(async () => {
            async function tryFetch(url) {
                try {
                    const res = await fetch(url);
                    if (res.ok) {
                        const txt = await res.text();
                        if (txt.includes('{')) {
                            const json = JSON.parse(txt);
                            return json.ip || json.ip_addr || null;
                        }
                        return txt.trim();
                    }
                } catch (e) {}
                return null;
            }
            let ip = await tryFetch('https://api.ipify.org?format=json');
            if (!ip) ip = await tryFetch('https://ifconfig.me/ip');
            if (!ip) ip = await tryFetch('https://ipinfo.io/json');
            return ip;
        });
        return ip;
    } catch (err) {
        browserLauncher.logWarning(`[Proxy Check] Lỗi check IP: ${err.message}`);
        return null;
    }
}

async function triggerProxyRotation(profileId, rotateUrlInput) {
    let rotateUrl = rotateUrlInput || "";
    if (!rotateUrl || !rotateUrl.trim()) {
        const profile = await dbManager.getProfile(profileId);
        if (profile && profile.proxy_rotate_url) {
            rotateUrl = profile.proxy_rotate_url;
        }
    }
    if (!rotateUrl || !rotateUrl.trim()) {
        rotateUrl = await dbManager.getSetting("api_proxy_changer");
    }

    if (rotateUrl && rotateUrl.trim()) {
        browserLauncher.logInfo(`[Proxy] Đang thực hiện gọi API xoay proxy: ${rotateUrl}`);
        try {
            const res = await makeHttpRequest(rotateUrl.trim(), "GET", null, {}, 15000);
            browserLauncher.logInfo(`[Proxy] Phản hồi xoay proxy: ${res ? JSON.stringify(res) : "Thành công"}`);
            browserLauncher.logInfo(`[Proxy] Tạm dừng 8 giây để IP mới có hiệu lực...`);
            await new Promise(r => setTimeout(r, 8000));
            return true;
        } catch (e) {
            browserLauncher.logWarning(`[Proxy Warning] Lỗi khi gọi API xoay proxy: ${e.message}`);
            return false;
        }
    } else {
        browserLauncher.logWarning(`[Proxy Warning] Không có URL xoay proxy nào được cấu hình.`);
        return false;
    }
}

const ipFilePath = path.join(__dirname, 'offline_storage', 'profile_ips.json');
function readProfileOldIp(profileId) {
    try {
        if (fs.existsSync(ipFilePath)) {
            const data = JSON.parse(fs.readFileSync(ipFilePath, 'utf8'));
            return data[profileId] || null;
        }
    } catch (e) {}
    return null;
}
function saveProfileOldIp(profileId, ip) {
    try {
        let data = {};
        if (fs.existsSync(ipFilePath)) {
            data = JSON.parse(fs.readFileSync(ipFilePath, 'utf8'));
        }
        data[profileId] = ip;
        fs.writeFileSync(ipFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
}

// --- VIOTP SERVICES (Dịch vụ thuê sim OTP Việt Nam) ---
async function getViotpServiceId(token, serviceName) {
    const url = `https://api.viotp.com/service/get?token=${token}`;
    const services = await makeHttpRequest(url);
    if (!services || !services.data) {
        return 9; // Mặc định ID dịch vụ "Khác"
    }
    
    const nameClean = serviceName.trim().toLowerCase();
    // 1. Tìm khớp hoàn toàn tên dịch vụ
    for (const s of services.data) {
        if (s.name.toLowerCase() === nameClean) return s.id;
    }
    // 2. Tìm khớp tương đối (chứa từ khóa)
    for (const s of services.data) {
        if (s.name.toLowerCase().includes(nameClean) || nameClean.includes(s.name.toLowerCase())) {
            return s.id;
        }
    }
    // 3. Tìm dịch vụ "Khác" làm dự phòng
    for (const s of services.data) {
        const sName = s.name.toLowerCase();
        if (sName.includes("khác") || sName.includes("khac") || sName.includes("other")) {
            return s.id;
        }
    }
    return 9;
}

async function rentPhoneViotp(token, serviceName, network = "ALL") {
    const serviceId = await getViotpServiceId(token, serviceName);
    const networkParam = network || "ALL";
    const url = `https://api.viotp.com/request/getv2?token=${token}&serviceId=${serviceId}&network=${networkParam}`;
    const res = await makeHttpRequest(url);
    if (res && res.status_code === 200 && res.data) {
        return { phone: res.data.phone_number, requestId: res.data.request_id };
    }
    return { phone: null, requestId: null };
}

async function checkOtpViotp(token, requestId) {
    const url = `https://api.viotp.com/session/getv2?token=${token}&requestId=${requestId}`;
    const res = await makeHttpRequest(url);
    if (res && res.status_code === 200 && res.data) {
        const code = res.data.Code;
        const sms = res.data.SMS || "";
        if (code) return { code, sms };
        return { code: null, status: res.data.Status };
    }
    return { code: null, status: null };
}

// --- SMSPOOL SERVICES (Dịch vụ thuê sim OTP Quốc tế) ---
async function rentPhoneSmspool(key, serviceName, countryId) {
    const serviceClean = encodeURIComponent(serviceName.toLowerCase().trim());
    const url = `https://api.smspool.net/purchase/sms?key=${key}&country=${countryId}&service=${serviceClean}`;
    const res = await makeHttpRequest(url);
    if (res && res.success === true) {
        const phone = res.phonenumber || res.number;
        const requestId = res.id;
        return { phone, requestId };
    }
    return { phone: null, requestId: null };
}

async function checkOtpSmspool(key, orderId) {
    const url = `https://api.smspool.net/sms/check?key=${key}&orderid=${orderId}`;
    const res = await makeHttpRequest(url);
    if (res) {
        const code = res.code;
        const sms = res.sms || "";
        if (code) return { code, sms };
        return { code: null, status: res.status };
    }
    return { code: null, status: null };
}

// --- HUY THUÊ SIM OTP (Dành cho kiểm thử và tự động hủy số khi timeout) ---
async function cancelPhoneViotp(token, requestId) {
    const url = `https://api.viotp.com/request/cancelv2?token=${token}&requestId=${requestId}`;
    try {
        const res = await makeHttpRequest(url);
        if (res && res.status_code === 200) {
            return { success: true };
        }
        return { success: false, error: (res && res.message) || "Không thể hủy số từ ViOTP" };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function cancelPhoneSmspool(key, orderId) {
    const url = `https://api.smspool.net/sms/cancel?key=${key}&orderid=${orderId}`;
    try {
        const res = await makeHttpRequest(url);
        if (res && res.success === true) {
            return { success: true };
        }
        return { success: false, error: (res && res.message) || "Không thể hủy số từ SMSPool" };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// --- HÀM HELPER SINH DỮ LIỆU ĐĂNG KÝ THÔNG MINH ---
function generateSmartFirstName() {
    const names = ["Anh", "Tuấn", "Linh", "Hùng", "Hải", "Lan", "Hương", "Trang", "Minh", "Đạt", "Huy", "Dương", "Thảo", "Quỳnh", "Chi", "Bảo", "Duy", "Giang", "Phong", "Sơn", "Tú", "Ly", "Mai", "Vân", "Nam", "Việt", "Khang", "Phúc", "Lộc", "Thọ"];
    return names[Math.floor(Math.random() * names.length)];
}

function generateSmartLastName() {
    const familyNames = ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Huỳnh", "Phan", "Vũ", "Võ", "Đặng", "Bùi", "Đỗ", "Hồ", "Ngô", "Dương", "Lý"];
    return familyNames[Math.floor(Math.random() * familyNames.length)];
}

function generateSmartUsername(profileId) {
    const chars = "abcdefghijklmnopqrstuvwxyz";
    let randPart = "";
    const len = Math.floor(Math.random() * 4) + 5;
    for (let i = 0; i < len; i++) {
        randPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    randPart += Math.floor(Math.random() * 90 + 10).toString();

    const now = new Date();
    const pp = String(now.getMinutes()).padStart(2, '0');
    const gg = String(now.getHours()).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();

    const profSuffix = profileId ? `profile${profileId}` : "prof";
    return `${randPart}_${profSuffix}_${pp}${gg}${dd}${mm}${yyyy}`;
}

function generateSmartPassword() {
    // Mật khẩu gồm đúng 10 ký tự, chữ đầu viết Hoa (A-Z), các ký tự tiếp theo (8 ký tự) gồm số và chữ, ký tự cuối cùng là 1 trong #$%^&
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const specials = "#$%^&";
    
    let pass = upper.charAt(Math.floor(Math.random() * upper.length));
    for (let i = 0; i < 8; i++) {
        pass += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    pass += specials.charAt(Math.floor(Math.random() * specials.length));
    return pass;
}

// Hàm gõ chữ mô phỏng người thật (gõ từ từ chậm lại để tránh phát hiện bot)
async function typeLikeHuman(page, cursor, selector, text) {
    try {
        await cursor.click(selector);
    } catch (e) {
        await page.click(selector);
    }
    // Xóa sạch nội dung cũ bằng phím tắt Ctrl+A -> Backspace
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 150));

    // Gõ từng ký tự với độ trễ ngẫu nhiên từ 60ms đến 160ms (trung bình ~110ms mỗi phím)
    for (const char of text.toString()) {
        await page.keyboard.sendCharacter(char);
        await new Promise(r => setTimeout(r, Math.random() * 100 + 60));
    }

    // Gửi các event input, change, blur thông qua evaluate để trang web nhận diện được dữ liệu thay đổi
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
    }, selector);
    await new Promise(r => setTimeout(r, 500));
}

// Kiểm tra xem trường nhập liệu có bị báo đỏ hoặc lỗi không
async function isElementRedOrInvalid(page, selector) {
    try {
        return await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            
            if (el.getAttribute('aria-invalid') === 'true') return true;
            
            const classList = Array.from(el.classList).map(c => c.toLowerCase());
            const errorWords = ['error', 'invalid', 'danger', 'warning', 'fail', 'red'];
            const hasErrorClass = classList.some(cls => errorWords.some(word => cls.includes(word)));
            if (hasErrorClass) return true;
            
            const style = window.getComputedStyle(el);
            const borderColor = style.borderColor || '';
            const boxShadow = style.boxShadow || '';
            const color = style.color || '';
            
            function isRedColor(colorStr) {
                if (!colorStr) return false;
                const matches = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                if (matches) {
                    const r = parseInt(matches[1]);
                    const g = parseInt(matches[2]);
                    const b = parseInt(matches[3]);
                    if (r > 150 && g < 100 && b < 100) return true;
                }
                return false;
            }
            
            if (isRedColor(borderColor) || isRedColor(boxShadow) || isRedColor(color)) return true;
            
            let parent = el.parentElement;
            for (let depth = 0; depth < 2; depth++) {
                if (!parent) break;
                const parentClasses = Array.from(parent.classList).map(c => c.toLowerCase());
                if (parentClasses.some(cls => errorWords.some(word => cls.includes(word)))) {
                    const children = parent.querySelectorAll('*');
                    for (const child of children) {
                        if (child !== el) {
                            const childStyle = window.getComputedStyle(child);
                            if (isRedColor(childStyle.color) || isRedColor(childStyle.borderColor)) {
                                return true;
                            }
                        }
                    }
                }
                parent = parent.parentElement;
            }
            
            return false;
        }, selector);
    } catch (e) {
        return false;
    }
}

// Gọi API dịch ngược tọa độ địa lý Nominatim và fallback offline theo quốc gia
async function getAddressFromCoords(lat, lon, countryCode = "VN") {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
        const headers = {
            "User-Agent": "ProfileManagerAutomation/1.0"
        };
        const res = await makeHttpRequest(url, "GET", null, headers, 5000, null);
        if (res && res.display_name) {
            return res.display_name;
        }
    } catch (e) {
        console.warn(`[Nominatim Geocode Warning] Lỗi gọi API: ${e.message}. Đang sử dụng dữ liệu fallback offline...`);
    }

    const addressFallback = {
        VN: [
            "120 Cầu Giấy, Phường Quan Hoa, Quận Cầu Giấy, Hà Nội",
            "456 Lê Lợi, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh",
            "789 Nguyễn Văn Linh, Phường Bình Hiên, Quận Hải Châu, Đà Nẵng",
            "321 Trần Hưng Đạo, Quận Ninh Kiều, Cần Thơ",
            "15 Quang Trung, Quận Hồng Bàng, Hải Phòng"
        ],
        US: [
            "350 5th Ave, New York, NY 10118, USA",
            "1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA",
            "1111 S Figueroa St, Los Angeles, CA 90015, USA",
            "233 S Wacker Dr, Chicago, IL 60606, USA",
            "701 Pike St, Seattle, WA 98101, USA"
        ],
        GB: [
            "Westminster, London SW1A 0AA, United Kingdom",
            "Trafalgar Square, London WC2N 5DN, United Kingdom",
            "16 Piccadilly, Manchester M1 3LY, United Kingdom"
        ],
        CA: [
            "290 Bremner Blvd, Toronto, ON M5V 3L9, Canada",
            "1000 Rue de la Gauchetière, Montréal, QC H3B 4W5, Canada"
        ],
        JP: [
            "4-2-8 Shibakoen, Minato City, Tokyo 105-0011, Japan",
            "1-1 Chiyoda, Chiyoda City, Tokyo 100-8111, Japan"
        ],
        KR: [
            "105 Namsangongwon-gil, Yongsan-gu, Seoul, South Korea",
            "161 Sajik-ro, Jongno-gu, Seoul, South Korea"
        ]
    };

    const country = (countryCode || "VN").toUpperCase();
    const list = addressFallback[country] || addressFallback["VN"];
    return list[Math.floor(Math.random() * list.length)];
}

// --- 1SECMAIL SERVICES (Dịch vụ email ảo miễn phí) ---
async function getEmailDomains1secmail() {
    const url = "https://www.1secmail.com/api/v1/?action=getDomainList";
    const domains = await makeHttpRequest(url);
    if (domains && Array.isArray(domains)) {
        return domains;
    }
    return ["1secmail.com", "1secmail.org", "1secmail.net", "laafd.com"];
}

async function checkEmailOtp1secmail(username, domain) {
    const url = `https://www.1secmail.com/api/v1/?action=getMessages&login=${username}&domain=${domain}`;
    const messages = await makeHttpRequest(url);
    if (!messages || !Array.isArray(messages)) return null;

    for (const msg of messages.slice(0, 5)) {
        const msgId = msg.id;
        const readUrl = `https://www.1secmail.com/api/v1/?action=readMessage&login=${username}&domain=${domain}&id=${msgId}`;
        const details = await makeHttpRequest(readUrl);
        if (details) {
            const body = details.textBody || details.body || details.subject || "";
            const code = extractOtpCode(body);
            if (code) return code;
        }
    }
    return null;
}

async function detectFormValidationErrors(page) {
    try {
        return await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            
            // Từ khóa báo lỗi trùng Email
            const emailKeywords = [
                "email already", "email exists", "email registered", "email in use", "email đã", "email duoc su dung", "email trùng",
                "mail already", "mail exists", "mail registered", "mail in use", "mail đã", "mail duoc su dung", "mail trùng",
                "đã có người dùng", "địa chỉ email này đã", "email is already"
            ];
            
            // Từ khóa báo lỗi trùng Username
            const usernameKeywords = [
                "username already", "username exists", "username in use", "username đã", "username duoc su dung", "username trùng",
                "tên đăng nhập đã", "tên người dùng đã", "user already", "user exists", "tên đăng nhập này đã", "username is already"
            ];
            
            // Từ khóa báo lỗi trùng hoặc sai Số điện thoại
            const phoneKeywords = [
                "phone already", "phone exists", "phone registered", "phone in use", "phone đã", "số điện thoại đã", "sđt đã",
                "số điện thoại không hợp lệ", "invalid phone", "phone number is already", "số điện thoại này đã"
            ];

            // Quét text trên body
            for (const kw of emailKeywords) {
                if (text.includes(kw)) {
                    return { type: "email", message: `Phát hiện lỗi Email trùng: "${kw}"` };
                }
            }
            for (const kw of usernameKeywords) {
                if (text.includes(kw)) {
                    return { type: "username", message: `Phát hiện lỗi Username trùng: "${kw}"` };
                }
            }
            for (const kw of phoneKeywords) {
                if (text.includes(kw)) {
                    return { type: "phone", message: `Phát hiện lỗi Số điện thoại: "${kw}"` };
                }
            }
            
            // Thử tìm các element có class chứa error/invalid/danger và xem text của nó
            const errorElements = Array.from(document.querySelectorAll('.error, .invalid, .danger, .warning, [class*="error"], [class*="invalid"]'));
            for (const el of errorElements) {
                const elText = el.innerText.toLowerCase();
                if (!elText) continue;
                for (const kw of emailKeywords) {
                    if (elText.includes(kw)) return { type: "email", message: `Lỗi email trong thông báo: "${elText}"` };
                }
                for (const kw of usernameKeywords) {
                    if (elText.includes(kw)) return { type: "username", message: `Lỗi username trong thông báo: "${elText}"` };
                }
                for (const kw of phoneKeywords) {
                    if (elText.includes(kw)) return { type: "phone", message: `Lỗi phone trong thông báo: "${elText}"` };
                }
            }

            return null;
        });
    } catch (e) {
        return null;
    }
}

function extractOtpCode(text) {
    if (!text) return null;
    const matches = text.match(/\b\d{4,8}\b/);
    return matches ? matches[0] : null;
}

// --- CAPTCHA SOLVER SERVICES (Dịch vụ giải mã Captcha hình ảnh qua API bên thứ ba) ---
async function solveImageCaptcha(serviceName, apiKey, base64Image) {
    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");
    
    if (serviceName === "anycaptcha") {
        const createUrl = "https://api.anycaptcha.com/createTask";
        const createTaskRes = await makeHttpRequest(createUrl, "POST", {
            clientKey: apiKey,
            task: {
                type: "ImageToTextTask",
                body: cleanBase64
            }
        });
        if (!createTaskRes || createTaskRes.errorId !== 0) {
            throw new Error(`AnyCaptcha createTask error: ${createTaskRes ? createTaskRes.errorDescription : "No response"}`);
        }
        const taskId = createTaskRes.taskId;
        const resultUrl = "https://api.anycaptcha.com/getTaskResult";
        const startTime = Date.now();
        while (Date.now() - startTime < 60000) {
            await new Promise(r => setTimeout(r, 2000));
            const checkRes = await makeHttpRequest(resultUrl, "POST", {
                clientKey: apiKey,
                taskId: taskId
            });
            if (checkRes && checkRes.status === "ready") {
                return checkRes.solution.text;
            }
            if (checkRes && checkRes.errorId !== 0) {
                throw new Error(`AnyCaptcha getTaskResult error: ${checkRes.errorDescription}`);
            }
        }
        throw new Error("AnyCaptcha timeout (60s)");
    } else {
        // Các dịch vụ tương thích với giao thức 2captcha (1stcaptcha, anticaptchatop, autocaptchapro, 2captcha)
        let baseUrl = "https://2captcha.com";
        if (serviceName === "1stcaptcha") baseUrl = "https://api.1stcaptcha.com";
        else if (serviceName === "anticaptchatop") baseUrl = "https://anticaptcha.top";
        else if (serviceName === "autocaptchapro") baseUrl = "https://autocaptcha.pro";
        
        const inUrl = `${baseUrl}/in.php`;
        const postData = {
            key: apiKey,
            method: "base64",
            body: cleanBase64,
            json: 1
        };
        
        const createRes = await makeHttpRequest(inUrl, "POST", postData);
        if (!createRes || createRes.status !== 1) {
            throw new Error(`${serviceName} submit error: ${createRes ? createRes.request : "No response"}`);
        }
        const taskId = createRes.request;
        
        const resUrl = `${baseUrl}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
        const startTime = Date.now();
        while (Date.now() - startTime < 60000) {
            await new Promise(r => setTimeout(r, 2000));
            const checkRes = await makeHttpRequest(resUrl);
            if (checkRes) {
                if (checkRes.status === 1) {
                    return checkRes.request;
                }
                if (checkRes.request !== "CAPCHA_NOT_READY") {
                    throw new Error(`${serviceName} resolve error: ${checkRes.request}`);
                }
            }
        }
        throw new Error(`${serviceName} timeout (60s)`);
    }
}

// --- ANTI-PROFILE CHROME DEVTOOLS PROTOCOL (CDP) HELPERS v2.9 ---

async function smartWait(page, timeout = 15000) {
    browserLauncher.logInfo("[Smart Wait] Đang tự động đợi trang ổn định và mạng rảnh bằng DevTools...");
    try {
        // Đợi mạng rảnh (networkidle2) qua Puppeteer
        await page.waitForNetworkIdle({ idleTime: 500, timeout: timeout }).catch(() => {});
        
        // Đợi thêm một chút để trang ổn định giao diện
        await new Promise(r => setTimeout(r, 400));
        
        // Đợi các phần tử DOM ổn định (không thay đổi số lượng)
        let lastCount = -1;
        const startTime = Date.now();
        while (Date.now() - startTime < 3000) {
            const currentCount = await page.evaluate(() => document.querySelectorAll('*').length).catch(() => 0);
            if (currentCount > 0 && currentCount === lastCount) {
                break;
            }
            lastCount = currentCount;
            await new Promise(r => setTimeout(r, 150));
        }
        browserLauncher.logInfo("[Smart Wait] Trang và mạng đã ổn định.");
    } catch (e) {
        browserLauncher.logWarning(`[Smart Wait Warning] Đợi ổn định gặp lỗi: ${e.message}`);
    }
}

async function cdpSend(page, method, params = {}) {
    const client = await page.target().createCDPSession();
    try {
        const res = await client.send(method, params);
        await client.detach();
        return res;
    } catch (e) {
        await client.detach().catch(() => {});
        throw e;
    }
}

async function cdpClick(page, selector) {
    browserLauncher.logInfo(`[CDP Action] Đang nhấp chuột qua DevTools vào selector: ${selector}`);
    const client = await page.target().createCDPSession();
    try {
        const doc = await client.send('DOM.getDocument');
        const node = await client.send('DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector: selector
        });
        if (!node || !node.nodeId) {
            throw new Error(`Không tìm thấy phần tử qua CDP: ${selector}`);
        }
        const box = await client.send('DOM.getBoxModel', { nodeId: node.nodeId });
        if (!box || !box.model || !box.model.content) {
            throw new Error(`Không lấy được toạ độ phần tử qua CDP: ${selector}`);
        }
        const content = box.model.content;
        const x = (content[0] + content[2] + content[4] + content[6]) / 4;
        const y = (content[1] + content[3] + content[5] + content[7]) / 4;

        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x,
            y: y
        });
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            clickCount: 1,
            x: x,
            y: y
        });
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            clickCount: 1,
            x: x,
            y: y
        });
        await client.detach();
    } catch (e) {
        await client.detach().catch(() => {});
        throw e;
    }
}

async function cdpType(page, selector, text) {
    browserLauncher.logInfo(`[CDP Action] Đang nhập liệu qua DevTools vào selector: ${selector}`);
    await cdpClick(page, selector);
    await new Promise(r => setTimeout(r, 150));
    
    // Clear text cũ bằng cách chọn tất cả và xóa
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 150));

    const client = await page.target().createCDPSession();
    try {
        for (const char of text.toString()) {
            await client.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                text: char,
                unmodifiedText: char,
                key: char
            });
            await client.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: char
            });
            await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
        }
        await client.detach();
    } catch (e) {
        await client.detach().catch(() => {});
        throw e;
    }
}

async function cdpHover(page, selector) {
    browserLauncher.logInfo(`[CDP Action] Đang rê chuột qua DevTools vào selector: ${selector}`);
    const client = await page.target().createCDPSession();
    try {
        const doc = await client.send('DOM.getDocument');
        const node = await client.send('DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector: selector
        });
        if (!node || !node.nodeId) {
            throw new Error(`Không tìm thấy phần tử qua CDP: ${selector}`);
        }
        const box = await client.send('DOM.getBoxModel', { nodeId: node.nodeId });
        if (!box || !box.model || !box.model.content) {
            throw new Error(`Không lấy được toạ độ phần tử qua CDP: ${selector}`);
        }
        const content = box.model.content;
        const x = (content[0] + content[2] + content[4] + content[6]) / 4;
        const y = (content[1] + content[3] + content[5] + content[7]) / 4;

        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x,
            y: y
        });
        await client.detach();
    } catch (e) {
        await client.detach().catch(() => {});
        throw e;
    }
}

// --- AUTOMATION RUNNER (Trình chạy kịch bản tự động hóa bằng Puppeteer + Ghost Cursor) ---
// --- RETRY STEP AUTOMATION WRAPPER ---
async function executeStepWithRetry(page, cursor, step, state, profileId, steps, idxOrLoopState) {
    // Tự động kích hoạt lắng nghe Console Errors và Network Failures để phục vụ gỡ lỗi nâng cao
    if (page && !page._hasErrorListeners) {
        page._hasErrorListeners = true;
        page.on('console', msg => {
            if (msg.type() === 'error') {
                browserLauncher.logWarning(`[Console Error] ${msg.text()} (Tại trang: ${page.url()})`);
            }
        });
        page.on('requestfailed', request => {
            const failure = request.failure();
            browserLauncher.logWarning(`[Network Failed] ${request.url()} - Lỗi: ${failure ? failure.errorText : 'unknown'}`);
        });
    }

    const loopState = (typeof idxOrLoopState === 'object' && idxOrLoopState !== null) ? idxOrLoopState : { idx: idxOrLoopState || 0 };
    const idx = loopState.idx;
    const action = step.action;
    const target = step.target;
    const value = step.value;
    state.variables = state.variables || {};
    const varName = step.var || step.variable || "";
    const captchaService = step.service || "";
    const stepTimeout = 20000; // Giới hạn 20 giây xử lý tối đa cho mỗi bước

    // Phòng vệ: Nếu hành động là goto mà URL (value) trống, bỏ qua để tránh sập kịch bản
    if (action === "goto" && (!value || !value.trim())) {
        browserLauncher.logWarning(`[Puppeteer] Bỏ qua bước ${idx + 1} (goto) do tham số URL bị rỗng.`);
        return { success: true };
    }

    // Phòng vệ: Nếu các hành động cần target (nút/input) mà target rỗng, bỏ qua
    const needsTarget = ["click", "click_right", "hover", "type", "type_phone"];
    if (needsTarget.includes(action) && (!target || !target.trim())) {
        browserLauncher.logWarning(`[Puppeteer] Bỏ qua bước ${idx + 1} (${action}) do Selector (Target) bị rỗng.`);
        return { success: true };
    }

    // Hàm thực hiện hành động theo cách 1 (Thông thường)
    const runWay1 = async () => {
        if (action === "goto") {
            await page.goto(value, { timeout: stepTimeout, waitUntil: 'load' });
        } 
        else if (action === "click") {
            await page.waitForSelector(target, { timeout: stepTimeout });
            await cursor.click(target);
        } 
        else if (action === "click_right") {
            await page.waitForSelector(target, { timeout: stepTimeout });
            const el = await page.$(target);
            const box = await el.boundingBox();
            if (box) {
                await cursor.moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
            } else {
                await page.click(target, { button: 'right' });
            }
        }
        else if (action === "click_xy" || action === "click_right_xy") {
            const coords = value.split(/[\s,]+/).map(Number);
            const x = coords[0];
            const y = coords[1];
            if (isNaN(x) || isNaN(y)) throw new Error(`Tọa độ không hợp lệ: ${value}`);
            await cursor.moveTo({ x, y });
            await page.mouse.click(x, y, { button: action === "click_right_xy" ? 'right' : 'left' });
        }
        else if (action === "hover") {
            await page.waitForSelector(target, { timeout: stepTimeout });
            const el = await page.$(target);
            const box = await el.boundingBox();
            if (box) {
                await cursor.moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
            } else {
                await page.hover(target);
            }
        }
        else if (action === "type") {
            await page.waitForSelector(target, { timeout: stepTimeout });
            await cursor.click(target);
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 150));
            for (const char of value.toString()) {
                await page.keyboard.sendCharacter(char);
                await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
            }
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                }
            }, target);
        } 
        else if (action === "press") {
            await page.keyboard.press(value);
        } 
        else if (action === "scroll") {
            const amt = value === "up" ? -350 : 350;
            await page.evaluate((scrollAmt) => window.scrollBy(0, scrollAmt), amt);
        } 
        else if (action === "wait") {
            const delay = parseInt(value) || 2000;
            await new Promise(r => setTimeout(r, delay));
        }
        else if (action === "start_performance_trace") {
            browserLauncher.logInfo(`[Performance] Bắt đầu ghi dấu vết hiệu năng DevTools...`);
            const tracesDir = path.join(__dirname, 'offline_storage', 'performance_traces');
            fs.mkdirSync(tracesDir, { recursive: true });
            state.tracePath = path.join(tracesDir, `trace_${profileId}_${Date.now()}.json`);
            await page.tracing.start({ path: state.tracePath, categories: ['devtools.timeline'] }).catch(e => {
                browserLauncher.logError(`Lỗi bắt đầu trace: ${e.message}`);
            });
        }
        else if (action === "stop_performance_trace") {
            browserLauncher.logInfo(`[Performance] Dừng ghi nhận và phân tích dấu vết hiệu năng...`);
            await page.tracing.stop().catch(() => {});
            
            if (state.tracePath && fs.existsSync(state.tracePath)) {
                try {
                    const traceData = JSON.parse(fs.readFileSync(state.tracePath, 'utf8'));
                    const stats = fs.statSync(state.tracePath);
                    browserLauncher.logInfo(`[Performance] Dấu vết hiệu năng đã được ghi thành công tại: ${state.tracePath} (${stats.size} bytes).`);
                    const events = traceData.traceEvents || [];
                    browserLauncher.logInfo(`[Performance] Phân tích thấy ${events.length} sự kiện hiệu năng từ DevTools.`);
                } catch (errTrace) {
                    browserLauncher.logError(`Lỗi đọc dữ liệu trace: ${errTrace.message}`);
                }
            } else {
                browserLauncher.logWarning(`Không tìm thấy tệp trace hiệu năng.`);
            }
        }
        else if (action === "rent_phone") {
            const service = target || "facebook";
            const profile = await dbManager.getProfile(profileId);
            const timezone = profile ? profile.timezone : null;
            let { countryCode, dialCode } = guessCountryFromTimezone(timezone);
            
            if (value) {
                const valClean = value.trim().toUpperCase();
                if (valClean === "VN" || valClean === "84") {
                    countryCode = "VN";
                    dialCode = "84";
                } else {
                    countryCode = valClean;
                    dialCode = valClean;
                }
            }
            
            const viotpToken = await dbManager.getSetting("api_viotp");
            const smspoolKey = await dbManager.getSetting("api_smspool");
            
            state.phone_service = service;
            state.phone_country_dial = dialCode;
            
            let useViotp = false;
            if (dialCode === "84" || countryCode === "VN") {
                if (viotpToken) useViotp = true;
            }
            
            let phoneNum = null;
            let reqId = null;
            
            if (useViotp) {
                const networks = ["VIETTEL", "VINAPHONE", "MOBIFONE", "VIETNAMOBILE"];
                const network = networks[state.network_idx % networks.length];
                const rentRes = await rentPhoneViotp(viotpToken, service, network);
                phoneNum = rentRes.phone;
                reqId = rentRes.requestId;
            } else {
                if (smspoolKey) {
                    const smspoolCountryId = SMSPOOL_COUNTRY_MAP[dialCode.toUpperCase()] || dialCode;
                    const rentRes = await rentPhoneSmspool(smspoolKey, service, smspoolCountryId);
                    phoneNum = rentRes.phone;
                    reqId = rentRes.requestId;
                } else if (viotpToken) {
                    const rentRes = await rentPhoneViotp(viotpToken, service, "ALL");
                    phoneNum = rentRes.phone;
                    reqId = rentRes.requestId;
                }
            }
            
            if (phoneNum) {
                const targetVar = varName || "phone_1";
                state.variables[targetVar] = phoneNum;
                state.variables[targetVar + "_request_id"] = reqId;
                state.variables[targetVar + "_service"] = service;
                state.variables[targetVar + "_use_viotp"] = useViotp;
                
                state.phone_number = phoneNum;
                state.phone_request_id = reqId;
                // Đăng ký số điện thoại thuê vào Resource Manager để tự động hủy khi đóng trình duyệt
                browserLauncher.registerProfilePhone(profileId, reqId, useViotp ? 'viotp' : 'smspool');
            } else {
                throw new Error("Không thuê được số điện thoại.");
            }
        } 
        else if (action === "type_phone") {
            const sourceVar = varName || "phone_1";
            const phone = state.variables[sourceVar] || state.phone_number;
            if (!phone) throw new Error(`Chưa có số điện thoại trong biến ${sourceVar} để nhập.`);
            
            // Lưu selector ô nhập số điện thoại để điền lại khi timeout
            state.variables[sourceVar + "_input_selector"] = target;
            state.phone_input_selector = target;
            
            await page.waitForSelector(target, { timeout: stepTimeout });
            await cursor.click(target);
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 150));
            for (const char of phone.toString()) {
                await page.keyboard.sendCharacter(char);
                await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
            }
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                }
            }, target);
        } 
        else if (action === "get_phone_code") {
            const sourceVar = varName || "phone_1";
            const reqId = state.variables[sourceVar + "_request_id"] || state.phone_request_id;
            const phoneNumber = state.variables[sourceVar] || state.phone_number;
            if (!reqId) throw new Error(`Không có Request ID trong biến ${sourceVar} để nhận OTP.`);
            
            const viotpToken = await dbManager.getSetting("api_viotp");
            const smspoolKey = await dbManager.getSetting("api_smspool");
            
            const isVN = phoneNumber ? (phoneNumber.toString().startsWith("84") || phoneNumber.toString().startsWith("0")) : true;
            let useViotp = isVN && viotpToken ? true : false;
            if (!viotpToken && smspoolKey) useViotp = false;
            
            let otpCode = null;
            let otpSms = "";
            const maxWait = 60000; // Tự động chờ tối đa 60 giây
            const startTime = Date.now();
            
            while (Date.now() - startTime < maxWait) {
                let checkRes;
                if (useViotp) {
                    checkRes = await checkOtpViotp(viotpToken, reqId);
                } else {
                    checkRes = await checkOtpSmspool(smspoolKey, reqId);
                }
                if (checkRes && checkRes.code) {
                    otpCode = checkRes.code;
                    otpSms = checkRes.sms || "";
                    break;
                }
                await new Promise(r => setTimeout(r, 3000)); // Thăm dò sau mỗi 3 giây
            }
            
            if (otpCode) {
                await page.waitForSelector(target, { timeout: stepTimeout });
                await cursor.click(target);
                await page.keyboard.down('Control');
                await page.keyboard.press('A');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 150));
                for (const char of otpCode.toString()) {
                    await page.keyboard.sendCharacter(char);
                    await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
                }
                await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                }, target);
                // Reset số lần thử lại OTP
                state.otp_retry_count = 0;
            } else {
                // Xử lý khi quá hạn 60 giây chưa nhận được OTP
                if (!state.otp_retry_count) {
                    state.otp_retry_count = 0;
                }
                state.otp_retry_count++;
                
                if (state.otp_retry_count > 3) {
                    throw new Error("Quá hạn 60 giây và đã vượt quá 3 lần thử lại OTP số điện thoại.");
                }

                browserLauncher.logWarning(`[Puppeteer] Quá hạn 60 giây chưa có OTP điện thoại. Đang tự động hủy số cũ và thuê số mới...`);

                // Gọi API hủy số cũ để hoàn tiền
                if (useViotp && viotpToken) {
                    try {
                        await makeHttpRequest(`https://api.viotp.com/request/cancelv2?token=${viotpToken}&requestId=${reqId}`);
                    } catch (e) {}
                } else if (!useViotp && smspoolKey) {
                    try {
                        await makeHttpRequest(`https://api.smspool.net/sms/cancel?key=${smspoolKey}&orderid=${reqId}`);
                    } catch (e) {}
                }

                // Giải phóng số điện thoại cũ
                state.variables[sourceVar] = null;
                state.variables[sourceVar + "_request_id"] = null;
                state.phone_number = null;
                state.phone_request_id = null;

                // 1. Nếu chạy kịch bản tuần tự (GUI Steps) và tìm được bước rent_phone trước đó
                let foundIndex = -1;
                if (steps && Array.isArray(steps) && steps.length > 0) {
                    for (let i = idx - 1; i >= 0; i--) {
                        if (steps[i].action === "rent_phone" && (steps[i].var || "phone_1") === sourceVar) {
                            foundIndex = i;
                            break;
                        }
                    }
                    if (foundIndex === -1) {
                        for (let i = idx - 1; i >= 0; i--) {
                            if (steps[i].action === "type_phone" && (steps[i].var || "phone_1") === sourceVar) {
                                foundIndex = i;
                                break;
                            }
                        }
                    }
                }

                if (foundIndex !== -1 && idxOrLoopState && typeof idxOrLoopState === 'object') {
                    browserLauncher.logInfo(`[Puppeteer] Quay ngược kịch bản về bước ${foundIndex + 1} (${steps[foundIndex].action}) để thuê số điện thoại mới cho biến ${sourceVar}. Lần thử lại: ${state.otp_retry_count}/3`);
                    idxOrLoopState.idx = foundIndex - 1; // Sẽ tự động tăng lên foundIndex ở cuối vòng lặp while
                    return { success: true };
                } 
                // 2. Nếu chạy kịch bản dạng mã JS hoặc không tìm được bước (Tự động thuê số và điền lại tại chỗ)
                else {
                    browserLauncher.logInfo(`[Puppeteer] Tự động thuê và điền lại số mới tại chỗ (Mã JS / Độc lập) cho biến ${sourceVar}. Lần thử lại: ${state.otp_retry_count}/3`);
                    const service = state.variables[sourceVar + "_service"] || state.phone_service || "facebook";
                    const dialCode = state.phone_country_dial || "84";
                    
                    let phoneNum = null;
                    let newReqId = null;
                    
                    if (useViotp) {
                        const networks = ["VIETTEL", "VINAPHONE", "MOBIFONE", "VIETNAMOBILE"];
                        const network = networks[state.network_idx % networks.length];
                        const rentRes = await rentPhoneViotp(viotpToken, service, network);
                        phoneNum = rentRes.phone;
                        newReqId = rentRes.requestId;
                    } else {
                        if (smspoolKey) {
                            const smspoolCountryId = SMSPOOL_COUNTRY_MAP[dialCode.toUpperCase()] || dialCode;
                            const rentRes = await rentPhoneSmspool(smspoolKey, service, smspoolCountryId);
                            phoneNum = rentRes.phone;
                            newReqId = rentRes.requestId;
                        } else if (viotpToken) {
                            const rentRes = await rentPhoneViotp(viotpToken, service, "ALL");
                            phoneNum = rentRes.phone;
                            newReqId = rentRes.requestId;
                        }
                    }
                    
                    if (phoneNum) {
                        state.variables[sourceVar] = phoneNum;
                        state.variables[sourceVar + "_request_id"] = newReqId;
                        state.phone_number = phoneNum;
                        state.phone_request_id = newReqId;
                        // Đăng ký số mới thuê vào Resource Manager để tự động hủy khi đóng trình duyệt
                        browserLauncher.registerProfilePhone(profileId, newReqId, useViotp ? 'viotp' : 'smspool');
                        browserLauncher.logInfo(`[Puppeteer] Thuê thành công số mới cho biến ${sourceVar}: ${phoneNum}. Đang điền lại...`);
                        
                        // Gõ lại số điện thoại vào ô nhập cũ
                        const inputSel = state.variables[sourceVar + "_input_selector"] || state.phone_input_selector;
                        if (inputSel) {
                            await page.waitForSelector(inputSel, { timeout: stepTimeout });
                            await page.click(inputSel);
                            // Xóa sạch
                            await page.keyboard.down('Control');
                            await page.keyboard.press('A');
                            await page.keyboard.up('Control');
                            await page.keyboard.press('Backspace');
                            // Gõ từng phím như người thật
                            for (const char of phoneNum.toString()) {
                                await page.keyboard.sendCharacter(char);
                                await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
                            }
                            // Giả lập Enter để submit lại số điện thoại
                            await page.keyboard.press('Enter');
                            await new Promise(r => setTimeout(r, 2000));
                        }
                        
                        // Thực hiện lại bước get_phone_code đệ quy
                        return await executeStepWithRetry(page, cursor, { action: "get_phone_code", target, var: sourceVar }, state, profileId, steps, idxOrLoopState);
                    } else {
                        throw new Error("Không thể thuê số điện thoại mới sau khi số cũ bị timeout.");
                    }
                }
            }
        } 
        else if (action === "create_mail") {
            const targetVar = varName || "mail_1";
            const apiMailUrl = await dbManager.getSetting("api_mail_url");
            let email = "";
            let username = "";
            let domain = "";

            if (apiMailUrl) {
                // Sử dụng Mail Manager nội bộ
                const payload = {};
                if (value && value.trim()) {
                    payload.address = value.trim();
                }
                browserLauncher.logInfo(`[Puppeteer] Đang gọi API Mail Manager để tạo hòm thư: ${apiMailUrl}/api/emails/create`);
                try {
                    const createRes = await makeHttpRequest(`${apiMailUrl}/api/emails/create`, "POST", payload);
                    if (createRes && createRes.success) {
                        email = createRes.address;
                        const parts = email.split("@");
                        username = parts[0];
                        domain = parts[1];
                        // Đăng ký email vào Resource Manager để tự động xóa khi đóng trình duyệt
                        browserLauncher.registerProfileEmail(profileId, email);
                        browserLauncher.logInfo(`[Puppeteer] Đã tạo hòm thư tạm thời qua Mail Manager thành công: ${email}`);
                    } else {
                        throw new Error(createRes ? createRes.error : "Không nhận được phản hồi success");
                    }
                } catch (err) {
                    browserLauncher.logWarning(`[Puppeteer] Lỗi gọi API Mail Manager (${err.message}). Tự động fallback sang 1secmail...`);
                    // Fallback
                    username = `user_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
                    const domains = await getEmailDomains1secmail();
                    state.email_domains_list = domains;
                    domain = domains[state.domain_idx % domains.length];
                    email = `${username}@${domain}`;
                }
            } else {
                // Fallback 1secmail mặc định
                if (value && value.includes("@")) {
                    const parts = value.trim().split("@");
                    email = value.trim();
                    username = parts[0];
                    domain = parts[1];
                } else {
                    username = `user_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
                    const domains = await getEmailDomains1secmail();
                    state.email_domains_list = domains;
                    domain = domains[state.domain_idx % domains.length];
                    email = `${username}@${domain}`;
                }
            }

            if (email) {
                state.variables[targetVar] = email;
                state.variables[targetVar + "_username"] = username;
                state.variables[targetVar + "_domain"] = domain;
                
                state.email = email;
                state.email_username = username;
                state.email_domain = domain;
            }
        } 
        else if (action === "type_mail") {
            const sourceVar = varName || "mail_1";
            const email = state.variables[sourceVar] || state.email;
            if (!email) throw new Error(`Chưa có email trong biến ${sourceVar} để nhập.`);
            
            state.variables[sourceVar + "_input_selector"] = target;
            
            await page.waitForSelector(target, { timeout: stepTimeout });
            await cursor.click(target);
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 150));
            for (const char of email.toString()) {
                await page.keyboard.sendCharacter(char);
                await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
            }
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                }
            }, target);
        } 
        else if (action === "get_mail_code") {
            const sourceVar = varName || "mail_1";
            const username = state.variables[sourceVar + "_username"] || state.email_username;
            const domain = state.variables[sourceVar + "_domain"] || state.email_domain;
            const email = state.variables[sourceVar] || state.email;
            if (!username || !domain) throw new Error(`Thiếu thông tin kiểm tra mail trong biến ${sourceVar}.`);
            
            const apiMailUrl = await dbManager.getSetting("api_mail_url");
            
            let otpCode = null;
            const maxWait = 60000; // Tăng thời gian chờ lên 60 giây
            const startTime = Date.now();
            
            while (Date.now() - startTime < maxWait) {
                let code = null;
                if (apiMailUrl && email) {
                    try {
                        const checkRes = await makeHttpRequest(`${apiMailUrl}/api/otp?email=${encodeURIComponent(email)}`);
                        if (checkRes && checkRes.success && checkRes.otp) {
                            code = checkRes.otp;
                        }
                    } catch (e) {
                        browserLauncher.logWarning(`Lỗi tra cứu OTP từ Mail Manager: ${e.message}`);
                    }
                }
                
                // Fallback nếu không dùng Mail Manager hoặc API lỗi
                if (!code) {
                    code = await checkEmailOtp1secmail(username, domain);
                }
                
                if (code) {
                    otpCode = code;
                    break;
                }
                await new Promise(r => setTimeout(r, 3000)); // Thăm dò sau mỗi 3 giây
            }
            
            if (otpCode) {
                await page.waitForSelector(target, { timeout: stepTimeout });
                await cursor.click(target);
                await page.keyboard.down('Control');
                await page.keyboard.press('A');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 150));
                for (const char of otpCode.toString()) {
                    await page.keyboard.sendCharacter(char);
                    await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
                }
                await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                }, target);
                // Reset số lần thử lại OTP
                state.otp_retry_count = 0;
            } else {
                // Xử lý khi quá hạn 60 giây chưa có OTP mail
                if (!state.otp_retry_count) {
                    state.otp_retry_count = 0;
                }
                state.otp_retry_count++;
                
                if (state.otp_retry_count > 3) {
                    throw new Error("Quá hạn 60 giây và đã vượt quá 3 lần thử lại OTP mail.");
                }

                browserLauncher.logWarning(`[Puppeteer] Quá hạn 60 giây chưa có OTP mail. Đang tự động dọn dẹp và quay lại bước trước để tạo mail mới...`);

                // Gọi API xóa mail hiện tại để giải phóng
                if (apiMailUrl && email) {
                    try {
                        await makeHttpRequest(`${apiMailUrl}/api/emails/delete`, "POST", { address: email });
                    } catch (e) {}
                }

                // Giải phóng mail cũ
                state.variables[sourceVar] = null;
                state.variables[sourceVar + "_username"] = null;
                state.variables[sourceVar + "_domain"] = null;
                state.email = null;
                state.email_username = null;
                state.email_domain = null;

                // Tìm ngược bước tạo/nhập mail gần nhất (Ưu tiên tạo mail mới)
                let foundIndex = -1;
                if (steps && Array.isArray(steps) && steps.length > 0) {
                    for (let i = idx - 1; i >= 0; i--) {
                        if (steps[i].action === "create_mail" && (steps[i].var || "mail_1") === sourceVar) {
                            foundIndex = i;
                            break;
                        }
                    }
                    if (foundIndex === -1) {
                        for (let i = idx - 1; i >= 0; i--) {
                            if (steps[i].action === "type_mail" && (steps[i].var || "mail_1") === sourceVar) {
                                foundIndex = i;
                                break;
                            }
                        }
                    }
                }

                if (foundIndex !== -1 && idxOrLoopState && typeof idxOrLoopState === 'object') {
                    browserLauncher.logInfo(`[Puppeteer] Quay ngược kịch bản về bước ${foundIndex + 1} (${steps[foundIndex].action}) để tạo mail mới. Lần thử lại: ${state.otp_retry_count}/3`);
                    idxOrLoopState.idx = foundIndex - 1; // Sẽ tự động tăng lên foundIndex ở cuối vòng lặp while
                    return { success: true };
                } else {
                    throw new Error("Hết thời gian chờ OTP mail và không tìm thấy bước nhập mail trước đó.");
                }
            }
        }
        else if (action === "social_message") {
            const msgClicked = await page.evaluate(() => {
                const selectors = [
                    '[aria-label="Nhắn tin"]', '[aria-label="Message"]',
                    'a[href*="/messages/t/"]', 'div[role="button"][aria-label*="Nhắn tin"]',
                    'div[role="button"][aria-label*="Message"]'
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.getBoundingClientRect().width > 0) { el.scrollIntoView({ block: 'center' }); el.click(); return true; }
                }
                const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                for (const btn of buttons) {
                    const txt = btn.innerText.toLowerCase().trim();
                    if (txt === 'nhắn tin' || txt === 'message' || txt === 'gửi tin nhắn' || txt === 'send message') {
                        btn.scrollIntoView({ block: 'center' });
                        btn.click();
                        return true;
                    }
                }
                return false;
            });
            if (!msgClicked) {
                throw new Error("Không tìm thấy nút Nhắn tin/Message trên trang");
            }
            await new Promise(r => setTimeout(r, 2000));
            const msgTyped = await page.evaluate((textVal) => {
                const inputs = Array.from(document.querySelectorAll('textarea, input, [role="textbox"], [contenteditable="true"]'));
                for (const input of inputs) {
                    const placeholder = (input.placeholder || input.getAttribute('aria-label') || '').toLowerCase();
                    if (placeholder.includes('nhắn tin') || placeholder.includes('message') || placeholder.includes('chat') || input.getAttribute('contenteditable') === 'true') {
                        input.focus();
                        if (input.getAttribute('contenteditable') === 'true') {
                            document.execCommand('insertText', false, textVal);
                        } else {
                            input.value = textVal;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        return true;
                    }
                }
                return false;
            }, value);
            if (!msgTyped) {
                throw new Error("Không tìm thấy ô nhập tin nhắn");
            }
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Enter');
        }
        else if (action === "social_reply_unread") {
            if (target && target.match(/^\d+[\s,]+\d+$/)) {
                const [x, y] = target.split(/[\s,]+/).map(Number);
                await page.mouse.click(x, y);
            } else if (target) {
                await page.waitForSelector(target, { timeout: stepTimeout });
                await page.click(target);
            } else {
                await page.evaluate(() => {
                    const selectors = [
                        '[aria-label="Messenger"]', '[aria-label="Tin nhắn"]', '[aria-label="Messages"]',
                        'a[href*="/messages/"]', '[id*="messenger-button"]', '.chat-inbox-icon'
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return; }
                    }
                    const elText = Array.from(document.querySelectorAll('a, button, div[role="button"]')).find(el => {
                        const txt = el.innerText.toLowerCase();
                        return txt.includes('messenger') || txt.includes('tin nhắn') || txt.includes('inbox') || txt.includes('hòm thư');
                    });
                    if (elText) elText.click();
                });
            }
            await new Promise(r => setTimeout(r, 2000));
            const foundUnread = await page.evaluate(() => {
                const unreadElements = Array.from(document.querySelectorAll('*')).filter(el => {
                    const style = window.getComputedStyle(el);
                    const isBold = style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 700;
                    const hasUnreadClass = Array.from(el.classList).some(c => c.toLowerCase().includes('unread') || c.toLowerCase().includes('chuadoc'));
                    const hasDot = el.querySelector('[aria-label*="chưa đọc"], [aria-label*="unread"], .unread-dot');
                    return (isBold || hasUnreadClass || hasDot) && (el.tagName === 'DIV' || el.tagName === 'A' || el.tagName === 'LI') && el.innerText.length > 0;
                });
                if (unreadElements.length > 0) {
                    unreadElements[0].scrollIntoView({ block: 'center' });
                    unreadElements[0].click();
                    return true;
                }
                return false;
            });
            if (!foundUnread) {
                await page.evaluate(() => {
                    const firstChat = document.querySelector('div[role="row"], li[role="tab"], [class*="thread"]');
                    if (firstChat) firstChat.click();
                });
            }
            await new Promise(r => setTimeout(r, 1000));
            const textVal = value || "Xin chào, tôi sẽ liên hệ lại sau.";
            await page.evaluate((txt) => {
                const inputs = Array.from(document.querySelectorAll('textarea, input, [role="textbox"], [contenteditable="true"]'));
                for (const input of inputs) {
                    const placeholder = (input.placeholder || input.getAttribute('aria-label') || '').toLowerCase();
                    if (placeholder.includes('nhắn tin') || placeholder.includes('message') || placeholder.includes('chat') || input.getAttribute('contenteditable') === 'true') {
                        input.focus();
                        if (input.getAttribute('contenteditable') === 'true') {
                            document.execCommand('insertText', false, txt);
                        } else {
                            input.value = txt;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        return;
                    }
                }
            }, textVal);
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Enter');
        }
        else if (action === "social_reply_comment") {
            if (target && target.match(/^\d+[\s,]+\d+$/)) {
                const [x, y] = target.split(/[\s,]+/).map(Number);
                await page.mouse.click(x, y);
            } else if (target) {
                await page.waitForSelector(target, { timeout: stepTimeout });
                await page.click(target);
            } else {
                await page.evaluate(() => {
                    const selectors = [
                        '[aria-label="Thông báo"]', '[aria-label="Notifications"]',
                        'a[href*="/notifications"]', '[id*="notifications-button"]'
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return; }
                    }
                });
            }
            await new Promise(r => setTimeout(r, 2000));
            const clickedNotif = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('a, div[role="listitem"], li'));
                for (const item of items) {
                    const text = item.innerText.toLowerCase();
                    if (text.includes('bình luận') || text.includes('commented') || text.includes('nhắc đến') || text.includes('mentioned')) {
                        item.scrollIntoView({ block: 'center' });
                        item.click();
                        return true;
                    }
                }
                const firstNotif = document.querySelector('[role="listitem"] a, a[href*="/notifications/"]');
                if (firstNotif) { firstNotif.click(); return true; }
                return false;
            });
            await new Promise(r => setTimeout(r, 2500));
            const textVal = value || "Cảm ơn bạn đã bình luận!";
            await page.evaluate((txt) => {
                const replies = Array.from(document.querySelectorAll('span, button, a')).filter(el => {
                    const t = el.innerText.toLowerCase().trim();
                    return t === 'phản hồi' || t === 'reply' || t === 'trả lời';
                });
                if (replies.length > 0) {
                    replies[0].scrollIntoView({ block: 'center' });
                    replies[0].click();
                }
                setTimeout(() => {
                    const inputs = Array.from(document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable="true"]'));
                    for (const input of inputs) {
                        const p = (input.placeholder || input.getAttribute('aria-label') || '').toLowerCase();
                        if (p.includes('bình luận') || p.includes('comment') || p.includes('viết phản hồi') || input.getAttribute('contenteditable') === 'true') {
                            input.focus();
                            if (input.getAttribute('contenteditable') === 'true') {
                                document.execCommand('insertText', false, txt);
                            } else {
                                input.value = txt;
                                input.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                            break;
                        }
                    }
                }, 500);
            }, textVal);
            await new Promise(r => setTimeout(r, 1000));
            await page.keyboard.press('Enter');
        }
        else if (action === "social_reaction") {
            if (target && target.match(/^\d+[\s,]+\d+$/)) {
                const [x, y] = target.split(/[\s,]+/).map(Number);
                await page.mouse.click(x, y);
            } else if (target) {
                await page.waitForSelector(target, { timeout: stepTimeout });
                await page.click(target);
            } else {
                await page.evaluate(() => {
                    const selectors = [
                        '[aria-label="Thông báo"]', '[aria-label="Notifications"]',
                        'a[href*="/notifications"]', '[id*="notifications-button"]'
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return; }
                    }
                });
            }
            await new Promise(r => setTimeout(r, 2000));
            await page.evaluate(() => {
                const firstNotif = document.querySelector('[role="listitem"] a, a[href*="/notifications/"], [class*="notification"] a');
                if (firstNotif) firstNotif.click();
            });
            await new Promise(r => setTimeout(r, 2500));
            const reactClicked = await page.evaluate((reactVal) => {
                const likeButtons = Array.from(document.querySelectorAll('button, div[role="button"], span')).filter(el => {
                    const txt = el.innerText.toLowerCase().trim();
                    return txt === 'thích' || txt === 'like' || txt === 'yêu thích' || txt === 'love' || el.getAttribute('aria-label') === 'Thích' || el.getAttribute('aria-label') === 'Like';
                });
                if (likeButtons.length > 0) {
                    likeButtons[0].scrollIntoView({ block: 'center' });
                    likeButtons[0].click();
                    return true;
                }
                return false;
            }, value);
            if (!reactClicked) {
                throw new Error("Không tìm thấy nút Thích/Like trên trang");
            }
        }
        else if (action === "fill_register") {
            // Lấy thông tin profile để có toạ độ địa lý (GPS) và quốc gia lựa chọn
            const profile = await dbManager.getProfile(profileId);
            const lat = profile && profile.latitude !== null ? profile.latitude : 21.0278;
            const lon = profile && profile.longitude !== null ? profile.longitude : 105.8342;
            const country = profile && profile.country ? profile.country : "VN";

            // Dịch ngược toạ độ GPS ra địa chỉ rõ ràng (Nominatim API hoặc fallback offline)
            const clearAddress = await getAddressFromCoords(lat, lon, country);

            // Xác định biến email và phone đang hoạt động trong kịch bản
            let mailVar = "mail_1";
            let phoneVar = "phone_1";
            if (steps && Array.isArray(steps)) {
                const mailStep = steps.find(s => s.action === "create_mail" || s.action === "type_mail");
                if (mailStep && (mailStep.var || mailStep.variable)) mailVar = mailStep.var || mailStep.variable;
                const phoneStep = steps.find(s => s.action === "rent_phone" || s.action === "type_phone");
                if (phoneStep && (phoneStep.var || phoneStep.variable)) phoneVar = phoneStep.var || phoneStep.variable;
            }

            // Hàm helper tạo lại email mới khi bị báo trùng
            const recreateMailForVariable = async (varName) => {
                const apiMailUrl = await dbManager.getSetting("api_mail_url");
                let email = "";
                let username = "";
                let domain = "";
                
                if (apiMailUrl) {
                    browserLauncher.logInfo(`[Smart Fill] Đang gọi API Mail Manager để tạo lại hòm thư mới...`);
                    try {
                        const createRes = await makeHttpRequest(`${apiMailUrl}/api/emails/create`, "POST", {});
                        if (createRes && createRes.success) {
                            email = createRes.address;
                            const parts = email.split("@");
                            username = parts[0];
                            domain = parts[1];
                            browserLauncher.registerProfileEmail(profileId, email);
                            browserLauncher.logInfo(`[Smart Fill] Tạo email mới thành công: ${email}`);
                        }
                    } catch (e) {
                        browserLauncher.logWarning(`[Smart Fill] Tạo email lỗi: ${e.message}. Fallback 1secmail...`);
                    }
                }
                
                if (!email) {
                    username = `user_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
                    const domains = state.email_domains_list && state.email_domains_list.length > 0 ? 
                                    state.email_domains_list : await getEmailDomains1secmail();
                    domain = domains[Math.floor(Math.random() * domains.length)];
                    email = `${username}@${domain}`;
                }
                
                state.variables[varName] = email;
                state.variables[varName + "_username"] = username;
                state.variables[varName + "_domain"] = domain;
                state.email = email;
                state.email_username = username;
                state.email_domain = domain;
                return email;
            };

            // Hàm helper thuê lại số phone mới khi bị báo trùng/lỗi
            const rerentPhoneForVariable = async (varName, service, dialCode, profileCountry) => {
                const viotpToken = await dbManager.getSetting("api_viotp");
                const smspoolKey = await dbManager.getSetting("api_smspool");
                
                // Nếu có số điện thoại cũ đang hoạt động, tiến hành hủy để hoàn tiền
                const oldReqId = state.variables[varName + "_request_id"] || state.phone_request_id;
                const oldUseViotp = state.variables[varName + "_use_viotp"];
                if (oldReqId) {
                    browserLauncher.logInfo(`[Smart Fill] Đang hủy số điện thoại cũ bị lỗi (Request ID: ${oldReqId}) để hoàn tiền...`);
                    if (oldUseViotp && viotpToken) {
                        try { await makeHttpRequest(`https://api.viotp.com/request/cancelv2?token=${viotpToken}&requestId=${oldReqId}`); } catch (e) {}
                    } else if (!oldUseViotp && smspoolKey) {
                        try { await makeHttpRequest(`https://api.smspool.net/sms/cancel?key=${smspoolKey}&orderid=${oldReqId}`); } catch (e) {}
                    }
                }

                let useViotp = false;
                if (dialCode === "84" || profileCountry === "VN") {
                    if (viotpToken) useViotp = true;
                }
                
                let phoneNum = null;
                let reqId = null;
                
                browserLauncher.logInfo(`[Smart Fill] Đang gọi API để thuê số điện thoại mới cho dịch vụ ${service}...`);
                if (useViotp) {
                    const networks = ["VIETTEL", "VINAPHONE", "MOBIFONE", "VIETNAMOBILE"];
                    state.network_idx = (state.network_idx || 0) + 1;
                    const network = networks[state.network_idx % networks.length];
                    const rentRes = await rentPhoneViotp(viotpToken, service, network);
                    phoneNum = rentRes.phone;
                    reqId = rentRes.requestId;
                } else {
                    if (smspoolKey) {
                        const smspoolCountryId = SMSPOOL_COUNTRY_MAP[dialCode.toUpperCase()] || dialCode;
                        const rentRes = await rentPhoneSmspool(smspoolKey, service, smspoolCountryId);
                        phoneNum = rentRes.phone;
                        reqId = rentRes.requestId;
                    } else if (viotpToken) {
                        const rentRes = await rentPhoneViotp(viotpToken, service, "ALL");
                        phoneNum = rentRes.phone;
                        reqId = rentRes.requestId;
                    }
                }
                
                if (phoneNum) {
                    state.variables[varName] = phoneNum;
                    state.variables[varName + "_request_id"] = reqId;
                    state.variables[varName + "_use_viotp"] = useViotp;
                    state.phone_number = phoneNum;
                    state.phone_request_id = reqId;
                    browserLauncher.registerProfilePhone(profileId, reqId, useViotp ? 'viotp' : 'smspool');
                    browserLauncher.logInfo(`[Smart Fill] Thuê số điện thoại mới thành công: ${phoneNum}`);
                    return phoneNum;
                }
                return null;
            };

            // 1. Chờ ổn định form tối đa 5 giây (đợi xem số lượng ô input/select/textarea có thay đổi không)
            let lastCount = 0;
            for (let i = 0; i < 10; i++) {
                const currentCount = await page.evaluate(() => {
                    return document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select').length;
                });
                if (currentCount > 0 && currentCount === lastCount) {
                    break;
                }
                lastCount = currentCount;
                await new Promise(r => setTimeout(r, 500));
            }

            let duplicateUsernameCount = 0;
            let duplicateEmailCount = 0;

            let smartInfo = {
                firstName: generateSmartFirstName(),
                lastName: generateSmartLastName(),
                username: generateSmartUsername(profileId),
                password: generateSmartPassword(),
                birthDay: Math.floor(Math.random() * 28 + 1).toString(),
                birthMonth: Math.floor(Math.random() * 12 + 1).toString(),
                birthYear: Math.floor(Math.random() * 15 + 1988).toString(),
                address: clearAddress
            };
            smartInfo.fullName = `${smartInfo.lastName} ${smartInfo.firstName}`;

            let registrationSuccess = false;
            let submitAttempts = 0;

            // Vòng lặp thử điền và submit form (tối đa 5 lần)
            while (!registrationSuccess && submitAttempts < 5) {
                submitAttempts++;
                browserLauncher.logInfo(`[Smart Fill] Bắt đầu điền và gửi form (Lần thử ${submitAttempts}/5)...`);

                // Quét danh sách các ô nhập liệu hiện tại trên form
                const currentFields = await page.evaluate(() => {
                    const fields = [];
                    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select'));
                    
                    function getUniqueSelector(el) {
                        if (el.id) return `#${el.id}`;
                        if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
                        let sel = el.tagName.toLowerCase();
                        if (el.type) sel += `[type="${el.type}"]`;
                        if (el.className) {
                            const classes = Array.from(el.classList).filter(c => !c.includes(':') && !c.includes('{'));
                            if (classes.length > 0) sel += `.${classes[0]}`;
                        }
                        const parent = el.parentElement;
                        if (parent) {
                            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                            if (siblings.length > 1) {
                                const index = siblings.indexOf(el) + 1;
                                sel += `:nth-of-type(${index})`;
                            }
                        }
                        return sel;
                    }

                    for (const el of inputs) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        const style = window.getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden') continue;

                        const name = (el.name || '').toLowerCase();
                        const id = (el.id || '').toLowerCase();
                        const placeholder = (el.placeholder || '').toLowerCase();
                        const type = (el.type || '').toLowerCase();
                        const label = (el.getAttribute('aria-label') || '').toLowerCase();
                        const tagName = el.tagName.toLowerCase();

                        let fieldType = 'unknown';
                        if (name.includes('firstname') || name.includes('first_name') || id.includes('firstname') || placeholder.includes('họ') || label.includes('họ') || placeholder.includes('first name') || label.includes('first name')) {
                            fieldType = 'firstName';
                        }
                        else if (name.includes('lastname') || name.includes('last_name') || id.includes('lastname') || placeholder.includes('tên') || label.includes('tên') || placeholder.includes('last name') || label.includes('last name')) {
                            if (placeholder.includes('họ và tên') || label.includes('họ và tên') || name.includes('fullname') || name.includes('full_name') || id.includes('fullname') || placeholder.includes('full name') || label.includes('full name')) {
                                fieldType = 'fullName';
                            } else {
                                fieldType = 'lastName';
                            }
                        }
                        else if (name.includes('fullname') || name.includes('full_name') || id.includes('fullname') || placeholder.includes('họ và tên') || label.includes('họ và tên') || placeholder.includes('full name') || label.includes('full name')) {
                            fieldType = 'fullName';
                        }
                        else if (name.includes('username') || name.includes('user_name') || id.includes('username') || id.includes('user_name') || placeholder.includes('username') || placeholder.includes('tên đăng nhập') || label.includes('username')) {
                            fieldType = 'username';
                        }
                        else if (name.includes('day') || id.includes('day') || placeholder.includes('ngày') || label.includes('ngày')) {
                            fieldType = 'birthDay';
                        }
                        else if (name.includes('month') || id.includes('month') || placeholder.includes('tháng') || label.includes('tháng')) {
                            fieldType = 'birthMonth';
                        }
                        else if (name.includes('year') || id.includes('year') || placeholder.includes('năm') || label.includes('năm')) {
                            fieldType = 'birthYear';
                        }
                        else if (name.includes('address') || id.includes('address') || placeholder.includes('địa chỉ') || placeholder.includes('address') || label.includes('địa chỉ')) {
                            fieldType = 'address';
                        }
                        else if (type === 'email' || name.includes('email') || id.includes('email') || placeholder.includes('email')) {
                            fieldType = 'email';
                        }
                        else if (type === 'tel' || name.includes('phone') || id.includes('phone') || placeholder.includes('số điện thoại') || placeholder.includes('sđt') || placeholder.includes('phone')) {
                            fieldType = 'phone';
                        }
                        else if (name.includes('otp') || id.includes('otp') || placeholder.includes('otp') || name.includes('code') || id.includes('code') || placeholder.includes('mã xác') || placeholder.includes('verification')) {
                            fieldType = 'otp';
                        }
                        else if (type === 'password' || name.includes('pass') || id.includes('pass') || placeholder.includes('mật khẩu') || placeholder.includes('password')) {
                            fieldType = 'password';
                        }
                        else if (name.includes('name') || id.includes('name') || placeholder.includes('tên') || label.includes('tên')) {
                            fieldType = 'fullName';
                        }

                        fields.push({
                            selector: getUniqueSelector(el),
                            tagName: tagName,
                            fieldType: fieldType
                        });
                    }
                    return fields;
                });

                // Tối ưu thứ tự điền: Điền trường thường trước, nhạy cảm sau
                const sensitiveTypes = ['email', 'phone', 'otp'];
                const normalFields = currentFields.filter(f => !sensitiveTypes.includes(f.fieldType));
                const sensitiveFields = currentFields.filter(f => sensitiveTypes.includes(f.fieldType));
                const sortedFields = [...normalFields, ...sensitiveFields];

                // Bắt đầu điền từng trường
                for (const field of sortedFields) {
                    const selector = field.selector;
                    const fieldType = field.fieldType;
                    const tagName = field.tagName;

                    if (fieldType === 'unknown') continue;

                    // Lấy giá trị hiện tại
                    const valCurrent = await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        return el ? el.value : '';
                    }, selector);

                    // Kiểm tra xem ô này có bị báo đỏ hay không
                    const isInvalid = await isElementRedOrInvalid(page, selector);

                    // Nếu ô bị trống hoặc báo đỏ, ta thực hiện điền
                    if (!valCurrent || isInvalid) {
                        let valToType = '';
                        if (fieldType === 'firstName') {
                            if (isInvalid) smartInfo.firstName = generateSmartFirstName();
                            valToType = smartInfo.firstName;
                        } else if (fieldType === 'lastName') {
                            if (isInvalid) smartInfo.lastName = generateSmartLastName();
                            valToType = smartInfo.lastName;
                        } else if (fieldType === 'fullName') {
                            if (isInvalid) {
                                smartInfo.firstName = generateSmartFirstName();
                                smartInfo.lastName = generateSmartLastName();
                                smartInfo.fullName = `${smartInfo.lastName} ${smartInfo.firstName}`;
                            }
                            valToType = smartInfo.fullName;
                        } else if (fieldType === 'username') {
                            if (isInvalid) smartInfo.username = generateSmartUsername(profileId);
                            valToType = smartInfo.username;
                        } else if (fieldType === 'password') {
                            if (isInvalid) smartInfo.password = generateSmartPassword();
                            valToType = smartInfo.password;
                        } else if (fieldType === 'birthDay') valToType = smartInfo.birthDay;
                        else if (fieldType === 'birthMonth') valToType = smartInfo.birthMonth;
                        else if (fieldType === 'birthYear') valToType = smartInfo.birthYear;
                        else if (fieldType === 'address') {
                            if (isInvalid) smartInfo.address = await getAddressFromCoords(lat + (Math.random() - 0.5) * 0.1, lon + (Math.random() - 0.5) * 0.1, country);
                            valToType = smartInfo.address;
                        } else if (fieldType === 'email') {
                            let mailValResult = state.variables[mailVar] || state.email;
                            if (!mailValResult) {
                                mailValResult = await recreateMailForVariable(mailVar);
                            }
                            valToType = mailValResult;
                        } else if (fieldType === 'phone') {
                            let phoneValResult = state.variables[phoneVar] || state.phone_number;
                            if (!phoneValResult) {
                                phoneValResult = await rerentPhoneForVariable(phoneVar, state.phone_service || "facebook", state.phone_country_dial || "84", country);
                            }
                            valToType = phoneValResult;
                        } else if (fieldType === 'otp') {
                            valToType = state.otp || state.email_otp || state.phone_otp || '';
                        }

                        if (valToType) {
                            browserLauncher.logInfo(`[Smart Fill] Điền ô ${fieldType} (Gõ: "${valToType}")`);

                            if (tagName === 'select') {
                                try {
                                    await page.select(selector, valToType);
                                } catch (e) {
                                    await page.evaluate((sel, v) => {
                                        const select = document.querySelector(sel);
                                        if (select) {
                                            select.value = v;
                                            select.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    }, selector, valToType);
                                }
                            } else {
                                try {
                                    await page.click(selector);
                                    await page.keyboard.down('Control');
                                    await page.keyboard.press('A');
                                    await page.keyboard.up('Control');
                                    await page.keyboard.press('Backspace');
                                    await new Promise(r => setTimeout(r, 100));

                                    await typeLikeHuman(page, cursor, selector, valToType);

                                    if (fieldType === 'address') {
                                        await new Promise(r => setTimeout(r, 1500));
                                        await page.keyboard.press('ArrowDown');
                                        await new Promise(r => setTimeout(r, 300));
                                        await page.keyboard.press('Enter');
                                    }
                                    
                                    const delayBetweenFields = Math.floor(Math.random() * 500 + 500); // Khoảng nghỉ nhỏ hơn (500-1000ms) để tối ưu tốc độ
                                    await new Promise(r => setTimeout(r, delayBetweenFields));
                                } catch (errType) {
                                    browserLauncher.logWarning(`[Smart Fill Warning] Lỗi gõ ô ${fieldType}: ${errType.message}`);
                                }
                            }
                        }
                    }
                }

                // Thực hiện bấm Submit form
                browserLauncher.logInfo("[Smart Fill] Bấm nút đăng ký (submit)...");
                let clicked = false;
                try {
                    const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'form button', 'form input[type="button"]'];
                    for (const sel of submitSelectors) {
                        const btn = await page.$(sel);
                        if (btn) {
                            const rect = await btn.boundingBox();
                            if (rect && rect.width > 0) {
                                await cursor.click(sel);
                                clicked = true;
                                break;
                            }
                        }
                    }
                    if (!clicked) {
                        clicked = await page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
                            for (const btn of buttons) {
                                const txt = btn.innerText.toLowerCase();
                                if (txt.includes('đăng ký') || txt.includes('register') || txt.includes('sign up') || txt.includes('submit') || btn.type === 'submit') {
                                    btn.scrollIntoView({ block: 'center' });
                                    btn.click();
                                    return true;
                                }
                            }
                            return false;
                        });
                    }
                } catch (submitErr) {
                    browserLauncher.logWarning(`[Smart Fill Warning] Lỗi bấm submit: ${submitErr.message}`);
                }

                // Đợi 4 giây phản hồi
                browserLauncher.logInfo("[Smart Fill] Chờ 4 giây phản hồi từ máy chủ...");
                await new Promise(r => setTimeout(r, 4000));

                // Quét phát hiện lỗi
                const validationError = await detectFormValidationErrors(page);
                if (validationError) {
                    browserLauncher.logWarning(`[Smart Fill Warning] Phát hiện lỗi đăng ký từ trang web: ${validationError.message}`);
                    
                    if (validationError.type === 'email') {
                        duplicateEmailCount++;
                        if (duplicateEmailCount > 3) {
                            throw new Error("Hủy kịch bản: Phát hiện trùng Email quá 3 lần liên tiếp.");
                        }

                        browserLauncher.logInfo(`[Smart Fill] Tiến hành tạo địa chỉ email mới (Số lần trùng: ${duplicateEmailCount}/3)...`);
                        await recreateMailForVariable(mailVar);
                        
                        const emailField = currentFields.find(f => f.fieldType === 'email');
                        if (emailField) {
                            try {
                                await page.click(emailField.selector);
                                await page.keyboard.down('Control');
                                await page.keyboard.press('A');
                                await page.keyboard.up('Control');
                                await page.keyboard.press('Backspace');
                            } catch (e) {}
                        }
                    } 
                    else if (validationError.type === 'phone') {
                        browserLauncher.logInfo(`[Smart Fill] Tiến hành thuê số điện thoại mới...`);
                        await rerentPhoneForVariable(phoneVar, state.phone_service || "facebook", state.phone_country_dial || "84", country);
                        
                        const phoneField = currentFields.find(f => f.fieldType === 'phone');
                        if (phoneField) {
                            try {
                                await page.click(phoneField.selector);
                                await page.keyboard.down('Control');
                                await page.keyboard.press('A');
                                await page.keyboard.up('Control');
                                await page.keyboard.press('Backspace');
                            } catch (e) {}
                        }
                    }
                    else if (validationError.type === 'username') {
                        duplicateUsernameCount++;
                        if (duplicateUsernameCount > 3) {
                            throw new Error("Hủy kịch bản: Phát hiện trùng Username quá 3 lần liên tiếp.");
                        }

                        browserLauncher.logInfo(`[Smart Fill] Tiến hành sinh tên đăng nhập mới (Số lần trùng: ${duplicateUsernameCount}/3)...`);
                        smartInfo.username = generateSmartUsername(profileId);
                        
                        const userField = currentFields.find(f => f.fieldType === 'username');
                        if (userField) {
                            try {
                                await page.click(userField.selector);
                                await page.keyboard.down('Control');
                                await page.keyboard.press('A');
                                await page.keyboard.up('Control');
                                await page.keyboard.press('Backspace');
                            } catch (e) {}
                        }
                    }
                } else {
                    let redFieldDetected = false;
                    for (const field of currentFields) {
                        if (await isElementRedOrInvalid(page, field.selector)) {
                            redFieldDetected = true;
                            browserLauncher.logWarning(`[Smart Fill Warning] Ô ${field.fieldType} vẫn bị báo đỏ/lỗi viền sau submit.`);
                        }
                    }

                    if (!redFieldDetected) {
                        browserLauncher.logInfo(`[Smart Fill] Đăng ký hoàn thành thành công! Không có lỗi nhập liệu nào xuất hiện.`);
                        registrationSuccess = true;
                        break;
                    }
                }
            }

            if (!registrationSuccess) {
                throw new Error("Không thể vượt qua lỗi đăng ký tự động trên form sau 5 lần thử sửa lỗi.");
            }
        }
        else if (action === "solve_captcha") {
            const targetVar = varName || "captcha_1";
            const service = captchaService || "autocaptchapro";
            
            const apiKeySettingName = `api_${service}`;
            const apiKey = await dbManager.getSetting(apiKeySettingName);
            if (!apiKey) {
                throw new Error(`Chưa cấu hình API Key cho dịch vụ giải captcha ${service}. Vui lòng kiểm tra cài đặt.`);
            }

            browserLauncher.logInfo(`[Captcha] Đang chuẩn bị giải captcha trên selector: ${target} sử dụng dịch vụ: ${service} (Lưu vào biến ${targetVar})...`);
            
            await page.waitForSelector(target, { timeout: stepTimeout });
            const element = await page.$(target);
            if (!element) {
                throw new Error(`Không tìm thấy phần tử captcha theo selector ${target}`);
            }

            const imgBase64 = await element.screenshot({ encoding: 'base64' });
            
            const solutionText = await solveImageCaptcha(service, apiKey, imgBase64);
            if (!solutionText) {
                throw new Error("Không giải được captcha (phản hồi rỗng)");
            }

            state.variables[targetVar] = solutionText;
            state.captcha_result = solutionText;
            browserLauncher.logInfo(`[Captcha] Giải captcha thành công cho biến ${targetVar}: ${solutionText}`);
        }
        else if (action === "rotate_proxy") {
            await triggerProxyRotation(profileId, value);
        }
        else if (action === "check_proxy") {
            const ip = await checkCurrentProxyIp(page);
            if (!ip) {
                throw new Error("Proxy Die hoặc không thể kết nối Internet qua Proxy.");
            }
            state.current_proxy_ip = ip;
            browserLauncher.logInfo(`[Proxy Check] IP hiện tại của Proxy: ${ip}`);
        }
        else if (action === "rotate_proxy_if_die") {
            const ip = await checkCurrentProxyIp(page);
            if (!ip) {
                browserLauncher.logWarning(`[Proxy Rotate If Die] Phát hiện Proxy Die, tiến hành xoay proxy...`);
                const rotated = await triggerProxyRotation(profileId, value);
                if (rotated) {
                    const newIp = await checkCurrentProxyIp(page);
                    if (!newIp) {
                        throw new Error("Đã xoay proxy nhưng Proxy vẫn Die.");
                    }
                    state.current_proxy_ip = newIp;
                    browserLauncher.logInfo(`[Proxy Rotate If Die] Xoay proxy thành công. IP mới: ${newIp}`);
                } else {
                    throw new Error("Không thể gọi API xoay Proxy.");
                }
            } else {
                state.current_proxy_ip = ip;
                browserLauncher.logInfo(`[Proxy Rotate If Die] Proxy vẫn hoạt động tốt. IP: ${ip}`);
            }
        }
        else if (action === "rotate_proxy_every_n_runs") {
            global.proxy_run_counts = global.proxy_run_counts || {};
            global.proxy_run_counts[profileId] = (global.proxy_run_counts[profileId] || 0) + 1;
            const n = parseInt(value) || 1;
            if (global.proxy_run_counts[profileId] >= n) {
                browserLauncher.logInfo(`[Proxy Run Count] Bộ đếm đạt ${global.proxy_run_counts[profileId]}/${n} lần chạy. Tiến hành xoay proxy...`);
                await triggerProxyRotation(profileId);
                global.proxy_run_counts[profileId] = 0;
            } else {
                browserLauncher.logInfo(`[Proxy Run Count] Bộ đếm: ${global.proxy_run_counts[profileId]}/${n} lần chạy. Bỏ qua xoay proxy.`);
            }
        }
        else if (action === "get_old_ip") {
            const currentIp = await checkCurrentProxyIp(page);
            if (!currentIp) {
                throw new Error("Không thể kiểm tra IP hiện tại của Proxy.");
            }
            let oldIp = readProfileOldIp(profileId);
            if (!oldIp) {
                saveProfileOldIp(profileId, currentIp);
                state.current_proxy_ip = currentIp;
                browserLauncher.logInfo(`[Get Old IP] Đã lưu IP đầu tiên cho Profile ${profileId}: ${currentIp}`);
            } else {
                browserLauncher.logInfo(`[Get Old IP] Profile ${profileId} có IP cũ là: ${oldIp}. IP hiện tại là: ${currentIp}`);
                if (currentIp !== oldIp) {
                    browserLauncher.logInfo(`[Get Old IP] Phát hiện IP hiện tại khác IP cũ. Đang thử xoay để lấy lại IP cũ...`);
                    let attempts = 0;
                    let matched = false;
                    let tempIp = currentIp;
                    while (attempts < 3) {
                        attempts++;
                        browserLauncher.logInfo(`[Get Old IP] Thử xoay lần thứ ${attempts}/3...`);
                        const rotated = await triggerProxyRotation(profileId, value);
                        if (rotated) {
                            tempIp = await checkCurrentProxyIp(page);
                            if (tempIp === oldIp) {
                                matched = true;
                                state.current_proxy_ip = tempIp;
                                browserLauncher.logInfo(`[Get Old IP] Đã khôi phục thành công IP cũ: ${oldIp}`);
                                break;
                            } else {
                                browserLauncher.logInfo(`[Get Old IP] IP sau khi xoay là: ${tempIp}, vẫn chưa khớp với IP cũ.`);
                            }
                        } else {
                            browserLauncher.logWarning(`[Get Old IP] Xoay proxy thất bại ở lần thử ${attempts}.`);
                        }
                    }
                    if (!matched) {
                        saveProfileOldIp(profileId, tempIp);
                        state.current_proxy_ip = tempIp;
                        browserLauncher.logWarning(`[Get Old IP Warning] Đã thử xoay 3 lần nhưng không lấy lại được IP cũ. Chấp nhận IP mới: ${tempIp}`);
                    }
                } else {
                    state.current_proxy_ip = currentIp;
                    browserLauncher.logInfo(`[Get Old IP] IP hiện tại khớp với IP cũ.`);
                }
            }
        }
        else if (action === "delete_mail") {
            const email = state.email || state.variables[varName || "email_1"];
            if (email) {
                const apiMailUrl = await dbManager.getSetting("api_mail_url");
                if (apiMailUrl) {
                    browserLauncher.logInfo(`[Delete Mail] Yêu cầu xóa mail ${email} trên Mail Manager...`);
                    try {
                        await makeHttpRequest(`${apiMailUrl}/api/emails/delete`, "POST", { address: email }, {}, 8000);
                    } catch (e) {
                        browserLauncher.logWarning(`[Delete Mail Warning] Lỗi khi gọi API xóa mail: ${e.message}`);
                    }
                }
                if (state.email === email) {
                    state.email = null;
                    state.email_username = null;
                    state.email_domain = null;
                }
                const targetVar = varName || "email_1";
                if (state.variables[targetVar] === email) {
                    delete state.variables[targetVar];
                    delete state.variables[targetVar + "_username"];
                    delete state.variables[targetVar + "_domain"];
                }
            } else {
                browserLauncher.logWarning(`[Delete Mail] Không có email trong state hoặc biến để xóa.`);
            }
        }
        else if (action === "cancel_phone") {
            const targetVar = varName || "phone_1";
            const reqId = state.variables[targetVar + "_request_id"] || state.phone_request_id;
            const useViotp = state.variables[targetVar + "_use_viotp"] !== undefined ? state.variables[targetVar + "_use_viotp"] : state.phone_use_viotp;
            if (reqId) {
                const viotpToken = await dbManager.getSetting("api_viotp");
                const smspoolKey = await dbManager.getSetting("api_smspool");
                browserLauncher.logInfo(`[Cancel Phone] Tiến hành hủy thuê số điện thoại ID: ${reqId}...`);
                try {
                    if (useViotp && viotpToken) {
                        await makeHttpRequest(`https://api.viotp.com/request/cancelv2?token=${viotpToken}&requestId=${reqId}`);
                    } else if (smspoolKey) {
                        await makeHttpRequest(`https://api.smspool.net/sms/cancel?key=${smspoolKey}&orderid=${reqId}`);
                    }
                } catch (e) {
                    browserLauncher.logWarning(`[Cancel Phone Warning] Lỗi khi hủy thuê số: ${e.message}`);
                }
                if (state.phone_request_id === reqId) {
                    state.phone_number = null;
                    state.phone_request_id = null;
                }
                delete state.variables[targetVar];
                delete state.variables[targetVar + "_request_id"];
                delete state.variables[targetVar + "_use_viotp"];
            } else {
                browserLauncher.logWarning(`[Cancel Phone] Không tìm thấy Request ID để hủy thuê số.`);
            }
        }
    };

    // Hàm thực hiện hành động theo cách 2 (Cách khác - Giao tiếp trực tiếp / Dự phòng)
    const runWay2 = async () => {
        browserLauncher.logWarning(`[Step Retry] Dang thu thuc hien lai buoc ${action} theo cach khac...`);
        if (action === "goto") {
            await page.evaluate((url) => { window.location.href = url; }, value);
            await new Promise(r => setTimeout(r, 5000)); // Đợi 5 giây trang tải
        } 
        else if (action === "click") {
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.scrollIntoView({ block: 'center' });
                    el.click();
                } else {
                    throw new Error("Không tìm thấy element trong DOM cách 2");
                }
            }, target);
        } 
        else if (action === "click_right") {
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.scrollIntoView({ block: 'center' });
                    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
                } else {
                    throw new Error("Không tìm thấy selector chuột phải");
                }
            }, target);
        }
        else if (action === "click_xy" || action === "click_right_xy") {
            const coords = value.split(/[\s,]+/).map(Number);
            const x = coords[0];
            const y = coords[1];
            await page.evaluate((cx, cy, right) => {
                const el = document.elementFromPoint(cx, cy);
                if (el) {
                    const eventName = right ? 'contextmenu' : 'click';
                    el.dispatchEvent(new MouseEvent(eventName, { clientX: cx, clientY: cy, bubbles: true }));
                } else {
                    throw new Error(`Không tìm thấy phần tử tại tọa độ ${cx}, ${cy}`);
                }
            }, x, y, action === "click_right_xy");
        }
        else if (action === "hover") {
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.scrollIntoView({ block: 'center' });
                    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                }
            }, target);
        }
        else if (action === "social_message" || action === "social_reply_unread" || action === "social_reply_comment" || action === "social_reaction" || action === "fill_register") {
            await runWay1();
        }
        else if (action === "type") {
            await page.evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.scrollIntoView({ block: 'center' });
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    throw new Error("Không tìm thấy element nhập liệu cách 2");
                }
            }, target, value);
        } 
        else if (action === "press") {
            await page.evaluate((key) => {
                const activeEl = document.activeElement || document.body;
                activeEl.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
                activeEl.dispatchEvent(new KeyboardEvent('keypress', { key: key, bubbles: true }));
                activeEl.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true }));
            }, value);
        } 
        else if (action === "scroll") {
            await page.evaluate((val) => {
                window.scrollTo({
                    top: val === "up" ? 0 : document.body.scrollHeight,
                    behavior: 'smooth'
                });
            }, value);
            await new Promise(r => setTimeout(r, 1000));
        }
        else if (action === "wait") {
            await new Promise(r => setTimeout(r, 2000));
        }
        else if (action === "rent_phone") {
            state.network_idx += 1;
            const service = target || "facebook";
            const profile = await dbManager.getProfile(profileId);
            const timezone = profile ? profile.timezone : null;
            let { countryCode, dialCode } = guessCountryFromTimezone(timezone);
            
            if (value) {
                const valClean = value.trim().toUpperCase();
                if (valClean === "VN" || valClean === "84") {
                    countryCode = "VN";
                    dialCode = "84";
                } else {
                    countryCode = valClean;
                    dialCode = valClean;
                }
            }

            const viotpToken = await dbManager.getSetting("api_viotp");
            const smspoolKey = await dbManager.getSetting("api_smspool");
            
            let phoneNum = null;
            let reqId = null;
            
            let useViotp = false;
            if (dialCode === "84" || countryCode === "VN") {
                if (viotpToken) useViotp = true;
            }

            if (useViotp) {
                const networks = ["VIETTEL", "VINAPHONE", "MOBIFONE", "VIETNAMOBILE"];
                const network = networks[state.network_idx % networks.length];
                const rentRes = await rentPhoneViotp(viotpToken, service, network);
                phoneNum = rentRes.phone;
                reqId = rentRes.requestId;
            } else if (smspoolKey) {
                const smspoolCountryId = SMSPOOL_COUNTRY_MAP[dialCode.toUpperCase()] || dialCode;
                const rentRes = await rentPhoneSmspool(smspoolKey, service, smspoolCountryId);
                phoneNum = rentRes.phone;
                reqId = rentRes.requestId;
            }
            
            if (phoneNum) {
                state.phone_number = phoneNum;
                state.phone_request_id = reqId;
            } else {
                throw new Error("Thuê số điện thoại dự phòng thất bại.");
            }
        }
        else if (action === "type_phone") {
            const phone = state.phone_number;
            if (!phone) throw new Error("Chưa có số điện thoại dự phòng.");
            await page.evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    throw new Error("Không tìm thấy ô nhập sđt cách 2");
                }
            }, target, phone);
        }
        else if (action === "get_phone_code") {
            browserLauncher.logWarning("[Step Retry] Xoay so dien thoai moi do cach 1 het han...");
            state.network_idx += 1;
            const service = state.phone_service || "facebook";
            const dialCode = state.phone_country_dial || "84";
            
            const viotpToken = await dbManager.getSetting("api_viotp");
            const smspoolKey = await dbManager.getSetting("api_smspool");
            
            let newPhoneNum = null;
            let newReqId = null;
            
            let useViotp = false;
            if (dialCode === "84") {
                if (viotpToken) useViotp = true;
            }

            if (useViotp) {
                const rentRes = await rentPhoneViotp(viotpToken, service, "ALL");
                newPhoneNum = rentRes.phone;
                newReqId = rentRes.requestId;
            } else if (smspoolKey) {
                const smspoolCountryId = SMSPOOL_COUNTRY_MAP[dialCode.toUpperCase()] || dialCode;
                const rentRes = await rentPhoneSmspool(smspoolKey, service, smspoolCountryId);
                newPhoneNum = rentRes.phone;
                newReqId = rentRes.requestId;
            }
            
            if (newPhoneNum) {
                state.phone_number = newPhoneNum;
                state.phone_request_id = newReqId;
                
                let phoneInputSelector = null;
                for (let sIdx = 0; sIdx < steps.length; sIdx++) {
                    if (steps[sIdx].action === "type_phone") {
                        phoneInputSelector = steps[sIdx].target;
                        break;
                    }
                }
                
                if (phoneInputSelector) {
                    await page.evaluate((sel, val) => {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.value = val;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }, phoneInputSelector, newPhoneNum);
                }
                
                const startTime = Date.now();
                let otpCode = null;
                while (Date.now() - startTime < 20000) {
                    let checkRes;
                    if (viotpToken && dialCode === "84") {
                        checkRes = await checkOtpViotp(viotpToken, newReqId);
                    } else {
                        checkRes = await checkOtpSmspool(smspoolKey, newReqId);
                    }
                    if (checkRes && checkRes.code) {
                        otpCode = checkRes.code;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 2000));
                }
                
                if (otpCode) {
                    await page.evaluate((sel, val) => {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.value = val;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }, target, otpCode);
                } else {
                    throw new Error("Không nhận được OTP số điện thoại xoay vòng.");
                }
            } else {
                throw new Error("Không thuê được số điện thoại xoay vòng.");
            }
        }
        else if (action === "create_mail") {
            state.domain_idx += 1;
            const username = `user_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
            const domains = state.email_domains_list.length > 0 ? state.email_domains_list : await getEmailDomains1secmail();
            const domain = domains[state.domain_idx % domains.length];
            state.email = `${username}@${domain}`;
            state.email_username = username;
            state.email_domain = domain;
        }
        else if (action === "type_mail") {
            const email = state.email;
            if (!email) throw new Error("Chưa có email dự phòng.");
            await page.evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    throw new Error("Không tìm thấy ô nhập email cách 2");
                }
            }, target, email);
        }
        else if (action === "get_mail_code") {
            browserLauncher.logWarning("[Step Retry] Đổi domain email mới do cách 1 hết hạn...");
            state.domain_idx += 1;
            const username = state.email_username;
            const domains = state.email_domains_list.length > 0 ? state.email_domains_list : await getEmailDomains1secmail();
            const newDomain = domains[state.domain_idx % domains.length];
            const newEmail = `${username}@${newDomain}`;
            
            state.email = newEmail;
            state.email_domain = newDomain;
            
            let emailInputSelector = null;
            for (let sIdx = 0; sIdx < steps.length; sIdx++) {
                if (steps[sIdx].action === "type_mail") {
                    emailInputSelector = steps[sIdx].target;
                    break;
                }
            }
            
            if (emailInputSelector) {
                await page.evaluate((sel, val) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.value = val;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, emailInputSelector, newEmail);
            }
            
            const startTime = Date.now();
            let otpCode = null;
            while (Date.now() - startTime < 20000) {
                const code = await checkEmailOtp1secmail(username, newDomain);
                if (code) {
                    otpCode = code;
                    break;
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            
            if (otpCode) {
                await page.evaluate((sel, val) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.value = val;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, target, otpCode);
            } else {
                throw new Error("Không nhận được OTP từ email xoay vòng cách 2.");
            }
        }
        else if (action === "solve_captcha" || action === "rotate_proxy" || action === "check_proxy" || action === "rotate_proxy_if_die" || action === "rotate_proxy_every_n_runs" || action === "get_old_ip" || action === "delete_mail" || action === "cancel_phone") {
            await runWay1();
        }
    };
    // Thực hiện chạy cách 1
    try {
        await runWay1();
        if (action !== "wait") {
            // Tự động gọi Smart Wait sau mỗi hành động tương tác (click, type, goto, press...) để đợi mạng rảnh & DOM ổn định
            await smartWait(page);
            const stepDelay = 200 + Math.floor(Math.random() * 300); // Trễ sinh học rất nhỏ để mô phỏng người thật
            await new Promise(r => setTimeout(r, stepDelay));
        }
        return { success: true };
    } catch (err1) {
        browserLauncher.logWarning(`[Step Failure] Buoc ${idx + 1} (${action}) that bai cach 1: ${err1.message}`);
        // Chạy thử cách 2
        try {
            await runWay2();
            if (action !== "wait") {
                await smartWait(page);
                const stepDelay = 200 + Math.floor(Math.random() * 300);
                await new Promise(r => setTimeout(r, stepDelay));
            }
            return { success: true };
        } catch (err2) {
            browserLauncher.logError(`[Step Failure] Buoc ${idx + 1} (${action}) that bai hoan toan ca 2 cach: ${err2.message}`);
            return { success: false, error: err2.message };
        }
    }
}
// --- OFFLINE STORAGE HELPERS (Các hàm lưu trữ dữ liệu ngoại tuyến trong thư mục dự án) ---
const OFFLINE_STORAGE_DIR = path.join(__dirname, 'offline_storage');

// Tự động tạo thư mục lưu trữ offline nếu chưa có
try {
    if (!fs.existsSync(OFFLINE_STORAGE_DIR)) {
        fs.mkdirSync(OFFLINE_STORAGE_DIR, { recursive: true });
    }
} catch (e) {
    console.error(`[Offline Storage Error] Không thể tạo thư mục offline_storage: ${e.message}`);
}

async function readOfflineFile(filename) {
    try {
        const filePath = path.isAbsolute(filename) ? filename : path.join(OFFLINE_STORAGE_DIR, filename);
        if (!fs.existsSync(filePath)) {
            browserLauncher.logWarning(`[Offline Storage] File không tồn tại: ${filename}`);
            return null;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        try {
            return JSON.parse(content);
        } catch (e) {
            return content; // Trả về chuỗi thô nếu không phải JSON
        }
    } catch (err) {
        browserLauncher.logError(`[Offline Storage Error] Lỗi đọc file ${filename}: ${err.message}`);
        return null;
    }
}

async function writeOfflineFile(filename, data) {
    try {
        const filePath = path.isAbsolute(filename) ? filename : path.join(OFFLINE_STORAGE_DIR, filename);
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        const content = typeof data === 'object' ? JSON.stringify(data, null, 4) : data.toString();
        fs.writeFileSync(filePath, content, 'utf8');
        browserLauncher.logInfo(`[Offline Storage] Đã lưu dữ liệu vào: ${filename}`);
        return true;
    } catch (err) {
        browserLauncher.logError(`[Offline Storage Error] Lỗi ghi file ${filename}: ${err.message}`);
        return false;
    }
}

// --- GEMINI HELPER (Gửi prompt phân tích tới Gemini AI hỗ trợ xoay tua keys dự phòng) ---
async function askGemini(prompt, responseMimeType = "application/json") {
    const geminiKey = await dbManager.getSetting("api_gemini");
    if (!geminiKey) {
        throw new Error("Chưa cấu hình API Key Gemini! Vui lòng lưu API Gemini trong phần 'Cấu hình chung'.");
    }
    const keys = geminiKey.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
        throw new Error("Không có API key Gemini nào khả dụng.");
    }
    
    // Lấy model từ setting, mặc định gemini-2.0-flash
    const modelSelectSetting = await dbManager.getSetting("api_gemini_model");
    let modelName = modelSelectSetting || "gemini-2.0-flash";
    if (modelName.includes("2.5")) {
        modelName = modelName.replace("2.5", "2.0");
    }
    
    const reqBody = {
        contents: [{ parts: [{ text: prompt }] }],
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
        ]
    };
    
    if (responseMimeType) {
        reqBody.generationConfig = { responseMimeType };
    }
    
    let resData = null;
    let success = false;
    let lastError = null;
    
    for (let i = 0; i < keys.length; i++) {
        const currentKey = keys[i];
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentKey}`;
        try {
            browserLauncher.logInfo(`[Gemini Helper] Đang gửi yêu cầu tới Gemini (Key index: ${i})...`);
            resData = await makeHttpRequest(url, "POST", reqBody, {}, 25000);
            if (resData && resData.candidates && resData.candidates[0] && resData.candidates[0].content) {
                success = true;
                break;
            } else {
                throw new Error(resData ? JSON.stringify(resData) : "Phản hồi rỗng");
            }
        } catch (err) {
            browserLauncher.logWarning(`[Gemini Helper Warning] Lỗi key index ${i}: ${err.message}. Đang thử key dự phòng...`);
            lastError = err;
        }
    }
    
    if (!success) {
        throw new Error(`Tất cả API keys Gemini đều lỗi. Lỗi cuối cùng: ${lastError ? lastError.message : "Không rõ"}`);
    }
    
    const contentText = resData.candidates[0].content.parts[0].text;
    if (!contentText) {
        throw new Error("Phản hồi từ Gemini rỗng");
    }
    return contentText.trim();
}

// --- BYPASS OTP HELPER (Tự động vượt xác minh OTP thông minh bằng AI Gemini) ---
async function autoVerify(page, state, profileId) {
    browserLauncher.logInfo("[autoVerify] Bắt đầu kích hoạt quy trình tự động vượt OTP thông minh...");
    
    // 1. Quét HTML của form hiện tại trên trình duyệt
    const cleanHtml = await page.evaluate(() => {
        const clone = document.body.cloneNode(true);
        const tagsToRemove = ['script', 'style', 'svg', 'iframe', 'noscript', 'link', 'meta'];
        tagsToRemove.forEach(tag => {
            const els = clone.querySelectorAll(tag);
            els.forEach(el => el.remove());
        });
        let text = clone.innerHTML || "";
        text = text.replace(/\s+/g, ' ').trim();
        if (text.length > 15000) {
            text = text.substring(0, 15000) + "...[TRUNCATED]";
        }
        return text;
    });
    
    // 2. Hỏi Gemini xem form này đòi xác minh gì
    browserLauncher.logInfo("[autoVerify] Gửi cấu trúc trang lên AI Gemini để nhận diện loại xác minh (SĐT/Email/Cả hai)...");
    const classificationPrompt = `
    Bạn là một chuyên gia phân tích HTML form. Hãy đọc mã HTML của form dưới đây và xác định xem form này đang yêu cầu xác minh thông tin gì của người dùng:
    - "phone": Nếu form yêu cầu nhập số điện thoại hoặc gửi mã OTP qua số điện thoại.
    - "email": Nếu form yêu cầu nhập email hoặc gửi mã OTP qua email.
    - "both": Nếu form yêu cầu cả số điện thoại và email.
    - "none": Nếu form không yêu cầu xác minh số điện thoại hay email (hoặc là form đăng nhập thông thường không có OTP).
    
    Trả về kết quả dưới dạng đối tượng JSON duy nhất có cấu trúc:
    {
      "verification_type": "phone" | "email" | "both" | "none",
      "reason": "Giải thích ngắn gọn tại sao"
    }
    
    Mã HTML của form:
    ${cleanHtml}
    `;
    
    let classification = { verification_type: "none", reason: "Không xác định" };
    try {
        const rawRes = await askGemini(classificationPrompt, "application/json");
        classification = JSON.parse(rawRes);
        browserLauncher.logInfo(`[autoVerify] Kết quả phân loại từ AI: ${classification.verification_type.toUpperCase()} (Lý do: ${classification.reason})`);
    } catch (e) {
        browserLauncher.logError(`[autoVerify Error] Lỗi phân loại qua Gemini: ${e.message}`);
        // Fallback: Quét nhanh HTML bằng regex đơn giản để tự phán đoán
        const htmlLower = cleanHtml.toLowerCase();
        if ((htmlLower.includes("phone") || htmlLower.includes("sđt") || htmlLower.includes("số điện thoại") || htmlLower.includes("sms")) && (htmlLower.includes("email") || htmlLower.includes("thư điện tử"))) {
            classification.verification_type = "both";
        } else if (htmlLower.includes("phone") || htmlLower.includes("sđt") || htmlLower.includes("số điện thoại") || htmlLower.includes("sms")) {
            classification.verification_type = "phone";
        } else if (htmlLower.includes("email") || htmlLower.includes("thư điện tử") || htmlLower.includes("mail")) {
            classification.verification_type = "email";
        } else {
            classification.verification_type = "none";
        }
        browserLauncher.logWarning(`[autoVerify Warning] Đã fallback sang thuật toán phân tích regex cục bộ: ${classification.verification_type.toUpperCase()}`);
    }
    
    const vType = classification.verification_type;
    if (vType === "none") {
        browserLauncher.logInfo("[autoVerify] AI nhận định trang không yêu cầu xác minh OTP. Hoàn tất!");
        return true;
    }
    
    let phoneNum = null;
    let requestId = null;
    let emailAddress = null;
    
    // 3. Gọi dịch vụ API tương ứng
    const profile = await dbManager.getProfile(profileId);
    const timezone = profile ? profile.timezone : null;
    let { countryCode, dialCode } = guessCountryFromTimezone(timezone);
    
    // Xác định tên dịch vụ (nền tảng) dựa trên URL
    const urlStr = page.url().toLowerCase();
    let serviceName = "khac";
    if (urlStr.includes("facebook.com")) serviceName = "facebook";
    else if (urlStr.includes("google.com") || urlStr.includes("gmail.com")) serviceName = "google";
    else if (urlStr.includes("microsoft.com") || urlStr.includes("outlook.com") || urlStr.includes("live.com")) serviceName = "microsoft";
    else if (urlStr.includes("telegram")) serviceName = "telegram";
    else if (urlStr.includes("twitter") || urlStr.includes("x.com")) serviceName = "twitter";
    
    const viotpToken = await dbManager.getSetting("api_viotp");
    const smspoolKey = await dbManager.getSetting("api_smspool");
    
    let useViotp = false;
    if (dialCode === "84" || countryCode === "VN") {
        if (viotpToken) useViotp = true;
    }
    
    // Nhánh 1 hoặc Nhánh 3: Cần Số điện thoại
    if (vType === "phone" || vType === "both") {
        browserLauncher.logInfo(`[autoVerify] Đang yêu cầu dịch vụ thuê số điện thoại (service: ${serviceName})...`);
        try {
            if (useViotp) {
                const rentRes = await rentPhoneViotp(viotpToken, serviceName, "ALL");
                phoneNum = rentRes.phone;
                requestId = rentRes.requestId;
            } else {
                if (smspoolKey) {
                    const rentRes = await rentPhoneSmspool(smspoolKey, serviceName, dialCode);
                    phoneNum = rentRes.phone;
                    requestId = rentRes.requestId;
                } else if (viotpToken) {
                    const rentRes = await rentPhoneViotp(viotpToken, serviceName, "ALL");
                    phoneNum = rentRes.phone;
                    requestId = rentRes.requestId;
                }
            }
            
            if (phoneNum) {
                browserLauncher.logInfo(`[autoVerify] Đã thuê được SĐT: ${phoneNum} (Mã yêu cầu: ${requestId})`);
                state.phone_number = phoneNum;
                state.phone_request_id = requestId;
                state.phone_service = serviceName;
            } else {
                throw new Error("Dịch vụ trả về số điện thoại rỗng. Vui lòng kiểm tra số dư tài khoản.");
            }
        } catch (errRent) {
            browserLauncher.logError(`[autoVerify Error] Thuê số thất bại: ${errRent.message}`);
            await dbManager.addAutomationLog(profileId, vType, "Không có", "Không có", "Thất bại", `Lỗi thuê số: ${errRent.message}`);
            return false;
        }
    }
    
    // Nhánh 2 hoặc Nhánh 3: Cần Email
    if (vType === "email" || vType === "both") {
        browserLauncher.logInfo("[autoVerify] Đang khởi tạo hòm thư ảo từ 1secmail...");
        try {
            const domains = await getEmailDomains1secmail();
            const randomUser = "user" + Math.floor(Math.random() * 9000000 + 1000000);
            const randomDomain = domains[Math.floor(Math.random() * domains.length)];
            emailAddress = `${randomUser}@${randomDomain}`;
            
            state.email = emailAddress;
            state.email_username = randomUser;
            state.email_domain = randomDomain;
            browserLauncher.logInfo(`[autoVerify] Tạo hòm thư ảo thành công: ${emailAddress}`);
        } catch (errMail) {
            browserLauncher.logError(`[autoVerify Error] Tạo email thất bại: ${errMail.message}`);
            await dbManager.addAutomationLog(profileId, vType, "Không có", "Không có", "Thất bại", `Lỗi tạo email: ${errMail.message}`);
            return false;
        }
    }
    
    // 4. Nhờ AI sinh JS điền thông tin và bấm nhận OTP
    browserLauncher.logInfo("[autoVerify] Yêu cầu AI Gemini sinh mã JavaScript tự động điền thông tin và bấm nhận mã...");
    const fillPrompt = `
    Bạn là một chuyên gia tự động hóa Puppeteer.
    Nhiệm vụ của bạn là viết một đoạn code JavaScript bất đồng bộ (async/await) chạy trong môi trường Puppeteer của chúng tôi để điền thông tin xác minh vào form HTML hiện tại và bấm nút gửi mã OTP (hoặc nút nhận mã).
    
    Bạn được cung cấp sẵn các biến/hàm sau trong ngữ cảnh thực thi:
    - page: Đối tượng Page của Puppeteer.
    - type(selector, text): Hàm điền text vào input (xóa trắng trước khi gõ).
    - click(selector): Hàm click vào phần tử.
    - wait(ms): Hàm chờ đợi mili giây.
    - logInfo(msg): Hàm ghi log.
    
    Thông tin cần điền:
    ${phoneNum ? `- Số điện thoại: "${phoneNum}"` : ""}
    ${emailAddress ? `- Email: "${emailAddress}"` : ""}
    
    Mã HTML của form:
    ${cleanHtml}
    
    Yêu cầu:
    - Tìm chính xác các ô nhập liệu số điện thoại / email dựa trên HTML và sử dụng hàm await type(selector, value) để nhập dữ liệu.
    - Tìm chính xác nút "Gửi mã", "Nhận OTP", "Tiếp tục" hoặc nút submit tương ứng để gửi mã OTP, và sử dụng hàm await click(selector) để bấm nút.
    - Thêm các lệnh await wait(1000) cần thiết giữa các bước để đảm bảo sinh học chống robot.
    - Trả về kết quả dưới dạng đối tượng JSON duy nhất có cấu trúc:
    {
      "explanation": "Giải thích các bước thực hiện điền thông tin",
      "js_code": "Đoạn code JS thực thi (chỉ chứa các câu lệnh JS, không bao bọc trong hàm và không có markdown block \`\`\`js)"
    }
    `;
    
    let fillJsCode = "";
    try {
        const rawRes = await askGemini(fillPrompt, "application/json");
        const resJson = JSON.parse(rawRes);
        fillJsCode = resJson.js_code;
        browserLauncher.logInfo(`[autoVerify] AI đề xuất mã điền: \n${fillJsCode}`);
    } catch (e) {
        browserLauncher.logError(`[autoVerify Error] Lỗi khi AI sinh mã điền thông tin: ${e.message}`);
        await dbManager.addAutomationLog(profileId, vType, phoneNum || emailAddress || "Không có", "Không có", "Thất bại", `Lỗi sinh mã điền: ${e.message}`);
        return false;
    }
    
    // Bơm JS vào Chrome chạy để gửi OTP
    browserLauncher.logInfo("[autoVerify] Tiến hành tiêm mã JavaScript điền thông tin vào trình duyệt...");
    try {
        const cursor = createCursor(page);
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const context = {
            page,
            type: async (selector, val) => {
                await page.waitForSelector(selector, { timeout: 15000 });
                await cursor.click(selector);
                await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) el.value = '';
                }, selector);
                await new Promise(r => setTimeout(r, 100));
                for (const char of val.toString()) {
                    await page.keyboard.sendCharacter(char);
                    await new Promise(r => setTimeout(r, Math.random() * 60 + 30));
                }
            },
            click: async (selector) => {
                await page.waitForSelector(selector, { timeout: 15000 });
                await cursor.click(selector);
            },
            wait: async (ms) => await new Promise(r => setTimeout(r, ms)),
            logInfo: (msg) => browserLauncher.logInfo(`[Inject Fill Code] ${msg}`)
        };
        
        const runFillScript = new AsyncFunction(...Object.keys(context), fillJsCode);
        await runFillScript(...Object.values(context));
        browserLauncher.logInfo("[autoVerify] Điền thông tin và gửi mã OTP thành công. Chờ trang cập nhật...");
        await new Promise(r => setTimeout(r, 4000)); // Chờ 4 giây để hệ thống gửi OTP và đổi giao diện
    } catch (errInject) {
        browserLauncher.logError(`[autoVerify Error] Lỗi khi thực thi mã điền thông tin: ${errInject.message}`);
        await dbManager.addAutomationLog(profileId, vType, phoneNum || emailAddress || "Không có", "Không có", "Thất bại", `Lỗi thực thi mã điền: ${errInject.message}`);
        return false;
    }
    
    // 5. Node.js gọi vòng lặp API để lấy OTP
    let otpCode = null;
    const maxRetries = 24; // 24 lần * 2.5s = 60s
    
    if (phoneNum && requestId) {
        browserLauncher.logInfo("[autoVerify] Đang chạy vòng lặp lấy mã OTP từ dịch vụ SMS...");
        for (let retry = 0; retry < maxRetries; retry++) {
            await new Promise(r => setTimeout(r, 2500));
            try {
                let checkRes = null;
                if (useViotp) {
                    checkRes = await checkOtpViotp(viotpToken, requestId);
                } else if (smspoolKey) {
                    checkRes = await checkOtpSmspool(smspoolKey, requestId);
                } else if (viotpToken) {
                    checkRes = await checkOtpViotp(viotpToken, requestId);
                }
                
                if (checkRes && checkRes.code) {
                    otpCode = checkRes.code;
                    browserLauncher.logInfo(`[autoVerify] Đã nhận được mã OTP SMS: ${otpCode}`);
                    break;
                }
                browserLauncher.logInfo(`[autoVerify] Đang đợi mã OTP SMS (Lần thử ${retry + 1}/${maxRetries})...`);
            } catch (errCheck) {
                browserLauncher.logWarning(`[autoVerify Warning] Lỗi khi kiểm tra OTP SMS: ${errCheck.message}`);
            }
        }
    }
    
    if (emailAddress && !otpCode) {
        browserLauncher.logInfo("[autoVerify] Đang chạy vòng lặp lấy mã OTP từ hòm thư 1secmail...");
        for (let retry = 0; retry < maxRetries; retry++) {
            await new Promise(r => setTimeout(r, 2500));
            try {
                const code = await checkEmailOtp1secmail(state.email_username, state.email_domain);
                if (code) {
                    otpCode = code;
                    browserLauncher.logInfo(`[autoVerify] Đã nhận được mã OTP Email: ${otpCode}`);
                    break;
                }
                browserLauncher.logInfo(`[autoVerify] Đang đợi mã OTP Email (Lần thử ${retry + 1}/${maxRetries})...`);
            } catch (errCheckMail) {
                browserLauncher.logWarning(`[autoVerify Warning] Lỗi khi kiểm tra OTP Mail: ${errCheckMail.message}`);
            }
        }
    }
    
    if (!otpCode) {
        browserLauncher.logError("[autoVerify Error] Hết thời gian chờ nhưng không nhận được mã OTP!");
        await dbManager.addAutomationLog(profileId, vType, phoneNum || emailAddress || "Không có", "Không có", "Thất bại", "Hết thời gian chờ OTP từ dịch vụ.");
        return false;
    }
    
    // 6. Quét lại HTML mới nhất để gửi AI sinh JS điền OTP và Xác nhận
    const cleanHtmlOtp = await page.evaluate(() => {
        const clone = document.body.cloneNode(true);
        const tagsToRemove = ['script', 'style', 'svg', 'iframe', 'noscript', 'link', 'meta'];
        tagsToRemove.forEach(tag => {
            const els = clone.querySelectorAll(tag);
            els.forEach(el => el.remove());
        });
        let text = clone.innerHTML || "";
        text = text.replace(/\s+/g, ' ').trim();
        if (text.length > 15000) {
            text = text.substring(0, 15000) + "...[TRUNCATED]";
        }
        return text;
    });
    
    browserLauncher.logInfo("[autoVerify] Yêu cầu AI Gemini sinh mã JavaScript điền OTP và bấm Xác nhận...");
    const otpPrompt = `
    Bạn là một chuyên gia tự động hóa Puppeteer.
    Nhiệm vụ của bạn là viết một đoạn code JavaScript bất đồng bộ (async/await) chạy trong môi trường Puppeteer để nhập mã OTP đã nhận được vào form HTML hiện tại và bấm nút Xác nhận (hoặc nút Submit hoàn tất xác minh).
    
    Bạn được cung cấp sẵn các biến/hàm sau trong ngữ cảnh thực thi:
    - page: Đối tượng Page của Puppeteer.
    - type(selector, text): Hàm điền text vào input.
    - click(selector): Hàm click vào phần tử.
    - wait(ms): Hàm chờ đợi ms.
    - logInfo(msg): Hàm ghi log.
    
    Mã OTP cần nhập: "${otpCode}"
    
    Mã HTML hiện tại của trang:
    ${cleanHtmlOtp}
    
    Yêu cầu:
    - Tìm chính xác ô nhập OTP dựa trên HTML và sử dụng hàm await type(selector, value) để nhập mã "${otpCode}".
    - Tìm chính xác nút "Xác nhận", "Xác minh", "Hoàn tất", "Xong" hoặc nút submit tương ứng để xác thực OTP, và sử dụng hàm await click(selector) để bấm nút.
    - Thêm các lệnh await wait(1000) cần thiết giữa các bước.
    - Trả về kết quả dưới dạng đối tượng JSON duy nhất có cấu trúc:
    {
      "explanation": "Giải thích các bước thực hiện điền mã OTP",
      "js_code": "Đoạn code JS thực thi (chỉ chứa các câu lệnh JS, không bao bọc trong hàm và không có markdown block \`\`\`js)"
    }
    `;
    
    let otpJsCode = "";
    try {
        const rawRes = await askGemini(otpPrompt, "application/json");
        const resJson = JSON.parse(rawRes);
        otpJsCode = resJson.js_code;
        browserLauncher.logInfo(`[autoVerify] AI đề xuất mã điền OTP: \n${otpJsCode}`);
    } catch (e) {
        browserLauncher.logError(`[autoVerify Error] Lỗi khi AI sinh mã điền OTP: ${e.message}`);
        await dbManager.addAutomationLog(profileId, vType, phoneNum || emailAddress || "Không có", otpCode, "Thất bại", `Lỗi sinh mã điền OTP: ${e.message}`);
        return false;
    }
    
    // Bơm JS OTP vào Chrome chạy để hoàn tất
    browserLauncher.logInfo("[autoVerify] Tiến hành tiêm mã JavaScript điền OTP vào trình duyệt...");
    try {
        const cursor = createCursor(page);
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const context = {
            page,
            type: async (selector, val) => {
                await page.waitForSelector(selector, { timeout: 15000 });
                await cursor.click(selector);
                await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) el.value = '';
                }, selector);
                await new Promise(r => setTimeout(r, 100));
                for (const char of val.toString()) {
                    await page.keyboard.sendCharacter(char);
                    await new Promise(r => setTimeout(r, Math.random() * 60 + 30));
                }
            },
            click: async (selector) => {
                await page.waitForSelector(selector, { timeout: 15000 });
                await cursor.click(selector);
            },
            wait: async (ms) => await new Promise(r => setTimeout(r, ms)),
            logInfo: (msg) => browserLauncher.logInfo(`[Inject OTP Code] ${msg}`)
        };
        
        const runOtpScript = new AsyncFunction(...Object.keys(context), otpJsCode);
        await runOtpScript(...Object.values(context));
        browserLauncher.logInfo("[autoVerify] Điền OTP và hoàn tất xác nhận thành công!");
        
        // 7. Lưu Log Database PostgreSQL / SQLite fallback
        await dbManager.addAutomationLog(
            profileId, 
            vType, 
            phoneNum || emailAddress || "Không có", 
            otpCode, 
            "Thành công", 
            `Vượt xác minh tự động bằng AI thành công. SĐT/Mail: ${phoneNum || emailAddress}, OTP: ${otpCode}`
        );
        return true;
    } catch (errOtpInject) {
        browserLauncher.logError(`[autoVerify Error] Lỗi khi thực thi mã điền OTP: ${errOtpInject.message}`);
        await dbManager.addAutomationLog(
            profileId, 
            vType, 
            phoneNum || emailAddress || "Không có", 
            otpCode, 
            "Thất bại", 
            `Lỗi thực thi mã điền OTP: ${errOtpInject.message}`
        );
        return false;
    }
}

// Hàm chuẩn hóa và làm sạch mã nguồn JavaScript của người dùng dán vào kịch bản để tránh các lỗi cú pháp thông thường
function cleanJsCode(code) {
    if (!code) return "";
    
    // Tự động sửa/thêm comment cho dòng ANTI_PROFILE_GUI_METADATA nếu thiếu // ở dòng đầu tiên
    let processedCode = code;
    const lines = processedCode.split('\n');
    if (lines.length > 0 && lines[0].trim().startsWith("ANTI_PROFILE_GUI_METADATA:")) {
        lines[0] = "// " + lines[0].trim();
        processedCode = lines.join('\n');
    }
    
    // 1. Chuẩn hóa các ký tự nháy kép/nháy đơn đặc biệt tiếng Việt hoặc sao chép lỗi từ Word/Chatbot
    processedCode = processedCode.replace(/[\u201C\u201D]/g, '"');
    processedCode = processedCode.replace(/[\u2018\u2019\u201B]/g, "'");
    processedCode = processedCode.replace(/\u00A0/g, ' ');

    // Loại bỏ các ký tự vô hình/ẩn (Zero-width spaces, Byte Order Mark)
    processedCode = processedCode.replace(/[\u200B-\u200D\uFEFF]/g, '');
    
    // 2. Tự động vá lỗi selector nút bấm Amazon Submit bị cắt cụt và gãy nháy đơn do lỗi parser cũ
    // Vá chuỗi 'input[name=\' thành 'input[name="cvfSubmitPhoneNumber"]'
    processedCode = processedCode.replace(/'input\[name=\\'/g, "'input[name=\"cvfSubmitPhoneNumber\"]'");
    // Vá lỗi thiếu nháy đơn đóng ở logInfo nếu có
    processedCode = processedCode.replace(/input\[name="cvfSubmitPhoneNumber"\]\);/g, 'input[name="cvfSubmitPhoneNumber"]\');');
    // Phòng hờ các chuỗi bị lỗi escape khác
    processedCode = processedCode.replace(/input\[name=\\['"]/g, 'input[name="cvfSubmitPhoneNumber"]');
    
    // Vá lỗi selector a[href=\' của ViOTP bị cụt và gãy nháy
    processedCode = processedCode.replace(/'a\[href=\\'/g, "'a[href*=\"HistoryServices\"]'");
    processedCode = processedCode.replace(/a\[href=\\['"]/g, 'a[href*="HistoryServices"]');
    processedCode = processedCode.replace(/a\[href=\\?\s*\);/g, 'a[href*="HistoryServices"]\');');
    processedCode = processedCode.replace(/a\[href\*="HistoryServices"\]\);/g, 'a[href*="HistoryServices"]\');');
    
    // Sửa lỗi gỡ đường dẫn folder Windows dùng gạch chéo ngược đơn độc (ví dụ 'C:\Users...' -> 'C:/Users...')
    processedCode = processedCode.replace(/(['"`])([a-zA-Z]:)\\(.*?)\1/g, (match, quote, drive, pathPart) => {
        const fixedPath = pathPart.replace(/\\/g, '/');
        return `${quote}${drive}/${fixedPath}${quote}`;
    });
    
    // 3. Tự động thêm 'await' vào trước các hàm IIFE tự chạy (async () => {})() nếu chưa có
    processedCode = processedCode.replace(/await\s*\(\s*async/g, '___AWAIT_IIFE_PLACEHOLDER___');
    processedCode = processedCode.replace(/\(\s*async\s*\(/g, 'await (async (');
    processedCode = processedCode.replace(/\(\s*async\s*function/g, 'await (async function');
    processedCode = processedCode.replace(/___AWAIT_IIFE_PLACEHOLDER___/g, 'await (async');
    
    return processedCode;
}

// --- AUTOMATION RUNNER (Trình chạy kịch bản tự động hóa bằng Puppeteer + Ghost Cursor) ---
async function runPuppeteerSteps(profileId, steps, isJsCodeLegacy = false, campaignId = null) {
    const port = 9200 + profileId;
    const browserUrl = `http://127.0.0.1:${port}`;
    
    let browser = null;
    let isSharedBrowser = false;
    
    const runInfo = browserLauncher.RUNNING_PROFILES[profileId];
    if (runInfo && runInfo.browser) {
        browser = runInfo.browser;
        isSharedBrowser = true;
        browserLauncher.logInfo(`[Puppeteer] Sử dụng kết nối trình duyệt trực tiếp chia sẻ cho Profile ${profileId}.`);
    } else {
        browserLauncher.logInfo(`[Puppeteer] Dang ket noi toi trinh duyet profile ${profileId} tai ${browserUrl}...`);
        try {
            // Thử kết nối qua 127.0.0.1
            browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${port}`,
                defaultViewport: null
            });
        } catch (e) {
            try {
                // Dự phòng kết nối qua localhost
                browser = await puppeteer.connect({
                    browserURL: `http://localhost:${port}`,
                    defaultViewport: null
                });
            } catch (errLocalhost) {
                browserLauncher.logError(`[Puppeteer] Khong the ket noi toi trinh duyet: ${e.message}`);
                return [false, `Không thể kết nối đến trình duyệt qua cổng debug: ${e.message}`];
            }
        }
    }
    
    // Lấy thời gian timeout cấu hình từ DB (mặc định 30 giây nếu chưa cấu hình)
    const timeoutSetting = await dbManager.getSetting("api_automation_timeout");
    const defaultTimeout = parseInt(timeoutSetting) || 30000;
    browserLauncher.logInfo(`[Puppeteer] Thoi gian cho phan tu toi da (Timeout): ${defaultTimeout}ms`);

    try {
        // Lấy danh sách các trang đang mở trước khi tạo trang mới
        const oldPages = await browser.pages();
        
        // Tạo một trang mới hoàn toàn sạch sẽ để thực thi kịch bản, tránh lỗi Detached Frame do tranh chấp chuyển hướng
        const page = await browser.newPage();
        
        // Đóng các trang cũ đang load dở (như whoer.net) để giải phóng RAM và tránh tranh chấp điều hướng
        if (oldPages.length > 0) {
            for (const oldP of oldPages) {
                try {
                    await oldP.close();
                } catch (e) {}
            }
        }
        
        // Khởi tạo ghost-cursor để giả lập chuột Bezier sinh học giống người thật
        const cursor = createCursor(page);
        
        const isJsCode = typeof steps === 'string';
        
        // Trạng thái lưu trữ tạm thời thông tin OTP & Mail trong phiên chạy để tái sử dụng
        const state = {
            phone_number: null,
            phone_request_id: null,
            phone_service: null,
            phone_country_dial: "84",
            network_idx: 0,
            
            email: null,
            email_username: null,
            email_domain: null,
            email_domains_list: [],
            domain_idx: 0,
            
            captured_user: null,
            captured_pass: null
        };

        if (isJsCode) {
            browserLauncher.logInfo(`[Puppeteer] Ket noi thanh cong! Bat dau thuc thi kich ban bang ma JavaScript...`);
            try {
                // Định nghĩa hàm bọc Page để bảo vệ tránh page.close() làm sập
                const wrapPage = (p) => {
                    if (!p) return p;
                    return new Proxy(p, {
                        get(target, prop) {
                            if (prop === 'close') {
                                return async () => {
                                    browserLauncher.logInfo("[Puppeteer Mock] Bỏ qua lệnh page.close() để hệ thống tự quản lý tab.");
                                    return;
                                };
                            }
                            const val = target[prop];
                            if (typeof val === 'function') {
                                return val.bind(target);
                            }
                            return val;
                        }
                    });
                };

                // Định nghĩa mockBrowser để bảo vệ tránh browser.close()
                const mockBrowser = new Proxy(browser, {
                    get(target, prop) {
                        if (prop === 'close') {
                            return async () => {
                                browserLauncher.logInfo("[Puppeteer Mock] Bỏ qua lệnh browser.close() để hệ thống quản lý trình duyệt.");
                                return;
                            };
                        }
                        if (prop === 'pages') {
                            return async () => {
                                const actualPages = await target.pages();
                                return actualPages.map(p => wrapPage(p));
                            };
                        }
                        if (prop === 'newPage') {
                            return async () => {
                                const newP = await target.newPage();
                                return wrapPage(newP);
                            };
                        }
                        const val = target[prop];
                        if (typeof val === 'function') {
                            return val.bind(target);
                        }
                        return val;
                    }
                });

                // Tạo một AsyncFunction để chạy mã JavaScript
                const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                
                // Định nghĩa mockPuppeteer dùng Proxy để kế thừa tất cả thuộc tính của puppeteer gốc,
                // nhưng chặn launch và connect để trả về trực tiếp đối tượng browser của profile đang chạy.
                const mockPuppeteer = new Proxy(puppeteer, {
                    get(target, prop) {
                        if (prop === 'launch' || prop === 'connect') {
                            return async () => mockBrowser;
                        }
                        const val = target[prop];
                        if (typeof val === 'function') {
                            return val.bind(target);
                        }
                        return val;
                    }
                });

                // Định nghĩa require giả lập để chặn nạp puppeteer gốc và trả về mockPuppeteer
                const customRequire = (moduleName) => {
                    if (moduleName === 'puppeteer' || moduleName === 'puppeteer-extra') {
                        return mockPuppeteer;
                    }
                    return require(moduleName);
                };

                const wrappedPage = wrapPage(page);

                // Các biến/hàm helper cung cấp cho context của JavaScript script
                const context = {
                    page: wrappedPage,
                    browser: mockBrowser,
                    puppeteer: mockPuppeteer,
                    browserLauncher,
                    dbManager,
                    state,
                    require: customRequire, // Truyền customRequire cho mã JS
                    setTimeout: (arg1, arg2) => {
                        if (typeof arg1 === 'function') {
                            const delay = parseInt(arg2) || 2000;
                            return global.setTimeout(arg1, delay);
                        } else {
                            const delay = parseInt(arg1) || 2000;
                            return new Promise(r => global.setTimeout(r, delay));
                        }
                    },
                    logInfo: (msg) => browserLauncher.logInfo(`[Script JS] ${msg}`),
                    logWarning: (msg) => browserLauncher.logWarning(`[Script JS] ${msg}`),
                    logError: (msg) => browserLauncher.logError(`[Script JS] ${msg}`),
                    
                    // Helpers bọc lại các hành động Puppeteer tối ưu đã lập trình
                    click: async (selector) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "click", target: selector }, state, profileId, [], 0);
                    },
                    clickRight: async (selector) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "click_right", target: selector }, state, profileId, [], 0);
                    },
                    clickXY: async (x, y) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "click_xy", value: `${x} ${y}` }, state, profileId, [], 0);
                    },
                    clickRightXY: async (x, y) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "click_right_xy", value: `${x} ${y}` }, state, profileId, [], 0);
                    },
                    hover: async (selector) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "hover", target: selector }, state, profileId, [], 0);
                    },
                    type: async (selector, val) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "type", target: selector, value: val }, state, profileId, [], 0);
                    },
                    press: async (key) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "press", value: key }, state, profileId, [], 0);
                    },
                    scroll: async (direction) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "scroll", value: direction }, state, profileId, [], 0);
                    },
                    wait: async (ms) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "wait", value: ms }, state, profileId, [], 0);
                    },
                    socialMessage: async (msg) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "social_message", value: msg }, state, profileId, [], 0);
                    },
                    socialReplyUnread: async (targetSelectorOrCoords, replyMsg) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "social_reply_unread", target: targetSelectorOrCoords, value: replyMsg }, state, profileId, [], 0);
                    },
                    socialReplyComment: async (targetSelectorOrCoords, replyMsg) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "social_reply_comment", target: targetSelectorOrCoords, value: replyMsg }, state, profileId, [], 0);
                    },
                    socialReaction: async (targetSelectorOrCoords, reactionType) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "social_reaction", target: targetSelectorOrCoords, value: reactionType }, state, profileId, [], 0);
                    },
                    fillRegister: async () => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "fill_register" }, state, profileId, [], 0);
                    },
                    autoVerify: async () => {
                        return await autoVerify(wrappedPage, state, profileId);
                    },
                    rentPhone: async (service, country, varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "rent_phone", target: service, value: country, var: varName }, state, profileId, [], 0);
                    },
                    typePhone: async (selector, varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "type_phone", target: selector, var: varName }, state, profileId, [], 0);
                    },
                    getPhoneCode: async (selector, varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "get_phone_code", target: selector, var: varName }, state, profileId, [], 0);
                    },
                    createMail: async (email, varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "create_mail", value: email, var: varName }, state, profileId, [], 0);
                    },
                    typeMail: async (selector, varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "type_mail", target: selector, var: varName }, state, profileId, [], 0);
                    },
                    getMailCode: async (selector, varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "get_mail_code", target: selector, var: varName }, state, profileId, [], 0);
                    },
                    solveCaptcha: async (selector, service, varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "solve_captcha", target: selector, service: service, var: varName }, state, profileId, [], 0);
                    },
                    rotateProxy: async (url) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "rotate_proxy", value: url }, state, profileId, [], 0);
                    },
                    deleteMail: async (varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "delete_mail", var: varName }, state, profileId, [], 0);
                    },
                    cancelPhone: async (varName) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "cancel_phone", var: varName }, state, profileId, [], 0);
                    },
                    checkProxy: async () => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "check_proxy" }, state, profileId, [], 0);
                    },
                    rotateProxyIfDie: async (url) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "rotate_proxy_if_die", value: url }, state, profileId, [], 0);
                    },
                    rotateProxyEveryNRuns: async (n) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "rotate_proxy_every_n_runs", value: n }, state, profileId, [], 0);
                    },
                    getOldIp: async (url) => {
                        return await executeStepWithRetry(wrappedPage, cursor, { action: "get_old_ip", value: url }, state, profileId, [], 0);
                    },
                    readOfflineFile: async (filename) => {
                        return await readOfflineFile(filename);
                    },
                    writeOfflineFile: async (filename, data) => {
                        return await writeOfflineFile(filename, data);
                    },
                    
                    // --- CÁC HÀM CDP BỔ TRỢ v2.9 CHUYÊN NGHIỆP ---
                    smartWait: async (timeout) => {
                        return await smartWait(wrappedPage, timeout);
                    },
                    cdpSend: async (method, params) => {
                        return await cdpSend(wrappedPage, method, params);
                    },
                    cdpClick: async (selector) => {
                        await cdpClick(wrappedPage, selector);
                        await smartWait(wrappedPage);
                    },
                    cdpType: async (selector, val) => {
                        await cdpType(wrappedPage, selector, val);
                        await smartWait(wrappedPage);
                    },
                    cdpHover: async (selector) => {
                        await cdpHover(wrappedPage, selector);
                    }
                };                
                const cleanedSteps = cleanJsCode(steps);
                
                // Tránh trùng lặp khai báo tham số bằng cách đổi tên tham số thành __sys_key
                const argKeys = Object.keys(context).map(k => `__sys_${k}`);
                
                // Khởi tạo các biến cục bộ trỏ tới các tham số __sys_
                const mappingDeclarations = Object.keys(context)
                    .map(k => `const ${k} = __sys_${k};`)
                    .join("\n");
                
                // Bọc kịch bản trong block scope cục bộ để che phủ (shadowing) các biến khai báo bằng const/let
                const finalCode = `
${mappingDeclarations}

{
${cleanedSteps}
}
`;
                const runScript = new AsyncFunction(...argKeys, finalCode);
                await runScript(...Object.values(context));
                
            } catch (errJs) {
                browserLauncher.logError(`[Puppeteer JS Error] Lỗi khi chạy kịch bản: ${errJs.message}`);
                return [false, `Lỗi kịch bản JavaScript: ${errJs.message}`];
            }
        } else {
            browserLauncher.logInfo(`[Puppeteer] Ket noi thanh cong! Bat dau thuc thi ${steps.length} buoc kich ban...`);
            
            const loopState = { idx: 0 };
            while (loopState.idx < steps.length) {
                const idx = loopState.idx;
                const step = steps[idx];
                const action = step.action;
                const target = step.target;
                const value = step.value;
                
                if (!browserLauncher.RUNNING_PROFILES[profileId]) {
                    browserLauncher.logWarning(`[Puppeteer] Profile ${profileId} da bi dung. Ngat kich ban.`);
                    return [false, "Trình duyệt đã bị đóng."];
                }
                
                browserLauncher.logInfo(`[Puppeteer] Buoc ${idx + 1}: ${action} | Selector: '${target}' | Tham so: '${value}'`);
                
                const stepResult = await executeStepWithRetry(page, cursor, step, state, profileId, steps, loopState);
                if (!stepResult.success) {
                    const isMandatory = step.required !== false && step.mandatory !== false;
                    if (isMandatory) {
                        browserLauncher.logError(`[Puppeteer] Buoc bat buoc ${idx + 1} (${action}) that bai. Tu dong dong profile de tranh kiem tra hanh vi bat thuong.`);
                        await browserLauncher.stopProfile(profileId);
                        return [false, `Lỗi bước bắt buộc: ${action} tại ${target}`];
                    } else {
                        browserLauncher.logWarning(`[Puppeteer] Buoc ${idx + 1} (${action}) that bai nhung khong bat buoc. Bo qua va chuyen sang buoc sau.`);
                    }
                }
                
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                loopState.idx++;
            }
        }
        
        // --- TỰ ĐỘNG THU LƯU TÀI NGUYÊN SAU KHI HOÀN THÀNH ---
        try {
            // 1. Kiểm tra cấu hình có cho phép lưu hay không (Tôn trọng master switch của chiến dịch)
            let shouldExtract = true;
            if (campaignId) {
                const campaign = await dbManager.getCampaign(campaignId);
                if (campaign && campaign.save_created_accounts === 0) {
                    shouldExtract = false;
                    browserLauncher.logInfo(`[Puppeteer] Tùy chọn lưu tài nguyên chiến dịch đang tắt. Bỏ qua.`);
                }
            }

            if (shouldExtract) {
                browserLauncher.logInfo("[Puppeteer] Bắt đầu trích xuất tài nguyên theo cấu hình CSS của kịch bản...");
                const currentUrl = page.url();
                let serviceName = "Web Service";
                try {
                    const urlObj = new URL(currentUrl);
                    serviceName = urlObj.hostname.replace('www.', '');
                } catch (e) {}

                // Lấy Script ID
                let scriptId = null;
                const profileObj = await dbManager.getProfile(profileId);
                if (profileObj && profileObj.script_id) {
                    scriptId = profileObj.script_id;
                }
                if (!scriptId && campaignId) {
                    const campaign = await dbManager.getCampaign(campaignId);
                    if (campaign) {
                        scriptId = campaign.script_id;
                    }
                }

                let captureConfig = null;
                if (scriptId) {
                    const scriptObj = await dbManager.getScript(scriptId);
                    if (scriptObj && scriptObj.capture_config) {
                        try {
                            captureConfig = JSON.parse(scriptObj.capture_config);
                        } catch (e) {
                            captureConfig = null;
                        }
                    }
                }

                // Định nghĩa hàm trích xuất text thô từ phần tử (innerText hoặc value)
                const extractFieldText = async (selector) => {
                    if (!selector) return "";
                    try {
                        return await page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            if (!el) return "";
                            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
                                return el.value ? el.value.trim() : "";
                            }
                            return el.innerText ? el.innerText.trim() : "";
                        }, selector);
                    } catch (errEval) {
                        return "";
                    }
                };

                let finalUser = "";
                let finalPass = "";
                let finalEmail = "";
                let finalPhone = "";
                let cookiesStr = "";

                if (captureConfig) {
                    // Nếu kịch bản có thiết lập cấu hình lưu chi tiết
                    if (captureConfig.username && captureConfig.username.enabled) {
                        finalUser = await extractFieldText(captureConfig.username.selector);
                    }
                    if (captureConfig.password && captureConfig.password.enabled) {
                        finalPass = await extractFieldText(captureConfig.password.selector);
                    }
                    if (captureConfig.email && captureConfig.email.enabled) {
                        finalEmail = await extractFieldText(captureConfig.email.selector);
                    }
                    if (captureConfig.phone && captureConfig.phone.enabled) {
                        finalPhone = await extractFieldText(captureConfig.phone.selector);
                    }
                    if (captureConfig.cookie && captureConfig.cookie.enabled) {
                        try {
                            const cookies = await page.cookies();
                            // Chuyển đổi cookies sang chuỗi text key=value gọn gàng không chứa trạng thái thô kệch
                            cookiesStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        } catch (e) {}
                    }
                    
                    // Chỉ lưu trữ nếu thu giữ được dữ liệu
                    if (finalUser || cookiesStr || finalEmail || finalPhone) {
                        const resId = await dbManager.addCapturedResource(
                            profileId,
                            serviceName,
                            finalUser || "unknown",
                            finalPass,
                            finalEmail,
                            "", // mật khẩu email
                            finalPhone,
                            cookiesStr
                        );
                        browserLauncher.logInfo(`[Puppeteer] Đã tự động lưu tài nguyên thu được vào CSDL theo CSS selector (ID tài nguyên: ${resId})`);
                    } else {
                        browserLauncher.logInfo(`[Puppeteer] Không tìm thấy dữ liệu khớp các CSS selector đã thiết lập. Bỏ qua.`);
                    }
                } else {
                    // Kịch bản cũ chưa cấu hình lưu chi tiết -> Không tự ý lưu tài nguyên bừa bãi
                    browserLauncher.logInfo("[Puppeteer] Kịch bản chưa được cấu hình CSS selector để lưu tài nguyên. Bỏ qua.");
                }
            }
        } catch (resErr) {
            browserLauncher.logWarning(`[Puppeteer] Lỗi khi tự động trích xuất tài nguyên: ${resErr.message}`);
        }

        browserLauncher.logInfo(`[Puppeteer] Profile ${profileId} da hoan thanh toan bo kich ban.`);
        return [true, "Kịch bản đã hoàn thành thành công."];
        
    } catch (e) {
        browserLauncher.logError(`[Puppeteer Error] Loi trong qua trinh tu dong hoa: ${e.message}`);
        return [false, `Lỗi tự động hóa: ${e.message}`];
    } finally {
        if (browser && !isSharedBrowser) {
            try {
                await browser.disconnect();
            } catch (e) {}
        }
    }
}

// Bộ nhớ đệm hàng đợi lệnh và trạng thái lệnh cho Extension kết nối
const AUTOMATION_QUEUES = {};
const LAST_COMMAND_STATUS = {};

module.exports = {
    runPuppeteerSteps,
    autoVerify,
    AUTOMATION_QUEUES,
    LAST_COMMAND_STATUS,
    rentPhoneViotp,
    checkOtpViotp,
    rentPhoneSmspool,
    checkOtpSmspool,
    getEmailDomains1secmail,
    checkEmailOtp1secmail,
    cancelPhoneViotp,
    cancelPhoneSmspool
};
