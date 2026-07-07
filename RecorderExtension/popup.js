const BACKEND_URL = "http://127.0.0.1:5000";
let activeProfileId = null;
let statusInterval = null;
let logInterval = null;
let activeTab = "system"; // system hoặc steps

// Khởi tạo các phần tử DOM
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const profileSelect = document.getElementById("profile-select");

const mcpToggle = document.getElementById("mcp-toggle");
const mcpStatus = document.getElementById("mcp-status");

const puppeteerToggle = document.getElementById("puppeteer-toggle");
const puppeteerStatus = document.getElementById("puppeteer-status");

const btnRecord = document.getElementById("btn-record-action");
const recControls = document.getElementById("recording-controls");
const btnPause = document.getElementById("btn-pause-action");
const btnStop = document.getElementById("btn-stop-action");
const btnMagic = document.getElementById("btn-magic-action");

const tabSystem = document.getElementById("tab-system");
const tabSteps = document.getElementById("tab-steps");
const systemLogContent = document.getElementById("system-log-content");
const stepsPreviewContent = document.getElementById("steps-preview-content");

// 1. Khởi động và kiểm tra kết nối Backend
async function initPopup() {
    try {
        const response = await fetch(`${BACKEND_URL}/api/profiles`);
        const profiles = await response.json();
        
        connDot.className = "badge-dot active";
        connText.innerText = "Đã kết nối";
        addSystemLog("Đã kết nối thành công tới Node.js Backend cổng 5000.");
        
        // Nạp danh sách profile
        profileSelect.innerHTML = `<option value="">-- Chọn Profile --</option>`;
        profiles.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.innerText = `${p.name} (ID: ${p.id})`;
            profileSelect.appendChild(opt);
        });

        // Khôi phục trạng thái cũ từ storage
        chrome.storage.local.get(["selectedProfileId", "recordingState", "recordedSteps"], (res) => {
            if (res.selectedProfileId) {
                const profileId = parseInt(res.selectedProfileId);
                const matchedProfile = profiles.find(p => p.id === profileId);
                if (matchedProfile) {
                    // Cập nhật giao diện tự động nhận dạng hồ sơ
                    const displayInfo = document.getElementById("profile-display-info");
                    const selectWrapper = document.getElementById("profile-select-wrapper");
                    const cardTitle = document.getElementById("profile-card-title");
                    if (displayInfo && selectWrapper && cardTitle) {
                        cardTitle.innerHTML = `<i class="fa-solid fa-id-card"></i> Hồ sơ hiện tại`;
                        displayInfo.innerText = `${matchedProfile.name} (ID: ${matchedProfile.id})`;
                        displayInfo.style.display = "block";
                        selectWrapper.style.display = "none";
                    }
                }

                profileSelect.value = res.selectedProfileId;
                handleProfileChange(res.selectedProfileId);
            }
            if (res.recordingState) {
                updateUIState(res.recordingState);
            }
            if (res.recordedSteps && res.recordedSteps.length > 0) {
                renderStepsPreview(res.recordedSteps);
            }
        });
        
        // Bắt đầu lấy log hệ thống thời gian thực
        startLogPolling();
    } catch (err) {
        connDot.className = "badge-dot";
        connText.innerText = "Mất kết nối";
        addSystemLog("⚠️ LỖI: Không thể kết nối tới Backend tại " + BACKEND_URL + ". Hãy chạy run.bat trước!");
        disableAllControls();
    }
}

// 2. Lắng nghe thay đổi Profile
profileSelect.addEventListener("change", (e) => {
    const profileId = e.target.value;
    chrome.storage.local.set({ selectedProfileId: profileId });
    handleProfileChange(profileId);
});

function handleProfileChange(profileId) {
    if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
    }
    
    if (!profileId) {
        activeProfileId = null;
        disableAllControls();
        return;
    }
    
    activeProfileId = parseInt(profileId);
    
    // Kích hoạt các nút toggle
    mcpToggle.disabled = false;
    btnRecord.disabled = false;
    
    // Chạy vòng lặp lấy trạng thái profile
    checkProfileStatus();
    statusInterval = setInterval(checkProfileStatus, 2000);
}

// 3. Ping trạng thái profile và các động cơ
async function checkProfileStatus() {
    if (!activeProfileId) return;
    try {
        const res = await fetch(`${BACKEND_URL}/api/profiles/${activeProfileId}/mcp_status`);
        const status = await res.json();
        if (status.success) {
            // Cập nhật nút gạt MCP Server theo cấu hình đã lưu trong database
            mcpToggle.checked = status.use_mcp;
            
            if (status.is_running) {
                // TRƯỜNG HỢP TRÌNH DUYỆT ĐANG CHẠY
                const configCard = document.getElementById("mcp-config-card");
                if (configCard) {
                    configCard.style.display = "block";
                }
                const debugPortEl = document.getElementById("mcp-debug-port");
                if (debugPortEl) debugPortEl.innerText = status.debug_port;
                
                const serverPortEl = document.getElementById("mcp-server-port");
                if (serverPortEl) serverPortEl.innerText = status.mcp_port;

                // Trạng thái MCP Server thực tế
                if (status.mcp_active) {
                    mcpStatus.innerText = `🟢 Sẵn sàng (Port ${status.mcp_port})`;
                    mcpStatus.className = "engine-status online";
                    mcpStatus.style.color = "var(--success-color)";
                } else {
                    mcpStatus.innerText = "🔴 Lỗi / Tắt";
                    mcpStatus.className = "engine-status";
                    mcpStatus.style.color = "var(--danger-color)";
                }
                // Trạng thái Puppeteer
                puppeteerToggle.disabled = false;
                puppeteerToggle.checked = status.puppeteer_active;
                
                const cdpStatusEl = document.getElementById("mcp-cdp-status");
                if (status.puppeteer_active) {
                    puppeteerStatus.innerText = `🟢 Đã kết nối (Port ${status.debug_port})`;
                    puppeteerStatus.className = "engine-status online";
                    puppeteerStatus.style.color = "var(--success-color)";
                    btnMagic.disabled = false; // Bật nút tự động điền
                    
                    if (cdpStatusEl) {
                        cdpStatusEl.innerText = "🟢 CDP CONNECTED";
                        cdpStatusEl.style.background = "rgba(16, 185, 129, 0.15)";
                        cdpStatusEl.style.color = "#10b981";
                        cdpStatusEl.style.borderColor = "rgba(16, 185, 129, 0.3)";
                    }
                } else {
                    puppeteerStatus.innerText = "⚪ Chờ kết nối";
                    puppeteerStatus.className = "engine-status";
                    puppeteerStatus.style.color = "var(--text-secondary)";
                    btnMagic.disabled = true;
                    
                    if (cdpStatusEl) {
                        cdpStatusEl.innerText = "🟡 CDP READY";
                        cdpStatusEl.style.background = "rgba(245, 158, 11, 0.15)";
                        cdpStatusEl.style.color = "#f59e0b";
                        cdpStatusEl.style.borderColor = "rgba(245, 158, 11, 0.3)";
                    }
                }
            } else {
                // TRƯỜNG HỢP TRÌNH DUYỆT ĐANG TẮT
                const configCard = document.getElementById("mcp-config-card");
                if (configCard) {
                    configCard.style.display = "none";
                }

                // Đèn chỉ báo MCP dựa trên cấu hình đã lưu (vì trình duyệt chưa chạy)
                if (status.use_mcp) {
                    mcpStatus.innerText = "🔵 Đã cấu hình";
                    mcpStatus.className = "engine-status";
                    mcpStatus.style.color = "#3b82f6"; // màu xanh dương chỉ cấu hình sẵn
                } else {
                    mcpStatus.innerText = "⚪ Tắt";
                    mcpStatus.className = "engine-status";
                    mcpStatus.style.color = "var(--text-secondary)";
                }

                // Đèn chỉ báo Puppeteer (chỉ chạy khi trình duyệt mở)
                puppeteerToggle.checked = false;
                puppeteerToggle.disabled = true;
                puppeteerStatus.innerText = "⚪ Tắt";
                puppeteerStatus.className = "engine-status";
                puppeteerStatus.style.color = "var(--text-secondary)";
                btnMagic.disabled = true;
            }
        }
    } catch (e) {
        console.error("Lỗi khi kiểm tra trạng thái profile:", e);
    }
}

// 4. Bật/tắt động MCP Server
mcpToggle.addEventListener("change", async (e) => {
    if (!activeProfileId) return;
    const enable = e.target.checked;
    addSystemLog(`Đang gửi lệnh ${enable ? 'BẬT' : 'TẮT'} MCP Server động...`);
    
    try {
        const res = await fetch(`${BACKEND_URL}/api/profiles/${activeProfileId}/toggle_mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enable })
        });
        const data = await res.json();
        if (data.success) {
            addSystemLog(`Hệ thống báo cáo: ${data.message}`);
            checkProfileStatus(); // cập nhật tức thì
        } else {
            addSystemLog(`⚠️ Lỗi bật/tắt MCP: ${data.error}`);
            mcpToggle.checked = !enable; // revert
        }
    } catch (err) {
        addSystemLog(`⚠️ Lỗi kết nối: ${err.message}`);
        mcpToggle.checked = !enable; // revert
    }
});

// 5. Bật/tắt động Puppeteer Engine
puppeteerToggle.addEventListener("change", async (e) => {
    if (!activeProfileId) return;
    const enable = e.target.checked;
    addSystemLog(`Đang ${enable ? 'kết nối' : 'ngắt kết nối'} giả lập Puppeteer tới trình duyệt...`);
    
    try {
        const res = await fetch(`${BACKEND_URL}/api/profiles/${activeProfileId}/toggle_puppeteer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enable })
        });
        const data = await res.json();
        if (data.success) {
            addSystemLog(`Hệ thống báo cáo: ${data.message}`);
            checkProfileStatus();
        } else {
            addSystemLog(`⚠️ Lỗi kết nối Puppeteer: ${data.error}`);
            puppeteerToggle.checked = !enable;
        }
    } catch (err) {
        addSystemLog(`⚠️ Lỗi kết nối: ${err.message}`);
        puppeteerToggle.checked = !enable;
    }
});

// 6. Nút Bắt đầu ghi hình trực tiếp tại trình duyệt hiện tại
btnRecord.addEventListener("click", () => {
    if (!activeProfileId) return;
    
    btnRecord.disabled = true;
    addSystemLog("Bắt đầu khởi động chế độ ghi hình...");
    
    // Gọi background extension bắt đầu thu âm sự kiện của cửa sổ/trình duyệt hiện tại
    chrome.runtime.sendMessage({ action: "start_recording", profileId: activeProfileId }, (response) => {
        btnRecord.disabled = false;
        if (response && response.success) {
            updateUIState("recording");
            addSystemLog("Đang ghi hình trên chính trình duyệt hiện tại này. Mọi click chuột và phím gõ của bạn trên các tab sẽ được lưu lại!");
            switchTab("steps");
        } else {
            addSystemLog("⚠️ Lỗi khởi động ghi hình.");
        }
    });
});

// 7. Tạm dừng / Tiếp tục ghi
btnPause.addEventListener("click", () => {
    chrome.storage.local.get(["recordingState"], (res) => {
        const isPaused = res.recordingState === "paused";
        const action = isPaused ? "resume_recording" : "pause_recording";
        
        chrome.runtime.sendMessage({ action: action }, (response) => {
            if (response && response.success) {
                updateUIState(isPaused ? "recording" : "paused");
                addSystemLog(isPaused ? "Tiếp tục tiến trình ghi hình..." : "Đã tạm dừng tiến trình ghi hình.");
            }
        });
    });
});

// 8. Kết thúc & Lưu kịch bản Puppeteer
btnStop.addEventListener("click", () => {
    const scriptName = prompt("Nhập tên kịch bản muốn lưu:", "Kịch bản tự động " + new Date().toLocaleDateString());
    if (!scriptName) return; // Hủy bỏ
    
    chrome.runtime.sendMessage({ action: "stop_recording" }, async (response) => {
        if (response && response.success) {
            updateUIState("idle");
            stepsPreviewContent.innerText = "Chưa có bước kịch bản nào được ghi lại...";
            
            addSystemLog("Đang chuyển đổi sự kiện thành code Puppeteer và gửi về CSDL...");
            try {
                const saveRes = await fetch(`${BACKEND_URL}/api/scripts`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: scriptName,
                        steps: response.codeJS
                    })
                });
                const saveData = await saveRes.json();
                if (saveData.success) {
                    addSystemLog(`Thành công! Đã lưu kịch bản '${scriptName}' vào Cơ sở dữ liệu.`);
                    alert(`Đã lưu kịch bản '${scriptName}' thành công!`);
                    switchTab("system");
                } else {
                    addSystemLog(`⚠️ Lỗi lưu kịch bản: ${saveData.error}`);
                }
            } catch (err) {
                addSystemLog(`⚠️ Lỗi kết nối khi gửi kịch bản: ${err.message}`);
            }
        }
    });
});

// 9. Nút Tự động điền & Xác minh OTP thông minh
btnMagic.addEventListener("click", async () => {
    if (!activeProfileId) return;
    
    btnMagic.disabled = true;
    addSystemLog("🔮 Kích hoạt chức năng Tự động điền & Xác minh OTP...");
    switchTab("system");
    
    try {
        const res = await fetch(`${BACKEND_URL}/api/profiles/${activeProfileId}/auto_fill_verify`, {
            method: "POST"
        });
        const data = await res.json();
        if (data.success) {
            addSystemLog("🚀 Đã khởi động phân tích HTML chạy ngầm. Hãy theo dõi Nhật ký hệ thống ở dưới!");
        } else {
            addSystemLog(`⚠️ Thất bại: ${data.error}`);
            btnMagic.disabled = false;
        }
    } catch (err) {
        addSystemLog(`⚠️ Lỗi kết nối: ${err.message}`);
        btnMagic.disabled = false;
    }
});

// 10. Polling Logs thời gian thực từ Backend
function startLogPolling() {
    if (logInterval) clearInterval(logInterval);
    
    // Xóa log cũ trên server trước khi bắt đầu để chỉ lấy log mới
    fetch(`${BACKEND_URL}/api/logs/clear`, { method: "POST" }).catch(() => {});
    
    logInterval = setInterval(async () => {
        try {
            const res = await fetch(`${BACKEND_URL}/api/logs`);
            const logs = await res.json();
            if (logs && logs.length > 0) {
                logs.forEach(log => {
                    const prefix = `[${log.timestamp.split(' ')[1]}] [${log.level}] `;
                    addSystemLog(prefix + log.message, false);
                });
                // Sau khi đọc xong log, yêu cầu server xóa log đã đọc
                await fetch(`${BACKEND_URL}/api/logs/clear`, { method: "POST" });
            }
        } catch (e) {
            // Im lặng nếu mất kết nối tạm thời
        }
    }, 1500);
}

// 11. Đồng bộ danh sách các bước ghi hình từ background
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "update_preview") {
        renderStepsPreview(message.steps);
    }
});

function renderStepsPreview(steps) {
    const stepsListContainer = document.getElementById("steps-list");
    if (!stepsListContainer) return;
    
    if (!steps || steps.length === 0) {
        stepsListContainer.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 20px 0; font-size: 0.75rem;">Chưa có bước kịch bản nào được ghi lại...</div>`;
        return;
    }
    
    stepsListContainer.innerHTML = "";
    
    steps.forEach((step, index) => {
        const card = document.createElement("div");
        card.className = "step-card";
        
        // Header của card
        const header = document.createElement("div");
        header.className = "step-header";
        
        const title = document.createElement("div");
        title.className = "step-title";
        
        let actionIcon = "fa-arrow-pointer";
        if (step.action === "goto") actionIcon = "fa-globe";
        else if (step.action === "type" || step.action === "type_phone" || step.action === "type_mail") actionIcon = "fa-keyboard";
        else if (step.action === "click" || step.action === "click_right" || step.action === "click_xy") actionIcon = "fa-arrow-pointer";
        else if (step.action === "wait") actionIcon = "fa-clock";
        else if (step.action === "call_api") actionIcon = "fa-network-wired";
        
        title.innerHTML = `<i class="fa-solid ${actionIcon}"></i> Bước ${index + 1}: <span style="text-transform: uppercase; font-weight:700;">${step.action}</span>`;
        
        const actions = document.createElement("div");
        actions.className = "step-actions";
        
        // Nút di chuyển lên
        const btnUp = document.createElement("button");
        btnUp.className = "step-btn";
        btnUp.innerHTML = `<i class="fa-solid fa-arrow-up"></i>`;
        btnUp.disabled = index === 0;
        btnUp.addEventListener("click", (e) => {
            e.stopPropagation();
            swapSteps(steps, index, index - 1);
        });
        
        // Nút di chuyển xuống
        const btnDown = document.createElement("button");
        btnDown.className = "step-btn";
        btnDown.innerHTML = `<i class="fa-solid fa-arrow-down"></i>`;
        btnDown.disabled = index === steps.length - 1;
        btnDown.addEventListener("click", (e) => {
            e.stopPropagation();
            swapSteps(steps, index, index + 1);
        });
        
        // Nút xóa bước
        const btnDel = document.createElement("button");
        btnDel.className = "step-btn btn-delete";
        btnDel.innerHTML = `<i class="fa-solid fa-trash-can"></i>`;
        btnDel.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteStep(steps, index);
        });
        
        actions.appendChild(btnUp);
        actions.appendChild(btnDown);
        actions.appendChild(btnDel);
        
        header.appendChild(title);
        header.appendChild(actions);
        
        // Body của card
        const body = document.createElement("div");
        body.className = "step-body";
        
        // Dòng chọn Action (Cho phép đổi loại action)
        const rowAction = document.createElement("div");
        rowAction.className = "step-row";
        rowAction.innerHTML = `<label style="font-size:0.68rem; width:48px;">Hành động</label>`;
        const selectAction = document.createElement("select");
        selectAction.className = "step-select";
        const actionOptions = [
            { value: "click", text: "Click trái" },
            { value: "click_right", text: "Click phải" },
            { value: "type", text: "Gõ phím (Type)" },
            { value: "goto", text: "Chuyển trang (Goto)" },
            { value: "wait", text: "Chờ đợi (Wait)" },
            { value: "call_api", text: "Gọi API độc lập" }
        ];
        actionOptions.forEach(opt => {
            const elOpt = document.createElement("option");
            elOpt.value = opt.value;
            elOpt.innerText = opt.text;
            if (step.action === opt.value) elOpt.selected = true;
            selectAction.appendChild(elOpt);
        });
        selectAction.addEventListener("change", (e) => {
            step.action = e.target.value;
            saveStepsToBackground(steps);
            renderStepsPreview(steps);
        });
        rowAction.appendChild(selectAction);
        body.appendChild(rowAction);
        
        // Dòng Selector (chỉ hiện nếu không phải goto, wait, click_xy)
        if (step.action !== "goto" && step.action !== "wait" && step.action !== "click_xy" && step.action !== "call_api") {
            const rowTarget = document.createElement("div");
            rowTarget.className = "step-row";
            rowTarget.innerHTML = `<label style="font-size:0.68rem; width:48px;">Selector</label>`;
            const inputTarget = document.createElement("input");
            inputTarget.type = "text";
            inputTarget.className = "step-input";
            inputTarget.value = step.target || "";
            inputTarget.addEventListener("input", (e) => {
                step.target = e.target.value;
                saveStepsToBackground(steps);
            });
            rowTarget.appendChild(inputTarget);
            body.appendChild(rowTarget);
        }
        
        // Dòng Value (hiện nếu là goto, type, wait, click_xy hoặc call_api)
        if (step.action === "goto" || step.action === "type" || step.action === "wait" || step.action === "click_xy" || step.action === "call_api") {
            const rowVal = document.createElement("div");
            rowVal.className = "step-row";
            
            let labelText = "Giá trị";
            if (step.action === "goto") labelText = "URL";
            else if (step.action === "wait") labelText = "Mili giây";
            else if (step.action === "click_xy") labelText = "Tọa độ XY";
            
            rowVal.innerHTML = `<label style="font-size:0.68rem; width:48px;">${labelText}</label>`;
            
            const inputVal = document.createElement("input");
            inputVal.type = "text";
            inputVal.className = "step-input";
            inputVal.value = step.value || "";
            
            if (step.use_api && (step.action === "type" || step.action === "call_api")) {
                inputVal.placeholder = "Lấy từ API...";
                inputVal.disabled = true;
            }
            
            inputVal.addEventListener("input", (e) => {
                step.value = e.target.value;
                saveStepsToBackground(steps);
            });
            rowVal.appendChild(inputVal);
            body.appendChild(rowVal);
        }
        
        // Cấu hình gọi API (chỉ hiện đối với type, click, call_api)
        if (step.action === "type" || step.action === "click" || step.action === "call_api") {
            const apiToggle = document.createElement("div");
            apiToggle.className = "step-api-toggle";
            
            const apiChk = document.createElement("input");
            apiChk.type = "checkbox";
            apiChk.id = `use-api-${index}`;
            apiChk.checked = !!step.use_api;
            
            const apiLbl = document.createElement("label");
            apiLbl.htmlFor = `use-api-${index}`;
            apiLbl.innerHTML = `<i class="fa-solid fa-gears"></i> Cấu hình gọi API`;
            apiLbl.style.cursor = "pointer";
            
            apiToggle.appendChild(apiChk);
            apiToggle.appendChild(apiLbl);
            body.appendChild(apiToggle);
            
            // Panel cấu hình chi tiết API
            const apiPanel = document.createElement("div");
            apiPanel.className = "step-api-panel";
            apiPanel.style.display = step.use_api ? "flex" : "none";
            
            // Bật/tắt hiển thị Panel khi thay đổi checkbox
            apiChk.addEventListener("change", (e) => {
                step.use_api = e.target.checked;
                apiPanel.style.display = step.use_api ? "flex" : "none";
                saveStepsToBackground(steps);
                renderStepsPreview(steps);
            });
            
            // API URL
            const apiRowUrl = document.createElement("div");
            apiRowUrl.className = "step-row";
            apiRowUrl.innerHTML = `<label style="font-size:0.65rem; width:52px;">API URL</label>`;
            const apiInputUrl = document.createElement("input");
            apiInputUrl.type = "text";
            apiInputUrl.className = "step-input";
            apiInputUrl.placeholder = "http://127.0.0.1:5000/...";
            apiInputUrl.value = step.api_url || "";
            apiInputUrl.addEventListener("input", (e) => {
                step.api_url = e.target.value;
                saveStepsToBackground(steps);
            });
            apiRowUrl.appendChild(apiInputUrl);
            apiPanel.appendChild(apiRowUrl);
            
            // API Method & JSON Path
            const apiRowMethodPath = document.createElement("div");
            apiRowMethodPath.className = "step-row";
            
            apiRowMethodPath.innerHTML = `<label style="font-size:0.65rem; width:52px;">Method</label>`;
            const apiSelectMethod = document.createElement("select");
            apiSelectMethod.className = "step-select";
            apiSelectMethod.style.maxWidth = "60px";
            ["GET", "POST"].forEach(m => {
                const opt = document.createElement("option");
                opt.value = m;
                opt.innerText = m;
                if (step.api_method === m) opt.selected = true;
                apiSelectMethod.appendChild(opt);
            });
            apiSelectMethod.addEventListener("change", (e) => {
                step.api_method = e.target.value;
                saveStepsToBackground(steps);
                renderStepsPreview(steps);
            });
            apiRowMethodPath.appendChild(apiSelectMethod);
            
            const apiLblPath = document.createElement("label");
            apiLblPath.style.width = "56px";
            apiLblPath.style.textAlign = "right";
            apiLblPath.style.paddingRight = "4px";
            apiLblPath.style.fontSize = "0.65rem";
            apiLblPath.innerText = "JSON Path";
            apiRowMethodPath.appendChild(apiLblPath);
            
            const apiInputPath = document.createElement("input");
            apiInputPath.type = "text";
            apiInputPath.className = "step-input";
            apiInputPath.placeholder = "$.code";
            apiInputPath.value = step.api_json_path || "";
            apiInputPath.addEventListener("input", (e) => {
                step.api_json_path = e.target.value;
                saveStepsToBackground(steps);
            });
            apiRowMethodPath.appendChild(apiInputPath);
            
            apiPanel.appendChild(apiRowMethodPath);
            
            // POST Body (chỉ hiện nếu method là POST)
            if (step.api_method === "POST") {
                const apiRowBody = document.createElement("div");
                apiRowBody.className = "step-row";
                apiRowBody.innerHTML = `<label style="font-size:0.65rem; width:52px;">Body JSON</label>`;
                const apiInputBody = document.createElement("input");
                apiInputBody.type = "text";
                apiInputBody.className = "step-input";
                apiInputBody.placeholder = '{"key": "value"}';
                apiInputBody.value = step.api_body || "";
                apiInputBody.addEventListener("input", (e) => {
                    step.api_body = e.target.value;
                    saveStepsToBackground(steps);
                });
                apiRowBody.appendChild(apiInputBody);
                apiPanel.appendChild(apiRowBody);
            }

            // Headers
            const apiRowHeaders = document.createElement("div");
            apiRowHeaders.className = "step-row";
            apiRowHeaders.innerHTML = `<label style="font-size:0.65rem; width:52px;">Headers</label>`;
            const apiInputHeaders = document.createElement("input");
            apiInputHeaders.type = "text";
            apiInputHeaders.className = "step-input";
            apiInputHeaders.placeholder = '{"Content-Type": "json"}';
            apiInputHeaders.value = step.api_headers || "";
            apiInputHeaders.addEventListener("input", (e) => {
                step.api_headers = e.target.value;
                saveStepsToBackground(steps);
            });
            apiRowHeaders.appendChild(apiInputHeaders);
            apiPanel.appendChild(apiRowHeaders);
            
            body.appendChild(apiPanel);
        }
        
        card.appendChild(header);
        card.appendChild(body);
        stepsListContainer.appendChild(card);
    });
}

function swapSteps(steps, idx1, idx2) {
    const temp = steps[idx1];
    steps[idx1] = steps[idx2];
    steps[idx2] = temp;
    saveStepsToBackground(steps);
    renderStepsPreview(steps);
}

function deleteStep(steps, idx) {
    if (confirm(`Bạn có chắc muốn xóa bước ${idx + 1}?`)) {
        steps.splice(idx, 1);
        saveStepsToBackground(steps);
        renderStepsPreview(steps);
    }
}

function saveStepsToBackground(steps) {
    chrome.runtime.sendMessage({ action: "update_steps", steps: steps }, (res) => {});
    chrome.storage.local.set({ recordedSteps: steps });
}

// 12. Helpers UI & Switch Tabs
function addSystemLog(msg, scroll = true) {
    const time = new Date().toLocaleTimeString();
    if (systemLogContent.innerText === "Chưa kết nối tới thiết bị...") {
        systemLogContent.innerText = "";
    }
    
    if (msg.includes("[Tự động điền & Xác minh] Chúc mừng") || msg.includes("hoàn tất xác nhận thành công")) {
        btnMagic.disabled = false; // Mở khóa nút khi chạy xong
    }
    
    systemLogContent.innerText += `${msg}\n`;
    if (scroll) {
        systemLogContent.scrollTop = systemLogContent.scrollHeight;
    }
}

function switchTab(tab) {
    activeTab = tab;
    if (tab === "system") {
        tabSystem.className = "tab-btn active";
        tabSteps.className = "tab-btn";
        systemLogContent.style.display = "block";
        stepsPreviewContent.style.display = "none";
    } else {
        tabSystem.className = "tab-btn";
        tabSteps.className = "tab-btn active";
        systemLogContent.style.display = "none";
        stepsPreviewContent.style.display = "block";
    }
}

tabSystem.addEventListener("click", () => switchTab("system"));
tabSteps.addEventListener("click", () => switchTab("steps"));

function updateUIState(state) {
    chrome.storage.local.set({ recordingState: state });
    if (state === "recording") {
        btnRecord.style.display = "none";
        recControls.style.display = "block";
        btnPause.innerHTML = `<i class="fa-solid fa-pause"></i> Tạm dừng`;
        btnPause.className = "btn btn-pause";
    } else if (state === "paused") {
        btnRecord.style.display = "none";
        recControls.style.display = "block";
        btnPause.innerHTML = `<i class="fa-solid fa-play"></i> Tiếp tục`;
        btnPause.className = "btn btn-record";
    } else {
        btnRecord.style.display = "block";
        recControls.style.display = "none";
    }
}

function disableAllControls() {
    profileSelect.value = "";
    mcpToggle.disabled = true;
    mcpToggle.checked = false;
    mcpStatus.innerText = "🔴 Tắt";
    mcpStatus.className = "engine-status";
    
    puppeteerToggle.disabled = true;
    puppeteerToggle.checked = false;
    puppeteerStatus.innerText = "🔴 Tắt";
    puppeteerStatus.className = "engine-status";
    
    btnRecord.disabled = true;
    btnMagic.disabled = true;
}

// --- CẤU HÌNH & TƯƠNG TÁC CDP DEVTOOLS v2.9 ---
const cdpCommandInput = document.getElementById("mcp-cdp-command");
const cdpExecuteBtn = document.getElementById("mcp-cdp-execute-btn");
const cdpConsoleMonitor = document.getElementById("mcp-console-monitor");
const btnClearConsole = document.getElementById("btn-clear-console");
const smartWaitToggle = document.getElementById("mcp-smart-wait-toggle");

if (btnClearConsole) {
    btnClearConsole.addEventListener("click", () => {
        if (cdpConsoleMonitor) {
            cdpConsoleMonitor.innerHTML = `<span style="color: var(--text-secondary);">[Console] Logs cleared. Ready.</span>`;
        }
    });
}

// Khôi phục trạng thái Smart Wait từ bộ nhớ tiện ích
chrome.storage.local.get(["smartWaitEnabled"], (res) => {
    if (smartWaitToggle) {
        smartWaitToggle.checked = res.smartWaitEnabled !== false;
    }
});

if (smartWaitToggle) {
    smartWaitToggle.addEventListener("change", (e) => {
        chrome.storage.local.set({ smartWaitEnabled: e.target.checked });
        addSystemLog(`Đã ${e.target.checked ? "BẬT" : "TẮT"} chế độ tự động Smart Wait trên DevTools.`);
    });
}

async function sendCdpCommand() {
    if (!activeProfileId || !cdpCommandInput) return;
    const command = cdpCommandInput.value.trim();
    if (!command) return;
    
    cdpConsoleMonitor.innerHTML += `\n<span style="color: #6366f1;">&gt; Executing: ${command}...</span>`;
    cdpConsoleMonitor.scrollTop = cdpConsoleMonitor.scrollHeight;
    
    try {
        const parts = command.split(" ");
        const method = parts[0];
        let params = {};
        if (parts.length > 1) {
            try {
                params = JSON.parse(parts.slice(1).join(" "));
            } catch (e) {
                // Thử parse dạng key=value
                const paramStr = parts.slice(1).join(" ");
                if (paramStr.includes("=")) {
                    paramStr.split(",").forEach(p => {
                        const [k, v] = p.split("=");
                        if (k && v) params[k.trim()] = v.trim();
                    });
                }
            }
        }

        const res = await fetch(`${BACKEND_URL}/api/profiles/${activeProfileId}/cdp_send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ method, params })
        });
        const data = await res.json();
        if (data.success) {
            const resStr = JSON.stringify(data.result);
            cdpConsoleMonitor.innerHTML += `\n<span style="color: #10b981;">&lt; Success: ${resStr.substring(0, 120)}${resStr.length > 120 ? '...' : ''}</span>`;
        } else {
            cdpConsoleMonitor.innerHTML += `\n<span style="color: #ef4444;">&lt; Error: ${data.error}</span>`;
        }
    } catch (err) {
        cdpConsoleMonitor.innerHTML += `\n<span style="color: #ef4444;">&lt; Fetch Error: ${err.message}</span>`;
    }
    cdpConsoleMonitor.scrollTop = cdpConsoleMonitor.scrollHeight;
    cdpCommandInput.value = "";
}

if (cdpExecuteBtn) {
    cdpExecuteBtn.addEventListener("click", sendCdpCommand);
}
if (cdpCommandInput) {
    cdpCommandInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            sendCdpCommand();
        }
    });
}

// Khởi chạy
initPopup();
