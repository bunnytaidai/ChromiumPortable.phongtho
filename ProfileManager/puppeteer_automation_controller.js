const EventEmitter = require('events');
const puppeteer = require('puppeteer-extra');

class PuppeteerAutomationController extends EventEmitter {
    constructor() {
        super();
        this.browser = null;
        this.page = null;
        this.cdpSession = null;
        this.isStopped = false;
    }

    // Gửi log dạng chuẩn về cho client
    log(moduleName, type, message) {
        const timestamp = new Date().toLocaleTimeString();
        this.emit('log', {
            timestamp,
            module: moduleName.toUpperCase(),
            type: type.toUpperCase(),
            message
        });
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 1. CDPSession (Raw Protocol Hub - Trạm giao tiếp CDP thô)
     */
    async initCDPSession(page) {
        try {
            this.cdpSession = await page.target().createCDPSession();
            this.log('CDP', 'INFO', 'Đã khởi tạo đường ống CDPSession thành công.');
        } catch (e) {
            this.log('CDP', 'ERROR', `Lỗi khởi tạo CDPSession: ${e.message}`);
            throw e;
        }
    }

    async emulateNetwork(speedPreset) {
        if (!this.cdpSession) return;
        try {
            let conditions = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
            
            if (speedPreset === 'offline') {
                conditions = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
                this.log('CDP', 'NETWORK', 'Đã giả lập trạng thái ngoại tuyến (Offline).');
            } else if (speedPreset === 'slow3g') {
                conditions = { offline: false, latency: 2000, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 150 * 1024 / 8 };
                this.log('CDP', 'NETWORK', 'Đã giả lập mạng 3G Chậm (Slow 3G) - Latency 2000ms.');
            } else if (speedPreset === 'fast3g') {
                conditions = { offline: false, latency: 560, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 768 * 1024 / 8 };
                this.log('CDP', 'NETWORK', 'Đã giả lập mạng 3G Nhanh (Fast 3G) - Latency 560ms.');
            } else if (speedPreset === '4g') {
                conditions = { offline: false, latency: 100, downloadThroughput: 10 * 1024 * 1024 / 8, uploadThroughput: 5 * 1024 * 1024 / 8 };
                this.log('CDP', 'NETWORK', 'Đã giả lập mạng 4G tiêu chuẩn - Latency 100ms.');
            } else {
                this.log('CDP', 'NETWORK', 'Đã khôi phục tốc độ mạng mặc định.');
            }

            await this.cdpSession.send('Network.emulateNetworkConditions', conditions);
        } catch (e) {
            this.log('CDP', 'ERROR', `Lỗi mô phỏng mạng qua CDP: ${e.message}`);
        }
    }

    async emulateCPUThrottling(rate) {
        if (!this.cdpSession) return;
        try {
            const throttleRate = parseInt(rate) || 1;
            await this.cdpSession.send('Emulation.setCPUThrottlingRate', { rate: throttleRate });
            if (throttleRate > 1) {
                this.log('CDP', 'INFO', `Đã giới hạn tốc độ xử lý CPU giảm đi ${throttleRate} lần.`);
            } else {
                this.log('CDP', 'INFO', 'Đã khôi phục hiệu suất CPU bình thường.');
            }
        } catch (e) {
            this.log('CDP', 'ERROR', `Lỗi giới hạn CPU qua CDP: ${e.message}`);
        }
    }

    /**
     * 2. Physical Input Emulator (Mô phỏng nhập liệu phần cứng người thật)
     */
    async typeHumanLike(selector, text, minDelay = 50, maxDelay = 150) {
        try {
            await this.page.focus(selector);
            this.log('INPUT', 'INFO', `Đang bắt đầu gõ vào ô chọn: ${selector}`);
            for (const char of text) {
                if (this.isStopped) return;
                await this.page.keyboard.sendCharacter(char);
                const delay = Math.random() * (maxDelay - minDelay) + minDelay;
                await this.sleep(delay);
            }
            this.log('INPUT', 'SUCCESS', `Đã gõ xong: '${text}'`);
        } catch (e) {
            this.log('INPUT', 'ERROR', `Lỗi nhập liệu giả lập: ${e.message}`);
            throw e;
        }
    }

    // Di chuyển chuột mượt mà bằng giải thuật nội suy tuyến tính (Linear Interpolation) kèm nhiễu ngẫu nhiên
    async moveMouseRealistic(toX, toY, steps = 20) {
        try {
            // Lấy tọa độ chuột hiện tại (nếu chưa di chuyển thì mặc định 0,0)
            const currentX = this.currentMouseX || 0;
            const currentY = this.currentMouseY || 0;
            
            this.log('INPUT', 'INFO', `Đang di chuyển chuột từ (${currentX}, ${currentY}) đến (${toX}, ${toY})`);
            
            for (let i = 1; i <= steps; i++) {
                if (this.isStopped) return;
                const t = i / steps;
                // Áp dụng giải thuật Bezier đơn giản hoặc nội suy để tạo đường cong mượt mà
                const targetX = Math.round(currentX + (toX - currentX) * t + (Math.random() - 0.5) * 4);
                const targetY = Math.round(currentY + (toY - currentY) * t + (Math.random() - 0.5) * 4);
                
                await this.page.mouse.move(targetX, targetY);
                await this.sleep(15);
            }
            
            await this.page.mouse.move(toX, toY);
            this.currentMouseX = toX;
            this.currentMouseY = toY;
            this.log('INPUT', 'SUCCESS', `Đã di chuyển chuột tới điểm đích (${toX}, ${toY})`);
        } catch (e) {
            this.log('INPUT', 'ERROR', `Lỗi di chuyển chuột: ${e.message}`);
        }
    }

    async clickRealistic(selector) {
        try {
            const element = await this.page.$(selector);
            if (!element) throw new Error(`Không tìm thấy phần tử ${selector}`);
            
            const box = await element.boundingBox();
            if (!box) throw new Error(`Phần tử ${selector} không có kích thước hình học.`);

            const clickX = Math.round(box.x + box.width / 2 + (Math.random() - 0.5) * (box.width / 4));
            const clickY = Math.round(box.y + box.height / 2 + (Math.random() - 0.5) * (box.height / 4));

            await this.moveMouseRealistic(clickX, clickY, 15);
            await this.page.mouse.down();
            await this.sleep(Math.random() * 50 + 50); // Nhấn giữ chuột từ 50-100ms
            await this.page.mouse.up();
            
            this.log('INPUT', 'SUCCESS', `Đã nhấp chuột thật vào phần tử ${selector} tại tọa độ (${clickX}, ${clickY})`);
        } catch (e) {
            this.log('INPUT', 'ERROR', `Lỗi click chuột thật: ${e.message}`);
            throw e;
        }
    }

    /**
     * 3. Network Interceptor (Đánh chặn và Định cấu hình Lưu lượng mạng)
     */
    async setupNetworkInterception(settings) {
        try {
            await this.page.setRequestInterception(true);
            
            const blockImages = !!settings.blockImages;
            const blockCSS = !!settings.blockCSS;
            const blockMedia = !!settings.blockMedia;
            
            // Xử lý các quy tắc Mock API gửi lên từ giao diện
            let mockRules = [];
            if (settings.mockRulesText) {
                try {
                    mockRules = JSON.parse(settings.mockRulesText);
                } catch (errJson) {
                    this.log('NETWORK', 'ERROR', `Lỗi phân tích quy tắc Mock API JSON: ${errJson.message}`);
                }
            }

            this.page.on('request', async (req) => {
                try {
                    const resourceType = req.resourceType();
                    
                    // A. Chặn các loại tài nguyên theo yêu cầu
                    if (blockImages && resourceType === 'image') {
                        await req.abort();
                        this.log('NETWORK', 'BLOCKED', `Đã chặn tải ảnh: ${req.url().substring(0, 60)}...`);
                        return;
                    }
                    if (blockCSS && resourceType === 'stylesheet') {
                        await req.abort();
                        this.log('NETWORK', 'BLOCKED', `Đã chặn tải CSS: ${req.url().substring(0, 60)}...`);
                        return;
                    }
                    if (blockMedia && (resourceType === 'media' || resourceType === 'font')) {
                        await req.abort();
                        this.log('NETWORK', 'BLOCKED', `Đã chặn tải Media/Font: ${req.url().substring(0, 60)}...`);
                        return;
                    }

                    // B. Chặn bắt và giả lập (Mock) dữ liệu API trả về
                    const url = req.url();
                    let matchedRule = null;
                    for (const rule of mockRules) {
                        if (rule.urlPattern && url.includes(rule.urlPattern)) {
                            matchedRule = rule;
                            break;
                        }
                    }

                    if (matchedRule) {
                        await req.respond({
                            status: matchedRule.status || 200,
                            contentType: 'application/json',
                            body: JSON.stringify(matchedRule.mockData || {})
                        });
                        this.log('NETWORK', 'MOCKED', `Đã đánh chặn và phản hồi API giả lập cho URL: ${url}`);
                        return;
                    }

                    await req.continue();
                } catch (eReq) {
                    // Tránh crash nếu request đã hoàn thành trước khi xử lý xong
                    try { await req.continue(); } catch(e) {}
                }
            });

            this.log('NETWORK', 'INFO', 'Đã kích hoạt bộ lọc tài nguyên và giả lập API thành công.');
        } catch (e) {
            this.log('NETWORK', 'ERROR', `Lỗi thiết lập chặn mạng: ${e.message}`);
        }
    }

    /**
     * 4. Environment Spoofer (Device & GPS Spoofing - Giả lập Môi trường & Thiết bị)
     */
    async spoofEnvironment(settings) {
        try {
            // A. Giả lập GPS
            if (settings.latitude !== undefined && settings.longitude !== undefined) {
                const lat = parseFloat(settings.latitude);
                const lon = parseFloat(settings.longitude);
                if (!isNaN(lat) && !isNaN(lon)) {
                    await this.page.setGeolocation({ latitude: lat, longitude: lon, accuracy: 10 });
                    this.log('ENV', 'INFO', `Đã giả lập tọa độ GPS ảo: Vĩ độ ${lat}, Kinh độ ${lon}`);
                    
                    // Cấp quyền tự động cho Geolocation
                    const origin = new URL(settings.targetUrl).origin;
                    await this.browser.defaultBrowserContext().overridePermissions(origin, ['geolocation']);
                    this.log('ENV', 'INFO', `Đã ghi đè quyền truy cập GPS cho nguồn: ${origin}`);
                }
            }

            // B. Giả lập thiết bị (Viewport & User Agent)
            if (settings.devicePreset === 'iphone') {
                await this.page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1");
                await this.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
                this.log('ENV', 'INFO', 'Đã chuyển đổi cấu hình hiển thị sang: Apple iPhone 14 Pro');
            } else if (settings.devicePreset === 'android') {
                await this.page.setUserAgent("Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36");
                await this.page.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true });
                this.log('ENV', 'INFO', 'Đã chuyển đổi cấu hình hiển thị sang: Samsung Galaxy S22');
            } else {
                await this.page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                await this.page.setViewport({ width: 1280, height: 720, isMobile: false, hasTouch: false });
                this.log('ENV', 'INFO', 'Đã chuyển đổi cấu hình hiển thị sang: Máy tính Máy trạm (Desktop Windows)');
            }
        } catch (e) {
            this.log('ENV', 'ERROR', `Lỗi cài đặt vân tay/môi trường: ${e.message}`);
        }
    }

    /**
     * 5. Deep Code Injector (Tiêm mã JS Sâu trước & sau khi load trang)
     */
    async injectPreloadScripts(preloadJs) {
        try {
            // Evasion script ẩn dấu webdriver
            await this.page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            if (preloadJs && preloadJs.trim()) {
                await this.page.evaluateOnNewDocument((code) => {
                    try {
                        eval(code);
                    } catch (errEval) {
                        console.error('Lỗi chạy Preload Script:', errEval);
                    }
                }, preloadJs);
                this.log('ENV', 'INJECT', 'Đã nạp mã tiêm sớm (Pre-load JS) thành công vào ngữ cảnh trình duyệt.');
            }
        } catch (e) {
            this.log('ENV', 'ERROR', `Lỗi cài đặt mã tiêm sớm: ${e.message}`);
        }
    }

    async runPostloadScript(postloadJs) {
        if (!postloadJs || !postloadJs.trim()) return;
        try {
            this.log('ENV', 'INJECT', 'Đang thực thi mã tiêm muộn (Post-load JS) sau khi tải trang...');
            const result = await this.page.evaluate((code) => {
                try {
                    const evalResult = eval(code);
                    return evalResult !== undefined ? String(evalResult) : 'Không có giá trị trả về';
                } catch (errEval) {
                    return 'LỖI THỰC THI: ' + errEval.message;
                }
            }, postloadJs);
            this.log('ENV', 'INJECT', `Kết quả mã tiêm muộn: ${result}`);
        } catch (e) {
            this.log('ENV', 'ERROR', `Lỗi thực thi mã tiêm muộn: ${e.message}`);
        }
    }

    /**
     * 6. Smart Locators API (Tự động chờ thông minh)
     */
    async executeStepWithLocator(action, selector, inputValue) {
        try {
            this.log('LOCATOR', 'INFO', `Đang định vị phần tử '${selector}' cho thao tác: ${action.toUpperCase()}`);
            
            // Sử dụng modern Locator API của Puppeteer
            const locator = this.page.locator(selector);
            
            if (action === 'click') {
                await locator.click();
                this.log('LOCATOR', 'SUCCESS', `Đã hoàn tất thao tác Click vào phần tử: ${selector}`);
            } else if (action === 'type') {
                const textVal = inputValue || '';
                // fill sẽ tự động chờ sẵn sàng và ghi đè nội dung sạch sẽ
                await locator.fill(textVal);
                this.log('LOCATOR', 'SUCCESS', `Đã hoàn tất thao tác Nhập liệu vào: ${selector} (Giá trị: '${textVal}')`);
            } else {
                throw new Error(`Thao tác không được hỗ trợ: ${action}`);
            }
        } catch (e) {
            this.log('LOCATOR', 'ERROR', `Lỗi thao tác trên phần tử ${selector}: ${e.message}`);
            throw e;
        }
    }

    /**
     * 🚀 QUY TRÌNH CHẠY BẢNG ĐIỀU KHIỂN AUTOMATION
     */
    async runAutomation(settings, steps) {
        this.isStopped = false;
        try {
            this.log('SYSTEM', 'START', `Đang khởi động tiến trình duyệt đến địa chỉ: ${settings.targetUrl}`);
            
            // A. Khởi chạy trình duyệt
            const launchArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ];
            
            this.browser = await puppeteer.launch({
                headless: false, // Để xem trực tiếp hành động
                executablePath: settings.chromePath || undefined,
                args: launchArgs
            });

            const pages = await this.browser.pages();
            this.page = pages[0] || await this.browser.newPage();

            // B. Khởi tạo các cấu phần
            await this.initCDPSession(this.page);
            await this.emulateNetwork(settings.networkSpeed);
            await this.emulateCPUThrottling(settings.cpuThrottling);
            await this.setupNetworkInterception(settings);
            await this.spoofEnvironment(settings);
            await this.injectPreloadScripts(settings.preloadJs);

            // C. Mở trang web mục tiêu
            this.log('SYSTEM', 'INFO', `Đang kết nối tải trang: ${settings.targetUrl}`);
            await this.page.goto(settings.targetUrl, { waitUntil: 'load', timeout: 45000 });
            this.log('SYSTEM', 'SUCCESS', 'Tải trang thành công.');

            // D. Chạy mã tiêm muộn (Post-load JS)
            await this.runPostloadScript(settings.postloadJs);

            // E. Thực thi chuỗi hành động cấu hình sẵn qua Locators
            if (steps && steps.length > 0) {
                this.log('SYSTEM', 'INFO', `Bắt đầu thực thi chuỗi ${steps.length} hành động tự động hóa...`);
                for (let idx = 0; idx < steps.length; idx++) {
                    if (this.isStopped) {
                        this.log('SYSTEM', 'INFO', 'Tiến trình tự động hóa đã bị dừng cưỡng chế.');
                        return;
                    }
                    const step = steps[idx];
                    this.log('SYSTEM', 'STEP', `[Hành động ${idx + 1}/${steps.length}]`);
                    
                    if (settings.humanClick && step.action === 'click') {
                        // Thử click chuột thật có di chuyển thay vì click qua DOM
                        await this.clickRealistic(step.selector);
                    } else if (settings.humanType && step.action === 'type') {
                        // Thử nhập liệu trễ ngẫu nhiên giống người thật
                        await this.typeHumanLike(step.selector, step.inputValue, parseInt(settings.minDelay), parseInt(settings.maxDelay));
                    } else {
                        // Mặc định chạy qua Smart Locators API tự động chờ
                        await this.executeStepWithLocator(step.action, step.selector, step.inputValue);
                    }
                    
                    // Nghỉ 1.5 giây giữa các thao tác
                    await this.sleep(1500);
                }
                this.log('SYSTEM', 'SUCCESS', 'Đã hoàn tất toàn bộ kịch bản tự động hóa.');
            } else {
                this.log('SYSTEM', 'INFO', 'Không có chuỗi kịch bản nào được lập trình.');
            }

        } catch (err) {
            this.log('SYSTEM', 'ERROR', `Lỗi nghiêm trọng trong quá trình chạy: ${err.message}`);
        }
    }

    async stop() {
        this.isStopped = true;
        this.log('SYSTEM', 'STOP', 'Đang thực hiện dừng cưỡng chế trình duyệt...');
        try {
            if (this.browser) {
                await this.browser.close();
            }
            this.browser = null;
            this.page = null;
            this.cdpSession = null;
            this.log('SYSTEM', 'STOP', 'Đã đóng và dọn dẹp trình duyệt thành công.');
        } catch (e) {
            this.log('SYSTEM', 'ERROR', `Gặp lỗi khi dừng trình duyệt: ${e.message}`);
        }
    }
}

module.exports = PuppeteerAutomationController;
