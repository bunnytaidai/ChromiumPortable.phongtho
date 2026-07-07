// Tránh tiêm lặp nhiều lần script trên cùng một trang
if (window.hasAntiProfileRecorder) {
    // Đã được tiêm trước đó, bỏ qua
} else {
    window.hasAntiProfileRecorder = true;
    initRecorder();
}

function initRecorder() {
    console.log("[Anti-Profile Recorder] Content script đã được khởi tạo.");

    let localRecordingState = "idle";
    let localRecordedSteps = [];
    let localActiveProfileId = null;
    let localInterceptionRules = { blockUrls: [], modifyRules: [] };

    async function safeFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                action: "proxy_http_request",
                url,
                options
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (response && response.success) {
                    resolve(response.data);
                } else {
                    reject(new Error(response ? response.error : "Unknown error"));
                }
            });
        });
    }

    // Tiêm script chặn mạng và console để bắt API & logs thời gian thực của web
    try {
        const interceptScript = document.createElement('script');
        interceptScript.textContent = `
            (function() {
                // Chặn Fetch
                const originalFetch = window.fetch;
                window.fetch = async function(...args) {
                    const url = args[0];
                    const options = args[1] || {};
                    const method = options.method || 'GET';
                    window.postMessage({
                        type: 'ANTI_NET_REQUEST',
                        url: typeof url === 'string' ? url : (url.url || String(url)),
                        method
                    }, '*');
                    return originalFetch.apply(this, args);
                };

                // Chặn XMLHttpRequest
                const originalSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.send = function(...args) {
                    this.addEventListener('load', function() {
                        window.postMessage({
                            type: 'ANTI_NET_REQUEST',
                            url: this.responseURL,
                            method: this._method || 'GET'
                        }, '*');
                    });
                    return originalSend.apply(this, args);
                };
                const originalOpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                    this._method = method;
                    return originalOpen.call(this, method, url, ...rest);
                };

                // Chặn Console
                const originalLog = console.log;
                console.log = function(...args) {
                    window.postMessage({
                        type: 'ANTI_CONSOLE_LOG',
                        logType: 'log',
                        message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
                    }, '*');
                    originalLog.apply(console, args);
                };
                const originalError = console.error;
                console.error = function(...args) {
                    window.postMessage({
                        type: 'ANTI_CONSOLE_LOG',
                        logType: 'error',
                        message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
                    }, '*');
                    originalError.apply(console, args);
                };
            })();
        `;
        document.documentElement.appendChild(interceptScript);
        interceptScript.remove();
    } catch (e) {
        console.error("Không thể tiêm Network/Console interceptor:", e);
    }

    // 1. Tự động ghi nhận chuyển trang khi load trang
    const currentUrl = window.location.href;
    if (currentUrl && !currentUrl.startsWith("chrome://") && !currentUrl.startsWith("about:")) {
        if (window === window.top) {
            chrome.runtime.sendMessage({
                action: "record_event",
                event: { action: "goto", target: "", value: currentUrl }
            }).catch(() => {});
        }
    }

    // 2. Lắng nghe sự kiện Click trên toàn trang
    document.addEventListener("click", (e) => {
        if (localRecordingState !== "recording") return;

        // Nếu click bên trong Widget Shadow DOM của chúng ta thì bỏ qua, không ghi nhận
        if (e.target.closest('#anti-recorder-widget-root') || (e.composedPath && e.composedPath().some(el => el.id === 'anti-recorder-widget-root'))) {
            return;
        }

        const target = e.target.closest("a, button, input, textarea, select, [role='button'], [onclick]");
        if (!target) return;
        
        const selector = getUniqueSelector(target);
        const tagName = target.tagName.toLowerCase();
        if (tagName === "input" && (target.type === "text" || target.type === "password" || target.type === "email" || target.type === "number")) {
            return;
        }
        if (tagName === "textarea") {
            return;
        }

        chrome.runtime.sendMessage({
            action: "record_event",
            event: { action: "click", target: selector, value: "" }
        }).catch(() => {});
    }, true);

    // 3. Lắng nghe sự kiện thay đổi dữ liệu (Change/Input) trên các form
    document.addEventListener("change", (e) => {
        if (localRecordingState !== "recording") return;

        if (e.target.closest('#anti-recorder-widget-root') || (e.composedPath && e.composedPath().some(el => el.id === 'anti-recorder-widget-root'))) {
            return;
        }

        const target = e.target;
        const tagName = target.tagName.toLowerCase();
        
        if (tagName === "input" || tagName === "textarea") {
            const selector = getUniqueSelector(target);
            const val = target.value;
            
            chrome.runtime.sendMessage({
                action: "record_event",
                event: { action: "type", target: selector, value: val }
            }).catch(() => {});
        }
    }, true);

    // --- KHU VỰC WIDGET NỔI SHADOW DOM TIÊN TIẾN ---
    let shadowRoot = null;
    let widgetContainer = null;
    let localActiveTab = "engines"; // engines, recorder, devtools, resources
    let recorderSubView = "gui"; // gui hoặc code_js
    let devtoolsSubView = "network"; // network hoặc console
    
    let mcpEngineStatus = { use_mcp: false, is_running: false, mcp_active: false, puppeteer_active: false, debug_port: 0, mcp_port: 0 };
    let resourceStats = { emails: 0, phones: 0, captcha_solved: 0, captcha_failed: 0, current_proxy: "Không dùng", last_proxy: "Không có dữ liệu cũ" };
    let interceptedRequests = [];
    let interceptedConsoleLogs = [];
    let generatedJsCode = "";
    
    let localStatusInterval = null;

    // Đăng ký thu nhận message postMessage từ webpage context
    window.addEventListener('message', (e) => {
        if (!e.data) return;
        
        if (e.data.type === 'ANTI_NET_REQUEST') {
            const req = {
                timestamp: new Date().toLocaleTimeString(),
                url: e.data.url,
                method: e.data.method
            };
            interceptedRequests.push(req);
            if (interceptedRequests.length > 50) interceptedRequests.shift();
            if (localActiveTab === 'devtools') {
                renderDevToolsLogs();
            }
        }
        
        if (e.data.type === 'ANTI_CONSOLE_LOG') {
            const log = {
                timestamp: new Date().toLocaleTimeString(),
                logType: e.data.logType,
                message: e.data.message
            };
            interceptedConsoleLogs.push(log);
            if (interceptedConsoleLogs.length > 50) interceptedConsoleLogs.shift();
            if (localActiveTab === 'devtools') {
                renderDevToolsLogs();
            }
        }
    });

    // Lấy trạng thái ghi hiện tại khi nạp trang
    chrome.runtime.sendMessage({ action: "get_recording_state" }, (response) => {
        if (response && response.success) {
            localRecordingState = response.recordingState;
            localRecordedSteps = response.recordedSteps || [];
            localActiveProfileId = response.activeProfileId;
            syncWidgetUI();
            startStatusPolling();
        }
    });

    // Lắng nghe thông điệp đồng bộ trạng thái từ background.js
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "sync_recording_state") {
            localRecordingState = message.recordingState;
            localRecordedSteps = message.recordedSteps || [];
            localActiveProfileId = message.activeProfileId;
            syncWidgetUI();
            startStatusPolling();
        }
    });

    function syncWidgetUI() {
        createWidgetIfNeeded();
        renderWidgetContent();
        updateJsCodePreview();
    }

    function startStatusPolling() {
        if (localStatusInterval) clearInterval(localStatusInterval);
        
        const fetchStatus = async () => {
            if (!localActiveProfileId) return;
            try {
                // Fetch mcp_status
                const s1 = await safeFetch(`http://127.0.0.1:5000/api/profiles/${localActiveProfileId}/mcp_status`);
                if (s1 && s1.success) {
                    mcpEngineStatus = s1;
                }
                
                // Fetch resources_stats
                const s2 = await safeFetch(`http://127.0.0.1:5000/api/profiles/${localActiveProfileId}/resources_stats`);
                if (s2 && s2.success) {
                    resourceStats = s2;
                }
                
                // Fetch network traffic cấp thấp từ CDP ở backend
                if (localActiveTab === 'devtools' && devtoolsSubView === 'network') {
                    const s3 = await safeFetch(`http://127.0.0.1:5000/api/profiles/${localActiveProfileId}/network_traffic`);
                    if (s3 && s3.success) {
                        interceptedRequests = s3.traffic || [];
                        renderDevToolsLogs();
                    }
                }
                
                updateLiveStatusElements();
            } catch (e) {
                // Im lặng khi mất kết nối backend tạm thời
            }
        };

        fetchStatus();
        localStatusInterval = setInterval(fetchStatus, 3000);
    }

    async function updateJsCodePreview() {
        chrome.runtime.sendMessage({ action: "get_js_code" }, (res) => {
            if (res && res.success) {
                generatedJsCode = res.codeJS;
                const txt = shadowRoot && shadowRoot.querySelector('#js-code-box');
                if (txt) txt.value = generatedJsCode;
            }
        });
    }

    function createWidgetIfNeeded() {
        if (document.getElementById('anti-recorder-widget-root')) return;

        // Tạo container chính cho Shadow DOM
        widgetContainer = document.createElement('div');
        widgetContainer.id = 'anti-recorder-widget-root';
        widgetContainer.style.position = 'fixed';
        widgetContainer.style.bottom = '20px';
        widgetContainer.style.right = '20px';
        widgetContainer.style.zIndex = '9999999';
        widgetContainer.style.fontFamily = "'Outfit', 'Segoe UI', sans-serif";
        document.body.appendChild(widgetContainer);

        shadowRoot = widgetContainer.attachShadow({ mode: 'open' });

        // Nạp font chữ Outfit vào Shadow DOM
        const linkFont = document.createElement('link');
        linkFont.rel = 'stylesheet';
        linkFont.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap';
        shadowRoot.appendChild(linkFont);

        // Nạp font FontAwesome để dùng icon
        const linkAwesome = document.createElement('link');
        linkAwesome.rel = 'stylesheet';
        linkAwesome.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
        shadowRoot.appendChild(linkAwesome);

        // CSS dành riêng cho Widget trong Shadow DOM
        const style = document.createElement('style');
        style.textContent = `
            :host {
                --bg-glass: rgba(11, 15, 25, 0.88);
                --bg-card: rgba(22, 28, 45, 0.95);
                --border-neon: rgba(99, 102, 241, 0.4);
                --text-main: #f3f4f6;
                --text-sub: #9ca3af;
                --neon-blue: #6366f1;
                --neon-pink: #ec4899;
                --neon-green: #10b981;
                --neon-orange: #f59e0b;
                --neon-red: #ef4444;
            }

            .widget-panel {
                width: 340px;
                height: 480px;
                background: var(--bg-glass);
                border: 1px solid var(--border-neon);
                border-radius: 16px;
                padding: 12px;
                color: var(--text-main);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 15px rgba(99, 102, 241, 0.25);
                backdrop-filter: blur(16px);
                user-select: none;
                display: flex;
                flex-direction: column;
                position: relative;
                box-sizing: border-box;
            }

            .widget-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                padding-bottom: 8px;
                margin-bottom: 8px;
                cursor: move;
                flex-shrink: 0;
            }

            .widget-title {
                font-weight: 700;
                font-size: 0.88rem;
                letter-spacing: 0.5px;
                background: linear-gradient(to right, #a5b4fc, #ec4899);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                display: flex;
                align-items: center;
                gap: 5px;
            }

            .status-badge {
                display: flex;
                align-items: center;
                gap: 5px;
                font-size: 0.65rem;
                font-weight: 600;
                background: rgba(255,255,255,0.05);
                padding: 3px 8px;
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.06);
            }

            .status-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background-color: var(--text-sub);
            }

            .status-dot.recording {
                background-color: var(--neon-green);
                box-shadow: 0 0 8px var(--neon-green);
                animation: pulse 1.5s infinite alternate;
            }

            .status-dot.paused {
                background-color: var(--neon-orange);
                box-shadow: 0 0 8px var(--neon-orange);
            }

            @keyframes pulse {
                from { opacity: 0.4; }
                to { opacity: 1; }
            }

            /* Tab bar */
            .tab-bar {
                display: flex;
                background: rgba(0,0,0,0.2);
                border: 1px solid rgba(255,255,255,0.05);
                border-radius: 8px;
                padding: 2px;
                margin-bottom: 10px;
                flex-shrink: 0;
            }

            .tab-btn {
                flex: 1;
                border: none;
                background: transparent;
                color: var(--text-sub);
                padding: 6px 0;
                font-size: 0.7rem;
                font-weight: 600;
                border-radius: 6px;
                cursor: pointer;
                text-align: center;
                transition: all 0.2s;
            }

            .tab-btn.active {
                background: rgba(99, 102, 241, 0.15);
                color: white;
                border: 1px solid rgba(99, 102, 241, 0.25);
            }

            /* Tab content area */
            .tab-content {
                flex: 1;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                box-sizing: border-box;
            }

            .tab-content::-webkit-scrollbar {
                width: 4px;
            }
            .tab-content::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.1);
                border-radius: 10px;
            }

            /* Controls & Buttons */
            .controls-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                margin-bottom: 10px;
                flex-shrink: 0;
            }

            .btn {
                border: none;
                border-radius: 6px;
                padding: 8px;
                font-family: inherit;
                font-size: 0.75rem;
                font-weight: 600;
                color: white;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                transition: all 0.2s;
            }

            .btn-start { background: linear-gradient(135deg, var(--neon-blue), #4f46e5); }
            .btn-start:hover { transform: translateY(-1px); }
            .btn-pause { background: var(--neon-orange); }
            .btn-pause:hover { background: #d97706; }
            .btn-resume { background: var(--neon-green); }
            .btn-resume:hover { background: #059669; }
            .btn-stop { background: var(--neon-red); }
            .btn-stop:hover { background: #dc2626; }
            
            .btn-wait {
                grid-column: span 2;
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.08);
            }
            .btn-wait:hover {
                background: rgba(255,255,255,0.12);
                border-color: var(--neon-blue);
            }

            /* Steps list */
            .steps-panel {
                flex: 1;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .sub-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
                font-size: 0.7rem;
                font-weight: 600;
                color: var(--text-sub);
                text-transform: uppercase;
            }

            .steps-container {
                flex: 1;
                overflow-y: auto;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.05);
                padding: 6px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .step-item {
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid rgba(255, 255, 255, 0.04);
                border-radius: 6px;
                padding: 6px 8px;
                font-size: 0.72rem;
                display: flex;
                align-items: center;
                justify-content: space-between;
                cursor: pointer;
                transition: all 0.2s;
            }
            .step-item:hover {
                border-color: var(--neon-blue);
                background: rgba(99, 102, 241, 0.08);
            }

            .step-info {
                display: flex;
                align-items: center;
                gap: 6px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                max-width: 220px;
            }

            .step-badge {
                padding: 1px 4px;
                border-radius: 4px;
                font-size: 0.58rem;
                font-weight: 700;
                text-transform: uppercase;
                background: var(--neon-blue);
            }
            
            .step-badge.goto { background: #3b82f6; }
            .step-badge.click { background: #8b5cf6; }
            .step-badge.type { background: #ec4899; }
            .step-badge.wait { background: #f59e0b; }

            .step-text {
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .step-edit-btn {
                background: none;
                border: none;
                color: var(--text-sub);
                cursor: pointer;
                font-size: 0.72rem;
            }
            .step-edit-btn:hover { color: white; }

            /* Step Editor Card styles */
            .step-editor-card {
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                padding: 8px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                box-sizing: border-box;
                transition: all 0.2s;
            }
            .step-editor-card:hover {
                border-color: rgba(99, 102, 241, 0.35);
                background: rgba(99, 102, 241, 0.04);
            }
            .step-ctrl-btn {
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.08);
                color: var(--text-sub);
                border-radius: 4px;
                cursor: pointer;
                padding: 3px 6px;
                font-size: 0.65rem;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
            }
            .step-ctrl-btn:hover {
                background: rgba(255,255,255,0.12);
                color: white;
            }
            .step-ctrl-btn.btn-insert:hover {
                background: rgba(16, 185, 129, 0.15);
                color: #34d399;
                border-color: rgba(16, 185, 129, 0.3);
            }
            .step-ctrl-btn.btn-delete:hover {
                background: rgba(239, 68, 68, 0.15);
                color: #f87171;
                border-color: rgba(239, 68, 68, 0.3);
            }

            /* Textarea Editor */
            .code-editor {
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.3);
                color: #fbbf24;
                font-family: monospace;
                font-size: 0.68rem;
                border: 1px solid rgba(255,255,255,0.06);
                border-radius: 6px;
                padding: 8px;
                resize: none;
                box-sizing: border-box;
                outline: none;
            }

            /* DevTools Traffic styling */
            .log-box {
                flex: 1;
                background: rgba(0,0,0,0.35);
                border: 1px solid rgba(255,255,255,0.06);
                border-radius: 6px;
                padding: 6px;
                font-family: monospace;
                font-size: 0.65rem;
                overflow-y: auto;
                line-height: 1.3;
            }

            .log-item {
                border-bottom: 1px solid rgba(255,255,255,0.02);
                padding: 3px 0;
                word-break: break-all;
            }
            .log-item.error { color: #f87171; }
            .log-item.warn { color: #fbbf24; }
            .log-item.net { color: #60a5fa; }

            /* Stats Asset Styling */
            .stats-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                margin-bottom: 10px;
            }

            .stat-card {
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.05);
                border-radius: 8px;
                padding: 8px;
                text-align: center;
            }

            .stat-val {
                font-size: 1.1rem;
                font-weight: 700;
                color: #818cf8;
                margin-bottom: 2px;
            }

            .stat-lbl {
                font-size: 0.65rem;
                color: var(--text-sub);
            }

            .proxy-box {
                background: rgba(0,0,0,0.25);
                border: 1px solid rgba(255,255,255,0.05);
                border-radius: 8px;
                padding: 8px;
                font-size: 0.72rem;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            /* Engine Configuration */
            .engine-card {
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(255,255,255,0.05);
                border-radius: 8px;
                padding: 8px;
                margin-bottom: 8px;
            }

            .engine-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 4px 0;
            }

            /* Toggle Switch */
            .switch {
                position: relative;
                display: inline-block;
                width: 34px;
                height: 18px;
            }

            .switch input { opacity: 0; width: 0; height: 0; }

            .slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: #374151;
                transition: .2s;
                border-radius: 18px;
            }

            .slider:before {
                position: absolute;
                content: "";
                height: 12px;
                width: 12px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: .2s;
                border-radius: 50%;
            }

            input:checked + .slider { background-color: var(--neon-blue); }
            input:checked + .slider:before { transform: translateX(16px); }
            input:disabled + .slider { opacity: 0.3; cursor: not-allowed; }

            /* Resize handle */
            .resize-handle {
                position: absolute;
                bottom: 0;
                right: 0;
                width: 12px;
                height: 12px;
                cursor: se-resize;
                background: linear-gradient(135deg, transparent 40%, var(--neon-blue) 40%, transparent 60%, var(--neon-blue) 60%);
                border-bottom-right-radius: 16px;
                z-index: 10;
            }

            /* CSS cho Modal Cài đặt đè trực tiếp lên panel */
            .settings-modal {
                position: absolute;
                top: 0; left: 0;
                width: 100%; height: 100%;
                background: var(--bg-card);
                border-radius: 16px;
                padding: 14px;
                box-sizing: border-box;
                display: none;
                flex-direction: column;
                gap: 10px;
                z-index: 100;
                overflow-y: auto;
            }

            .modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                padding-bottom: 6px;
                font-weight: 700;
                font-size: 0.85rem;
                color: #a5b4fc;
                flex-shrink: 0;
            }

            .form-row {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .form-row label {
                font-size: 0.68rem;
                color: var(--text-sub);
                font-weight: 500;
            }

            .form-input, .form-select {
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 6px;
                color: var(--text-main);
                padding: 6px 8px;
                font-size: 0.75rem;
                font-family: inherit;
                outline: none;
            }
            .form-input:focus, .form-select:focus {
                border-color: var(--neon-blue);
            }

            .api-toggle-container {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 0.7rem;
                color: var(--text-sub);
                cursor: pointer;
                margin-top: 4px;
            }

            .api-panel {
                background: rgba(0, 0, 0, 0.2);
                border: 1px dashed rgba(255, 255, 255, 0.06);
                border-radius: 8px;
                padding: 8px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .modal-actions {
                display: grid;
                grid-template-columns: 1fr 1fr 1fr;
                gap: 6px;
                margin-top: auto;
                padding-top: 10px;
                flex-shrink: 0;
            }

            .btn-save { background: var(--neon-blue); }
            .btn-save:hover { background: #4f46e5; }
            .btn-delete { background: var(--neon-red); }
            .btn-delete:hover { background: #dc2626; }
            .btn-close { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); }
            .btn-close:hover { background: rgba(255,255,255,0.12); }
        `;
        shadowRoot.appendChild(style);

        // Tạo div chứa Widget Panel co giãn
        const panel = document.createElement('div');
        panel.className = 'widget-panel';
        shadowRoot.appendChild(panel);

        // Nạp tọa độ và kích thước đã lưu
        chrome.storage.local.get(["widget_left", "widget_top", "widget_width", "widget_height"], (res) => {
            if (res.widget_left !== undefined && res.widget_top !== undefined) {
                widgetContainer.style.left = res.widget_left + 'px';
                widgetContainer.style.top = res.widget_top + 'px';
                widgetContainer.style.bottom = 'auto';
                widgetContainer.style.right = 'auto';
            }
            if (res.widget_width !== undefined && res.widget_height !== undefined) {
                panel.style.width = res.widget_width + 'px';
                panel.style.height = res.widget_height + 'px';
            }
        });

        // 1. KÉO THẢ (DRAG & DROP) WIDGET
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const header = document.createElement('div');
        header.className = 'widget-header';
        panel.appendChild(header);

        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button') || e.target.closest('input')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = widgetContainer.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            widgetContainer.style.left = (initialLeft + dx) + 'px';
            widgetContainer.style.top = (initialTop + dy) + 'px';
            widgetContainer.style.bottom = 'auto';
            widgetContainer.style.right = 'auto';
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                const rect = widgetContainer.getBoundingClientRect();
                chrome.storage.local.set({
                    widget_left: rect.left,
                    widget_top: rect.top
                });
            }
        });

        // 2. CO GIÃN KÍCH THƯỚC (RESIZE) WIDGET
        let isResizing = false;
        let startWidth, startHeight, startMouseX, startMouseY;

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle';
        panel.appendChild(resizeHandle);

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startMouseX = e.clientX;
            startMouseY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            e.preventDefault();
            e.stopPropagation();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startMouseX;
            const dy = e.clientY - startMouseY;
            const w = Math.max(300, startWidth + dx);
            const h = Math.max(400, startHeight + dy);
            panel.style.width = w + 'px';
            panel.style.height = h + 'px';
        });

        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                const rect = panel.getBoundingClientRect();
                chrome.storage.local.set({
                    widget_width: rect.width,
                    widget_height: rect.height
                });
            }
        });

        // Tab bar container
        const tabBar = document.createElement('div');
        tabBar.className = 'tab-bar';
        panel.appendChild(tabBar);

        // Content Area
        const contentArea = document.createElement('div');
        contentArea.className = 'tab-content';
        panel.appendChild(contentArea);

        // Settings Modal đè bên trong Shadow DOM
        const modal = document.createElement('div');
        modal.className = 'settings-modal';
        panel.appendChild(modal);
    }

    function renderWidgetContent() {
        if (!shadowRoot) return;
        const panel = shadowRoot.querySelector('.widget-panel');
        if (!panel) return;

        // Render Header
        const header = shadowRoot.querySelector('.widget-header');
        header.innerHTML = `
            <div class="widget-title">
                <i class="fa-solid fa-wand-magic-sparkles"></i> Anti-Recorder Pro
            </div>
            <div class="status-badge">
                <span class="status-dot ${localRecordingState}"></span>
                <span style="font-size:0.6rem; font-weight:bold;">${localRecordingState === 'recording' ? 'ĐANG GHI' : (localRecordingState === 'paused' ? 'TẠM DỪNG' : 'CHỜ LỆNH')}</span>
            </div>
        `;

        // Render Tab bar
        const tabBar = shadowRoot.querySelector('.tab-bar');
        tabBar.innerHTML = `
            <button class="tab-btn ${localActiveTab === 'engines' ? 'active' : ''}" data-tab="engines"><i class="fa-solid fa-gears"></i> Máy</button>
            <button class="tab-btn ${localActiveTab === 'recorder' ? 'active' : ''}" data-tab="recorder"><i class="fa-solid fa-circle-play"></i> Ghi</button>
            <button class="tab-btn ${localActiveTab === 'devtools' ? 'active' : ''}" data-tab="devtools"><i class="fa-solid fa-terminal"></i> Web</button>
            <button class="tab-btn ${localActiveTab === 'resources' ? 'active' : ''}" data-tab="resources"><i class="fa-solid fa-cube"></i> Kho</button>
        `;

        // Gắn sự kiện tab
        tabBar.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                localActiveTab = btn.getAttribute('data-tab');
                renderWidgetContent();
                if (localActiveTab === 'recorder') {
                    updateJsCodePreview();
                }
            });
        });

        // Render Content Area
        const contentArea = shadowRoot.querySelector('.tab-content');
        contentArea.innerHTML = "";

        if (localActiveTab === "engines") {
            renderEnginesTab(contentArea);
        } else if (localActiveTab === "recorder") {
            renderRecorderTab(contentArea);
        } else if (localActiveTab === "devtools") {
            renderDevToolsTab(contentArea);
        } else if (localActiveTab === "resources") {
            renderResourcesTab(contentArea);
        }
    }

    function renderEnginesTab(container) {
        container.innerHTML = `
            <div class="engine-card">
                <div style="font-size: 0.72rem; font-weight: bold; color: #a5b4fc; margin-bottom: 6px;">HỒ SƠ HIỆN TẠI</div>
                <div style="font-size: 0.8rem; background: rgba(255,255,255,0.03); padding: 6px 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);">
                    Profile ID: <span style="font-weight:bold; color:var(--neon-blue);">${localActiveProfileId || 'Đang nhận dạng...'}</span>
                </div>
            </div>

            <div class="engine-card">
                <div style="font-size: 0.72rem; font-weight: bold; color: #a5b4fc; margin-bottom: 6px;">ĐỘNG CƠ ĐIỀU KHIỂN</div>
                
                <div class="engine-row">
                    <div style="display:flex; flex-direction:column; gap:2px;">
                        <span style="font-size:0.75rem; font-weight:600;"><i class="fa-solid fa-network-wired" style="color:var(--neon-blue); margin-right:4px;"></i> MCP Server</span>
                        <span style="font-size:0.6rem; color:var(--text-sub);" id="mcp-desc-status">Tắt</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="mcp-toggle-widget" ${mcpEngineStatus.use_mcp ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                
                <div class="engine-row" style="margin-top: 8px; border-top: 1px dashed rgba(255,255,255,0.04); padding-top: 8px;">
                    <div style="display:flex; flex-direction:column; gap:2px;">
                        <span style="font-size:0.75rem; font-weight:600;"><i class="fa-solid fa-robot" style="color:var(--neon-pink); margin-right:4px;"></i> Puppeteer Engine</span>
                        <span style="font-size:0.6rem; color:var(--text-sub);" id="puppeteer-desc-status">Chờ kết nối...</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="puppeteer-toggle-widget" ${mcpEngineStatus.puppeteer_active ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>

            <div class="engine-card" id="widget-mcp-info-panel" style="display: ${mcpEngineStatus.is_running ? 'block' : 'none'};">
                <div style="font-size: 0.72rem; font-weight: bold; color: #a5b4fc; margin-bottom: 6px;">KẾT NỐI DEBUG CDP</div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; font-size:0.68rem;">
                    <div style="background:rgba(0,0,0,0.2); padding:4px; border-radius:4px; border:1px solid rgba(255,255,255,0.03);">
                        <span style="color:var(--text-sub);">Debug Port:</span> <span style="font-weight:bold; color:var(--neon-green);">${mcpEngineStatus.debug_port}</span>
                    </div>
                    <div style="background:rgba(0,0,0,0.2); padding:4px; border-radius:4px; border:1px solid rgba(255,255,255,0.03);">
                        <span style="color:var(--text-sub);">MCP Port:</span> <span style="font-weight:bold; color:var(--neon-blue);">${mcpEngineStatus.mcp_port}</span>
                    </div>
                </div>
            </div>
        `;

        updateLiveStatusElements();

        const chkMcp = shadowRoot.querySelector('#mcp-toggle-widget');
        chkMcp.addEventListener('change', async (e) => {
            if (!localActiveProfileId) return;
            const enable = e.target.checked;
            try {
                const data = await safeFetch(`http://127.0.0.1:5000/api/profiles/${localActiveProfileId}/toggle_mcp`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ enable })
                });
                if (data && !data.success) {
                    alert("Lỗi cấu hình MCP: " + data.error);
                    chkMcp.checked = !enable;
                }
            } catch (err) {
                chkMcp.checked = !enable;
            }
        });

        const chkPuppeteer = shadowRoot.querySelector('#puppeteer-toggle-widget');
        chkPuppeteer.addEventListener('change', async (e) => {
            if (!localActiveProfileId) return;
            const enable = e.target.checked;
            try {
                const data = await safeFetch(`http://127.0.0.1:5000/api/profiles/${localActiveProfileId}/toggle_puppeteer`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ enable })
                });
                if (data && !data.success) {
                    alert("Lỗi cấu hình Puppeteer: " + data.error);
                    chkPuppeteer.checked = !enable;
                }
            } catch (err) {
                chkPuppeteer.checked = !enable;
            }
        });
    }    function getStepInputsHtml(step, idx) {
        const action = step.action || "goto";
        const target = step.target || "";
        const value = step.value || "";
        const variable = step.var || step.variable || "mail_1";
        const service = step.service || "autocaptcha";
        
        let html = "";
        
        // 1. Selector target input
        const showTargetInput = !['goto', 'wait', 'press', 'click_xy', 'click_right_xy', 'fill_register', 'create_mail', 'rent_phone', 'rotate_proxy', 'check_proxy', 'rotate_proxy_if_die', 'rotate_proxy_every_n_runs', 'get_old_ip', 'delete_mail', 'cancel_phone', 'type_phone', 'get_phone_code', 'type_mail', 'get_mail_code', 'solve_captcha'].includes(action);
        if (showTargetInput) {
            html += `<input type="text" class="step-target-input" data-index="${idx}" placeholder="CSS Selector" value="${target}" style="flex: 1; min-width: 100px; padding: 4px; font-size: 0.72rem; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35); color: white; outline: none; box-sizing: border-box;">`;
        }
        
        // 2. Select variable (for mail, phone, captcha)
        const showVarSelect = ['create_mail', 'type_mail', 'get_mail_code', 'delete_mail', 'rent_phone', 'type_phone', 'get_phone_code', 'cancel_phone', 'solve_captcha'].includes(action);
        if (showVarSelect) {
            const isMail = ['create_mail', 'type_mail', 'get_mail_code', 'delete_mail'].includes(action);
            const isPhone = ['rent_phone', 'type_phone', 'get_phone_code', 'cancel_phone'].includes(action);
            const isCaptcha = ['solve_captcha'].includes(action);
            
            let varOptions = "";
            if (isMail) {
                varOptions = `
                    <option value="mail_1" ${variable === 'mail_1' ? 'selected' : ''}>mail_1</option>
                    <option value="mail_2" ${variable === 'mail_2' ? 'selected' : ''}>mail_2</option>
                    <option value="mail_3" ${variable === 'mail_3' ? 'selected' : ''}>mail_3</option>
                `;
            } else if (isPhone) {
                varOptions = `
                    <option value="phone_1" ${variable === 'phone_1' ? 'selected' : ''}>phone_1</option>
                    <option value="phone_2" ${variable === 'phone_2' ? 'selected' : ''}>phone_2</option>
                    <option value="phone_3" ${variable === 'phone_3' ? 'selected' : ''}>phone_3</option>
                `;
            } else if (isCaptcha) {
                varOptions = `
                    <option value="captcha_1" ${variable === 'captcha_1' ? 'selected' : ''}>captcha_1</option>
                    <option value="captcha_2" ${variable === 'captcha_2' ? 'selected' : ''}>captcha_2</option>
                `;
            }
            
            html += `
                <select class="step-var-select" data-index="${idx}" style="padding: 4px; font-size: 0.72rem; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35); color: white; width: 75px; outline: none; box-sizing: border-box;">
                    ${varOptions}
                </select>
            `;
        }

        // 3. Select phone service (for rent_phone)
        if (action === 'rent_phone') {
            html += `
                <select class="step-phone-service-select" data-index="${idx}" style="padding: 4px; font-size: 0.72rem; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35); color: white; flex: 1; min-width: 80px; outline: none; box-sizing: border-box;">
                    <option value="facebook" ${target === 'facebook' ? 'selected' : ''}>Facebook</option>
                    <option value="google" ${target === 'google' ? 'selected' : ''}>Google/Gmail</option>
                    <option value="telegram" ${target === 'telegram' ? 'selected' : ''}>Telegram</option>
                    <option value="twitter" ${target === 'twitter' ? 'selected' : ''}>Twitter/X</option>
                    <option value="microsoft" ${target === 'microsoft' ? 'selected' : ''}>Hotmail/Outlook</option>
                    <option value="shopee" ${target === 'shopee' ? 'selected' : ''}>Shopee</option>
                    <option value="tiktok" ${target === 'tiktok' ? 'selected' : ''}>Tiktok</option>
                    <option value="amazon" ${target === 'amazon' ? 'selected' : ''}>Amazon</option>
                </select>
                
                <select class="step-phone-country-select" data-index="${idx}" style="padding: 4px; font-size: 0.72rem; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35); color: white; width: 95px; outline: none; box-sizing: border-box;">
                    <option value="VN" ${value === 'VN' || value === '84' ? 'selected' : ''}>Việt Nam</option>
                    <option value="US" ${value === 'US' || value === '1' ? 'selected' : ''}>Mỹ</option>
                    <option value="GB" ${value === 'GB' || value === '44' ? 'selected' : ''}>Anh</option>
                    <option value="CA" ${value === 'CA' ? 'selected' : ''}>Canada</option>
                </select>
            `;
        }

        // 4. Select captcha service (for solve_captcha)
        if (action === 'solve_captcha') {
            html += `
                <select class="step-captcha-service-select" data-index="${idx}" style="padding: 4px; font-size: 0.72rem; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35); color: white; flex: 1; min-width: 100px; outline: none; box-sizing: border-box;">
                    <option value="autocaptcha" ${service === 'autocaptcha' ? 'selected' : ''}>AutoCaptcha.pro</option>
                    <option value="anticaptcha" ${service === 'anticaptcha' ? 'selected' : ''}>AntiCaptcha.top</option>
                    <option value="1stcaptcha" ${service === '1stcaptcha' ? 'selected' : ''}>1stCaptcha</option>
                    <option value="2captcha" ${service === '2captcha' ? 'selected' : ''}>2Captcha</option>
                </select>
            `;
        }

        // 5. Value input
        const showValueInput = !['rent_phone', 'type_phone', 'get_phone_code', 'type_mail', 'get_mail_code', 'solve_captcha', 'check_proxy', 'delete_mail', 'cancel_phone'].includes(action);
        if (showValueInput) {
            let placeholder = "Giá trị / Tham số";
            if (action === 'goto') placeholder = "URL (Ví dụ: https://...)";
            else if (action === 'wait') placeholder = "Mili giây (Ví dụ: 2000)";
            else if (action === 'press') placeholder = "Phím (Ví dụ: Enter)";
            else if (action === 'scroll') placeholder = "Pixel (Ví dụ: 500)";
            else if (action === 'click_xy' || action === 'click_right_xy') placeholder = "Tọa độ X,Y";
            
            html += `<input type="text" class="step-value-input" data-index="${idx}" placeholder="${placeholder}" value="${value}" style="flex: 1.2; min-width: 100px; padding: 4px; font-size: 0.72rem; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35); color: white; outline: none; box-sizing: border-box;">`;
        }

        return html;
    }

    function syncStepsToBackground() {
        chrome.runtime.sendMessage({
            action: "update_steps",
            steps: localRecordedSteps
        }, () => {
            renderWidgetContent();
            updateJsCodePreview();
        });
    }

    function renderRecorderTab(container) {
        const isRecording = localRecordingState === "recording";
        const isPaused = localRecordingState === "paused";
        const isIdle = localRecordingState === "idle";

        container.innerHTML = `
            <div class="controls-grid">
                ${isIdle ? `
                    <button class="btn btn-start" id="anti-widget-start-btn" style="grid-column: span 2;">
                        <i class="fa-solid fa-circle-play"></i> Bắt đầu ghi hình
                    </button>
                ` : `
                    <button class="btn ${isRecording ? 'btn-pause' : 'btn-resume'}" id="anti-widget-pause-btn">
                        <i class="fa-solid ${isRecording ? 'fa-pause' : 'fa-play'}"></i>
                        ${isRecording ? 'Tạm dừng' : 'Tiếp tục'}
                    </button>
                    <button class="btn btn-stop" id="anti-widget-stop-btn">
                        <i class="fa-solid fa-circle-check"></i> Hoàn tất
                    </button>
                `}
                <button class="btn btn-wait" id="anti-widget-add-wait-btn">
                    <i class="fa-solid fa-clock"></i> Chèn bước Đợi (Wait)
                </button>
            </div>

            <div class="steps-panel">
                <div class="sub-header">
                    <span>${recorderSubView === 'gui' ? 'Hành động trực quan' : 'Mã JS Puppeteer'}</span>
                    <div style="display:flex; gap:4px;">
                        <button class="step-edit-btn" id="btn-view-gui" style="font-size:0.65rem; color:${recorderSubView === 'gui' ? 'white' : 'var(--text-sub)'}">[GUI]</button>
                        <button class="step-edit-btn" id="btn-view-code" style="font-size:0.65rem; color:${recorderSubView === 'code_js' ? 'white' : 'var(--text-sub)'}">[CODE JS]</button>
                    </div>
                </div>

                <div style="flex:1; overflow-y:auto; display:flex; flex-direction:column; box-sizing:border-box;">
                    ${recorderSubView === 'gui' ? `
                        <div class="steps-container" style="flex:1; overflow-y:auto; background: rgba(0, 0, 0, 0.2); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05); padding: 6px; display: flex; flex-direction: column; gap: 6px;">
                            ${localRecordedSteps.length === 0 ? 
                                `<div style="text-align: center; color: var(--text-sub); font-size: 0.68rem; padding: 25px 0;">Chưa có bước hành động nào. Hãy ghi hình hoặc bấm thêm phía dưới!</div>` :
                                localRecordedSteps.map((step, idx) => {
                                    const action = step.action || "goto";
                                    return `
                                    <div class="step-editor-card" data-index="${idx}">
                                        <!-- Row 1: Header & Control Buttons -->
                                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: nowrap; width: 100%; box-sizing: border-box;">
                                            <div style="display: flex; align-items: center; gap: 4px; flex-grow: 1; min-width: 0;">
                                                <span style="font-size: 0.65rem; font-weight: 700; color: #a5b4fc; background: rgba(129, 140, 248, 0.15); border: 1px solid rgba(129, 140, 248, 0.3); border-radius: 4px; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">${idx + 1}</span>
                                                <select class="step-action-select" data-index="${idx}" style="flex-grow: 1; min-width: 0; padding: 3px; font-size: 0.7rem; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: white; outline: none; box-sizing: border-box;">
                                                    <optgroup label="Tương tác cơ bản">
                                                        <option value="goto" ${action === 'goto' ? 'selected' : ''}>Mở URL (goto)</option>
                                                        <option value="click" ${action === 'click' ? 'selected' : ''}>Click trái (click)</option>
                                                        <option value="click_right" ${action === 'click_right' ? 'selected' : ''}>Click phải (click_right)</option>
                                                        <option value="click_xy" ${action === 'click_xy' ? 'selected' : ''}>Click tọa độ trái (click_xy)</option>
                                                        <option value="click_right_xy" ${action === 'click_right_xy' ? 'selected' : ''}>Click tọa độ phải (click_right_xy)</option>
                                                        <option value="hover" ${action === 'hover' ? 'selected' : ''}>Di chuột (hover)</option>
                                                        <option value="type" ${action === 'type' ? 'selected' : ''}>Gõ chữ (type)</option>
                                                        <option value="press" ${action === 'press' ? 'selected' : ''}>Nhấn Phím (press)</option>
                                                        <option value="scroll" ${action === 'scroll' ? 'selected' : ''}>Cuộn trang (scroll)</option>
                                                        <option value="wait" ${action === 'wait' ? 'selected' : ''}>Đợi mili giây (wait)</option>
                                                        <option value="fill_register" ${action === 'fill_register' ? 'selected' : ''}>Đăng ký thông minh (fill_register)</option>
                                                    </optgroup>
                                                    <optgroup label="Nhóm API Mail">
                                                        <option value="create_mail" ${action === 'create_mail' ? 'selected' : ''}>Tạo email (create_mail)</option>
                                                        <option value="type_mail" ${action === 'type_mail' ? 'selected' : ''}>Gõ email ảo (type_mail)</option>
                                                        <option value="get_mail_code" ${action === 'get_mail_code' ? 'selected' : ''}>Lấy OTP email (get_mail_code)</option>
                                                        <option value="delete_mail" ${action === 'delete_mail' ? 'selected' : ''}>Xóa email (delete_mail)</option>
                                                    </optgroup>
                                                    <optgroup label="Nhóm API Thuê Phone">
                                                        <option value="rent_phone" ${action === 'rent_phone' ? 'selected' : ''}>Thuê số điện thoại (rent_phone)</option>
                                                        <option value="type_phone" ${action === 'type_phone' ? 'selected' : ''}>Gõ số điện thoại (type_phone)</option>
                                                        <option value="get_phone_code" ${action === 'get_phone_code' ? 'selected' : ''}>Lấy OTP điện thoại (get_phone_code)</option>
                                                        <option value="cancel_phone" ${action === 'cancel_phone' ? 'selected' : ''}>Hủy số điện thoại (cancel_phone)</option>
                                                    </optgroup>
                                                    <optgroup label="Nhóm API Vượt Captcha">
                                                        <option value="solve_captcha" ${action === 'solve_captcha' ? 'selected' : ''}>Giải ảnh Captcha (solve_captcha)</option>
                                                    </optgroup>
                                                    <optgroup label="Nhóm API Proxy">
                                                        <option value="rotate_proxy" ${action === 'rotate_proxy' ? 'selected' : ''}>Xoay Proxy (rotate_proxy)</option>
                                                        <option value="check_proxy" ${action === 'check_proxy' ? 'selected' : ''}>Kiểm tra Proxy (check_proxy)</option>
                                                    </optgroup>
                                                </select>
                                            </div>
                                            <div style="display: flex; gap: 3px; flex-shrink: 0; flex-wrap: nowrap;">
                                                <button class="step-ctrl-btn btn-up" data-index="${idx}" title="Di chuyển lên" style="padding: 2px 4px; font-size: 0.6rem;"><i class="fa-solid fa-arrow-up"></i></button>
                                                <button class="step-ctrl-btn btn-down" data-index="${idx}" title="Di chuyển xuống" style="padding: 2px 4px; font-size: 0.6rem;"><i class="fa-solid fa-arrow-down"></i></button>
                                                <button class="step-ctrl-btn btn-insert" data-index="${idx}" title="Chèn hành động dưới" style="padding: 2px 4px; font-size: 0.6rem;"><i class="fa-solid fa-plus"></i></button>
                                                <button class="step-ctrl-btn btn-delete" data-index="${idx}" title="Xóa hành động" style="padding: 2px 4px; font-size: 0.6rem;"><i class="fa-solid fa-trash"></i></button>
                                            </div>
                                        </div>

                                        <!-- Row 2: Dynamic Input parameters -->
                                        <div style="display: flex; gap: 4px; width: 100%; box-sizing: border-box; flex-wrap: nowrap; align-items: center;">
                                            ${getStepInputsHtml(step, idx)}
                                        </div>
                                    </div>
                                    `;
                                }).join('')
                            }
                        </div>
                        <button class="btn btn-add-step" id="btn-add-action-end" style="width: 100%; margin-top: 6px; font-size: 0.7rem; padding: 5px; background: rgba(99, 102, 241, 0.12); border: 1px dashed rgba(99, 102, 241, 0.35); color: #cbd5e1; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; border-radius: 6px; flex-shrink: 0;">
                            <i class="fa-solid fa-circle-plus"></i> + Thêm hành động mới
                        </button>
                    ` : `
                        <textarea class="code-editor" id="js-code-box" readonly placeholder="// Mã JS Puppeteer sẽ sinh ra tự động tại đây...">${generatedJsCode}</textarea>
                    `}
                </div>
            </div>
        `;

        shadowRoot.querySelector('#btn-view-gui').addEventListener('click', () => {
            recorderSubView = 'gui';
            renderWidgetContent();
        });
        shadowRoot.querySelector('#btn-view-code').addEventListener('click', () => {
            recorderSubView = 'code_js';
            renderWidgetContent();
            updateJsCodePreview();
        });

        const btnStart = shadowRoot.querySelector('#anti-widget-start-btn');
        if (btnStart) {
            btnStart.addEventListener('click', () => {
                if (!localActiveProfileId) {
                    alert("Vui lòng mở Profile từ Bảng điều khiển trước khi ghi hình!");
                    return;
                }
                chrome.runtime.sendMessage({ action: "start_recording", profileId: localActiveProfileId }, () => {
                    localRecordingState = "recording";
                    localRecordedSteps = [];
                    renderWidgetContent();
                });
            });
        }

        const btnPause = shadowRoot.querySelector('#anti-widget-pause-btn');
        if (btnPause) {
            btnPause.addEventListener('click', () => {
                const action = localRecordingState === 'recording' ? 'pause_recording' : 'resume_recording';
                chrome.runtime.sendMessage({ action: action }, () => {
                    localRecordingState = isRecording ? "paused" : "recording";
                    renderWidgetContent();
                });
            });
        }

        const btnStop = shadowRoot.querySelector('#anti-widget-stop-btn');
        if (btnStop) {
            btnStop.addEventListener('click', () => {
                const scriptName = prompt("Nhập tên kịch bản muốn lưu:", "Kịch bản ghi hình " + new Date().toLocaleDateString());
                if (!scriptName) return;

                chrome.runtime.sendMessage({ action: "stop_recording" }, async (response) => {
                    if (response && response.success) {
                        try {
                            const saveData = await safeFetch("http://127.0.0.1:5000/api/scripts", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    name: scriptName,
                                    steps: response.codeJS
                                })
                            });
                            if (saveData.success) {
                                alert(`Đã lưu kịch bản '${scriptName}' thành công!`);
                            } else {
                                alert(`Lỗi lưu kịch bản: ${saveData.error}`);
                            }
                        } catch (err) {
                            alert(`Lỗi kết nối máy chủ: ${err.message}`);
                        }
                    }
                    localRecordingState = "idle";
                    localRecordedSteps = [];
                    renderWidgetContent();
                });
            });
        }

        const btnAddWait = shadowRoot.querySelector('#anti-widget-add-wait-btn');
        if (btnAddWait) {
            btnAddWait.addEventListener('click', () => {
                const waitMs = prompt("Nhập số mili giây cần đợi:", "2000");
                if (!waitMs) return;
                chrome.runtime.sendMessage({
                    action: "record_event",
                    event: { action: "wait", target: "", value: waitMs }
                }, () => {
                    renderWidgetContent();
                });
            });
        }

        // Đăng ký các sự kiện inline sửa đổi dữ liệu (chỉ áp dụng cho chế độ xem trực quan)
        if (recorderSubView === 'gui') {
            // 1. Gắn sự kiện thay đổi select hành động (step-action-select)
            shadowRoot.querySelectorAll('.step-action-select').forEach(select => {
                select.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    const step = localRecordedSteps[idx];
                    if (step) {
                        step.action = e.target.value;
                        // Reset or initialize fields to avoid errors
                        if (['create_mail', 'type_mail', 'get_mail_code', 'delete_mail', 'rent_phone', 'type_phone', 'get_phone_code', 'cancel_phone', 'solve_captcha'].includes(step.action)) {
                            step.variable = step.variable || "mail_1";
                            step.var = step.var || "mail_1";
                        }
                        if (step.action === 'rent_phone') {
                            step.target = step.target || "facebook";
                            step.value = step.value || "VN";
                        }
                        if (step.action === 'solve_captcha') {
                            step.service = step.service || "autocaptcha";
                        }
                        syncStepsToBackground();
                    }
                });
            });

            // 2. Gắn sự kiện thay đổi input Selector/Target
            shadowRoot.querySelectorAll('.step-target-input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    const step = localRecordedSteps[idx];
                    if (step) {
                        step.target = e.target.value;
                        syncStepsToBackground();
                    }
                });
            });

            // 3. Gắn sự kiện thay đổi input Value
            shadowRoot.querySelectorAll('.step-value-input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    const step = localRecordedSteps[idx];
                    if (step) {
                        step.value = e.target.value;
                        syncStepsToBackground();
                    }
                });
            });

            // 4. Gắn sự kiện thay đổi select Biến (step-var-select)
            shadowRoot.querySelectorAll('.step-var-select').forEach(select => {
                select.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    const step = localRecordedSteps[idx];
                    if (step) {
                        step.variable = e.target.value;
                        step.var = e.target.value;
                        syncStepsToBackground();
                    }
                });
            });

            // 5. Gắn sự kiện thay đổi select Dịch vụ thuê Sim (step-phone-service-select)
            shadowRoot.querySelectorAll('.step-phone-service-select').forEach(select => {
                select.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    const step = localRecordedSteps[idx];
                    if (step) {
                        step.target = e.target.value;
                        syncStepsToBackground();
                    }
                });
            });

            // 6. Gắn sự kiện thay đổi select Quốc gia Sim (step-phone-country-select)
            shadowRoot.querySelectorAll('.step-phone-country-select').forEach(select => {
                select.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    const step = localRecordedSteps[idx];
                    if (step) {
                        step.value = e.target.value;
                        syncStepsToBackground();
                    }
                });
            });

            // 7. Gắn sự kiện thay đổi select Dịch vụ Captcha (step-captcha-service-select)
            shadowRoot.querySelectorAll('.step-captcha-service-select').forEach(select => {
                select.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    const step = localRecordedSteps[idx];
                    if (step) {
                        step.service = e.target.value;
                        syncStepsToBackground();
                    }
                });
            });

            // 8. Gắn sự kiện di chuyển Up (↑)
            shadowRoot.querySelectorAll('.step-ctrl-btn.btn-up').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-index'));
                    if (idx > 0) {
                        const temp = localRecordedSteps[idx];
                        localRecordedSteps[idx] = localRecordedSteps[idx - 1];
                        localRecordedSteps[idx - 1] = temp;
                        syncStepsToBackground();
                    }
                });
            });

            // 9. Gắn sự kiện di chuyển Down (↓)
            shadowRoot.querySelectorAll('.step-ctrl-btn.btn-down').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-index'));
                    if (idx < localRecordedSteps.length - 1) {
                        const temp = localRecordedSteps[idx];
                        localRecordedSteps[idx] = localRecordedSteps[idx + 1];
                        localRecordedSteps[idx + 1] = temp;
                        syncStepsToBackground();
                    }
                });
            });

            // 10. Gắn sự kiện chèn bước phía dưới (+)
            shadowRoot.querySelectorAll('.step-ctrl-btn.btn-insert').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-index'));
                    const newStep = { action: "goto", target: "", value: "" };
                    localRecordedSteps.splice(idx + 1, 0, newStep);
                    syncStepsToBackground();
                });
            });

            // 11. Gắn sự kiện xóa bước (trash)
            shadowRoot.querySelectorAll('.step-ctrl-btn.btn-delete').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-index'));
                    if (confirm(`Bạn có chắc muốn xóa hành động bước ${idx + 1}?`)) {
                        localRecordedSteps.splice(idx, 1);
                        syncStepsToBackground();
                    }
                });
            });

            // 12. Nút thêm hành động mới ở cuối danh sách
            const btnAddActionEnd = shadowRoot.querySelector('#btn-add-action-end');
            if (btnAddActionEnd) {
                btnAddActionEnd.addEventListener('click', () => {
                    const newStep = { action: "goto", target: "", value: "" };
                    localRecordedSteps.push(newStep);
                    syncStepsToBackground();
                });
            }
        }
    }

    function renderDevToolsTab(container) {
        container.innerHTML = `
            <div class="sub-header" style="flex-shrink:0; display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px; text-transform:none;">
                <span style="width:100%; margin-bottom:4px; font-weight:bold; color:var(--text-sub);">Can thiệp & Giám sát Web</span>
                <button class="step-edit-btn" id="btn-dev-net" style="font-size:0.62rem; color:${devtoolsSubView === 'network' ? 'white' : 'var(--text-sub)'}">[MẠNG]</button>
                <button class="step-edit-btn" id="btn-dev-console" style="font-size:0.62rem; color:${devtoolsSubView === 'console' ? 'white' : 'var(--text-sub)'}">[LOGS]</button>
                <button class="step-edit-btn" id="btn-dev-rules" style="font-size:0.62rem; color:${devtoolsSubView === 'rules' ? 'white' : 'var(--text-sub)'}">[CHẶN/SỬA]</button>
                <button class="step-edit-btn" id="btn-dev-inject" style="font-size:0.62rem; color:${devtoolsSubView === 'inject' ? 'white' : 'var(--text-sub)'}">[TIÊM JS]</button>
            </div>

            <div class="log-box" id="devtools-log-box" style="flex:1; display:flex; flex-direction:column; overflow-y:auto; box-sizing:border-box;">
                <!-- Dữ liệu nạp động -->
            </div>
        `;

        shadowRoot.querySelector('#btn-dev-net').addEventListener('click', () => {
            devtoolsSubView = 'network';
            renderWidgetContent();
        });
        shadowRoot.querySelector('#btn-dev-console').addEventListener('click', () => {
            devtoolsSubView = 'console';
            renderWidgetContent();
        });
        shadowRoot.querySelector('#btn-dev-rules').addEventListener('click', () => {
            devtoolsSubView = 'rules';
            renderWidgetContent();
        });
        shadowRoot.querySelector('#btn-dev-inject').addEventListener('click', () => {
            devtoolsSubView = 'inject';
            renderWidgetContent();
        });

        renderDevToolsLogs();
    }

    function renderDevToolsLogs() {
        if (!shadowRoot) return;
        const logBox = shadowRoot.querySelector('#devtools-log-box');
        if (!logBox) return;

        if (devtoolsSubView === 'network') {
            if (interceptedRequests.length === 0) {
                logBox.innerHTML = `<div style="color:var(--text-sub); text-align:center; padding-top:40px; font-size:0.7rem;">Đang lắng nghe traffic mạng cấp thấp qua CDP...</div>`;
            } else {
                logBox.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:4px; max-height:100%;">
                        ${interceptedRequests.map(r => {
                            const isPending = r.status === 'Pending';
                            const isError = !isPending && parseInt(r.status) >= 400;
                            const color = isPending ? '#fbbf24' : (isError ? '#ef4444' : '#10b981');
                            return `
                                <div class="log-item net" style="border-bottom:1px solid rgba(255,255,255,0.03); padding:4px 0; display:flex; flex-direction:column; font-size:0.65rem; word-break:break-all;">
                                    <div style="display:flex; justify-content:space-between; align-items:center;">
                                        <span style="color:#818cf8; font-weight:bold;">[${r.timestamp}]</span>
                                        <span style="font-weight:700; color:${color};">${r.method} (${r.status})</span>
                                        <span style="color:#ec4899; font-size:0.58rem;">${r.type}</span>
                                    </div>
                                    <div style="color:#e2e8f0; margin-top:2px;" title="${r.url}">
                                        ${r.url.length > 70 ? r.url.substring(0, 70) + '...' : r.url}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
                logBox.scrollTop = logBox.scrollHeight;
            }
        } else if (devtoolsSubView === 'console') {
            if (interceptedConsoleLogs.length === 0) {
                logBox.innerHTML = `<div style="color:var(--text-sub); text-align:center; padding-top:40px; font-size:0.7rem;">Đang lắng nghe console log...</div>`;
            } else {
                logBox.innerHTML = interceptedConsoleLogs.map(l => `
                    <div class="log-item ${l.logType === 'error' ? 'error' : (l.logType === 'warn' ? 'warn' : '')}">
                        <span style="color:#f59e0b;">[${l.timestamp}]</span> 
                        <span style="font-weight:bold;">[${l.logType.toUpperCase()}]</span> 
                        <span>${l.message}</span>
                    </div>
                `).join('');
                logBox.scrollTop = logBox.scrollHeight;
            }
        } else if (devtoolsSubView === 'rules') {
            renderRulesPane(logBox);
        } else if (devtoolsSubView === 'inject') {
            renderInjectPane(logBox);
        }
    }

    function renderRulesPane(container) {
        container.style.overflowY = 'auto';
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px; padding:4px; font-size:0.72rem; box-sizing:border-box;">
                <!-- 1. Luật Chặn -->
                <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); padding:8px; border-radius:6px;">
                    <div style="font-weight:bold; color:#a5b4fc; margin-bottom:6px;"><i class="fa-solid fa-ban"></i> Quy tắc chặn kết nối (Block URLs)</div>
                    <div style="display:flex; gap:4px; margin-bottom:6px;">
                        <input type="text" id="rule-block-input" placeholder="Ví dụ: *google-analytics* hoặc *.png" style="flex:1; padding:4px 6px; font-size:0.7rem; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.3); color:white; outline:none; box-sizing:border-box;">
                        <button id="rule-block-add-btn" style="padding:4px 8px; font-size:0.68rem; font-weight:bold; background:#ef4444; border:none; border-radius:4px; color:white; cursor:pointer;">Chặn</button>
                    </div>
                    <div id="rule-block-list" style="display:flex; flex-direction:column; gap:4px; max-height:80px; overflow-y:auto; background:rgba(0,0,0,0.2); padding:4px; border-radius:4px;">
                        ${localInterceptionRules.blockUrls.length === 0 ? 
                            `<span style="color:var(--text-sub); font-size:0.65rem; text-align:center; display:block;">Chưa chặn URL nào.</span>` :
                            localInterceptionRules.blockUrls.map((pattern, idx) => `
                                <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.2); padding:2px 4px; border-radius:3px;">
                                    <span style="font-family:monospace; color:#f87171; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px;">${pattern}</span>
                                    <button class="rule-block-del" data-index="${idx}" style="background:none; border:none; color:var(--text-sub); cursor:pointer; font-size:0.68rem;"><i class="fa-solid fa-xmark"></i></button>
                                </div>
                            `).join('')
                        }
                    </div>
                </div>

                <!-- 2. Luật Sửa -->
                <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); padding:8px; border-radius:6px;">
                    <div style="font-weight:bold; color:#a5b4fc; margin-bottom:6px;"><i class="fa-solid fa-pen-to-square"></i> Can thiệp sửa đổi gói tin (Modify Request)</div>
                    <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:6px;">
                        <input type="text" id="rule-mod-url" placeholder="URL Pattern chứa (Ví dụ: /api/login)" style="padding:4px 6px; font-size:0.7rem; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.3); color:white; outline:none; box-sizing:border-box;">
                        <div style="display:flex; gap:4px;">
                            <input type="text" id="rule-mod-hdr-name" placeholder="Header Name" style="flex:1; padding:4px 6px; font-size:0.7rem; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.3); color:white; outline:none; box-sizing:border-box;">
                            <input type="text" id="rule-mod-hdr-val" placeholder="Value" style="flex:1; padding:4px 6px; font-size:0.7rem; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.3); color:white; outline:none; box-sizing:border-box;">
                        </div>
                        <textarea id="rule-mod-body" rows="2" placeholder="Sửa Payload Body (JSON hoặc Text, tùy chọn)" style="padding:4px 6px; font-size:0.68rem; font-family:monospace; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.3); color:white; outline:none; resize:none; box-sizing:border-box;"></textarea>
                        <button id="rule-mod-add-btn" style="width:100%; padding:4px; font-size:0.7rem; font-weight:bold; background:#10b981; border:none; border-radius:4px; color:white; cursor:pointer;">Thêm luật can thiệp</button>
                    </div>
                    <div id="rule-mod-list" style="display:flex; flex-direction:column; gap:4px; max-height:80px; overflow-y:auto; background:rgba(0,0,0,0.2); padding:4px; border-radius:4px;">
                        ${localInterceptionRules.modifyRules.length === 0 ? 
                            `<span style="color:var(--text-sub); font-size:0.65rem; text-align:center; display:block;">Chưa có luật can thiệp nào.</span>` :
                            localInterceptionRules.modifyRules.map((rule, idx) => `
                                <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.2); padding:4px; border-radius:3px; font-size:0.62rem;">
                                    <div style="display:flex; flex-direction:column; overflow:hidden; max-width:230px;">
                                        <span style="font-family:monospace; color:#34d399; font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Match: ${rule.urlPattern}</span>
                                        ${rule.headers ? `<span style="color:var(--text-sub); font-size:0.58rem;">Header: ${Object.keys(rule.headers)[0]}=${Object.values(rule.headers)[0]}</span>` : ''}
                                        ${rule.postData ? `<span style="color:#fbbf24; font-size:0.58rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Payload: ${rule.postData}</span>` : ''}
                                    </div>
                                    <button class="rule-mod-del" data-index="${idx}" style="background:none; border:none; color:var(--text-sub); cursor:pointer; font-size:0.68rem; align-self:center;"><i class="fa-solid fa-xmark"></i></button>
                                </div>
                            `).join('')
                        }
                    </div>
                </div>
            </div>
        `;

        // Gắn sự kiện thêm luật chặn
        const addBlockBtn = container.querySelector('#rule-block-add-btn');
        if (addBlockBtn) {
            addBlockBtn.addEventListener('click', async () => {
                const input = container.querySelector('#rule-block-input');
                const val = input.value.trim();
                if (!val) return;
                localInterceptionRules.blockUrls.push(val);
                input.value = "";
                await syncRulesToBackend();
                renderRulesPane(container);
            });
        }

        // Gắn sự kiện xóa luật chặn
        container.querySelectorAll('.rule-block-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                const idx = parseInt(btn.getAttribute('data-index'));
                localInterceptionRules.blockUrls.splice(idx, 1);
                await syncRulesToBackend();
                renderRulesPane(container);
            });
        });

        // Gắn sự kiện thêm luật sửa
        const addModBtn = container.querySelector('#rule-mod-add-btn');
        if (addModBtn) {
            addModBtn.addEventListener('click', async () => {
                const pattern = container.querySelector('#rule-mod-url').value.trim();
                const hdrName = container.querySelector('#rule-mod-hdr-name').value.trim();
                const hdrVal = container.querySelector('#rule-mod-hdr-val').value.trim();
                const body = container.querySelector('#rule-mod-body').value.trim();

                if (!pattern) {
                    alert("Vui lòng nhập URL Pattern muốn khớp!");
                    return;
                }

                const newRule = { urlPattern: pattern };
                if (hdrName && hdrVal) {
                    newRule.headers = {};
                    newRule.headers[hdrName] = hdrVal;
                }
                if (body) {
                    newRule.postData = body;
                }

                localInterceptionRules.modifyRules.push(newRule);
                container.querySelector('#rule-mod-url').value = "";
                container.querySelector('#rule-mod-hdr-name').value = "";
                container.querySelector('#rule-mod-hdr-val').value = "";
                container.querySelector('#rule-mod-body').value = "";

                await syncRulesToBackend();
                renderRulesPane(container);
            });
        }

        // Gắn sự kiện xóa luật sửa
        container.querySelectorAll('.rule-mod-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                const idx = parseInt(btn.getAttribute('data-index'));
                localInterceptionRules.modifyRules.splice(idx, 1);
                await syncRulesToBackend();
                renderRulesPane(container);
            });
        });
    }

    async function syncRulesToBackend() {
        if (!localActiveProfileId) return;
        try {
            await safeFetch(`http://127.0.0.1:5000/api/profiles/${localActiveProfileId}/interception_rules`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(localInterceptionRules)
            });
        } catch (e) {
            console.error("Lỗi đồng bộ quy tắc chặn/sửa:", e);
        }
    }

    function renderInjectPane(container) {
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:8px; padding:4px; font-size:0.72rem; height:100%; box-sizing:border-box;">
                <div style="font-weight:bold; color:#a5b4fc;"><i class="fa-solid fa-code"></i> Tiêm mã Javascript tùy biến (JS Injection)</div>
                <div style="flex:1; min-height:120px; position:relative; display:flex; flex-direction:column;">
                    <textarea id="rule-inject-code-box" style="flex:1; width:100%; background:rgba(0,0,0,0.3); color:#fbbf24; font-family:monospace; font-size:0.68rem; border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:8px; resize:none; outline:none; box-sizing:border-box;" placeholder="// Viết mã Javascript của bạn tại đây...\n// Ví dụ:\nconsole.log('Tiêu đề trang:', document.title);\nalert('Tiêm mã thành công!');"></textarea>
                </div>
                <button id="rule-inject-execute-btn" style="width:100%; padding:8px; font-size:0.72rem; font-weight:bold; background:linear-gradient(135deg, #6366f1 0%, #ec4899 100%); border:none; border-radius:6px; color:white; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Thực thi Tiêm mã qua CDP
                </button>
            </div>
        `;

        const execBtn = container.querySelector('#rule-inject-execute-btn');
        if (execBtn) {
            execBtn.addEventListener('click', async () => {
                const code = container.querySelector('#rule-inject-code-box').value.trim();
                if (!code) {
                    alert("Vui lòng viết mã Javascript trước khi tiêm!");
                    return;
                }
                
                execBtn.disabled = true;
                execBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang thực thi...`;

                try {
                    const res = await safeFetch(`http://127.0.0.1:5000/api/profiles/${localActiveProfileId}/cdp_send`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            method: "Runtime.evaluate",
                            params: { expression: code, returnByValue: true }
                        })
                    });
                    if (res && res.success) {
                        alert("Thực thi tiêm mã thành công!");
                    } else {
                        alert("Lỗi thực thi CDP: " + (res ? res.error : "Không phản hồi"));
                    }
                } catch (err) {
                    alert("Lỗi kết nối máy chủ: " + err.message);
                } finally {
                    execBtn.disabled = false;
                    execBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Thực thi Tiêm mã qua CDP`;
                }
            });
        }
    }

    function renderResourcesTab(container) {
        container.innerHTML = `
            <div style="font-size: 0.72rem; font-weight: bold; color: #a5b4fc; margin-bottom: 8px;">TÀI NGUYÊN PROFILE ĐÃ TẠO</div>
            
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-val" id="stat-emails">${resourceStats.emails}</div>
                    <div class="stat-lbl">Email đã tạo</div>
                </div>
                <div class="stat-card">
                    <div class="stat-val" id="stat-phones">${resourceStats.phones}</div>
                    <div class="stat-lbl">SĐT đã thuê</div>
                </div>
                <div class="stat-card">
                    <div class="stat-val" id="stat-solved" style="color:var(--neon-green);">${resourceStats.captcha_solved}</div>
                    <div class="stat-lbl">Captcha đã giải</div>
                </div>
                <div class="stat-card">
                    <div class="stat-val" id="stat-failed" style="color:var(--neon-red);">${resourceStats.captcha_failed}</div>
                    <div class="stat-lbl">Captcha thất bại</div>
                </div>
            </div>

            <div style="font-size: 0.72rem; font-weight: bold; color: #a5b4fc; margin-bottom: 6px;">KẾT NỐI PROXY</div>
            <div class="proxy-box">
                <div><span style="color:var(--text-sub);">Proxy hiện tại:</span> <span style="font-weight:bold; color:#818cf8;" id="proxy-current">${resourceStats.current_proxy}</span></div>
                <div style="border-top: 1px dashed rgba(255,255,255,0.03); padding-top:4px; margin-top:2px;">
                    <span style="color:var(--text-sub);">Proxy trước đó:</span> <span style="color:var(--text-sub);" id="proxy-last">${resourceStats.last_proxy}</span>
                </div>
            </div>
        `;
    }

    function updateLiveStatusElements() {
        if (!shadowRoot) return;

        if (localActiveTab === 'engines') {
            const mcpDesc = shadowRoot.querySelector('#mcp-desc-status');
            if (mcpDesc) {
                if (mcpEngineStatus.is_running && mcpEngineStatus.mcp_active) {
                    mcpDesc.innerText = `Hoạt động - Cổng ${mcpEngineStatus.mcp_port}`;
                    mcpDesc.style.color = 'var(--neon-green)';
                } else {
                    mcpDesc.innerText = 'Chờ kết nối / Tắt';
                    mcpDesc.style.color = 'var(--neon-red)';
                }
            }

            const puppeteerDesc = shadowRoot.querySelector('#puppeteer-desc-status');
            if (puppeteerDesc) {
                if (mcpEngineStatus.is_running && mcpEngineStatus.puppeteer_active) {
                    puppeteerDesc.innerText = `Đã kết nối - Cổng ${mcpEngineStatus.debug_port}`;
                    puppeteerDesc.style.color = 'var(--neon-green)';
                } else {
                    puppeteerDesc.innerText = 'Chờ kết nối / Tắt';
                    puppeteerDesc.style.color = 'var(--text-sub)';
                }
            }

            const infoPanel = shadowRoot.querySelector('#widget-mcp-info-panel');
            if (infoPanel) {
                infoPanel.style.display = mcpEngineStatus.is_running ? 'block' : 'none';
            }

            const chkMcp = shadowRoot.querySelector('#mcp-toggle-widget');
            if (chkMcp) {
                chkMcp.checked = mcpEngineStatus.use_mcp;
            }

            const chkPuppeteer = shadowRoot.querySelector('#puppeteer-toggle-widget');
            if (chkPuppeteer) {
                chkPuppeteer.checked = mcpEngineStatus.puppeteer_active;
            }
        }

        if (localActiveTab === 'resources') {
            const emailsEl = shadowRoot.querySelector('#stat-emails');
            if (emailsEl) emailsEl.innerText = resourceStats.emails;

            const phonesEl = shadowRoot.querySelector('#stat-phones');
            if (phonesEl) phonesEl.innerText = resourceStats.phones;

            const solvedEl = shadowRoot.querySelector('#stat-solved');
            if (solvedEl) solvedEl.innerText = resourceStats.captcha_solved;

            const failedEl = shadowRoot.querySelector('#stat-failed');
            if (failedEl) failedEl.innerText = resourceStats.captcha_failed;

            const currentProxyEl = shadowRoot.querySelector('#proxy-current');
            if (currentProxyEl) currentProxyEl.innerText = resourceStats.current_proxy;
        }
    }

    function openSettingsModal(index) {
        if (!shadowRoot) return;
        const modal = shadowRoot.querySelector('.settings-modal');
        if (!modal) return;

        const step = localRecordedSteps[index];
        if (!step) return;

        modal.style.display = 'flex';

        const hasSelector = step.action !== "goto" && step.action !== "wait" && step.action !== "click_xy" && step.action !== "call_api";
        const hasValue = step.action === "goto" || step.action === "type" || step.action === "wait" || step.action === "click_xy" || step.action === "call_api";
        const showApiConfig = step.action === "type" || step.action === "click" || step.action === "call_api";

        modal.innerHTML = `
            <div class="modal-header">
                <span>CÀI ĐẶT BƯỚC ${index + 1}</span>
                <span style="font-size: 0.65rem; background: var(--neon-blue); color: white; padding: 2px 6px; border-radius: 4px;">${step.action.toUpperCase()}</span>
            </div>

            <div class="form-row">
                <label>Hành động</label>
                <select class="form-select" id="modal-action-select">
                    <option value="click" ${step.action === 'click' ? 'selected' : ''}>Click trái</option>
                    <option value="click_right" ${step.action === 'click_right' ? 'selected' : ''}>Click phải</option>
                    <option value="type" ${step.action === 'type' ? 'selected' : ''}>Gõ phím (Type)</option>
                    <option value="goto" ${step.action === 'goto' ? 'selected' : ''}>Chuyển trang (Goto)</option>
                    <option value="wait" ${step.action === 'wait' ? 'selected' : ''}>Chờ đợi (Wait)</option>
                    <option value="call_api" ${step.action === 'call_api' ? 'selected' : ''}>Gọi API độc lập</option>
                </select>
            </div>

            ${hasSelector ? `
                <div class="form-row">
                    <label>CSS Selector</label>
                    <input type="text" class="form-input" id="modal-target-input" value="${step.target || ''}">
                </div>
            ` : ''}

            ${hasValue ? `
                <div class="form-row">
                    <label>${step.action === 'goto' ? 'URL' : (step.action === 'wait' ? 'Mili giây' : 'Giá trị')}</label>
                    <input type="text" class="form-input" id="modal-value-input" value="${step.value || ''}" ${step.use_api ? 'disabled placeholder="Lấy từ API..."' : ''}>
                </div>
            ` : ''}

            ${showApiConfig ? `
                <div class="api-toggle-container">
                    <input type="checkbox" id="modal-use-api" ${step.use_api ? 'checked' : ''}>
                    <label for="modal-use-api" style="cursor:pointer; display:flex; align-items:center; gap:4px;">
                        <i class="fa-solid fa-gears"></i> Cấu hình gọi API lấy dữ liệu động
                    </label>
                </div>

                <div class="api-panel" id="modal-api-panel" style="display: ${step.use_api ? 'flex' : 'none'};">
                    <div class="form-row">
                        <label>API URL</label>
                        <input type="text" class="form-input" id="modal-api-url" placeholder="http://..." value="${step.api_url || ''}">
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 80px 1fr; gap: 8px;">
                        <div class="form-row">
                            <label>Method</label>
                            <select class="form-select" id="modal-api-method">
                                <option value="GET" ${step.api_method === 'GET' ? 'selected' : ''}>GET</option>
                                <option value="POST" ${step.api_method === 'POST' ? 'selected' : ''}>POST</option>
                            </select>
                        </div>
                        <div class="form-row">
                            <label>JSON Path</label>
                            <input type="text" class="form-input" id="modal-api-path" placeholder="$.data.value" value="${step.api_json_path || ''}">
                        </div>
                    </div>

                    <div class="form-row" id="modal-api-body-row" style="display: ${step.api_method === 'POST' ? 'flex' : 'none'};">
                        <label>POST Body JSON</label>
                        <input type="text" class="form-input" id="modal-api-body" placeholder='{"key": "val"}' value="${step.api_body || ''}">
                    </div>

                    <div class="form-row">
                        <label>Headers JSON</label>
                        <input type="text" class="form-input" id="modal-api-headers" placeholder='{"Authorization": "Bearer..."}' value="${step.api_headers || '{}'}">
                    </div>
                </div>
            ` : ''}

            <div class="modal-actions">
                <button class="btn btn-save" id="modal-save-btn"><i class="fa-solid fa-floppy-disk"></i> Lưu</button>
                <button class="btn btn-delete" id="modal-delete-btn"><i class="fa-solid fa-trash"></i> Xóa</button>
                <button class="btn btn-close" id="modal-close-btn"><i class="fa-solid fa-xmark"></i> Hủy</button>
            </div>
        `;

        shadowRoot.querySelector('#modal-close-btn').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        if (showApiConfig) {
            const chkApi = shadowRoot.querySelector('#modal-use-api');
            const panelApi = shadowRoot.querySelector('#modal-api-panel');
            chkApi.addEventListener('change', (e) => {
                panelApi.style.display = e.target.checked ? 'flex' : 'none';
                const valInput = shadowRoot.querySelector('#modal-value-input');
                if (valInput) {
                    valInput.disabled = e.target.checked;
                    if (e.target.checked) {
                        valInput.placeholder = "Lấy từ API...";
                    } else {
                        valInput.placeholder = "";
                    }
                }
            });

            const selectMethod = shadowRoot.querySelector('#modal-api-method');
            const rowBody = shadowRoot.querySelector('#modal-api-body-row');
            selectMethod.addEventListener('change', (e) => {
                rowBody.style.display = e.target.value === 'POST' ? 'flex' : 'none';
            });
        }

        shadowRoot.querySelector('#modal-action-select').addEventListener('change', (e) => {
            step.action = e.target.value;
            openSettingsModal(index);
        });

        shadowRoot.querySelector('#modal-delete-btn').addEventListener('click', () => {
            if (confirm(`Bạn có chắc muốn xóa bước ${index + 1}?`)) {
                localRecordedSteps.splice(index, 1);
                chrome.runtime.sendMessage({
                    action: "update_steps",
                    steps: localRecordedSteps
                }, () => {
                    modal.style.display = 'none';
                    renderWidgetContent();
                });
            }
        });

        shadowRoot.querySelector('#modal-save-btn').addEventListener('click', () => {
            const targetInput = shadowRoot.querySelector('#modal-target-input');
            const valueInput = shadowRoot.querySelector('#modal-value-input');
            
            if (targetInput) step.target = targetInput.value;
            if (valueInput) step.value = valueInput.value;

            if (showApiConfig) {
                const useApiChk = shadowRoot.querySelector('#modal-use-api');
                step.use_api = useApiChk.checked;
                if (step.use_api) {
                    step.api_url = shadowRoot.querySelector('#modal-api-url').value;
                    step.api_method = shadowRoot.querySelector('#modal-api-method').value;
                    step.api_json_path = shadowRoot.querySelector('#modal-api-path').value;
                    step.api_headers = shadowRoot.querySelector('#modal-api-headers').value;
                    if (step.api_method === 'POST') {
                        step.api_body = shadowRoot.querySelector('#modal-api-body').value;
                    }
                }
            }

            chrome.runtime.sendMessage({
                action: "update_steps",
                steps: localRecordedSteps
            }, () => {
                modal.style.display = 'none';
                renderWidgetContent();
            });
        });
    }

    function removeWidget() {
        const root = document.getElementById('anti-recorder-widget-root');
        if (root) {
            root.remove();
        }
        shadowRoot = null;
        widgetContainer = null;
    }
}

// Hàm trích xuất CSS Selector duy nhất và tối ưu cho một phần tử DOM
function getUniqueSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";

    // 1. Ưu tiên sử dụng ID nếu ID hợp lệ (không chứa ký số tự động sinh)
    if (el.id && isUniqueId(el.id)) {
        return `#${el.id}`;
    }

    // 2. Ưu tiên sử dụng thẻ loại có thuộc tính name (rất tốt cho các ô input)
    if (el.name) {
        return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
    }

    // 3. Sử dụng thuộc tính placeholder nếu có
    if (el.getAttribute("placeholder")) {
        return `${el.tagName.toLowerCase()}[placeholder="${el.getAttribute("placeholder")}"]`;
    }

    // 4. Nếu là thẻ liên kết có href
    if (el.tagName.toLowerCase() === "a" && el.getAttribute("href") && el.getAttribute("href") !== "#") {
        return `a[href="${el.getAttribute("href")}"]`;
    }

    // 5. Dựng selector theo đường dẫn phân cấp DOM (DOM Path)
    const path = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.tagName.toLowerCase();
        if (current.id && isUniqueId(current.id)) {
            selector += `#${current.id}`;
            path.unshift(selector);
            break;
        } else {
            let sibling = current;
            let nth = 1;
            while (sibling = sibling.previousElementSibling) {
                if (sibling.tagName === current.tagName) {
                    nth++;
                }
            }
            let hasSiblingsOfSameTag = false;
            let next = current.nextElementSibling;
            while (next) {
                if (next.tagName === current.tagName) {
                    hasSiblingsOfSameTag = true;
                    break;
                }
                next = next.nextElementSibling;
            }
            if (nth > 1 || hasSiblingsOfSameTag) {
                selector += `:nth-of-type(${nth})`;
            }
        }
        path.unshift(selector);
        current = current.parentElement;
    }
    return path.join(" > ");
}

// Kiểm tra xem ID có phải là tự động sinh (ví dụ id chứa các chuỗi số ngẫu nhiên ngắt quãng)
function isUniqueId(id) {
    if (!id) return false;
    try {
        const els = document.querySelectorAll(`#${CSS.escape(id)}`);
        if (els.length > 1) return false;
    } catch (e) {
        return false;
    }
    const dynamicRegex = /(ember|react|wp|-\d{3,})|^\d+/i;
    return !dynamicRegex.test(id);
}

// Tự động phát hiện Profile ID từ document.documentElement (được tiêm từ Puppeteer)
function detectProfileId() {
    const id = document.documentElement && document.documentElement.getAttribute('data-profile-id');
    if (id) {
        console.log("[Anti-Profile Recorder] Đã phát hiện Profile ID từ trình duyệt:", id);
        chrome.runtime.sendMessage({
            action: "detected_profile_id",
            profileId: parseInt(id)
        }).catch(() => {});
    } else {
        setTimeout(detectProfileId, 100);
    }
}
detectProfileId();
