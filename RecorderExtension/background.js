let recordingState = "idle";
let recordedSteps = [];
let activeProfileId = null;

// Khởi tạo trạng thái từ storage
chrome.storage.local.get(["recordingState", "recordedSteps", "selectedProfileId"], (res) => {
    if (res.recordingState) recordingState = res.recordingState;
    if (res.recordedSteps) recordedSteps = res.recordedSteps;
    if (res.selectedProfileId) activeProfileId = res.selectedProfileId;
});

// Lắng nghe và đồng bộ trạng thái ghi sang tất cả các tab (cho Widget nổi)
function broadcastState() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.id) {
                chrome.tabs.sendMessage(tab.id, {
                    action: "sync_recording_state",
                    recordingState,
                    recordedSteps,
                    activeProfileId
                }).catch(() => {});
            }
        });
    });
}

// Lắng nghe message từ popup và content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "detected_profile_id") {
        activeProfileId = request.profileId;
        chrome.storage.local.set({ selectedProfileId: activeProfileId });
        broadcastState();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === "update_steps") {
        recordedSteps = request.steps;
        chrome.storage.local.set({ recordedSteps });
        broadcastState();
        // Gửi message cập nhật preview tới popup.js (nếu popup đang mở)
        chrome.runtime.sendMessage({ action: "update_preview", steps: recordedSteps }).catch(() => {});
        sendResponse({ success: true });
        return true;
    }

    if (request.action === "start_recording") {
        recordingState = "recording";
        recordedSteps = [];
        activeProfileId = request.profileId;
        
        chrome.storage.local.set({ recordingState, recordedSteps, selectedProfileId: activeProfileId });
        broadcastState();
        sendResponse({ success: true });
        
        // Gửi thông báo reset preview cho popup
        chrome.runtime.sendMessage({ action: "update_preview", steps: recordedSteps }).catch(() => {});
        return true;
    }
    
    if (request.action === "pause_recording") {
        recordingState = "paused";
        chrome.storage.local.set({ recordingState });
        broadcastState();
        sendResponse({ success: true });
        return true;
    }
    
    if (request.action === "resume_recording") {
        recordingState = "recording";
        chrome.storage.local.set({ recordingState });
        broadcastState();
        sendResponse({ success: true });
        return true;
    }
    
    if (request.action === "stop_recording") {
        const finalSteps = [...recordedSteps];
        const codeJS = convertStepsToPuppeteer(finalSteps);
        
        recordingState = "idle";
        recordedSteps = [];
        chrome.storage.local.set({ recordingState, recordedSteps });
        broadcastState();
        
        sendResponse({ success: true, codeJS: codeJS });
        return true;
    }
    
    if (request.action === "get_recording_state") {
        sendResponse({
            success: true,
            recordingState,
            recordedSteps,
            activeProfileId
        });
        return true;
    }

    if (request.action === "proxy_http_request") {
        const { url, options } = request;
        fetch(url, options)
            .then(res => res.json())
            .then(data => sendResponse({ success: true, data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep message channel open for async response
    }
    
    if (request.action === "get_js_code") {
        const codeJS = convertStepsToPuppeteer(recordedSteps);
        sendResponse({ success: true, codeJS });
        return true;
    }
    
    // Nhận sự kiện từ content.js
    if (request.action === "record_event") {
        if (recordingState === "recording") {
            const newStep = {
                action: request.event.action,
                target: request.event.target || "",
                value: request.event.value || "",
                use_api: false,
                api_url: "",
                api_method: "GET",
                api_json_path: "$",
                api_body: "",
                api_headers: "{}"
            };
            
            // Tránh ghi lặp lặp sự kiện click cùng selector liên tục
            const lastStep = recordedSteps[recordedSteps.length - 1];
            if (lastStep && lastStep.action === newStep.action && lastStep.target === newStep.target && newStep.action === "click") {
                // Bỏ qua nếu click trùng lặp liên tiếp
                sendResponse({ success: false, reason: "duplicate click" });
                return true;
            }
            
            recordedSteps.push(newStep);
            chrome.storage.local.set({ recordedSteps });
            broadcastState();
            
            // Gửi message cập nhật preview tới popup.js (nếu popup đang mở)
            chrome.runtime.sendMessage({ action: "update_preview", steps: recordedSteps }).catch(() => {});
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, reason: "not recording" });
        }
        return true;
    }
});

// Hàm biên dịch từ danh sách sự kiện sang mã JavaScript Puppeteer
function convertStepsToPuppeteer(steps) {
    if (!steps || steps.length === 0) {
        return "logInfo('Kịch bản rỗng.');";
    }
    
    let jsCode = "";
    jsCode += `// Kịch bản được ghi hình tự động bởi Anti-Profile Recorder v2.6\n`;
    jsCode += `logInfo("Bắt đầu kịch bản tự động hóa...");\n\n`;
    
    steps.forEach((step, index) => {
        const action = step.action;
        const target = step.target ? step.target.replace(/"/g, '\\"') : "";
        const value = step.value ? step.value.replace(/"/g, '\\"') : "";
        
        jsCode += `// Bước ${index + 1}: ${action.toUpperCase()}\n`;
        
        // Sinh code gọi API nếu được cấu hình use_api
        if (step.use_api && (action === "type" || action === "click" || action === "call_api")) {
            const apiMethod = step.api_method || "GET";
            const apiUrl = step.api_url || "";
            const jsonPath = step.api_json_path || "$";
            const apiHeaders = step.api_headers ? step.api_headers.replace(/"/g, '\\"') : "{}";
            const apiBody = step.api_body ? step.api_body.replace(/"/g, '\\"') : "null";
            
            jsCode += `let apiRes_${index} = await makeHttpRequest("${apiUrl}", "${apiMethod}", ${apiMethod === "POST" ? 'JSON.parse("' + apiBody + '")' : 'null'}, JSON.parse("${apiHeaders}"));\n`;
            jsCode += `logInfo("Phản hồi từ API bước ${index + 1}: " + JSON.stringify(apiRes_${index}));\n`;
            jsCode += `let apiVal_${index} = (() => {
    const obj = apiRes_${index};
    let path = "${jsonPath}";
    try {
        if (!path || path === "$") return typeof obj === 'object' ? JSON.stringify(obj) : obj;
        if (path.startsWith("$.")) path = path.substring(2);
        else if (path.startsWith("$")) path = path.substring(1);
        const parts = path.split('.');
        let val = obj;
        for (const part of parts) {
            if (!part) continue;
            if (part.includes('[') && part.includes(']')) {
                const arrayPart = part.split('[')[0];
                const idx = parseInt(part.split('[')[1].split(']')[0]);
                val = val[arrayPart][idx];
            } else {
                val = val[part];
            }
        }
        return val !== undefined ? val : "";
    } catch (e) {
        return "";
    }
})();\n`;
            jsCode += `logInfo("Giá trị lấy được từ API bước ${index + 1}: " + apiVal_${index});\n`;
        }
        
        if (action === "goto") {
            jsCode += `await page.goto("${value}", { waitUntil: "load" });\n\n`;
        } else if (action === "click" || action === "click_right") {
            jsCode += `await page.waitForSelector("${target}", { timeout: 30000 });\n`;
            if (action === "click_right") {
                jsCode += `await page.click("${target}", { button: "right" });\n\n`;
            } else {
                jsCode += `await page.click("${target}");\n\n`;
            }
        } else if (action === "type") {
            jsCode += `await page.waitForSelector("${target}", { timeout: 30000 });\n`;
            jsCode += `await page.click("${target}");\n`;
            jsCode += `await page.evaluate((sel) => { const el = document.querySelector(sel); if(el) el.value = ''; }, "${target}");\n`;
            
            if (step.use_api) {
                jsCode += `await page.type("${target}", String(apiVal_${index}), { delay: 100 });\n`;
                jsCode += `await page.waitForFunction((sel, val) => {
    const el = document.querySelector(sel);
    return el && el.value === val;
}, { timeout: 15000 }, "${target}", String(apiVal_${index}));\n\n`;
            } else {
                jsCode += `await page.type("${target}", "${value}", { delay: 100 });\n`;
                jsCode += `await page.waitForFunction((sel, val) => {
    const el = document.querySelector(sel);
    return el && el.value === val;
}, { timeout: 15000 }, "${target}", "${value}");\n\n`;
            }
        } else if (action === "wait") {
            const delay = parseInt(value) || 2000;
            jsCode += `await setTimeout(${delay});\n\n`;
        } else if (action === "call_api") {
            jsCode += `logInfo("Đã gọi API bước ${index + 1} hoàn tất.");\n\n`;
        }
    });
    
    jsCode += `logInfo("Hoàn thành kịch bản tự động hóa!");\n`;
    return jsCode;
}
