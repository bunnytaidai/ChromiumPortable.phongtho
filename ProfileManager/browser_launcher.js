const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { FingerprintGenerator } = require('fingerprint-generator');
const { FingerprintInjector } = require('fingerprint-injector');
const proxyChain = require('proxy-chain');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execSync, spawn } = require('child_process');
const dbManager = require('./db_manager');

puppeteer.use(StealthPlugin());

const CHROME_PATH = "c:\\Users\\Ok_duoc\\Desktop\\ChromiumPortable\\App\\Chromium\\64\\chrome.exe";
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Danh sách các profile đang hoạt động (Running profile handles)
const RUNNING_PROFILES = {};

// Quản lý tài nguyên hoạt động của các profile (Emails, số điện thoại đã thuê)
const ACTIVE_RESOURCES = {};

// Quản lý log chạy thực tế của các tiện ích mở rộng
const EXTENSION_RUN_LOGS = {};

function attachExtensionLogListeners(page, profileId) {
    if (!EXTENSION_RUN_LOGS[profileId]) {
        EXTENSION_RUN_LOGS[profileId] = [];
    }
    
    if (page._extensionLogsAttached) return;
    page._extensionLogsAttached = true;

    page.on('pageerror', err => {
        if (err.stack && err.stack.includes('chrome-extension://')) {
            EXTENSION_RUN_LOGS[profileId].push({
                timestamp: new Date().toLocaleTimeString(),
                type: 'error',
                message: err.message,
                stack: err.stack
            });
        }
    });

    page.on('console', msg => {
        const text = msg.text();
        const location = msg.location();
        if (location && location.url && location.url.includes('chrome-extension://')) {
            EXTENSION_RUN_LOGS[profileId].push({
                timestamp: new Date().toLocaleTimeString(),
                type: msg.type(),
                message: text,
                url: location.url,
                lineNumber: location.lineNumber
            });
        }
    });
}

const PROFILE_NETWORK_TRAFFIC = {};
const PROFILE_INTERCEPTION_RULES = {};

async function attachNetworkInterception(page, profileId) {
    if (!PROFILE_NETWORK_TRAFFIC[profileId]) {
        PROFILE_NETWORK_TRAFFIC[profileId] = [];
    }
    try {
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        await client.send('Fetch.enable', {
            patterns: [{ requestStage: 'Request' }]
        });

        // 1. Lắng nghe logs mạng cấp thấp
        client.on('Network.requestWillBeSent', (event) => {
            const { requestId, request, type } = event;
            if (request.url.startsWith('http')) {
                const traffic = {
                    requestId,
                    timestamp: new Date().toLocaleTimeString(),
                    url: request.url,
                    method: request.method,
                    type: type || 'Other',
                    headers: request.headers,
                    postData: request.postData || null,
                    status: 'Pending',
                    responseHeaders: null,
                    responseBody: null
                };
                if (!PROFILE_NETWORK_TRAFFIC[profileId]) {
                    PROFILE_NETWORK_TRAFFIC[profileId] = [];
                }
                PROFILE_NETWORK_TRAFFIC[profileId].push(traffic);
                if (PROFILE_NETWORK_TRAFFIC[profileId].length > 100) {
                    PROFILE_NETWORK_TRAFFIC[profileId].shift();
                }
            }
        });

        client.on('Network.responseReceived', async (event) => {
            const { requestId, response, type } = event;
            const trafficList = PROFILE_NETWORK_TRAFFIC[profileId];
            if (trafficList) {
                const traffic = trafficList.find(t => t.requestId === requestId);
                if (traffic) {
                    traffic.status = response.status;
                    traffic.responseHeaders = response.headers;
                    traffic.mimeType = response.mimeType;
                    
                    if (type === 'XHR' || type === 'Fetch') {
                        try {
                            const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId });
                            traffic.responseBody = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
                        } catch (errBody) {}
                    }
                }
            }
        });

        // 2. Thực thi Chặn & Sửa gói tin qua Fetch.requestPaused
        client.on('Fetch.requestPaused', async (event) => {
            const { requestId, request } = event;
            const url = request.url;
            const rules = PROFILE_INTERCEPTION_RULES[profileId] || { blockUrls: [], modifyRules: [] };

            // A. Kiểm tra luật chặn (Block patterns)
            const shouldBlock = rules.blockUrls.some(pattern => {
                if (pattern.startsWith('*') && pattern.endsWith('*')) return url.includes(pattern.slice(1, -1));
                if (pattern.startsWith('*')) return url.endsWith(pattern.slice(1));
                if (pattern.endsWith('*')) return url.startsWith(pattern.slice(0, -1));
                return url === pattern;
            });

            if (shouldBlock) {
                logWarning(`[Chặn mạng] Đã chặn kết nối tới: ${url}`);
                try {
                    await client.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
                } catch (e) {}
                return;
            }

            // B. Kiểm tra luật sửa đổi request (Modify rules)
            let modifiedHeaders = null;
            let modifiedPostData = null;
            let isModified = false;

            if (rules.modifyRules && rules.modifyRules.length > 0) {
                for (const rule of rules.modifyRules) {
                    if (url.includes(rule.urlPattern)) {
                        isModified = true;
                        
                        // Sửa đổi headers
                        if (rule.headers) {
                            modifiedHeaders = [];
                            const combinedHeaders = Object.assign({}, request.headers, rule.headers);
                            for (const name in combinedHeaders) {
                                modifiedHeaders.push({ name, value: String(combinedHeaders[name]) });
                            }
                        }
                        
                        // Sửa đổi postData
                        if (rule.postData) {
                            const dataStr = typeof rule.postData === 'object' ? JSON.stringify(rule.postData) : String(rule.postData);
                            modifiedPostData = Buffer.from(dataStr).toString('base64');
                        }
                        logInfo(`[Sửa request] Can thiệp sửa đổi gói tin thành công: ${url}`);
                        break;
                    }
                }
            }

            try {
                if (isModified) {
                    const continueParams = { requestId };
                    if (modifiedHeaders) continueParams.headers = modifiedHeaders;
                    if (modifiedPostData) continueParams.postData = modifiedPostData;
                    await client.send('Fetch.continueRequest', continueParams);
                } else {
                    await client.send('Fetch.continueRequest', { requestId });
                }
            } catch (e) {}
        });

    } catch (e) {
        console.error(`Fetch Interception error: ${e.message}`);
    }
}

function registerProfileEmail(profileId, email) {
    if (!ACTIVE_RESOURCES[profileId]) {
        ACTIVE_RESOURCES[profileId] = { emails: [], phones: [] };
    }
    if (!ACTIVE_RESOURCES[profileId].emails.includes(email)) {
        ACTIVE_RESOURCES[profileId].emails.push(email);
        logInfo(`[Quản lý tài nguyên] Đã đăng ký email tạm thời ${email} cho Profile ID: ${profileId}`);
    }
}

function registerProfilePhone(profileId, requestId, provider) {
    if (!ACTIVE_RESOURCES[profileId]) {
        ACTIVE_RESOURCES[profileId] = { emails: [], phones: [] };
    }
    const exists = ACTIVE_RESOURCES[profileId].phones.some(p => p.requestId === requestId);
    if (!exists) {
        ACTIVE_RESOURCES[profileId].phones.push({ requestId, provider });
        logInfo(`[Quản lý tài nguyên] Đã đăng ký số điện thoại thuê có ID yêu cầu ${requestId} (${provider}) cho Profile ID: ${profileId}`);
    }
}

async function cleanupProfileResources(profileId) {
    const resources = ACTIVE_RESOURCES[profileId];
    if (!resources) return;

    logInfo(`[Dọn dẹp tài nguyên] Bắt đầu giải phóng tài nguyên của Profile ID: ${profileId}...`);

    // 1. Dọn dẹp mail tạm thời (Mail Manager)
    if (resources.emails && resources.emails.length > 0) {
        const apiMailUrl = await dbManager.getSetting("api_mail_url");
        if (apiMailUrl) {
            for (const email of resources.emails) {
                logInfo(`[Dọn dẹp tài nguyên] Đang yêu cầu xóa mail ${email} trên Mail Manager...`);
                try {
                    await fetch(`${apiMailUrl}/api/emails/delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ address: email }),
                        signal: AbortSignal.timeout(8000)
                    }).catch(() => {});
                } catch (e) {
                    logError(`Lỗi khi dọn dẹp mail: ${e.message}`);
                }
            }
        }
        resources.emails = [];
    }

    // 2. Dọn dẹp số điện thoại đã thuê (ViOTP / SMSPool)
    if (resources.phones && resources.phones.length > 0) {
        const viotpToken = await dbManager.getSetting("api_viotp");
        const smspoolKey = await dbManager.getSetting("api_smspool");
        for (const phone of resources.phones) {
            logInfo(`[Dọn dẹp tài nguyên] Đang yêu cầu hủy thuê số điện thoại ID yêu cầu ${phone.requestId} (${phone.provider})...`);
            try {
                if (phone.provider === 'viotp' && viotpToken) {
                    await fetch(`https://api.viotp.com/request/cancelv2?token=${viotpToken}&requestId=${phone.requestId}`, {
                        signal: AbortSignal.timeout(8000)
                    }).catch(() => {});
                } else if (phone.provider === 'smspool' && smspoolKey) {
                    await fetch(`https://api.smspool.net/sms/cancel?key=${smspoolKey}&orderid=${phone.requestId}`, {
                        signal: AbortSignal.timeout(8000)
                    }).catch(() => {});
                }
            } catch (e) {
                logError(`Lỗi khi dọn dẹp số điện thoại: ${e.message}`);
            }
        }
        resources.phones = [];
    }

    delete ACTIVE_RESOURCES[profileId];
    logInfo(`[Dọn dẹp tài nguyên] Hoàn tất dọn dẹp tài nguyên cho Profile ID: ${profileId}`);
}

// Nhật ký hệ thống (System logs memory bank)
const SYSTEM_LOGS = [];

function addLog(level, message) {
    const entry = {
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        level: level, // INFO, WARNING, ERROR, SYSTEM
        message: message
    };
    SYSTEM_LOGS.push(entry);
    console.log(`[${level}] ${message}`);
    if (SYSTEM_LOGS.length > 100) {
        SYSTEM_LOGS.shift();
    }
}

const logInfo = (msg) => addLog("INFO", msg);
const logWarning = (msg) => addLog("WARNING", msg);
const logError = (msg) => addLog("ERROR", msg);

function killProcessOnPort(port) {
    try {
        const output = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' });
        const pids = new Set();
        output.split('\n').forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5 && parts[1].endsWith(`:${port}`)) {
                const pid = parts[4];
                if (pid && pid !== '0') pids.add(parseInt(pid));
            }
        });
        pids.forEach(pid => {
            try {
                execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
                logInfo(`Da cuong che dung tien trinh PID ${pid} dang su dung cong ${port}.`);
            } catch (e) {}
        });
    } catch (e) {}
}

function killMcpProcess(runInfo) {
    if (runInfo && runInfo.mcpProcess) {
        try {
            execSync(`taskkill /PID ${runInfo.mcpProcess.pid} /T /F`, { stdio: 'ignore' });
            logInfo("Da dong bang cuong che (taskkill) MCP Server cho profile.");
        } catch (e) {
            try {
                runInfo.mcpProcess.kill('SIGTERM');
                logInfo("Da dong MCP Server bang SIGTERM.");
            } catch (err) {}
        }
    }
}

// Phán đoán mã ngôn ngữ và danh sách ngôn ngữ dựa trên múi giờ giả lập
function guessLanguageFromTimezone(timezone) {
    if (!timezone) {
        return { langCode: "vi-VN", langList: ["vi-VN", "vi", "en-US", "en"] };
    }
    const tz = timezone.toLowerCase();
    if (tz.includes("vietnam") || tz.includes("ho_chi_minh") || tz.includes("saigon") || tz.includes("hanoi")) {
        return { langCode: "vi-VN", langList: ["vi-VN", "vi", "en-US", "en"] };
    }
    if (tz.includes("america") || tz.includes("new_york") || tz.includes("los_angeles") || tz.includes("chicago") || tz.includes("detroit") || tz.includes("denver")) {
        return { langCode: "en-US", langList: ["en-US", "en"] };
    }
    if (tz.includes("london") || tz.includes("europe/london") || tz.includes("gb")) {
        return { langCode: "en-GB", langList: ["en-GB", "en-US", "en"] };
    }
    if (tz.includes("tokyo") || tz.includes("asia/tokyo") || tz.includes("japan")) {
        return { langCode: "ja-JP", langList: ["ja-JP", "ja", "en-US", "en"] };
    }
    if (tz.includes("seoul") || tz.includes("asia/seoul") || tz.includes("korea")) {
        return { langCode: "ko-KR", langList: ["ko-KR", "ko", "en-US", "en"] };
    }
    if (tz.includes("singapore")) {
        return { langCode: "zh-SG", langList: ["zh-SG", "zh", "en-SG", "en-US", "en"] };
    }
    return { langCode: "vi-VN", langList: ["vi-VN", "vi", "en-US", "en"] };
}

// Phán đoán ngôn ngữ dựa trên mã quốc gia (ISO code)
let countryLangMapCache = null;

function loadCountriesConfig() {
    if (countryLangMapCache) return countryLangMapCache;
    try {
        const filePath = path.join(__dirname, 'static', 'countries.js');
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            // content có dạng: const ALL_COUNTRIES = [...];
            const match = content.match(/const\s+ALL_COUNTRIES\s*=\s*([\s\S]*?);/);
            if (match && match[1]) {
                const countries = JSON.parse(match[1]);
                countryLangMapCache = {};
                for (const c of countries) {
                    if (c.code) {
                        const code = c.code.toUpperCase();
                        // Định dạng: { langCode: "vi-VN", langList: ["vi-VN", "vi", "en-US", "en"] }
                        const mainLang = c.lang || "en-US";
                        const baseLang = mainLang.split('-')[0];
                        const langList = [mainLang];
                        if (baseLang && baseLang !== mainLang) {
                            langList.push(baseLang);
                        }
                        if (!langList.includes("en-US")) {
                            langList.push("en-US");
                        }
                        if (!langList.includes("en")) {
                            langList.push("en");
                        }
                        countryLangMapCache[code] = {
                            langCode: mainLang,
                            langList: langList
                        };
                    }
                }
                return countryLangMapCache;
            }
        }
    } catch (e) {
        console.error('[browser_launcher] Lỗi phân tích countries.js để lấy ngôn ngữ:', e);
    }
    return null;
}

function guessLanguageFromCountry(countryCode) {
    if (!countryCode) return null;
    const code = countryCode.toUpperCase();
    
    // Nạp dữ liệu đầy đủ từ cơ sở dữ liệu quốc gia tĩnh countries.js
    const fullMap = loadCountriesConfig();
    if (fullMap && fullMap[code]) {
        return fullMap[code];
    }
    
    // Bản đồ ngôn ngữ tương ứng của các quốc gia phổ biến (fallback và tương thích ngược)
    const countryLangMap = {
        "VN": { langCode: "vi-VN", langList: ["vi-VN", "vi", "en-US", "en"] },
        "US": { langCode: "en-US", langList: ["en-US", "en"] },
        "GB": { langCode: "en-GB", langList: ["en-GB", "en-US", "en"] },
        "CA": { langCode: "en-CA", langList: ["en-CA", "en-US", "en", "fr-CA", "fr"] },
        "JP": { langCode: "ja-JP", langList: ["ja-JP", "ja", "en-US", "en"] },
        "KR": { langCode: "ko-KR", langList: ["ko-KR", "ko", "en-US", "en"] },
        "DE": { langCode: "de-DE", langList: ["de-DE", "de", "en-US", "en"] },
        "FR": { langCode: "fr-FR", langList: ["fr-FR", "fr", "en-US", "en"] },
        "SG": { langCode: "en-SG", langList: ["en-SG", "zh-CN", "zh", "en-US", "en"] },
        "AU": { langCode: "en-AU", langList: ["en-AU", "en-US", "en"] },
        "CN": { langCode: "zh-CN", langList: ["zh-CN", "zh", "en-US", "en"] },
        "TW": { langCode: "zh-TW", langList: ["zh-TW", "zh", "en-US", "en"] },
        "HK": { langCode: "zh-HK", langList: ["zh-HK", "zh", "en-US", "en"] },
        "RU": { langCode: "ru-RU", langList: ["ru-RU", "ru", "en-US", "en"] },
        "BR": { langCode: "pt-BR", langList: ["pt-BR", "pt", "en-US", "en"] },
        "ES": { langCode: "es-ES", langList: ["es-ES", "es", "en-US", "en"] },
        "IT": { langCode: "it-IT", langList: ["it-IT", "it", "en-US", "en"] },
        "IN": { langCode: "hi-IN", langList: ["hi-IN", "hi", "en-IN", "en-US", "en"] },
        "TH": { langCode: "th-TH", langList: ["th-TH", "th", "en-US", "en"] },
        "MY": { langCode: "ms-MY", langList: ["ms-MY", "ms", "en-US", "en"] },
        "ID": { langCode: "id-ID", langList: ["id-ID", "id", "en-US", "en"] },
        "PH": { langCode: "en-PH", langList: ["en-PH", "tl-PH", "tl", "en-US", "en"] },
        "NL": { langCode: "nl-NL", langList: ["nl-NL", "nl", "en-US", "en"] },
        "SE": { langCode: "sv-SE", langList: ["sv-SE", "sv", "en-US", "en"] },
        "CH": { langCode: "de-CH", langList: ["de-CH", "fr-CH", "it-CH", "en-US", "en"] },
        "BE": { langCode: "nl-BE", langList: ["nl-BE", "fr-BE", "de-BE", "en-US", "en"] },
        "AT": { langCode: "de-AT", langList: ["de-AT", "en-US", "en"] },
        "NZ": { langCode: "en-NZ", langList: ["en-NZ", "en-US", "en"] },
        "MX": { langCode: "es-MX", langList: ["es-MX", "es", "en-US", "en"] },
        "TR": { langCode: "tr-TR", langList: ["tr-TR", "tr", "en-US", "en"] },
        "UA": { langCode: "uk-UA", langList: ["uk-UA", "uk", "en-US", "en"] },
        "AE": { langCode: "ar-AE", langList: ["ar-AE", "ar", "en-US", "en"] },
        "SA": { langCode: "ar-SA", langList: ["ar-SA", "ar", "en-US", "en"] },
        "ZA": { langCode: "en-ZA", langList: ["en-ZA", "en-US", "en"] },
        "PL": { langCode: "pl-PL", langList: ["pl-PL", "pl", "en-US", "en"] },
        "PT": { langCode: "pt-PT", langList: ["pt-PT", "pt", "en-US", "en"] }
    };
    
    if (countryLangMap[code]) {
        return countryLangMap[code];
    }
    
    return { langCode: "en-US", langList: ["en-US", "en"] };
}

// Cấu hình tất cả các thuộc tính giả lập cho một tab/page
async function setupPageProperties(page, browser, profile, fingerprint, langCode, langList, langHeader, fingerprintInjector, proxyPublicIp = null, blockResources = true) {
    if (!page) return;
    try {
        // Tối ưu hóa hiệu năng bằng cách chặn tài nguyên không thiết yếu khi chạy tự động hóa (Resource Blocking)
        if (blockResources) {
            try {
                const client = await page.target().createCDPSession();
                await client.send('Network.enable');
                await client.send('Network.setBlockedURLs', {
                    urls: [
                        '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.webp', // Hình ảnh
                        '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',          // Font chữ
                        '*.mp4', '*.webm', '*.ogg', '*.mp3',                     // Media
                        '*google-analytics.com*', '*analytics.js*', '*facebook.net*', '*connect.facebook.net*', '*googletagmanager.com*' // Analytics/Tracking
                    ]
                });
            } catch (errCDP) {
                // Bỏ qua lỗi CDP
            }
        }
        // 1. Múi giờ giả lập
        if (profile.timezone) {
            await page.emulateTimezone(profile.timezone).catch(() => {});
        }
        // 2. Toạ độ GPS
        if (profile.latitude !== null && profile.longitude !== null) {
            await page.setGeolocation({
                latitude: profile.latitude,
                longitude: profile.longitude,
                accuracy: 10
            }).catch(() => {});
        }
        // 3. Thiết lập Ngôn ngữ giả lập
        await page.setExtraHTTPHeaders({ 'Accept-Language': langHeader }).catch(() => {});
        await page.evaluateOnNewDocument((lang, languages) => {
            Object.defineProperty(navigator, 'language', { get: () => lang });
            Object.defineProperty(navigator, 'languages', { get: () => languages });
        }, langCode, langList).catch(() => {});
        
        // 4. Tự động cấp quyền Geolocation cho origin khi chuyển trang
        page.on('framenavigated', async (frame) => {
            if (frame === page.mainFrame()) {
                const url = page.url();
                if (url.startsWith('http')) {
                    try {
                        const origin = new URL(url).origin;
                        await browser.defaultBrowserContext().overridePermissions(origin, ['geolocation']).catch(() => {});
                    } catch (e) {}
                }
            }
        });
        
        // 5. Tiêm vân tay chống phát hiện bot
        await fingerprintInjector.attachFingerprintToPuppeteer(page, fingerprint).catch(() => {});

        // 6. Thiết lập data-profile-id trên root HTML để Extension Content Script tự động nhận dạng
        await page.evaluateOnNewDocument((id) => {
            const injectProfileId = () => {
                if (document.documentElement) {
                    document.documentElement.setAttribute('data-profile-id', id.toString());
                } else {
                    setTimeout(injectProfileId, 1);
                }
            };
            injectProfileId();
        }, profile.id).catch(() => {});

        // 7. Tiêm đè sâu các API vân tay và luồng mạng cấp cao (Canvas, Audio, WebRTC, Media Devices, Client Rects, Screen, Fonts, RAM/CPU)
        const devMemory = profile.device_memory || 8;
        const hwConcurrency = profile.hardware_concurrency || 4;
        await page.evaluateOnNewDocument((params) => {
            const seed = params.profileId;
            const webrtcMode = params.webrtcMode;
            const useProxy = params.useProxy;
            const proxyIp = params.proxyIp;
            const canvasNoise = params.canvasNoise;
            const fontsMode = params.fontsMode;
            const mediaDevicesMode = params.mediaDevicesMode;
            const screenWidth = params.screenWidth;
            const screenHeight = params.screenHeight;
            const devMem = params.devMemory;
            const hwConc = params.hwConcurrency;

            // Bộ sinh số ngẫu nhiên giả (PRNG) Mulberry32 dựa trên seed cố định
            function mulberry32(a) {
                return function() {
                    let t = a += 0x6D2B79F5;
                    t = Math.imul(t ^ (t >>> 15), t | 1);
                    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                }
            }
            const random = mulberry32(seed);

            const makeNative = (fn, name) => {
                const toString = function() {
                    return `function ${name}() { [native code] }`;
                };
                Object.defineProperty(toString, 'name', { value: 'toString', configurable: true });
                Object.defineProperty(fn, 'toString', {
                    value: toString,
                    configurable: true,
                    writable: true
                });
            };

            // Giả lập sâu RAM & CPU
            Object.defineProperty(navigator, 'deviceMemory', { get: () => devMem });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => hwConc });

            // A. Giả lập Screen và Kích thước cửa sổ (Screen Spoofing)
            const screenProps = {
                width: screenWidth,
                height: screenHeight,
                availWidth: screenWidth,
                availHeight: screenHeight - 40,
                colorDepth: 24,
                pixelDepth: 24
            };

            for (const prop in screenProps) {
                try {
                    Object.defineProperty(window.screen, prop, {
                        get: () => screenProps[prop],
                        configurable: true
                    });
                } catch (e) {}
            }

            try {
                Object.defineProperty(window, 'outerWidth', { get: () => screenWidth, configurable: true });
                Object.defineProperty(window, 'outerHeight', { get: () => screenHeight - 40, configurable: true });
            } catch (e) {}

            // B. Giả lập WebRTC Mode
            if (webrtcMode === 'disable') {
                try {
                    delete window.RTCPeerConnection;
                    delete window.webkitRTCPeerConnection;
                    delete window.mozRTCPeerConnection;
                    delete navigator.getUserMedia;
                    delete navigator.webkitGetUserMedia;
                    delete navigator.mozGetUserMedia;
                    if (navigator.mediaDevices) {
                        delete navigator.mediaDevices.getUserMedia;
                    }
                } catch(e) {}
            } else if (webrtcMode === 'spoof') {
                const OriginalRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
                if (OriginalRTCPeerConnection) {
                    const mdnsLocal = 'c7e8e45c-897d-419b-a01b-bf8885b5e7d5.local';
                    
                    const cleanCandidate = (candidate) => {
                        if (typeof candidate !== 'string') return candidate;
                        return candidate.replace(/([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/g, (ip) => {
                            const isPrivate = /^(10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[0-1])\..*|127\..*|fe80:.*|::1|fc00:.*|fd00:.*)/i.test(ip);
                            if (isPrivate) return mdnsLocal;
                            if (useProxy === 1 && proxyIp) return proxyIp;
                            return ip;
                        });
                    };

                    const cleanSdp = (sdp) => {
                        if (typeof sdp !== 'string') return sdp;
                        return sdp.replace(/([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/g, (ip) => {
                            const isPrivate = /^(10\..*|192\.168\..*|172\.(1[6-9]|2\d|3[0-1])\..*|127\..*|fe80:.*|::1|fc00:.*|fd00:.*)/i.test(ip);
                            if (isPrivate) return mdnsLocal;
                            if (useProxy === 1 && proxyIp) return proxyIp;
                            return ip;
                        });
                    };

                    const proto = OriginalRTCPeerConnection.prototype;
                    
                    if (proto.addIceCandidate) {
                        const originalAddIceCandidate = proto.addIceCandidate;
                        proto.addIceCandidate = function(candidate) {
                            if (candidate && candidate.candidate) {
                                candidate.candidate = cleanCandidate(candidate.candidate);
                            }
                            return originalAddIceCandidate.apply(this, arguments);
                        };
                        makeNative(proto.addIceCandidate, 'addIceCandidate');
                    }

                    if (proto.createOffer) {
                        const originalCreateOffer = proto.createOffer;
                        proto.createOffer = function() {
                            return originalCreateOffer.apply(this, arguments).then(offer => {
                                if (offer && offer.sdp) {
                                    offer.sdp = cleanSdp(offer.sdp);
                                }
                                return offer;
                            });
                        };
                        makeNative(proto.createOffer, 'createOffer');
                    }

                    if (proto.createAnswer) {
                        const originalCreateAnswer = proto.createAnswer;
                        proto.createAnswer = function() {
                            return originalCreateAnswer.apply(this, arguments).then(answer => {
                                if (answer && answer.sdp) {
                                    answer.sdp = cleanSdp(answer.sdp);
                                }
                                return answer;
                            });
                        };
                        makeNative(proto.createAnswer, 'createAnswer');
                    }

                    if (proto.setLocalDescription) {
                        const originalSetLocalDescription = proto.setLocalDescription;
                        proto.setLocalDescription = function(desc) {
                            if (desc && desc.sdp) {
                                desc.sdp = cleanSdp(desc.sdp);
                            }
                            return originalSetLocalDescription.apply(this, arguments);
                        };
                        makeNative(proto.setLocalDescription, 'setLocalDescription');
                    }
                }
            }

            // C. Giả lập Canvas Fingerprint Spoofing (Canvas Noise siêu tốc độ cố định dựa trên seed)
            if (canvasNoise === 1) {
                const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function() {
                    const ctx = this.getContext('2d');
                    if (ctx) {
                        try {
                            const oldFillStyle = ctx.fillStyle;
                            ctx.fillStyle = 'rgba(0,0,0,0.01)';
                            const x = Math.floor(random() * this.width);
                            const y = Math.floor(random() * this.height);
                            ctx.fillRect(x, y, 1, 1);
                            ctx.fillStyle = oldFillStyle;
                        } catch (e) {}
                    }
                    return originalToDataURL.apply(this, arguments);
                };
                makeNative(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');

                const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
                CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
                    const imageData = originalGetImageData.apply(this, arguments);
                    try {
                        const data = imageData.data;
                        if (data && data.length >= 4) {
                            const drawRandom = mulberry32(seed + sx + sy);
                            // Chỉ làm nhiễu duy nhất 5 điểm ảnh ngẫu nhiên để thay đổi hash chữ ký vân tay mà không gây treo luồng chính (main thread)
                            for (let k = 0; k < 5; k++) {
                                const idx = Math.floor(drawRandom() * (data.length / 4)) * 4;
                                const noise = Math.floor(drawRandom() * 3) - 1;
                                data[idx] = (data[idx] + noise + 256) % 256;
                                data[idx + 1] = (data[idx + 1] + noise + 256) % 256;
                                data[idx + 2] = (data[idx + 2] + noise + 256) % 256;
                            }
                        }
                    } catch (e) {}
                    return imageData;
                };
                makeNative(CanvasRenderingContext2D.prototype.getImageData, 'getImageData');
            }

            // D. Giả lập Audio Fingerprint Spoofing (Làm nhiễu sóng âm siêu tốc cố định dựa trên seed)
            if (window.AudioBuffer) {
                const originalGetChannelData = AudioBuffer.prototype.getChannelData;
                AudioBuffer.prototype.getChannelData = function(channel) {
                    const data = originalGetChannelData.apply(this, arguments);
                    try {
                        if (data && data.length > 0) {
                            const audioRandom = mulberry32(seed + channel);
                            // Chỉ làm nhiễu 10 điểm sóng âm ngẫu nhiên để tăng tốc độ xử lý âm thanh
                            for (let k = 0; k < 10; k++) {
                                const idx = Math.floor(audioRandom() * data.length);
                                data[idx] = data[idx] + (audioRandom() - 0.5) * 1e-7;
                            }
                        }
                    } catch (e) {}
                    return data;
                };
                makeNative(AudioBuffer.prototype.getChannelData, 'getChannelData');
                
                if (AudioBuffer.prototype.copyFromChannel) {
                    const originalCopyFromChannel = AudioBuffer.prototype.copyFromChannel;
                    AudioBuffer.prototype.copyFromChannel = function(destination, channelNumber, startInChannel) {
                        originalCopyFromChannel.apply(this, arguments);
                        try {
                            if (destination && destination.length > 0) {
                                const audioRandom = mulberry32(seed + channelNumber + (startInChannel || 0));
                                for (let k = 0; k < 10; k++) {
                                    const idx = Math.floor(audioRandom() * destination.length);
                                    destination[idx] = destination[idx] + (audioRandom() - 0.5) * 1e-7;
                                }
                            }
                        } catch (e) {}
                    };
                    makeNative(AudioBuffer.prototype.copyFromChannel, 'copyFromChannel');
                }
            }

            // E. Giả lập Media Devices Spoofing (Mic, camera, loa ảo cố định)
            if (mediaDevicesMode === 1 && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                const deviceRandom = mulberry32(seed + 100);
                
                const generateId = (prefix) => {
                    let idStr = prefix;
                    for (let i = 0; i < 32; i++) {
                        idStr += Math.floor(deviceRandom() * 16).toString(16);
                    }
                    return idStr;
                };
                
                const micId = generateId("mic");
                const camId = generateId("cam");
                const speakerId = generateId("spk");
                const groupId = generateId("grp");
                
                const fakeDevices = [
                    {
                        deviceId: micId,
                        kind: "audioinput",
                        label: "Microphone (Realtek High Definition Audio)",
                        groupId: groupId
                    },
                    {
                        deviceId: speakerId,
                        kind: "audiooutput",
                        label: "Speakers (Realtek High Definition Audio)",
                        groupId: groupId
                    },
                    {
                        deviceId: camId,
                        kind: "videoinput",
                        label: "HD Web Camera",
                        groupId: groupId
                    }
                ];

                navigator.mediaDevices.enumerateDevices = async function() {
                    return fakeDevices;
                };
                makeNative(navigator.mediaDevices.enumerateDevices, 'enumerateDevices');
            }

            // Đã loại bỏ các giả lập Client Rects và Fonts measureText để đảm bảo trình duyệt hoạt động ổn định 100%, không bị sập tab khi gõ phím.

        }, {
            profileId: profile.id,
            webrtcMode: profile.webrtc_mode || 'spoof',
            useProxy: profile.use_proxy,
            proxyIp: proxyPublicIp,
            canvasNoise: profile.canvas_noise !== undefined ? profile.canvas_noise : 1,
            fontsMode: profile.fonts_mode !== undefined ? profile.fonts_mode : 1,
            mediaDevicesMode: profile.media_devices !== undefined ? profile.media_devices : 1,
            screenWidth: profile.screen_width || 1280,
            screenHeight: profile.screen_height || 720,
            devMemory: devMemory,
            hwConcurrency: hwConcurrency
        }).catch(() => {});

        // 8. Giả lập thông tin phần cứng card đồ họa GPU (WebGL Vendor và Renderer)
        if (profile.gpu_vendor && profile.gpu_renderer) {
            await page.evaluateOnNewDocument((vendor, renderer) => {
                const overrideWebGL = (proto) => {
                    if (!proto) return;
                    const originalGetParameter = proto.getParameter;
                    proto.getParameter = function(parameter) {
                        // UNMASKED_VENDOR_WEBGL = 0x9245
                        if (parameter === 37445) {
                            return vendor;
                        }
                        // UNMASKED_RENDERER_WEBGL = 0x9246
                        if (parameter === 37446) {
                            return renderer;
                        }
                        return originalGetParameter.apply(this, arguments);
                    };
                    
                    const toString = function() {
                        return 'function getParameter() { [native code] }';
                    };
                    Object.defineProperty(toString, 'name', { value: 'toString', configurable: true });
                    Object.defineProperty(proto.getParameter, 'toString', {
                        value: toString,
                        configurable: true,
                        writable: true
                    });
                };
                
                if (window.WebGLRenderingContext) {
                    overrideWebGL(window.WebGLRenderingContext.prototype);
                }
                if (window.WebGL2RenderingContext) {
                    overrideWebGL(window.WebGL2RenderingContext.prototype);
                }
            }, profile.gpu_vendor, profile.gpu_renderer).catch(() => {});
        }
    } catch (err) {
        console.error(`setupPageProperties error: ${err.message}`);
    }
}

// Hàm chạy ngầm lấy IP công cộng thực tế của Proxy thông qua kết nối cục bộ
function getProxyPublicIp(proxyUrl) {
    return new Promise((resolve) => {
        const cmd = `curl -s -x "${proxyUrl}" "http://ip-api.com/json"`;
        exec(cmd, { timeout: 2000 }, (error, stdout) => {
            if (error) return resolve(null);
            try {
                const data = JSON.parse(stdout.trim());
                if (data && data.status === "success" && data.query) {
                    return resolve(data.query);
                }
            } catch (e) {}
            resolve(null);
        });
    });
}

async function isPortResponding(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(1000)
        });
        return response.ok;
    } catch (e) {
        return false;
    }
}function getExtensionIdFromPath(extPath) {
    let absolutePath = path.resolve(extPath);
    if (process.platform === 'win32') {
        absolutePath = absolutePath.replace(/\//g, '\\');
        if (absolutePath.match(/^[a-zA-Z]:/)) {
            absolutePath = absolutePath.charAt(0).toUpperCase() + absolutePath.slice(1);
        }
    }
    const buffer = Buffer.from(absolutePath, 'utf16le');
    const hash = crypto.createHash('sha256').update(buffer).digest();
    let id = '';
    for (let i = 0; i < 16; i++) {
        const byte = hash[i];
        const high = (byte >> 4) & 0x0f;
        const low = byte & 0x0f;
        id += String.fromCharCode(97 + high);
        id += String.fromCharCode(97 + low);
    }
    return id;
}

async function configureExtensionPrefs(profileDir, profileExtensions) {
    const defaultDir = path.join(profileDir, 'Default');
    if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
    }
    
    const prefsPath = path.join(defaultDir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(prefsPath)) {
        try {
            prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
        } catch (e) {
            prefs = {};
        }
    }
    
    // 1. Bật chế độ nhà phát triển
    if (!prefs.extensions) prefs.extensions = {};
    prefs.extensions.developer_mode = true;
    
    // 2. Thiết lập ghim tiện ích
    if (!prefs.extensions.pinned_extensions) {
        prefs.extensions.pinned_extensions = [];
    }
    
    if (!prefs.extensions.settings) {
        prefs.extensions.settings = {};
    }
    
    for (const ext of profileExtensions) {
        const extId = getExtensionIdFromPath(ext.path);
        if (!extId) continue;
        
        if (!prefs.extensions.pinned_extensions.includes(extId)) {
            prefs.extensions.pinned_extensions.push(extId);
        }
        
        if (!prefs.extensions.settings[extId]) {
            prefs.extensions.settings[extId] = {};
        }
        
        const extSetting = prefs.extensions.settings[extId];
        extSetting.state = 1; // Bật tiện ích
        extSetting.incognito = true; // Cho phép ở chế độ ẩn danh
        extSetting.file_access = true; // Cho phép truy cập vào các URL của tệp
        extSetting.show_on_developer_mode_warning = true; // Thu thập lỗi
        extSetting.allowed_on_all_sites = true; // Cho phép trên mọi trang web
    }
    
    try {
        fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf8');
    } catch (e) {
        console.error("[Extension Prefs] Lỗi lưu Preferences:", e.message);
    }
}

async function configureExtensionSettingsOnBrowser(browser, profileExtensions) {
    if (!profileExtensions || profileExtensions.length === 0) return;
    try {
        logInfo(`[Tiện ích] Đang tự động cấu hình quyền cho ${profileExtensions.length} tiện ích mở rộng...`);
        const page = await browser.newPage();
        
        for (const ext of profileExtensions) {
            const extId = getExtensionIdFromPath(ext.path);
            if (!extId) continue;
            
            logInfo(`[Tiện ích] Cấu hình chế độ ẩn danh, nhà phát triển, ghim, truy cập file và thu thập lỗi cho tiện ích ID: ${extId} (${ext.name})...`);
            
            // Mở trang chi tiết tiện ích
            await page.goto(`chrome://extensions/?id=${extId}`, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 1200)); // Đợi trang render hoàn toàn các shadow DOM
            
            await page.evaluate(() => {
                const manager = document.querySelector('extensions-manager');
                if (!manager) return;
                
                // 1. Tự động bật chế độ nhà phát triển nếu chưa bật
                const toolbar = manager.shadowRoot.querySelector('extensions-toolbar');
                if (toolbar) {
                    const devModeToggle = toolbar.shadowRoot.querySelector('#devMode');
                    if (devModeToggle && !devModeToggle.checked) {
                        devModeToggle.click();
                    }
                }
                
                // 2. Đi sâu vào detail view
                const viewManager = manager.shadowRoot.querySelector('#viewManager');
                if (!viewManager) return;
                const detailView = viewManager.querySelector('extensions-detail-view');
                if (!detailView) return;
                
                // Các id của toggle row tương ứng:
                // - pin-to-toolbar: Ghim vào thanh công cụ
                // - allow-incognito: Cho phép ở chế độ ẩn danh
                // - allow-on-file-urls: Cho phép truy cập vào các URL của tệp
                // - collect-errors: Thu thập lỗi
                const toggles = ['pin-to-toolbar', 'allow-incognito', 'allow-on-file-urls', 'collect-errors'];
                toggles.forEach(id => {
                    const row = detailView.shadowRoot.querySelector(`extensions-toggle-row#${id}`);
                    if (row) {
                        const crToggle = row.shadowRoot.querySelector('#crToggle');
                        if (crToggle && !crToggle.checked) {
                            crToggle.click();
                        }
                    }
                });
            }).catch(errEval => {
                console.error("[Extensions Detail Config Eval Error]", errEval);
            });
        }
        
        await page.close().catch(() => {});
        logInfo("[Tiện ích] Hoàn thành cấu hình tự động tất cả các quyền cho tiện ích mở rộng.");
    } catch (e) {
        logError(`[Tiện ích] Thất bại khi tự động cấu hình tiện ích mở rộng: ${e.message}`);
    }
}

async function startProfile(profileId, headless = false) {
    EXTENSION_RUN_LOGS[profileId] = []; // Reset log của tiện ích khi khởi chạy
    
    if (RUNNING_PROFILES[profileId]) {
        return [true, "Profile dang chay."];
    }

    const profile = await dbManager.getProfile(profileId);
    if (!profile) {
        logError(`Khong tim thay Profile ID: ${profileId}`);
        return [false, "Không tìm thấy Profile."];
    }

    const port = 9200 + profileId;
    
    // Tự động kiểm tra tái sử dụng phiên trình duyệt đang hoạt động (Warm-Start)
    const isAlive = await isPortResponding(port);
    let browser = null;
    let localProxyUrl = null;
    let proxyArg = null;
    let needsAuthEvent = false;
    let proxyPublicIp = null;
    let isReconnected = false;

    if (isAlive) {
        logInfo(`[Warm-Start] Phát hiện Profile ID ${profileId} đang chạy trên cổng ${port}. Tiến hành kết nối lại siêu tốc...`);
        try {
            browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${port}`,
                defaultViewport: null
            });
            isReconnected = true;
            logInfo(`[Warm-Start] Kết nối lại thành công tới profile ${profileId} trong < 0.5 giây.`);
        } catch (errConnect) {
            logWarning(`[Warm-Start] Kết nối lại thất bại: ${errConnect.message}. Tiến hành khởi động lại.`);
            killProcessOnPort(port);
        }
    } else {
        killProcessOnPort(port);
    }

    const profileDir = path.join(__dirname, 'profiles_data', `profile_${profileId}`);
    fs.mkdirSync(profileDir, { recursive: true });

    logInfo(`Dang khoi chay profile '${profile.name}' (ID: ${profileId})...`);

    // 1. Xoay Proxy IP trước khi chạy (nếu có cấu hình URL xoay IP)
    if (!isReconnected && profile.use_proxy === 1 && profile.proxy_rotate_url) {
        logInfo(`Gui yeu cau xoay IP den: ${profile.proxy_rotate_url}`);
        try {
            await fetch(profile.proxy_rotate_url, { signal: AbortSignal.timeout(8000) });
            logInfo("Dang cho 5 giay de proxy khoi dong lai voi IP moi...");
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
            logError(`Loi khi gui yeu cau xoay IP: ${e.message}`);
        }
    }

    // 2. Định tuyến Proxy qua proxy-chain (HTTP) hoặc gán trực tiếp (SOCKS5/HTTP)

    if (!isReconnected && profile.use_proxy === 1 && profile.proxy_server) {
        let proxyUrl = profile.proxy_server.trim();
        
        // Xác định giao thức mặc định nếu không có '://'
        if (!proxyUrl.includes("://")) {
            proxyUrl = "http://" + proxyUrl;
        }

        let authProxyUrl = proxyUrl;
        if (profile.proxy_user && profile.proxy_pass) {
            try {
                // Encode username/password để tránh lỗi ký tự đặc biệt trong URL
                const urlObj = new URL(proxyUrl);
                urlObj.username = encodeURIComponent(profile.proxy_user);
                urlObj.password = encodeURIComponent(profile.proxy_pass);
                authProxyUrl = urlObj.toString();
            } catch (e) {
                // Fallback nếu URL parsing bị lỗi (ví dụ định dạng không chuẩn)
                const proto = proxyUrl.includes("://") ? proxyUrl.split("://")[0] + "://" : "http://";
                const hostPort = proxyUrl.includes("://") ? proxyUrl.split("://")[1] : proxyUrl;
                authProxyUrl = `${proto}${encodeURIComponent(profile.proxy_user)}:${encodeURIComponent(profile.proxy_pass)}@${hostPort}`;
            }
        }

        const hasAuth = !!(profile.proxy_user && profile.proxy_pass);

        if (hasAuth) {
            // Proxy có tài khoản mật khẩu: BẮT BUỘC dùng proxy-chain để chuyển sang HTTP local không auth
            try {
                localProxyUrl = await proxyChain.anonymizeProxy(authProxyUrl);
                proxyArg = `--proxy-server=${localProxyUrl}`;
                logInfo(`Gan proxy co auth qua proxy-chain local: ${localProxyUrl}`);
                proxyPublicIp = await getProxyPublicIp(localProxyUrl);
            } catch (err) {
                logError(`Loi thiet lap proxy-chain cho proxy co auth: ${err.message}. Fallback gan truc tiep.`);
                proxyArg = `--proxy-server=${proxyUrl}`;
                needsAuthEvent = true;
                proxyPublicIp = await getProxyPublicIp(authProxyUrl);
            }
        } else {
            // Proxy không có tài khoản mật khẩu: Gán trực tiếp cho Chrome
            proxyArg = `--proxy-server=${proxyUrl}`;
            logInfo(`Gan proxy truc tiep khong auth: ${proxyUrl}`);
            proxyPublicIp = await getProxyPublicIp(proxyUrl);
        }
        
        if (proxyPublicIp) {
            logInfo(`[WebRTC Protect] Nhận dạng IP thực tế của Proxy: ${proxyPublicIp}. Tiến hành đồng bộ ngầm Múi giờ & Định vị theo IP...`);
            Promise.resolve().then(async () => {
                try {
                    const ipResponse = await fetch(`http://ip-api.com/json/${proxyPublicIp}`, { signal: AbortSignal.timeout(3000) });
                    const ipData = await ipResponse.json();
                    if (ipData && ipData.status === "success") {
                        profile.timezone = ipData.timezone || profile.timezone;
                        profile.latitude = ipData.lat || profile.latitude;
                        profile.longitude = ipData.lon || profile.longitude;
                        profile.country = ipData.countryCode || profile.country;
                        logInfo(`[Đồng bộ IP] Thành công! Múi giờ: ${profile.timezone}, GPS: ${profile.latitude},${profile.longitude}, Quốc gia: ${profile.country}`);
                        
                        await dbManager.updateProfile(
                            profile.id, profile.name, profile.user_agent, profile.proxy_server,
                            profile.proxy_user, profile.proxy_pass, profile.timezone, profile.latitude,
                            profile.longitude, profile.screen_width, profile.screen_height, profile.script_id,
                            profile.use_proxy, profile.proxy_rotate_url, profile.use_mcp, profile.country,
                            profile.fingerprint_json, profile.device_memory, profile.hardware_concurrency, profile.canvas_noise,
                            profile.gpu_vendor, profile.gpu_renderer, profile.locale, profile.webrtc_mode, profile.fonts_mode, profile.media_devices
                        ).catch(() => {});
                    }
                } catch (eIpSync) {
                    logWarning(`[Đồng bộ IP ngầm] Không thể kết nối API định vị IP: ${eIpSync.message}. Dùng cấu hình lưu sẵn.`);
                }
            });
        } else {
            logWarning(`[WebRTC Protect] Không lấy được IP của Proxy qua curl, dùng IP mặc định.`);
        }
    } else {
        logInfo("Chay truc tiep, khong su dung Proxy.");
    }

    // 3. Khởi tạo hoặc nạp vân tay giả lập cố định
    let fingerprint = null;
    const fingerprintInjector = new FingerprintInjector();

    if (profile.fingerprint_json) {
        try {
            fingerprint = JSON.parse(profile.fingerprint_json);
            logInfo(`[Antidetect] Nạp thành công vân tay phần cứng cố định từ Cơ sở dữ liệu cho Profile ID ${profileId}.`);
        } catch (errJson) {
            logWarning(`[Antidetect] Lỗi phân tích cú pháp vân tay lưu sẵn: ${errJson.message}. Tiến hành sinh mới...`);
        }
    }

    if (!fingerprint) {
        logInfo(`[Antidetect] Chưa có vân tay lưu sẵn hoặc vân tay lỗi cho Profile ID ${profileId}. Đang sinh vân tay cố định mới...`);
        const osType = (profile.user_agent || '').toLowerCase().includes('macintosh') ? 'macos' : 'windows';
        const fingerprintGenerator = new FingerprintGenerator({
            devices: ['desktop'],
            operatingSystems: [osType]
        });
        const { fingerprint: generatedFp } = fingerprintGenerator.getFingerprint();
        fingerprint = generatedFp;

        // Lưu ngược lại Database để vĩnh viễn hóa vân tay này cho các lần chạy sau
        fingerprint.userAgent = profile.user_agent || fingerprint.userAgent;
        fingerprint.screenHeight = profile.screen_height || 720;
        fingerprint.screenWidth = profile.screen_width || 1280;
        fingerprint.deviceMemory = profile.device_memory || 8;
        fingerprint.hardwareConcurrency = profile.hardware_concurrency || 4;

        const fingerprintJson = JSON.stringify(fingerprint);
        dbManager.updateProfile(
            profile.id, profile.name, profile.user_agent, profile.proxy_server,
            profile.proxy_user, profile.proxy_pass, profile.timezone, profile.latitude,
            profile.longitude, profile.screen_width, profile.screen_height, profile.script_id,
            profile.use_proxy, profile.proxy_rotate_url, profile.use_mcp, profile.country,
            fingerprintJson, profile.device_memory, profile.hardware_concurrency, profile.canvas_noise
        ).then(() => {
            logInfo(`[Antidetect] Đã lưu vân tay cố định mới tạo vào Cơ sở dữ liệu thành công cho Profile ID ${profileId}.`);
        }).catch(errDb => {
            logError(`[Antidetect] Lỗi lưu vân tay cố định mới vào DB: ${errDb.message}`);
        });
    } else {
        // Đồng bộ các thuộc tính nếu người dùng đã thay đổi ở UI
        if (profile.user_agent) fingerprint.userAgent = profile.user_agent;
        fingerprint.screenHeight = profile.screen_height || 720;
        fingerprint.screenWidth = profile.screen_width || 1280;
        fingerprint.deviceMemory = profile.device_memory || 8;
        fingerprint.hardwareConcurrency = profile.hardware_concurrency || 4;
    }

    // Phân tích ngôn ngữ giả lập: Ưu tiên theo cấu hình locale cố định của profile
    let langCode = profile.locale || "vi-VN";
    let langList = [langCode];
    const baseLang = langCode.split('-')[0];
    if (baseLang && baseLang !== langCode) {
        langList.push(baseLang);
    }
    if (!langList.includes("en-US")) langList.push("en-US");
    if (!langList.includes("en")) langList.push("en");
    const langHeader = langList.join(',');
    logInfo(`Gia lap ngon ngu: ${langCode} (${langHeader})`);

    // 4. Thiết lập tham số khởi chạy Puppeteer
    const args = [
        `--user-data-dir=${profileDir}`,
        `--window-size=${profile.screen_width},${profile.screen_height}`,
        `--remote-debugging-port=${port}`,
        `--lang=${langCode}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-webrtc-multiple-routes',
        '--disable-infobars',
        '--no-first-run',
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled' // Che giấu navigator.webdriver ở cấp Chromium flag
    ];

    // Lấy các tiện ích mở rộng được bật cho profile này
    try {
        const profileExtensions = await dbManager.getEnabledExtensionsForProfile(profileId);
        if (profileExtensions && profileExtensions.length > 0) {
            // Cấu hình tự động Preferences (Developer mode, Ghim, Ẩn danh, File Access, Bật tiện ích...)
            await configureExtensionPrefs(profileDir, profileExtensions);
            
            const paths = profileExtensions.map(ext => ext.path).join(',');
            args.push(`--load-extension=${paths}`);
            args.push(`--disable-extensions-except=${paths}`);
            logInfo(`Đã nạp và cấu hình tự động ${profileExtensions.length} tiện ích mở rộng cho Profile ID ${profileId}: ${profileExtensions.map(e => e.name).join(', ')}`);
        }
    } catch (errExt) {
        logError(`Lỗi nạp hoặc cấu hình tiện ích mở rộng cho Profile: ${errExt.message}`);
    }

    if (proxyArg) args.push(proxyArg);

    try {
        if (!isReconnected) {
            browser = await puppeteer.launch({
                headless: headless ? "new" : false,
                executablePath: CHROME_PATH,
                userDataDir: profileDir,
                defaultViewport: null,
                ignoreDefaultArgs: ['--enable-automation'],
                args: args
            });
        }

        // Hàm helper gán xác thực nếu cần thiết
        const handleAuth = async (page) => {
            if (needsAuthEvent && profile.proxy_user && profile.proxy_pass) {
                await page.authenticate({
                    username: profile.proxy_user,
                    password: profile.proxy_pass
                }).catch(() => {});
            }
        };

        let keepAliveInterval = null;

        const handleDisconnect = async () => {
            logWarning(`[Antidetect] Phát hiện mất kết nối CDP (WebSocket) với profile ${profileId}. Đang kiểm tra trạng thái thực tế...`);
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
            }

            // Trì hoãn 3 giây để kiểm tra cổng debug xem trình duyệt thực sự còn chạy không
            setTimeout(async () => {
                try {
                    const isAlive = await isPortResponding(port);
                    if (isAlive) {
                        logInfo(`[Auto-Reconnect] Trình duyệt của profile ${profileId} vẫn đang hoạt động trên cổng debug ${port}. Tiến hành tự động kết nối lại...`);
                        try {
                            const newBrowser = await puppeteer.connect({
                                browserURL: `http://127.0.0.1:${port}`,
                                defaultViewport: null
                            });
                            
                            logInfo(`[Auto-Reconnect] Đã kết nối lại thành công tới profile ${profileId}.`);
                            if (RUNNING_PROFILES[profileId]) {
                                RUNNING_PROFILES[profileId].browser = newBrowser;
                            }
                            
                            setupBrowserListeners(newBrowser);
                            await dbManager.updateStatus(profileId, "Running").catch(() => {});
                            return;
                        } catch (errConnect) {
                            logError(`[Auto-Reconnect] Kết nối lại thất bại: ${errConnect.message}`);
                        }
                    }

                    // Trình duyệt thực sự đã bị đóng
                    logInfo(`[Antidetect] Trình duyệt của profile ${profileId} đã đóng hẳn.`);
                    await dbManager.updateStatus(profileId, "Stopped").catch(() => {});
                    
                    if (localProxyUrl) {
                        logInfo(`[Antidetect] Đang ngắt kết nối proxy-chain local của profile ${profileId}...`);
                        await proxyChain.closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
                    }
                    
                    if (RUNNING_PROFILES[profileId]) {
                        killMcpProcess(RUNNING_PROFILES[profileId]);
                    }
                    
                    await cleanupProfileResources(profileId).catch(() => {});
                } catch (eDisconnect) {
                    logError(`Lỗi trong quá trình xử lý đóng profile ${profileId}: ${eDisconnect.message}`);
                } finally {
                    // Đảm bảo luôn dọn dẹp RAM của profile để nút Start/Stop hiển thị đồng bộ chuẩn xác
                    delete RUNNING_PROFILES[profileId];
                }
            }, 3000);
        };

        const setupBrowserListeners = (b) => {
            b.on('targetcreated', async (target) => {
                if (target.type() === 'page') {
                    try {
                        const page = await target.page();
                        if (page) {
                            await handleAuth(page);
                            await setupPageProperties(page, b, profile, fingerprint, langCode, langList, langHeader, fingerprintInjector, proxyPublicIp, true);
                            
                            // Đăng ký bộ thu thập log tiện ích và giám sát mạng
                            attachExtensionLogListeners(page, profileId);
                            attachNetworkInterception(page, profileId);
                        }
                    } catch (err) {}
                }
            });

            b.on('disconnected', handleDisconnect);

            // Bắt đầu vòng lặp Keep-Alive (ping trình duyệt mỗi 10 giây để giữ kết nối WebSocket không bị đứt)
            keepAliveInterval = setInterval(async () => {
                if (RUNNING_PROFILES[profileId] && RUNNING_PROFILES[profileId].browser && RUNNING_PROFILES[profileId].browser.connected) {
                    try {
                        await RUNNING_PROFILES[profileId].browser.version();
                    } catch (e) {
                        logWarning(`[Keep-Alive] Ping profile ${profileId} gặp lỗi: ${e.message}`);
                    }
                } else {
                    clearInterval(keepAliveInterval);
                }
            }, 10000);
        };

        // Đăng ký listeners ban đầu cho browser vừa launch
        setupBrowserListeners(browser);

        if (!isReconnected) {
            // Mở trang đầu tiên
            const pages = await browser.pages();
            const page = pages[0] || await browser.newPage();
            
            // Khóa kích thước cửa sổ trình duyệt vật lý thực tế qua CDP để cố định kích thước màn hình
            if (profile.screen_width && profile.screen_height) {
                try {
                    // Đặt kích thước vùng nội dung trang web (Viewport)
                    await page.setViewport({
                        width: profile.screen_width,
                        height: profile.screen_height,
                        deviceScaleFactor: 1,
                        isMobile: false,
                        hasTouch: false
                    }).catch(() => {});

                    // Gửi lệnh CDP (Chrome DevTools Protocol) để thiết lập chính xác kích thước cửa sổ Chromium vật lý trên Windows
                    const session = await page.target().createCDPSession();
                    const { windowId } = await session.send('Browser.getWindowForTarget');
                    await session.send('Browser.setWindowBounds', {
                        windowId,
                        bounds: {
                            width: profile.screen_width,
                            height: profile.screen_height,
                            windowState: 'normal' // Trạng thái bình thường để giữ đúng kích thước cấu hình
                        }
                    });
                    await session.detach();
                } catch (errWindow) {
                    // Bỏ qua nếu lỗi kết nối CDP
                }
            }
            
            await handleAuth(page);
            await setupPageProperties(page, browser, profile, fingerprint, langCode, langList, langHeader, fingerprintInjector, proxyPublicIp, true);
            attachExtensionLogListeners(page, profileId);
            attachNetworkInterception(page, profileId);

            // Tự động cấu hình chi tiết tiện ích (nhà phát triển, ẩn danh, ghim, truy cập file, thu thập lỗi)
            try {
                const profileExtensions = await dbManager.getEnabledExtensionsForProfile(profileId);
                await configureExtensionSettingsOnBrowser(browser, profileExtensions);
            } catch (errExtConfig) {
                logError(`Lỗi tự động cấu hình chi tiết tiện ích: ${errExtConfig.message}`);
            }

            if (!headless) {
                page.goto("https://whoer.net").catch(() => {});
            }
        } else {
            // Nếu reconnect, ta thiết lập properties cho tất cả các trang hiện có
            const pages = await browser.pages();
            for (const p of pages) {
                await setupPageProperties(p, browser, profile, fingerprint, langCode, langList, langHeader, fingerprintInjector, proxyPublicIp, true).catch(() => {});
            }
        }

        await dbManager.updateStatus(profileId, "Running");

        // Bắt đầu khởi chạy MCP Server cho profile này nếu có cấu hình use_mcp (chạy nền hoàn toàn)
        let mcpProcess = null;
        if (profile.use_mcp === 1) {
            const mcpPort = 10000 + profileId;
            Promise.resolve().then(async () => {
                const isMcpAlive = await isPortResponding(mcpPort);
                if (isMcpAlive) {
                    logInfo(`[MCP Server] MCP Server cho profile ${profileId} đã đang chạy trên cổng ${mcpPort}. Bỏ qua khởi chạy mới.`);
                } else {
                    logInfo(`[MCP Server] Đang khởi chạy MCP Server cho profile ${profileId} tại cổng ${mcpPort}...`);
                    try {
                        const cmdArgs = [
                            '-y', 
                            'chrome-devtools-mcp@latest', 
                            '--port', mcpPort.toString(), 
                            '--browserUrl', `http://127.0.0.1:${port}`
                        ];
                        
                        const proc = spawn(npxCommand, cmdArgs, {
                            shell: true,
                            stdio: 'ignore',
                            detached: true,
                            windowsHide: true
                        });
                        proc.unref();
                        logInfo(`[MCP Server] Đã khởi chạy MCP Server thành công (PID: ${proc.pid}).`);
                        if (RUNNING_PROFILES[profileId]) {
                            RUNNING_PROFILES[profileId].mcpProcess = proc;
                        }
                    } catch (errMcp) {
                        logError(`[MCP Server] Lỗi khi khởi chạy MCP Server: ${errMcp.message}`);
                    }
                }
            }).catch(() => {});
        } else {
            logInfo(`[MCP Server] Không bật MCP Server cho profile ${profileId} (chạy Puppeteer trực tiếp).`);
        }

        // Đăng ký profile vào danh sách đang chạy
        RUNNING_PROFILES[profileId] = {
            browser: browser,
            localProxyUrl: localProxyUrl,
            mcpProcess: mcpProcess
        };

        return [true, "Khởi chạy trình duyệt thành công."];
    } catch (e) {
        logError(`Loi khi mo trinh duyet profile ${profileId}: ${e.message}`);
        if (localProxyUrl) {
            await proxyChain.closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
        }
        await dbManager.updateStatus(profileId, "Stopped");
        return [false, e.message];
    }
}

async function stopProfile(profileId) {
    const runInfo = RUNNING_PROFILES[profileId];
    if (runInfo) {
        try {
            await runInfo.browser.close();
        } catch (e) {}
        if (runInfo.localProxyUrl) {
            await proxyChain.closeAnonymizedProxy(runInfo.localProxyUrl, true).catch(() => {});
        }
        killMcpProcess(runInfo);
        delete RUNNING_PROFILES[profileId];
    }
    
    // Luôn dọn dẹp triệt để kể cả khi trình duyệt tự tắt hoặc không còn trong danh sách chạy
    const port = 9200 + profileId;
    killProcessOnPort(port);
    await cleanupProfileResources(profileId).catch(() => {});
    await dbManager.updateStatus(profileId, "Stopped").catch(() => {});
    return true;
}

async function startMcpForRunningProfile(profileId) {
    const runInfo = RUNNING_PROFILES[profileId];
    if (!runInfo) {
        return [false, "Profile chưa chạy."];
    }
    if (runInfo.mcpProcess) {
        return [true, "MCP Server đã đang chạy."];
    }
    
    const port = 9200 + profileId;
    const mcpPort = 10000 + profileId;
    logInfo(`[MCP Server Dynamic] Đang khởi chạy MCP Server cho profile ${profileId} tại cổng ${mcpPort}...`);
    try {
        const cmdArgs = [
            '-y', 
            'chrome-devtools-mcp@latest', 
            '--port', mcpPort.toString(), 
            '--browserUrl', `http://127.0.0.1:${port}`
        ];
        
        const mcpProcess = spawn(npxCommand, cmdArgs, {
            shell: true,
            stdio: 'ignore',
            detached: true,
            windowsHide: true
        });
        mcpProcess.unref();
        
        runInfo.mcpProcess = mcpProcess;
        logInfo(`[MCP Server Dynamic] Đã khởi chạy MCP Server thành công (PID: ${mcpProcess.pid}).`);
        await dbManager.updateProfileMcpStatus(profileId, 1);
        return [true, "Đã bật MCP Server thành công."];
    } catch (e) {
        logError(`[MCP Server Dynamic] Lỗi khi khởi chạy MCP: ${e.message}`);
        return [false, e.message];
    }
}

async function stopMcpForRunningProfile(profileId) {
    const runInfo = RUNNING_PROFILES[profileId];
    if (!runInfo) {
        return [false, "Profile chưa chạy."];
    }
    if (!runInfo.mcpProcess) {
        return [true, "MCP Server đã tắt."];
    }
    
    try {
        killMcpProcess(runInfo);
        runInfo.mcpProcess = null;
        logInfo(`[MCP Server Dynamic] Đã tắt MCP Server của profile ${profileId}.`);
        await dbManager.updateProfileMcpStatus(profileId, 0);
        return [true, "Đã tắt MCP Server thành công."];
    } catch (e) {
        logError(`[MCP Server Dynamic] Lỗi khi dừng MCP: ${e.message}`);
        return [false, e.message];
    }
}

async function checkAndReconnectProfile(profileId) {
    if (RUNNING_PROFILES[profileId]) {
        return true;
    }
    const port = 9200 + profileId;
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(1000)
        });
        if (response.ok) {
            logInfo(`[Auto-Reconnect] Phát hiện Profile ID ${profileId} đang chạy trên cổng debug ${port}. Đang kết nối lại...`);
            const browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${port}`,
                defaultViewport: null
            });
            
            // Đăng ký lại hồ sơ đang chạy
            RUNNING_PROFILES[profileId] = {
                browser: browser,
                localProxyUrl: null,
                mcpProcess: null
            };
            
            await dbManager.updateStatus(profileId, "Running");
            
            // Lắng nghe sự kiện ngắt kết nối
            browser.on('disconnected', async () => {
                logInfo(`Trình duyệt của profile ${profileId} đã đóng.`);
                await dbManager.updateStatus(profileId, "Stopped");
                delete RUNNING_PROFILES[profileId];
            });
            
            return true;
        }
    } catch (e) {
        // Cổng debug chưa mở hoặc trình duyệt chưa chạy
    }
    return false;
}

module.exports = {
    RUNNING_PROFILES,
    SYSTEM_LOGS,
    EXTENSION_RUN_LOGS,
    PROFILE_NETWORK_TRAFFIC,
    PROFILE_INTERCEPTION_RULES,
    attachNetworkInterception,
    logInfo,
    logWarning,
    logError,
    startProfile,
    stopProfile,
    startMcpForRunningProfile,
    stopMcpForRunningProfile,
    registerProfileEmail,
    registerProfilePhone,
    cleanupProfileResources,
    checkAndReconnectProfile
};
