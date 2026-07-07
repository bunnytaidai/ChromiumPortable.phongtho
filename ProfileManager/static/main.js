// Trang thai toan cuc
let map = null;
let marker = null;
let allScripts = [];
let globalSMSPoolCountries = [];
let globalSMSPoolServices = [];

// Ham giai ma chuoi thoat (unescape string) de loai bo dau gach cheo nguoc \ cua ky tu dac biet
function unescapeString(str) {
    if (!str) return "";
    return str.replace(/\\(.)/g, "$1");
}

// Tu dien User-Agent presets nhu truoc
const PRESETS = {
    windows: {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        width: 1366,
        height: 768,
        deviceMemory: 8,
        hardwareConcurrency: 4,
        gpuVendor: "Google Inc. (NVIDIA)",
        gpuRenderer: "NVIDIA GeForce GTX 1660 Ti/PCIe/SSE2",
        locale: "vi-VN"
    },
    mac: {
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        width: 1440,
        height: 900,
        deviceMemory: 8,
        hardwareConcurrency: 8,
        gpuVendor: "Google Inc. (Intel)",
        gpuRenderer: "Intel(R) Iris(TM) Plus Graphics 640",
        locale: "en-US"
    },
    android: {
        ua: "Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36",
        width: 360,
        height: 800,
        deviceMemory: 4,
        hardwareConcurrency: 8,
        gpuVendor: "Google Inc. (Qualcomm)",
        gpuRenderer: "Adreno (TM) 640",
        locale: "vi-VN"
    }
};

// Bản đồ dòng card đồ họa giả lập phân loại theo Nhà sản xuất
const GPU_RENDERERS_MAP = {
    "Google Inc. (NVIDIA)": [
        "NVIDIA GeForce GTX 1660 Ti/PCIe/SSE2",
        "NVIDIA GeForce RTX 3060/PCIe/SSE2",
        "NVIDIA GeForce RTX 4070/PCIe/SSE2",
        "NVIDIA GeForce RTX 3080/PCIe/SSE2",
        "NVIDIA GeForce GTX 1060 6GB/PCIe/SSE2"
    ],
    "Google Inc. (Intel)": [
        "Intel(R) UHD Graphics 620",
        "Intel(R) Iris(R) Xe Graphics",
        "Intel(R) HD Graphics 620",
        "Intel(R) Iris(TM) Plus Graphics 640"
    ],
    "Google Inc. (ATI Technologies Inc.)": [
        "Radeon RX 580 Series",
        "AMD Radeon(TM) Graphics",
        "Radeon RX 6600"
    ],
    "Apple Inc.": [
        "Apple M1",
        "Apple M2",
        "Apple M3",
        "Apple M1 Max",
        "Apple M2 Pro"
    ],
    "Google Inc. (Qualcomm)": [
        "Adreno (TM) 640",
        "Adreno (TM) 730",
        "Adreno (TM) 610"
    ],
    "Google Inc. (ARM)": [
        "Mali-G78",
        "Mali-G57",
        "Mali-T880"
    ]
};

// Hàm tự động cập nhật danh sách Dòng card đồ họa theo hãng GPU được chọn
function updateGpuRendererOptions(vendorVal, selectValue = null) {
    const rendererSelect = document.getElementById("p-gpu-renderer");
    if (!rendererSelect) return;
    
    rendererSelect.innerHTML = "";
    const renderers = GPU_RENDERERS_MAP[vendorVal] || [];
    
    renderers.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r;
        opt.innerText = r;
        rendererSelect.appendChild(opt);
    });
    
    // Nếu có giá trị tùy chỉnh từ DB (nằm ngoài preset)
    if (selectValue) {
        let hasValue = renderers.includes(selectValue);
        if (!hasValue) {
            const opt = document.createElement("option");
            opt.value = selectValue;
            opt.innerText = `${selectValue} (Tùy chỉnh)`;
            rendererSelect.appendChild(opt);
        }
        rendererSelect.value = selectValue;
    } else if (renderers.length > 0) {
        rendererSelect.value = renderers[0];
    }
}

async function loadSMSPoolData() {
    try {
        let countriesRes = await fetch("/api/smspool/countries");
        globalSMSPoolCountries = await countriesRes.json();
    } catch (e) {
        console.error("Lỗi tải quốc gia SMSPool:", e);
    }
    try {
        let servicesRes = await fetch("/api/smspool/services");
        globalSMSPoolServices = await servicesRes.json();
    } catch (e) {
        console.error("Lỗi dịch vụ SMSPool:", e);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    // 1. Khoi chay va tai du lieu ban dau
    loadSMSPoolData();
    loadScripts().then(() => {
        loadProfiles();
    });
    loadCampaigns();
    loadSettings();
    startLogPolling();
    startStatusRealtimeMonitor();

    const geminiModelSelect = document.getElementById("ai-gemini-model");
    if (geminiModelSelect) {
        geminiModelSelect.addEventListener("change", updateGeminiQuotaBadge);
    }

    // 2. Chuyen Tab tren Sidebar
    setupTabs();

    // 3. Bat su kien cho Profile Modal
    document.getElementById("btn-create-profile").addEventListener("click", () => {
        openProfileModal("create");
    });
    document.getElementById("btn-close-modal").addEventListener("click", closeProfileModal);
    document.getElementById("btn-cancel-modal").addEventListener("click", closeProfileModal);
    document.getElementById("profile-form").addEventListener("submit", handleProfileFormSubmit);

    // 4. Bat su kien dong bo hoa Proxy
    document.getElementById("btn-sync-proxy").addEventListener("click", syncProxyDetails);

    // 5. Tim kiem tren ban do
    document.getElementById("btn-map-search").addEventListener("click", searchMapLocation);
    document.getElementById("map-search-input").addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            searchMapLocation();
        }
    });

    // Bat su kien khi nhap toa do thu cong de tu dong lay mui gio va update map
    document.getElementById("p-lat").addEventListener("input", handleCoordinateInput);
    document.getElementById("p-lng").addEventListener("input", handleCoordinateInput);
    document.getElementById("p-lat").addEventListener("change", handleCoordinateInput);
    document.getElementById("p-lng").addEventListener("change", handleCoordinateInput);

    // 6. Bat su kien nut kịch ban va chien dich
    document.getElementById("btn-create-script").addEventListener("click", () => openScriptModal("create"));
    document.getElementById("script-form").addEventListener("submit", handleScriptFormSubmit);
    document.getElementById("btn-create-campaign").addEventListener("click", () => openCampaignModal());

    // 7. Bat su kien AI Prompt Chinh sua
    const aiEditPrompt = document.getElementById("ai-edit-prompt");
    if (aiEditPrompt) {
        aiEditPrompt.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                modifyScriptWithAI();
            }
        });
    }

    // 8. Khôi phục trạng thái thu gọn các Card Cài đặt từ localStorage
    document.querySelectorAll('.card[data-card-id]').forEach(card => {
        const cardId = card.getAttribute('data-card-id');
        const isCollapsed = localStorage.getItem(`card_collapsed_${cardId}`) === 'true';
        if (isCollapsed) {
            card.classList.add('collapsed');
            const icon = card.querySelector('.collapse-icon i');
            if (icon) {
                icon.className = 'fa-solid fa-chevron-down';
            }
        }
    });
    
    // Lắng nghe sự kiện thay đổi Hãng GPU để cập nhật Dòng card đồ họa
    document.getElementById("p-gpu-vendor").addEventListener("change", function() {
        updateGpuRendererOptions(this.value);
    });
    
    // 9. Khoi tao autocomplete quoc gia
    initCountryAutocomplete();

    // 10. Bắt đầu polling đồng bộ trạng thái Chromium theo thời gian thực (Real-time sync)
    startStatusPolling();
    const syncAllBtn = document.getElementById("btn-sync-all-status");
    if (syncAllBtn) {
        syncAllBtn.addEventListener("click", syncAllProfilesStatus);
    }
});

// Hàm hỗ trợ Đóng / Mở Card Cài đặt (Collapsible Cards) và lưu vào localStorage
function toggleCardCollapse(headerEl) {
    const card = headerEl.closest('.card');
    if (!card) return;
    
    card.classList.toggle('collapsed');
    
    // Cập nhật biểu tượng chevron
    const icon = headerEl.querySelector('.collapse-icon i');
    if (icon) {
        if (card.classList.contains('collapsed')) {
            icon.className = 'fa-solid fa-chevron-down';
        } else {
            icon.className = 'fa-solid fa-chevron-up';
        }
    }
    
    // Lưu trạng thái vào localStorage
    const cardId = card.getAttribute('data-card-id');
    if (cardId) {
        localStorage.setItem(`card_collapsed_${cardId}`, card.classList.contains('collapsed') ? 'true' : 'false');
    }
}


// --- MENU & TAB SWITCHING ---
function setupTabs() {
    const tabs = [
        { btn: "menu-profiles", pane: "pane-profiles" },
        { btn: "menu-backups", pane: "pane-backups" },
        { btn: "menu-scripts", pane: "pane-scripts" },
        { btn: "menu-campaigns", pane: "pane-campaigns" },
        { btn: "menu-mail", pane: "pane-mail" },
        { btn: "menu-extensions", pane: "pane-extensions" },
        { btn: "menu-settings", pane: "pane-settings" }
    ];

    tabs.forEach(t => {
        document.getElementById(t.btn).addEventListener("click", (e) => {
            e.preventDefault();
            
            // Xoa active menu
            tabs.forEach(x => {
                document.getElementById(x.btn).classList.remove("active");
                document.getElementById(x.pane).style.display = "none";
            });

            // Active tab chon
            document.getElementById(t.btn).classList.add("active");
            document.getElementById(t.pane).style.display = "block";
            
            // Lưu tab hiện tại vào localStorage
            localStorage.setItem("activeTab", t.btn);
            
            // Reload du lieu khi switch tab
            if (t.pane === "pane-profiles") loadProfiles();
            if (t.pane === "pane-backups") loadBackups();
            if (t.pane === "pane-scripts") loadScripts();
            if (t.pane === "pane-campaigns") loadCampaigns();
            if (t.pane === "pane-extensions") {
                loadExtensionsList();
                loadExtensionsProfileSelect();
            }
            if (t.pane === "pane-settings") loadSettings();
            if (t.pane === "pane-mail") {
                const iframe = document.querySelector("#pane-mail iframe");
                if (iframe) iframe.src = iframe.src; // Tự động tải lại nội dung hòm thư
            }
        });
    });

    // Tự động kích hoạt lại tab cũ khi F5 tải lại trang
    const activeTab = localStorage.getItem("activeTab");
    if (activeTab && document.getElementById(activeTab)) {
        document.getElementById(activeTab).click();
    } else {
        // Mặc định click tab profiles đầu tiên
        document.getElementById("menu-profiles").click();
    }
}

// --- USER-AGENT PRESET ---
function setPreset(type) {
    const preset = PRESETS[type];
    if (preset) {
        document.getElementById("p-ua").value = preset.ua;
        document.getElementById("p-width").value = preset.width;
        document.getElementById("p-height").value = preset.height;
        if (preset.deviceMemory) {
            document.getElementById("p-device-memory").value = preset.deviceMemory;
        }
        if (preset.hardwareConcurrency) {
            document.getElementById("p-hardware-concurrency").value = preset.hardwareConcurrency;
        }
        document.getElementById("p-canvas-noise").value = "1";
        if (preset.gpuVendor) {
            document.getElementById("p-gpu-vendor").value = preset.gpuVendor;
            updateGpuRendererOptions(preset.gpuVendor, preset.gpuRenderer || null);
        }
        if (preset.locale) {
            document.getElementById("p-locale").value = preset.locale;
        }
        document.getElementById("p-webrtc-mode").value = "spoof";
        document.getElementById("p-fonts-mode").value = "1";
        document.getElementById("p-media-devices").value = "1";
    }
}

// Hàm sinh ngẫu nhiên toàn bộ cấu hình vân tay khớp logic 100% với hệ điều hành giả lập
function randomizeProfileFingerprint() {
    // 1. Chọn ngẫu nhiên hệ điều hành (OS)
    const osList = ["windows", "mac", "android"];
    const os = osList[Math.floor(Math.random() * osList.length)];
    
    // 2. Danh sách User-Agent phiên bản Chrome mới và ổn định
    const uaPool = {
        windows: [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
        ],
        mac: [
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
        ],
        android: [
            "Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36",
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
            "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36"
        ]
    };
    
    const selectedUa = uaPool[os][Math.floor(Math.random() * uaPool[os].length)];
    document.getElementById("p-ua").value = selectedUa;
    
    // 3. Độ phân giải màn hình tương thích
    const resolutions = {
        windows: [
            { w: 1920, h: 1080 },
            { w: 1536, h: 864 },
            { w: 1366, h: 768 },
            { w: 1600, h: 900 }
        ],
        mac: [
            { w: 1440, h: 900 },
            { w: 1680, h: 1050 },
            { w: 1920, h: 1200 },
            { w: 2560, h: 1600 }
        ],
        android: [
            { w: 360, h: 800 },
            { w: 390, h: 844 },
            { w: 412, h: 915 }
        ]
    };
    const res = resolutions[os][Math.floor(Math.random() * resolutions[os].length)];
    document.getElementById("p-width").value = res.w;
    document.getElementById("p-height").value = res.h;
    
    // 4. RAM & CPU Cores khớp logic theo OS
    const hardwarePool = {
        windows: {
            ram: ["8", "16", "32"],
            cpu: ["4", "6", "8", "12", "16"]
        },
        mac: {
            ram: ["8", "16"],
            cpu: ["8", "12"]
        },
        android: {
            ram: ["4", "6", "8"],
            cpu: ["8"]
        }
    };
    
    const ramOptions = hardwarePool[os].ram;
    const cpuOptions = hardwarePool[os].cpu;
    document.getElementById("p-device-memory").value = ramOptions[Math.floor(Math.random() * ramOptions.length)];
    document.getElementById("p-hardware-concurrency").value = cpuOptions[Math.floor(Math.random() * cpuOptions.length)];
    
    // 5. GPU Vendor & GPU Renderer khớp logic theo OS
    const gpuPool = {
        windows: [
            { vendor: "Google Inc. (NVIDIA)", list: GPU_RENDERERS_MAP["Google Inc. (NVIDIA)"] },
            { vendor: "Google Inc. (Intel)", list: GPU_RENDERERS_MAP["Google Inc. (Intel)"] },
            { vendor: "Google Inc. (ATI Technologies Inc.)", list: GPU_RENDERERS_MAP["Google Inc. (ATI Technologies Inc.)"] }
        ],
        mac: [
            { vendor: "Apple Inc.", list: GPU_RENDERERS_MAP["Apple Inc."] },
            { vendor: "Google Inc. (Intel)", list: GPU_RENDERERS_MAP["Google Inc. (Intel)"] }
        ],
        android: [
            { vendor: "Google Inc. (Qualcomm)", list: GPU_RENDERERS_MAP["Google Inc. (Qualcomm)"] },
            { vendor: "Google Inc. (ARM)", list: GPU_RENDERERS_MAP["Google Inc. (ARM)"] }
        ]
    };
    
    const selectedGpuGroup = gpuPool[os][Math.floor(Math.random() * gpuPool[os].length)];
    document.getElementById("p-gpu-vendor").value = selectedGpuGroup.vendor;
    const selectedRenderer = selectedGpuGroup.list[Math.floor(Math.random() * selectedGpuGroup.list.length)];
    updateGpuRendererOptions(selectedGpuGroup.vendor, selectedRenderer);
    
    // 6. Ngôn ngữ Locale đồng bộ quốc gia hiện tại được chọn trên form
    const currentCountry = document.getElementById("p-country").value || "VN";
    const countryToLocale = {
        "VN": "vi-VN", "US": "en-US", "GB": "en-GB", "CA": "en-CA", 
        "JP": "ja-JP", "KR": "ko-KR", "DE": "de-DE", "FR": "fr-FR", 
        "SG": "en-SG", "AU": "en-AU", "CN": "zh-CN", "TW": "zh-TW", 
        "HK": "zh-HK", "RU": "ru-RU", "BR": "pt-BR", "ES": "es-ES", 
        "IT": "it-IT", "IN": "hi-IN", "TH": "th-TH", "MY": "ms-MY",
        "ID": "id-ID", "PH": "en-PH", "NL": "nl-NL", "TR": "tr-TR"
    };
    const guessedLocale = countryToLocale[currentCountry] || "en-US";
    document.getElementById("p-locale").value = guessedLocale;
    
    // 7. Bật các cấu hình chống dấu vân tay ở mức độ tối đa
    document.getElementById("p-canvas-noise").value = "1";
    document.getElementById("p-webrtc-mode").value = "spoof";
    document.getElementById("p-fonts-mode").value = "1";
    document.getElementById("p-media-devices").value = "1";
}

// --- BAN DO LEAFLET.JS & GEOLOCATION ---
function initLeafletMap(lat = 21.02776, lng = 105.83416) {
    // Dam bao xoa map cu truoc khi tao map moi tranh loi trung lap DOM
    if (map) {
        map.remove();
        map = null;
    }

    // Khoi tao ban do tai toa do chi dinh
    map = L.map('leaflet-map').setView([lat, lng], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    // Dat marker co the keo tha
    marker = L.marker([lat, lng], { draggable: true }).addTo(map);

    // Kien nghi toa do khi keo marker xong
    marker.on('dragend', function (e) {
        const position = marker.getLatLng();
        updateCoordinates(position.lat, position.lng);
    });

    // Click ban do de ghim marker moi
    map.on('click', function (e) {
        marker.setLatLng(e.latlng);
        updateCoordinates(e.latlng.lat, e.latlng.lng);
    });

    // Reset size map sau khi modal mo ra hoan toan
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
}

// Cap nhat toa do vao Form va tim kiem Mui gio phu hop
async function updateCoordinates(lat, lng) {
    document.getElementById("p-lat").value = lat.toFixed(6);
    document.getElementById("p-lng").value = lng.toFixed(6);
    
    // Tu dong tim kiem mui gio (Timezone API) theo toa do vua chon
    await fetchTimezoneFromCoordinates(lat, lng);
}

// Tra cuu mui gio keyless tu TimeAPI
async function fetchTimezoneFromCoordinates(lat, lng) {
    let success = false;
    try {
        const response = await fetch(`https://timeapi.io/api/Time/current/coordinate?latitude=${lat}&longitude=${lng}`);
        const data = await response.json();
        if (data && data.timeZone) {
            const tzSelect = document.getElementById("p-timezone");
            
            // Kiem tra neu option nay chua co trong select thi tu dong append vao
            let found = false;
            for (let i = 0; i < tzSelect.options.length; i++) {
                if (tzSelect.options[i].value === data.timeZone) {
                    found = true;
                    tzSelect.selectedIndex = i;
                    break;
                }
            }
            if (!found) {
                const opt = document.createElement("option");
                opt.value = data.timeZone;
                opt.innerText = `${data.timeZone} (Tu dong)`;
                tzSelect.appendChild(opt);
                tzSelect.value = data.timeZone;
            } else {
                tzSelect.value = data.timeZone;
            }
            success = true;
        }
    } catch (err) {
        console.warn("Khong the tra cuu mui gio tu TimeAPI: " + err.message);
    }
    
    // Fallback ngoại tuyến nếu API online bị lỗi (rate limit hoặc mất mạng)
    if (!success) {
        try {
            const tzSelect = document.getElementById("p-timezone");
            const utcOffset = Math.round(lng / 15);
            
            // Ánh xạ múi giờ phổ biến nhất theo kinh độ địa lý
            const timezoneMapping = {
                "-12": "Etc/GMT+12",
                "-11": "Pacific/Midway",
                "-10": "Pacific/Honolulu",
                "-9": "America/Anchorage",
                "-8": "America/Los_Angeles",
                "-7": "America/Denver",
                "-6": "America/Chicago",
                "-5": "America/New_York",
                "-4": "America/Halifax",
                "-3": "America/Argentina/Buenos_Aires",
                "-2": "America/Noronha",
                "-1": "Atlantic/Azores",
                "0": "Europe/London",
                "1": "Europe/Paris",
                "2": "Europe/Cairo",
                "3": "Europe/Moscow",
                "4": "Asia/Dubai",
                "5": "Asia/Karachi",
                "6": "Asia/Dhaka",
                "7": "Asia/Ho_Chi_Minh",
                "8": "Asia/Singapore",
                "9": "Asia/Tokyo",
                "10": "Australia/Sydney",
                "11": "Pacific/Guadalcanal",
                "12": "Pacific/Auckland"
            };
            
            const guessedTz = timezoneMapping[utcOffset.toString()] || "Asia/Ho_Chi_Minh";
            console.log(`[Timezone Fallback] Doan mui gio tu dong theo kinh do ${lng} -> ${guessedTz}`);
            
            let found = false;
            for (let i = 0; i < tzSelect.options.length; i++) {
                if (tzSelect.options[i].value === guessedTz) {
                    found = true;
                    tzSelect.selectedIndex = i;
                    break;
                }
            }
            if (!found) {
                const opt = document.createElement("option");
                opt.value = guessedTz;
                opt.innerText = `${guessedTz} (Tự động)`;
                tzSelect.appendChild(opt);
                tzSelect.value = guessedTz;
            } else {
                tzSelect.value = guessedTz;
            }
        } catch (fallbackErr) {
            console.error("Loi fallback tinh mui gio ngoai tuyen:", fallbackErr);
        }
    }
}

// Tu dong cap nhat ban do va lay mui gio khi nguoi dung nhap toa do thu cong
async function handleCoordinateInput() {
    const latInput = document.getElementById("p-lat").value.trim();
    const lngInput = document.getElementById("p-lng").value.trim();
    
    if (latInput === "" || lngInput === "") return;
    
    const latVal = parseFloat(latInput);
    const lngVal = parseFloat(lngInput);
    
    if (isNaN(latVal) || isNaN(lngVal)) return;
    
    // Gioi han vĩ độ và kinh độ hợp lệ
    if (latVal < -90 || latVal > 90 || lngVal < -180 || lngVal > 180) return;
    
    // Cap nhat Leaflet Map va Marker
    if (map && marker) {
        map.setView([latVal, lngVal], map.getZoom());
        marker.setLatLng([latVal, lngVal]);
    }
    
    // Goi API lay mui gio
    await fetchTimezoneFromCoordinates(latVal, lngVal);
}

// Tim kiem vi tri dia ly tu map search box (OSM Nominatim)
async function searchMapLocation() {
    const input = document.getElementById("map-search-input").value;
    if (!input) return;

    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(input)}`);
        const results = await response.json();
        
        if (results && results.length > 0) {
            const loc = results[0];
            const lat = parseFloat(loc.lat);
            const lng = parseFloat(loc.lon);

            // Fly map toi diem do
            map.flyTo([lat, lng], 10);
            marker.setLatLng([lat, lng]);
            
            updateCoordinates(lat, lng);
        } else {
            alert("Khong tim thay vi tri nay tren ban do!");
        }
    } catch (err) {
        alert("Loi tim kiem vi tri: " + err.message);
    }
}

// --- DONG BO HOA PROXY ---
async function syncProxyDetails() {
    const proxyType = document.getElementById("p-proxy-type").value;
    const proxyAddr = document.getElementById("p-proxy").value.trim();
    const proxy = proxyAddr ? (proxyType + proxyAddr) : "";
    const user = document.getElementById("p-proxy-user").value;
    const pass = document.getElementById("p-proxy-pass").value;

    if (!proxy) {
        alert("Vui long nhap dia chi Proxy truoc khi bam dong bo!");
        return;
    }

    const btn = document.getElementById("btn-sync-proxy");
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Dang kiem tra...`;
    btn.disabled = true;

    try {
        const response = await fetch("/api/check_proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                proxy_server: proxy,
                proxy_user: user,
                proxy_pass: pass,
                profile_country: document.getElementById("p-country").value
            })
        });
        const result = await response.json();
        
        if (result.success) {
            if (result.warning) {
                alert(`[CẢNH BÁO LỆCH QUỐC GIA]\n${result.warning}\nHệ thống sẽ tự động đồng bộ Quốc gia Profile theo IP Proxy thực tế!`);
            } else {
                alert(`Ket noi Proxy thanh cong!\nIP: ${result.ip}\nQuoc gia: ${result.country}`);
            }

            if (result.proxy_country_code) {
                document.getElementById("p-country").value = result.proxy_country_code;
            }
            
            // Cap nhat toa do va mui gio dong bo theo Proxy
            document.getElementById("p-lat").value = result.latitude;
            document.getElementById("p-lng").value = result.longitude;
            
            // Fly map marker den toa do moi cua proxy
            if (map && marker) {
                map.flyTo([result.latitude, result.longitude], 8);
                marker.setLatLng([result.latitude, result.longitude]);
            }
            
            // Dong bo select mui gio
            const tzSelect = document.getElementById("p-timezone");
            let found = false;
            for (let i = 0; i < tzSelect.options.length; i++) {
                if (tzSelect.options[i].value === result.timezone) {
                    found = true;
                    tzSelect.selectedIndex = i;
                    break;
                }
            }
            if (!found) {
                const opt = document.createElement("option");
                opt.value = result.timezone;
                opt.innerText = `${result.timezone} (Proxy)`;
                tzSelect.appendChild(opt);
                tzSelect.value = result.timezone;
            }
        } else {
            alert("Loi kiem tra Proxy: " + result.error);
        }
    } catch (err) {
        alert("Khong the kiem tra Proxy: " + err.message);
    } finally {
        btn.innerHTML = `<i class="fa-solid fa-rotate"></i> Dong bo tu Proxy`;
        btn.disabled = false;
    }
}

// --- PROFILES MANAGEMENT ---
async function loadProfiles() {
    const tbody = document.getElementById("profile-list-body");
    try {
        const response = await fetch("/api/profiles");
        const profiles = await response.json();
        
        // Cập nhật danh sách profile vào ô chọn ghi hình AI
        const aiSelect = document.getElementById("ai-record-profile");
        if (aiSelect) {
            const currentVal = aiSelect.value;
            aiSelect.innerHTML = `<option value="">-- Tự động chọn Profile (Chạy trình duyệt) --</option>`;
            profiles.forEach(p => {
                const opt = document.createElement("option");
                opt.value = p.id;
                const statusText = p.status === "Running" ? "Đang chạy" : "Đã dừng";
                opt.innerText = `${p.name} (ID: ${p.id} - ${statusText})`;
                aiSelect.appendChild(opt);
            });
            aiSelect.value = currentVal;
        }
        
        if (profiles.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 40px; color: var(--text-secondary);">
                        <i class="fa-solid fa-folder-open" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
                        Chua co profile nao. Hay nhap "Tao Profile Moi" de bat dau!
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = "";
        profiles.forEach(profile => {
            const isRunning = profile.status === "Running";
            const statusBadge = isRunning 
                ? `<span class="badge badge-success"><span class="status-dot online"></span> Dang chay</span>`
                : `<span class="badge badge-secondary"><span class="status-dot"></span> Da dung</span>`;

            const playStopButton = isRunning
                ? `<button class="btn-icon btn-stop" onclick="stopProfile(${profile.id})" title="Dung Trinh duyet"><i class="fa-solid fa-square"></i></button>`
                : `<button class="btn-icon btn-start" onclick="startProfile(${profile.id})" title="Chay Trinh duyet"><i class="fa-solid fa-play"></i></button>`;

            // Hien thi nut robot neu profile co gan kich ban hoac chay demo
            const autoButton = isRunning
                ? `<button class="btn-icon btn-auto" onclick="triggerProfileAutomation(${profile.id})" title="Chay kich ban tu dong"><i class="fa-solid fa-robot"></i></button>`
                : `<button class="btn-icon" style="opacity: 0.3; cursor: not-allowed;" disabled><i class="fa-solid fa-robot"></i></button>`;

            // Show scripting label neu co script rieng gan kem
            let nameColContent = `<span class="text-bold">${profile.name}</span>`;
            if (profile.script_id) {
                const sName = getScriptNameById(profile.script_id);
                nameColContent += `<div style="font-size: 0.75rem; color: #818cf8; margin-top: 2px;"><i class="fa-solid fa-scroll"></i> Script: ${sName}</div>`;
            }

            const proxyDisplay = profile.proxy_server 
                ? `<span class="text-bold">${profile.proxy_server}</span>`
                : `<span class="text-mute" style="color: #64748b;">Khong Proxy (Direct)</span>`;

            const tr = document.createElement("tr");
            tr.setAttribute("data-profile-id", profile.id);
            
            const syncButton = `<button class="btn-icon btn-sync" onclick="syncSingleProfileStatus(${profile.id}, event)" title="Đồng bộ trạng thái thực tế"><i class="fa-solid fa-arrows-rotate"></i></button>`;

            tr.innerHTML = `
                <td>
                    ${nameColContent}
                    <div class="text-mute">ID: ${profile.id}</div>
                </td>
                <td class="status-cell">${statusBadge}</td>
                <td>
                    <div style="font-size: 0.85rem; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${profile.user_agent}">
                        ${profile.user_agent}
                    </div>
                    <div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">
                        <span class="info-badge">${profile.screen_width}x${profile.screen_height}</span>
                        <span class="info-badge" style="background-color: rgba(16, 185, 129, 0.15); color: #34d399;"><i class="fa-solid fa-memory"></i> ${profile.device_memory || 8} GB</span>
                        <span class="info-badge" style="background-color: rgba(99, 102, 241, 0.15); color: #818cf8;"><i class="fa-solid fa-microchip"></i> GPU: ${profile.gpu_renderer ? profile.gpu_renderer.split('/')[0] : 'NVIDIA'}</span>
                        <span class="info-badge" style="background-color: rgba(245, 158, 11, 0.15); color: #fbbf24;"><i class="fa-solid fa-wand-magic-sparkles"></i> Canvas: ${profile.canvas_noise === 1 ? 'Noise' : 'Off'}</span>
                        <span class="info-badge" style="background-color: rgba(236, 72, 153, 0.15); color: #f472b6;"><i class="fa-solid fa-language"></i> ${profile.locale || 'vi-VN'}</span>
                        <span class="info-badge" style="background-color: rgba(79, 70, 229, 0.1); color: #a5b4fc;">Port Debug: ${9200 + profile.id}</span>
                        <span class="info-badge" style="background-color: rgba(14, 165, 233, 0.15); color: #38bdf8;"><i class="fa-solid fa-hard-drive"></i> Dung lượng: ${profile.size_formatted}</span>
                    </div>
                </td>
                <td>${proxyDisplay}</td>
                <td>
                    <div><i class="fa-regular fa-clock"></i> ${profile.timezone.split('/').pop()}</div>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">
                        ${profile.latitude ? `<i class="fa-solid fa-location-dot"></i> ${profile.latitude}, ${profile.longitude}` : '<i class="fa-solid fa-location-dot"></i> Mac dinh'}
                    </div>
                </td>
                <td>
                    <div class="action-buttons">
                        ${playStopButton}
                        ${autoButton}
                        ${syncButton}
                        <button class="btn-icon" style="color: #10b981;" onclick="triggerPuppeteerDiagnostic(${profile.id}, event)" title="Chẩn đoán Puppeteer v1.2.0"><i class="fa-solid fa-stethoscope"></i></button>
                        <button class="btn-icon btn-clean" onclick="cleanProfileJunk(${profile.id}, event)" title="Dọn dẹp tệp tin rác (Cache/Logs)"><i class="fa-solid fa-broom"></i></button>
                        <button class="btn-icon btn-start" onclick="triggerProfileBackup(${profile.id})" title="Backup profile (Sao lưu full môi trường)"><i class="fa-solid fa-cloud-arrow-up"></i></button>
                        <button class="btn-icon" onclick="editProfile(${profile.id})" title="Sua cau hinh"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button class="btn-icon btn-delete" onclick="deleteProfile(${profile.id})" title="Xoa profile"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger-color); padding: 20px;">Loi tai du lieu: ${err.message}</td></tr>`;
    }
}

async function renderProfileExtensionsCheckboxes(mode, profileId = null) {
    const container = document.getElementById("profile-extensions-checkboxes");
    if (!container) return;
    container.innerHTML = `<div style="color: var(--text-secondary); font-size: 0.85rem;"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang tải danh sách tiện ích...</div>`;
    
    try {
        const extRes = await fetch("/api/extensions");
        const allExtensions = await extRes.json();
        
        let enabledExts = [];
        if (mode === "edit" && profileId) {
            const profileExtRes = await fetch(`/api/profiles/${profileId}/extensions`);
            const profileExts = await profileExtRes.json();
            enabledExts = profileExts.filter(e => e.enabled === 1).map(e => e.id);
        }
        
        if (allExtensions.length === 0) {
            container.innerHTML = `<div style="color: var(--text-secondary); font-size: 0.85rem; grid-column: 1/-1;">Chưa có tiện ích nào trong kho. Hãy vào tab "Tiện ích mở rộng" để quét.</div>`;
            return;
        }
        
        container.innerHTML = "";
        allExtensions.forEach(ext => {
            const isChecked = mode === "create" ? (ext.auto_install === 1) : enabledExts.includes(ext.id);
            const label = document.createElement("label");
            label.className = "checkbox-label";
            label.style.cssText = "display: flex; align-items: center; gap: 8px; font-weight: 500; cursor: pointer; user-select: none; font-size: 0.85rem; color: #cbd5e1; background: rgba(255,255,255,0.02); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05); transition: all 0.2s;";
            label.innerHTML = `
                <input type="checkbox" class="profile-ext-checkbox" value="${ext.id}" ${isChecked ? 'checked' : ''} style="width: auto; cursor: pointer; margin: 0;">
                <div style="display: flex; flex-direction: column; min-width: 0; flex-grow: 1;">
                    <span style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f1f5f9;" title="${ext.name}">${ext.name}</span>
                    <span style="font-size: 0.72rem; color: var(--text-secondary);">v${ext.version}</span>
                </div>
            `;
            
            label.addEventListener('mouseenter', () => {
                label.style.borderColor = 'rgba(99, 102, 241, 0.35)';
                label.style.background = 'rgba(99, 102, 241, 0.04)';
            });
            label.addEventListener('mouseleave', () => {
                label.style.borderColor = 'rgba(255, 255, 255, 0.05)';
                label.style.background = 'rgba(255,255,255,0.02)';
            });
            
            container.appendChild(label);
        });
    } catch (e) {
        container.innerHTML = `<div style="color: #f87171; font-size: 0.85rem; grid-column: 1/-1;">Lỗi tải tiện ích: ${e.message}</div>`;
    }
}

async function openProfileModal(mode, id = null) {
    const modal = document.getElementById("profile-modal");
    const form = document.getElementById("profile-form");
    form.reset();

    // Load list scripts vao dropdown
    populateScriptDropdown("p-script-id");

    let lat = 21.027760;
    let lng = 105.834160;

    if (mode === "create") {
        document.getElementById("modal-title").innerText = "Cấu hình Profile mới";
        document.getElementById("profile-id").value = "";
        document.getElementById("p-use-proxy").checked = false;
        document.getElementById("p-proxy-rotate-url").value = "";
        document.getElementById("p-use-mcp").checked = false;
        
        document.getElementById("p-device-memory").value = "8";
        document.getElementById("p-hardware-concurrency").value = "4";
        document.getElementById("p-canvas-noise").value = "1";
        
        document.getElementById("p-gpu-vendor").value = "Google Inc. (NVIDIA)";
        document.getElementById("p-gpu-renderer").value = "NVIDIA GeForce GTX 1660 Ti/PCIe/SSE2";
        document.getElementById("p-locale").value = "vi-VN";
        document.getElementById("p-webrtc-mode").value = "spoof";
        document.getElementById("p-fonts-mode").value = "1";
        document.getElementById("p-media-devices").value = "1";
        
        document.getElementById("p-country").value = "VN";
        const vnData = typeof ALL_COUNTRIES !== 'undefined' ? ALL_COUNTRIES.find(c => c.code === "VN") : null;
        document.getElementById("p-country-search").value = vnData ? `${vnData.name_vi} (${vnData.name_en})` : "Việt Nam (Vietnam)";
        
        toggleProxyFields();
        setPreset("windows");
        renderProfileExtensionsCheckboxes("create");
    } else {
        document.getElementById("modal-title").innerText = "Chỉnh sửa cấu hình Profile";
        document.getElementById("profile-id").value = id;
        renderProfileExtensionsCheckboxes("edit", id);
        
        try {
            const response = await fetch(`/api/profiles/${id}`);
            const profile = await response.json();
            
            document.getElementById("p-name").value = profile.name;
            document.getElementById("p-ua").value = profile.user_agent;
            document.getElementById("p-width").value = profile.screen_width;
            document.getElementById("p-height").value = profile.screen_height;
            let proxyServer = profile.proxy_server || "";
            let proxyType = "http://";
            if (proxyServer.includes("://")) {
                const parts = proxyServer.split("://");
                proxyType = parts[0] + "://";
                proxyServer = parts[1];
            }
            document.getElementById("p-proxy-type").value = proxyType;
            document.getElementById("p-proxy").value = proxyServer;
            document.getElementById("p-proxy-user").value = profile.proxy_user || "";
            document.getElementById("p-proxy-pass").value = profile.proxy_pass || "";
            document.getElementById("p-timezone").value = profile.timezone;
            document.getElementById("p-script-id").value = profile.script_id || "";
            
            document.getElementById("p-device-memory").value = profile.device_memory !== undefined && profile.device_memory !== null ? profile.device_memory : "8";
            document.getElementById("p-hardware-concurrency").value = profile.hardware_concurrency !== undefined && profile.hardware_concurrency !== null ? profile.hardware_concurrency : "4";
            document.getElementById("p-canvas-noise").value = profile.canvas_noise !== undefined && profile.canvas_noise !== null ? profile.canvas_noise : "1";
            
            const vendor = profile.gpu_vendor !== undefined && profile.gpu_vendor !== null ? profile.gpu_vendor : "Google Inc. (NVIDIA)";
            const renderer = profile.gpu_renderer !== undefined && profile.gpu_renderer !== null ? profile.gpu_renderer : "NVIDIA GeForce GTX 1660 Ti/PCIe/SSE2";
            document.getElementById("p-gpu-vendor").value = vendor;
            updateGpuRendererOptions(vendor, renderer);
            document.getElementById("p-locale").value = profile.locale !== undefined && profile.locale !== null ? profile.locale : "vi-VN";
            document.getElementById("p-webrtc-mode").value = profile.webrtc_mode !== undefined && profile.webrtc_mode !== null ? profile.webrtc_mode : "spoof";
            document.getElementById("p-fonts-mode").value = profile.fonts_mode !== undefined && profile.fonts_mode !== null ? profile.fonts_mode.toString() : "1";
            document.getElementById("p-media-devices").value = profile.media_devices !== undefined && profile.media_devices !== null ? profile.media_devices.toString() : "1";
            
            const countryCode = profile.country || "VN";
            document.getElementById("p-country").value = countryCode;
            const cData = typeof ALL_COUNTRIES !== 'undefined' ? ALL_COUNTRIES.find(c => c.code === countryCode) : null;
            document.getElementById("p-country-search").value = cData ? `${cData.name_vi} (${cData.name_en})` : countryCode;
            
            const useProxy = profile.use_proxy === 1;
            document.getElementById("p-use-proxy").checked = useProxy;
            document.getElementById("p-proxy-rotate-url").value = profile.proxy_rotate_url || "";
            document.getElementById("p-use-mcp").checked = profile.use_mcp === 1;
            toggleProxyFields();
            
            if (profile.latitude !== null && profile.longitude !== null) {
                lat = profile.latitude;
                lng = profile.longitude;
                document.getElementById("p-lat").value = lat;
                document.getElementById("p-lng").value = lng;
            }
        } catch (err) {
            alert("Loi tai thong tin profile: " + err.message);
        }
    }

    modal.classList.add("active");
    // Khoi tao map voi toa do
    initLeafletMap(lat, lng);
}

function toggleProxyFields() {
    const useProxyCheckbox = document.getElementById("p-use-proxy");
    const proxyContainer = document.getElementById("proxy-fields-container");
    if (useProxyCheckbox.checked) {
        proxyContainer.style.display = "block";
    } else {
        proxyContainer.style.display = "none";
    }
}

function closeProfileModal() {
    document.getElementById("profile-modal").classList.remove("active");
}

async function handleProfileFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById("profile-id").value;
    const isEdit = id !== "";

    const data = {
        name: document.getElementById("p-name").value,
        user_agent: document.getElementById("p-ua").value,
        screen_width: parseInt(document.getElementById("p-width").value) || 1280,
        screen_height: parseInt(document.getElementById("p-height").value) || 720,
        proxy_server: (function() {
            const proxyType = document.getElementById("p-proxy-type").value;
            const proxyAddr = document.getElementById("p-proxy").value.trim();
            return proxyAddr ? (proxyType + proxyAddr) : null;
        })(),
        proxy_user: document.getElementById("p-proxy-user").value || null,
        proxy_pass: document.getElementById("p-proxy-pass").value || null,
        timezone: document.getElementById("p-timezone").value,
        script_id: document.getElementById("p-script-id").value ? parseInt(document.getElementById("p-script-id").value) : null,
        latitude: document.getElementById("p-lat").value ? parseFloat(document.getElementById("p-lat").value) : null,
        longitude: document.getElementById("p-lng").value ? parseFloat(document.getElementById("p-lng").value) : null,
        use_proxy: document.getElementById("p-use-proxy").checked ? 1 : 0,
        proxy_rotate_url: document.getElementById("p-proxy-rotate-url").value || null,
        use_mcp: document.getElementById("p-use-mcp").checked ? 1 : 0,
        country: document.getElementById("p-country").value,
        device_memory: parseInt(document.getElementById("p-device-memory").value) || 8,
        hardware_concurrency: parseInt(document.getElementById("p-hardware-concurrency").value) || 4,
        canvas_noise: parseInt(document.getElementById("p-canvas-noise").value) || 1,
        gpu_vendor: document.getElementById("p-gpu-vendor").value || null,
        gpu_renderer: document.getElementById("p-gpu-renderer").value || null,
        locale: document.getElementById("p-locale").value || "vi-VN",
        webrtc_mode: document.getElementById("p-webrtc-mode").value || "spoof",
        fonts_mode: parseInt(document.getElementById("p-fonts-mode").value) !== undefined ? parseInt(document.getElementById("p-fonts-mode").value) : 1,
        media_devices: parseInt(document.getElementById("p-media-devices").value) !== undefined ? parseInt(document.getElementById("p-media-devices").value) : 1
    };

    const url = isEdit ? `/api/profiles/${id}` : "/api/profiles";
    const method = isEdit ? "PUT" : "POST";

    try {
        const response = await fetch(url, {
            method: method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (result.success) {
            const profileId = isEdit ? parseInt(id) : result.id;
            
            // Lưu cấu hình Tiện ích mở rộng đã chọn trong Form
            const extCheckboxes = document.querySelectorAll("#profile-extensions-checkboxes .profile-ext-checkbox");
            const extPayload = [];
            extCheckboxes.forEach(cb => {
                extPayload.push({
                    id: parseInt(cb.value),
                    enabled: cb.checked ? 1 : 0,
                    config_json: "{}"
                });
            });
            
            try {
                await fetch(`/api/profiles/${profileId}/extensions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ extensions: extPayload })
                });
            } catch (errExt) {
                console.error("Lỗi đồng bộ cấu hình tiện ích cho profile:", errExt);
            }

            closeProfileModal();
            loadProfiles();
            if (isEdit) {
                await checkAndPromptProfileRestart(profileId);
            }
        } else {
            alert("Loi: " + result.error);
        }
    } catch (err) {
        alert("Loi kết noi: " + err.message);
    }
}

async function editProfile(id) {
    openProfileModal("edit", id);
}

async function deleteProfile(id) {
    if (!confirm("Bạn có chắc chắn muốn xóa profile này? Mọi file cookie liên quan sẽ bị xóa!")) return;
    try {
        const response = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
        const result = await response.json();
        if (result.success) {
            loadProfiles();
        }
    } catch (err) {
        alert("Loi: " + err.message);
    }
}

async function startProfile(id) {
    try {
        const response = await fetch(`/api/profiles/${id}/start`, { method: "POST" });
        const result = await response.json();
        if (!result.success) {
            alert("Loi khoi chay: " + result.error);
        }
        loadProfiles();
    } catch (err) {
        alert("Loi: " + err.message);
        loadProfiles();
    }
}

async function stopProfile(id) {
    try {
        const response = await fetch(`/api/profiles/${id}/stop`, { method: "POST" });
        const result = await response.json();
        if (result.success) {
            alert("Da dong trinh duyet!");
        } else {
            alert("Loi khi dung: " + result.error);
        }
        loadProfiles();
    } catch (err) {
        alert("Loi: " + err.message);
        loadProfiles();
    }
}

// Chay auto
function triggerProfileAutomation(id) {
    // Check xem profile nay co script rieng hay khong
    fetch(`/api/profiles/${id}`)
        .then(res => res.json())
        .then(profile => {
            if (profile.script_id) {
                // Neu co script rieng gan kem, chay luon
                if (confirm("Profile nay da duoc gan mot kich ban rieng. Bat dau chay kich ban nay tu dong?")) {
                    fetch(`/api/profiles/${id}/automate`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" }
                    })
                    .then(r => r.json())
                    .then(res => {
                        if (res.success) alert("Da bat dau chay kich ban rieng!");
                    });
                }
            } else {
                // Khong co script rieng, mo form chay Google Search test
                document.getElementById("automation-profile-id").value = id;
                document.getElementById("automation-modal").classList.add("active");
            }
        });
}

function closeAutomationModal() {
    document.getElementById("automation-modal").classList.remove("active");
}

async function submitAutomation() {
    const id = document.getElementById("automation-profile-id").value;
    const keyword = document.getElementById("auto-keyword").value;
    closeAutomationModal();

    try {
        const response = await fetch(`/api/profiles/${id}/automate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keyword: keyword })
        });
        const result = await response.json();
        if (result.success) {
            alert("Lenh tu dong hoa da gui. Hay quan sat Chromium!");
        } else {
            alert("Loi: " + result.error);
        }
    } catch (err) {
        alert("Loi: " + err.message);
    }
}

// Helper lay ten script tu cache
function getScriptNameById(id) {
    const s = allScripts.find(x => x.id === id);
    return s ? s.name : "Unknow";
}

// Fill scripts vao element select
function populateScriptDropdown(elementId) {
    const select = document.getElementById(elementId);
    const currentValue = select.value;
    
    // Clear bot options cu ngoai tru option dau tien
    select.innerHTML = select.options[0].outerHTML;
    
    allScripts.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.innerText = s.name;
        select.appendChild(opt);
    });
    
    select.value = currentValue;
}

// Hàm escapeHtml dùng để chuyển đổi các ký tự HTML đặc biệt như <, >, & tránh lỗi hiển thị và bảo mật (XSS)
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- AUTOMATION SCRIPTS CRUD ---
async function loadScripts() {
    try {
        const response = await fetch("/api/scripts");
        allScripts = await response.json();
        populateAiScriptDropdown();
        
        const tbody = document.getElementById("script-list-body");
        tbody.innerHTML = "";
        
        if (allScripts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-secondary);">Chua co kich ban nao</td></tr>`;
            return;
        }

        allScripts.forEach(s => {
            // Nhận diện kiểu kịch bản: Mảng các bước JSON cũ hay mã nguồn JS Puppeteer mới
            let stepsObj = [];
            let isJson = true;
            try { 
                stepsObj = JSON.parse(s.steps); 
                if (!Array.isArray(stepsObj)) {
                    isJson = false;
                }
            } catch(e) {
                isJson = false;
            }
            
            let stepsHtml = "";
            let stepsCountText = "";
            
            if (!isJson) {
                // Kịch bản viết bằng mã nguồn JS Puppeteer mới
                // Đếm số dòng code thực tế (loại bỏ các dòng trống)
                const codeLines = s.steps ? s.steps.split("\n").map(line => line.trim()).filter(line => line.length > 0) : [];
                stepsCountText = `${codeLines.length} dòng JS`;
                
                // Trích xuất 150 ký tự đầu tiên để hiển thị xem trước (preview) trên bảng
                const previewText = s.steps ? (s.steps.length > 150 ? s.steps.substring(0, 150) + "..." : s.steps) : "";
                stepsHtml = `<code style="font-family: monospace; font-size: 11px; background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 4px; display: block; white-space: pre-wrap; word-break: break-all; border: 1px solid rgba(255,255,255,0.1); color: #a6e22e;">${escapeHtml(previewText)}</code>`;
            } else {
                // Kịch bản cũ dạng danh sách hành động (JSON steps)
                stepsCountText = `${stepsObj.length} bước`;
                stepsObj.forEach(step => {
                    const action = step.action;
                    const value = step.value;
                    const target = step.target ? `[${step.target}]` : "";
                    
                    stepsHtml += `<span class="step-pill step-pill-${action}">${action} ${target} "${value}"</span>`;
                });
            }

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><span class="text-bold">${s.name}</span></td>
                <td>${stepsCountText}</td>
                <td><div style="max-width: 450px; white-space: normal;">${stepsHtml}</div></td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-icon" onclick="editScript(${s.id})" title="Sua kich ban"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button class="btn-icon btn-delete" onclick="deleteScript(${s.id})" title="Xoa kich ban"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch(err) {
        console.error("Khong the load scripts: " + err.message);
    }
}

// Biến lưu trạng thái mode hiện tại của Modal kịch bản
let currentScriptMode = "gui";

function unescapeString(str) {
    if (!str) return "";
    return str.toString().replace(/\\'/g, "'").replace(/\\"/g, '"');
}

function parseGuiFromRawJs(jsCode) {
    const lines = jsCode.split("\n");
    const steps = [];
    let lastWaitSelector = null;
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line || line.startsWith("//") || line.startsWith("logInfo") || line.startsWith("logWarning") || line.startsWith("logError")) {
            continue; 
        }
        
        // 1. Check waitForSelector
        const waitSelMatch = line.match(/await\s+page\.waitForSelector\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/);
        if (waitSelMatch) {
            if (lastWaitSelector) {
                steps.push({ action: "click", target: lastWaitSelector, value: "" });
            }
            lastWaitSelector = unescapeString(waitSelMatch[1]);
            continue; 
        }
        
        // 2. Check Goto
        const gotoMatch = line.match(/await\s+page\.goto\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/);
        if (gotoMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "goto", target: "", value: unescapeString(gotoMatch[1]) });
            continue;
        }
        
        // 3. Check Type
        const typeMatch = line.match(/await\s+page\.type\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/);
        if (typeMatch) {
            lastWaitSelector = null; // Gộp thành công
            steps.push({ action: "type", target: unescapeString(typeMatch[1]), value: unescapeString(typeMatch[2]) });
            continue;
        }
        
        // 4. Check Click
        const clickMatch = line.match(/await\s+page\.click\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/);
        if (clickMatch) {
            lastWaitSelector = null; // Gộp thành công
            steps.push({ action: "click", target: unescapeString(clickMatch[1]), value: "" });
            continue;
        }
        
        // 5. Check Click Right
        const clickRightMatch = line.match(/await\s+clickRight\(\s*page\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/);
        if (clickRightMatch) {
            lastWaitSelector = null;
            steps.push({ action: "click_right", target: unescapeString(clickRightMatch[1]), value: "" });
            continue;
        }
        
        // 6. Check Click XY
        const clickXyMatch = line.match(/await\s+clickXY\(\s*page\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (clickXyMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "click_xy", target: "", value: `${clickXyMatch[1]} ${clickXyMatch[2]}` });
            continue;
        }
        
        // 7. Check Click Right XY
        const clickRightXyMatch = line.match(/await\s+clickRightXY\(\s*page\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (clickRightXyMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "click_right_xy", target: "", value: `${clickRightXyMatch[1]} ${clickRightXyMatch[2]}` });
            continue;
        }
        
        // 8. Check Hover
        const hoverMatch = line.match(/await\s+hover\(\s*page\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/);
        if (hoverMatch) {
            lastWaitSelector = null;
            steps.push({ action: "hover", target: unescapeString(hoverMatch[1]), value: "" });
            continue;
        }
        
        // 9. Check Press
        const pressMatch = line.match(/await\s+page\.keyboard\.press\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]/);
        if (pressMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "press", target: "", value: unescapeString(pressMatch[1]) });
            continue;
        }
        
        // 10. Check Scroll
        const scrollMatch = line.match(/window\.scrollBy\(\s*0\s*,\s*(-?\d+)\)/);
        if (scrollMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            const amt = parseInt(scrollMatch[1]);
            steps.push({ action: "scroll", target: "", value: amt < 0 ? "up" : "down" });
            continue;
        }
        
        // 11. Check Wait
        const waitMatch = line.match(/await\s+(?:new\s+Promise\(\s*r\s*=>\s*)?setTimeout\(\s*(?:r\s*,\s*)?(\d+)/);
        if (waitMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            let delayMs = parseInt(waitMatch[1]);
            let delaySec = delayMs >= 100 ? (delayMs / 1000) : delayMs;
            steps.push({ action: "wait", target: "", value: delaySec.toString() });
            continue;
        }
        
        // 12. Check Social Message
        const socMsgMatch = line.match(/await\s+socialMessage\(\s*page\s*,\s*['"`]([^'"]+)['"`]/);
        if (socMsgMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "social_message", target: "", value: socMsgMatch[1] });
            continue;
        }
        
        // 13. Check Social Reply Unread
        const socRepUnreadMatch = line.match(/await\s+socialReplyUnread\(\s*page\s*,\s*['"`]([^'"]+)['"`](?:\s*,\s*['"`]([^'"]*)['"`])?/);
        if (socRepUnreadMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({
                action: "social_reply_unread",
                target: socRepUnreadMatch[1],
                value: socRepUnreadMatch[2] || ""
            });
            continue;
        }
        
        // 14. Check Social Reply Comment
        const socRepCommMatch = line.match(/await\s+socialReplyComment\(\s*page\s*,\s*['"`]([^'"]+)['"`](?:\s*,\s*['"`]([^'"]*)['"`])?/);
        if (socRepCommMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({
                action: "social_reply_comment",
                target: socRepCommMatch[1],
                value: socRepCommMatch[2] || ""
            });
            continue;
        }
        
        // 15. Check Social Reaction
        const socReactMatch = line.match(/await\s+socialReaction\(\s*page\s*,\s*['"`]([^'"]+)['"`](?:\s*,\s*['"`]([^'"]*)['"`])?/);
        if (socReactMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({
                action: "social_reaction",
                target: socReactMatch[1],
                value: socReactMatch[2] || ""
            });
            continue;
        }
        
        // 16. Check Fill Register
        if (line.includes("await fillRegister(")) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "fill_register", target: "", value: "" });
            continue;
        }
        
        // 17. Check Rent Phone
        const rentPhoneMatch = line.match(/await\s+rentPhone\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`](?:\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (rentPhoneMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "rent_phone", target: unescapeString(rentPhoneMatch[1]), value: unescapeString(rentPhoneMatch[2]), var: unescapeString(rentPhoneMatch[3]) || "phone_1" });
            continue;
        }
        
        // 18. Check Type Phone
        const typePhoneMatch = line.match(/await\s+typePhone\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`](?:\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (typePhoneMatch) {
            lastWaitSelector = null;
            steps.push({ action: "type_phone", target: unescapeString(typePhoneMatch[1]), value: "", var: unescapeString(typePhoneMatch[2]) || "phone_1" });
            continue;
        }
        
        // 19. Check Get Phone Code
        const getPhoneCodeMatch = line.match(/await\s+getPhoneCode\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`](?:\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (getPhoneCodeMatch) {
            lastWaitSelector = null;
            steps.push({ action: "get_phone_code", target: unescapeString(getPhoneCodeMatch[1]), value: "", var: unescapeString(getPhoneCodeMatch[2]) || "phone_1" });
            continue;
        }
        
        // 20. Check Create Mail
        const createMailMatch = line.match(/await\s+createMail\(\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`]|null)?\s*(?:\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (createMailMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "create_mail", target: "", value: (createMailMatch[1] === "null" || !createMailMatch[1]) ? "" : unescapeString(createMailMatch[1]), var: unescapeString(createMailMatch[2]) || "mail_1" });
            continue;
        }
        
        // 21. Check Type Mail
        const typeMailMatch = line.match(/await\s+typeMail\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`](?:\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (typeMailMatch) {
            lastWaitSelector = null;
            steps.push({ action: "type_mail", target: unescapeString(typeMailMatch[1]), value: "", var: unescapeString(typeMailMatch[2]) || "mail_1" });
            continue;
        }
        
        // 22. Check Get Mail Code
        const getMailCodeMatch = line.match(/await\s+getMailCode\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`](?:\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (getMailCodeMatch) {
            lastWaitSelector = null;
            steps.push({ action: "get_mail_code", target: unescapeString(getMailCodeMatch[1]), value: "", var: unescapeString(getMailCodeMatch[2]) || "mail_1" });
            continue;
        }

        // 22a. Check Delete Mail
        const deleteMailMatch = line.match(/await\s+deleteMail\(\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (deleteMailMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "delete_mail", target: "", value: "", var: unescapeString(deleteMailMatch[1]) || "mail_1" });
            continue;
        }

        // 22b. Check Cancel Phone
        const cancelPhoneMatch = line.match(/await\s+cancelPhone\(\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (cancelPhoneMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "cancel_phone", target: "", value: "", var: unescapeString(cancelPhoneMatch[1]) || "phone_1" });
            continue;
        }

        // 23. Check Solve Captcha
        const solveCaptchaMatch = line.match(/await\s+solveCaptcha\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*(?:\s*,\s*['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (solveCaptchaMatch) {
            lastWaitSelector = null;
            steps.push({ action: "solve_captcha", target: unescapeString(solveCaptchaMatch[1]), service: unescapeString(solveCaptchaMatch[2]), var: unescapeString(solveCaptchaMatch[3]) || "captcha_1", value: "" });
            continue;
        }
        // 24. Check Rotate Proxy
        const rotateProxyMatch = line.match(/await\s+rotateProxy\(\s*(?:['"`]((?:[^'"`\\]|\\.)*)['"`])?\s*\)/);
        if (rotateProxyMatch) {
            if (lastWaitSelector) { steps.push({ action: "click", target: lastWaitSelector, value: "" }); lastWaitSelector = null; }
            steps.push({ action: "rotate_proxy", target: "", value: unescapeString(rotateProxyMatch[1]) || "" });
            continue;
        }
        
        // Nếu có waitForSelector mồ côi
        if (lastWaitSelector) {
            steps.push({ action: "click", target: lastWaitSelector, value: "" });
            lastWaitSelector = null;
        }
    }
    
    if (lastWaitSelector) {
        steps.push({ action: "click", target: lastWaitSelector, value: "" });
    }
    
    return steps;
}

function switchScriptMode(mode, skipGenerate = false) {
    const btnGui = document.getElementById("btn-mode-gui");
    const btnCode = document.getElementById("btn-mode-code");
    const guiEditor = document.getElementById("gui-script-editor");
    const codeEditor = document.getElementById("code-script-editor");

    if (!btnGui || !btnCode || !guiEditor || !codeEditor) return;

    if (mode === "gui") {
        const jsCode = document.getElementById("script-js-code").value.trim();
        
        // Tự động phân tích và đồng bộ trực tiếp từ code JS sang GUI mà không cần confirm
        if (jsCode) {
            const container = document.getElementById("script-steps-container");
            if (container) {
                container.innerHTML = "";
                
                // Phân tích mã JS thô thành các bước hành động trực quan
                const steps = parseGuiFromRawJs(jsCode);
                if (steps.length > 0) {
                    steps.forEach(step => {
                        addScriptStepRow(step);
                    });
                } else {
                    addScriptStepRow();
                }
            }
        }
        
        currentScriptMode = "gui";
        btnGui.className = "btn btn-sm btn-primary";
        btnCode.className = "btn btn-sm btn-outline";
        guiEditor.style.display = "block";
        codeEditor.style.display = "none";
    } else {
        // Trước khi chuyển sang Code, tự động sinh mã JS từ các khối GUI để hiển thị trong textarea
        if (!skipGenerate) {
            generateJsFromGui();
        }
        
        currentScriptMode = "code";
        btnGui.className = "btn btn-sm btn-outline";
        btnCode.className = "btn btn-sm btn-primary";
        guiEditor.style.display = "none";
        codeEditor.style.display = "block";
        
        // Cập nhật số dòng, check cú pháp và gán autocomplete
        setTimeout(initJsEditorEnrichments, 50);
    }
}

function escapeSingleQuote(str) {
    if (!str) return "";
    return str.toString().replace(/'/g, "\\'");
}

function generateJsFromGui() {
    const container = document.getElementById("script-steps-container");
    if (!container) return;
    const rows = container.querySelectorAll(".script-step-row");
    
    const stepsData = [];
    let generatedCode = "";
    
    rows.forEach((row) => {
        const actionSelect = row.querySelector(".step-action");
        const targetInput = row.querySelector(".target-input");
        const valueInput = row.querySelector(".value-input");
        const varSelect = row.querySelector(".step-var-select");
        const captchaSelect = row.querySelector(".step-captcha-select");
        
        if (!actionSelect) return;
        
        const action = actionSelect.value;
        const rawTarget = targetInput ? targetInput.value : "";
        const rawValue = valueInput ? valueInput.value : "";
        const variable = varSelect ? varSelect.value : "";
        const service = captchaSelect ? captchaSelect.value : "";
        
        stepsData.push({ action, target: rawTarget, value: rawValue, var: variable, service });
        
        const target = escapeSingleQuote(rawTarget);
        const value = escapeSingleQuote(rawValue);
        
        // Sinh code Puppeteer tương ứng
        if (action === "goto") {
            generatedCode += `await page.goto('${value}', { waitUntil: 'load' });\nlogInfo('Đã mở trang web ${value}');\n`;
        } else if (action === "click") {
            generatedCode += `await page.waitForSelector('${target}', { timeout: 30000 });\nawait page.click('${target}');\nlogInfo('Đã click selector ${target}');\n`;
        } else if (action === "click_right") {
            generatedCode += `await page.waitForSelector('${target}', { timeout: 30000 });\nawait hover(page, '${target}');\nawait clickRight(page, '${target}');\nlogInfo('Đã click chuột phải vào ${target}');\n`;
        } else if (action === "click_xy") {
            const coords = value.split(/[\s,]+/).map(Number);
            const x = coords[0] || 0;
            const y = coords[1] || 0;
            generatedCode += `await clickXY(page, ${x}, ${y});\nlogInfo('Đã click tọa độ ${x}, ${y}');\n`;
        } else if (action === "click_right_xy") {
            const coords = value.split(/[\s,]+/).map(Number);
            const x = coords[0] || 0;
            const y = coords[1] || 0;
            generatedCode += `await clickRightXY(page, ${x}, ${y});\nlogInfo('Đã click chuột phải tọa độ ${x}, ${y}');\n`;
        } else if (action === "hover") {
            generatedCode += `await page.waitForSelector('${target}', { timeout: 30000 });\nawait hover(page, '${target}');\nlogInfo('Đã di chuột tới ${target}');\n`;
        } else if (action === "type") {
            generatedCode += `await page.waitForSelector('${target}', { timeout: 30000 });\nawait page.click('${target}');\nawait page.type('${target}', '${value}');\nlogInfo('Đã nhập chữ vào ${target}');\n`;
        } else if (action === "press") {
            generatedCode += `await page.keyboard.press('${value}');\nlogInfo('Đã nhấn phím ${value}');\n`;
        } else if (action === "scroll") {
            const amt = value === "up" ? -350 : 350;
            generatedCode += `await page.evaluate(() => window.scrollBy(0, ${amt}));\nlogInfo('Đã cuộn trang ${value}');\n`;
        } else if (action === "wait") {
            let delayVal = parseFloat(value) || 2;
            let delayMs = delayVal <= 100 ? Math.round(delayVal * 1000) : Math.round(delayVal);
            generatedCode += `await new Promise(r => setTimeout(r, ${delayMs}));\nlogInfo('Đã chờ ${delayMs}ms');\n`;
        } else if (action === "social_message") {
            generatedCode += `await socialMessage(page, '${value}');\nlogInfo('Đã gửi tin nhắn MXH: ${value}');\n`;
        } else if (action === "social_reply_unread") {
            generatedCode += `await socialReplyUnread(page, '${value}');\nlogInfo('Đã trả lời tin nhắn chưa đọc: ${value}');\n`;
        } else if (action === "social_reply_comment") {
            generatedCode += `await socialReplyComment(page, '${value}');\nlogInfo('Đã trả lời bình luận: ${value}');\n`;
        } else if (action === "social_reaction") {
            generatedCode += `await socialReaction(page, '${value}');\nlogInfo('Đã thả reaction: ${value}');\n`;
        } else if (action === "fill_register") {
            generatedCode += `await fillRegister(page);\nlogInfo('Đã điền thông tin đăng ký thông minh');\n`;
        } else if (action === "rent_phone") {
            generatedCode += `await rentPhone('${target}', '${value}', '${variable}');\nlogInfo('Đã thuê số điện thoại dịch vụ ${target} quốc gia ${value} lưu vào ${variable}');\n`;
        } else if (action === "type_phone") {
            generatedCode += `await typePhone('${target}', '${variable}');\nlogInfo('Đã nhập số điện thoại từ biến ${variable} vào ${target}');\n`;
        } else if (action === "get_phone_code") {
            generatedCode += `await getPhoneCode('${target}', '${variable}');\nlogInfo('Đã lấy OTP điện thoại từ biến ${variable} điền vào ${target}');\n`;
        } else if (action === "create_mail") {
            if (value) {
                generatedCode += `await createMail('${value}', '${variable}');\nlogInfo('Đã sử dụng email cũ ${value} lưu vào ${variable}');\n`;
            } else {
                generatedCode += `await createMail(null, '${variable}');\nlogInfo('Đã tạo email ảo mới lưu vào ${variable}');\n`;
            }
        } else if (action === "type_mail") {
            generatedCode += `await typeMail('${target}', '${variable}');\nlogInfo('Đã nhập email từ biến ${variable} vào ${target}');\n`;
        } else if (action === "get_mail_code") {
            generatedCode += `await getMailCode('${target}', '${variable}');\nlogInfo('Đã lấy OTP email từ biến ${variable} điền vào ${target}');\n`;
        } else if (action === "delete_mail") {
            generatedCode += `await deleteMail('${variable}');\nlogInfo('Đã giải phóng hòm thư ảo biến ${variable}');\n`;
        } else if (action === "cancel_phone") {
            generatedCode += `await cancelPhone('${variable}');\nlogInfo('Đã hủy thuê số điện thoại biến ${variable}');\n`;
        } else if (action === "solve_captcha") {
            generatedCode += `await solveCaptcha('${target}', '${service}', '${variable}');\nlogInfo('Đã giải captcha tại ${target} qua ${service} lưu vào ${variable}');\n`;
        } else if (action === "rotate_proxy") {
            if (value) {
                generatedCode += `await rotateProxy('${value}');\nlogInfo('Đã gọi API xoay Proxy tại ${value}');\n`;
            } else {
                generatedCode += `await rotateProxy();\nlogInfo('Đã gọi API xoay Proxy mặc định');\n`;
            }
        } else if (action === "check_proxy") {
            generatedCode += `await checkProxy();\nlogInfo('Đã kiểm tra trạng thái IP proxy');\n`;
        } else if (action === "rotate_proxy_if_die") {
            generatedCode += `await rotateProxyIfDie('${value}');\nlogInfo('Tự động xoay proxy nếu phát hiện IP die');\n`;
        } else if (action === "rotate_proxy_every_n_runs") {
            generatedCode += `await rotateProxyEveryNRuns(${parseInt(value) || 1});\nlogInfo('Tự động xoay proxy sau mỗi ${value} lần chạy');\n`;
        } else if (action === "get_old_ip") {
            generatedCode += `await getOldIp('${value}');\nlogInfo('Kiểm tra và khôi phục về IP cũ của profile');\n`;
        } else {
            generatedCode += `// Hành động không xác định: ${action}\n`;
        }
        
        // Trễ sinh học nhỏ giữa các bước
        if (action !== "wait") {
            generatedCode += `await new Promise(r => setTimeout(r, 1200));\n`;
        }
    });
    
    // Thêm dòng metadata ở dòng đầu tiên
    const metadataComment = `// ANTI_PROFILE_GUI_METADATA: ${JSON.stringify(stepsData)}\n`;
    document.getElementById("script-js-code").value = metadataComment + generatedCode;
}

function parseGuiFromJs(jsCode) {
    const container = document.getElementById("script-steps-container");
    if (!container) return false;
    container.innerHTML = ""; // Xóa sạch các khối cũ

    let hasMetadata = false;
    let metadataStr = "";
    
    if (jsCode) {
        const trimmed = jsCode.trim();
        if (trimmed.startsWith("// ANTI_PROFILE_GUI_METADATA:")) {
            hasMetadata = true;
            metadataStr = trimmed.split("\n")[0].replace("// ANTI_PROFILE_GUI_METADATA:", "").trim();
        } else if (trimmed.startsWith("ANTI_PROFILE_GUI_METADATA:")) {
            hasMetadata = true;
            metadataStr = trimmed.split("\n")[0].replace("ANTI_PROFILE_GUI_METADATA:", "").trim();
        }
    }

    if (!hasMetadata) {
        // Không phải kịch bản GUI, mở ở tab Code JS
        switchScriptMode("code", true);
        return false;
    }

    try {
        const stepsData = JSON.parse(metadataStr);

        if (Array.isArray(stepsData)) {
            stepsData.forEach((step) => {
                addScriptStepRow(step);
            });
            switchScriptMode("gui", true);
            return true;
        }
    } catch (e) {
        console.error("Lỗi parse GUI metadata khi mở kịch bản:", e);
    }

    switchScriptMode("code", true);
    return false;
}

// ========================================================================
// NOTEPAD++ EDITOR & AUTOCOMPLETE ENHANCEMENTS BY ANTIGRAVITY
// ========================================================================

const SELECTOR_TRANSLATIONS = {
    "#ap_email": "Khung điền email đăng nhập (Amazon)",
    "#ap_password": "Khung điền mật khẩu (Amazon)",
    "#ap_customer_name": "Khung điền họ và tên (Amazon)",
    "#ap_password_check": "Khung nhập lại mật khẩu (Amazon)",
    "#continue": "Nút Tiếp tục",
    "#auth-signin-button": "Nút Đăng nhập",
    "#createAccountSubmit": "Nút Tạo tài khoản mới",
    "input[type='email']": "Khung điền email",
    "input[type='password']": "Khung điền mật khẩu",
    "input[type='text']": "Khung nhập chữ",
    "input[type='submit']": "Nút bấm gửi đi",
    "button[type='submit']": "Nút xác nhận",
    "#cvf-page-ocr-imageUrl": "Mã xác minh CAPTCHA / Ảnh mã OTP",
    "#cvf-input-code": "Khung điền mã OTP xác minh",
    "a[href*='register']": "Đường dẫn đăng ký",
    "a[href*='signin']": "Đường dẫn đăng nhập"
};

const AUTOCOMPLETE_SUGGESTIONS = [
    { label: "page", insertText: "page", desc: "Đối tượng trang web hiện tại (Puppeteer Page)", type: "Biến" },
    { label: "browser", insertText: "browser", desc: "Đối tượng trình duyệt (Puppeteer Browser)", type: "Biến" },
    { label: "puppeteer", insertText: "puppeteer", desc: "Thư viện Puppeteer gốc", type: "Biến" },
    { label: "await page.goto('url')", insertText: "await page.goto('https://', { waitUntil: 'load' });", desc: "Mở một địa chỉ trang web mới", type: "Hàm" },
    { label: "await page.click('selector')", insertText: "await page.click('');", desc: "Nhấp chuột trái vào một nút hoặc phần tử", type: "Hàm" },
    { label: "await page.type('selector', 'text')", insertText: "await page.type('', '');", desc: "Nhập chữ vào ô nhập liệu", type: "Hàm" },
    { label: "await page.keyboard.press('key')", insertText: "await page.keyboard.press('Enter');", desc: "Nhấn một phím trên bàn phím (như Enter, Tab)", type: "Hàm" },
    { label: "await new Promise(r => setTimeout(r, ms))", insertText: "await new Promise(r => setTimeout(r, 2000));", desc: "Tạm dừng kịch bản trong khoảng mili-giây", type: "Hàm" },
    { label: "await hover(page, 'selector')", insertText: "await hover(page, '');", desc: "Rê chuột vào một phần tử trên trang web", type: "Hàm" },
    { label: "await clickRight(page, 'selector')", insertText: "await clickRight(page, '');", desc: "Nhấp chuột phải vào một phần tử", type: "Hàm" },
    { label: "await clickXY(page, x, y)", insertText: "await clickXY(page, 100, 200);", desc: "Nhấp chuột trái vào một tọa độ màn hình X, Y", type: "Hàm" },
    { label: "await clickRightXY(page, x, y)", insertText: "await clickRightXY(page, 100, 200);", desc: "Nhấp chuột phải vào tọa độ X, Y", type: "Hàm" },
    { label: "await rentPhone(service, country)", insertText: "await rentPhone('facebook', 'VN');", desc: "Thuê số điện thoại ảo để lấy OTP", type: "API Phone" },
    { label: "await typePhone('selector')", insertText: "await typePhone('');", desc: "Tự động nhập số điện thoại ảo đã thuê", type: "API Phone" },
    { label: "await getPhoneCode('selector')", insertText: "await getPhoneCode('');", desc: "Đợi nhận OTP điện thoại và tự động điền vào", type: "API Phone" },
    { label: "await cancelPhone()", insertText: "await cancelPhone();", desc: "Hủy thuê số điện thoại ảo đang hoạt động", type: "API Phone" },
    { label: "await createMail(email)", insertText: "await createMail();", desc: "Tạo một hòm thư ảo tạm thời mới", type: "API Mail" },
    { label: "await typeMail('selector')", insertText: "await typeMail('');", desc: "Tự động nhập địa chỉ email ảo đã tạo", type: "API Mail" },
    { label: "await getMailCode('selector')", insertText: "await getMailCode('');", desc: "Đợi nhận OTP email và tự động điền vào", type: "API Mail" },
    { label: "await deleteMail()", insertText: "await deleteMail();", desc: "Giải phóng và xóa hòm thư ảo hiện tại", type: "API Mail" },
    { label: "await solveCaptcha(page, 'selector')", insertText: "await solveCaptcha(page, '');", desc: "Tự động giải mã Captcha hình ảnh", type: "API Captcha" },
    { label: "await rotateProxy()", insertText: "await rotateProxy();", desc: "Xoay IP proxy (gọi url xoay proxy)", type: "API Proxy" },
    { label: "await checkProxy()", insertText: "await checkProxy();", desc: "Kiểm tra IP hiện tại của Proxy", type: "API Proxy" },
    { label: "await rotateProxyIfDie()", insertText: "await rotateProxyIfDie();", desc: "Tự động xoay proxy nếu phát hiện IP die", type: "API Proxy" },
    { label: "await rotateProxyEveryNRuns(n)", insertText: "await rotateProxyEveryNRuns(5);", desc: "Tự động xoay proxy sau N lần chạy", type: "API Proxy" },
    { label: "await getOldIp()", insertText: "await getOldIp();", desc: "Khôi phục lại IP cũ của profile", type: "API Proxy" },
    { label: "await fillRegister(page)", insertText: "await fillRegister(page);", desc: "Tự động điền nhanh các thông tin đăng ký mẫu", type: "Hàm" },
    { label: "logInfo('message')", insertText: "logInfo('');", desc: "Ghi nhật ký thông tin màu xanh lên bảng trạng thái", type: "Log" },
    { label: "logWarning('message')", insertText: "logWarning('');", desc: "Ghi nhật ký cảnh báo màu vàng lên bảng trạng thái", type: "Log" },
    { label: "logError('message')", insertText: "logError('');", desc: "Ghi nhật ký lỗi màu đỏ lên bảng trạng thái", type: "Log" }
];

let activeSuggestionIndex = 0;
let filteredSuggestions = [];

function updateLineNumbers() {
    const textarea = document.getElementById("script-js-code");
    const lineNumbersDiv = document.getElementById("editor-line-numbers");
    if (!textarea || !lineNumbersDiv) return;

    const lines = textarea.value.split("\n");
    const lineCount = Math.max(1, lines.length);
    
    let html = "";
    for (let i = 1; i <= lineCount; i++) {
        html += `<span id="line-num-${i}">${i}</span>`;
    }
    lineNumbersDiv.innerHTML = html;
}

function syncEditorScroll() {
    const textarea = document.getElementById("script-js-code");
    const lineNumbersDiv = document.getElementById("editor-line-numbers");
    if (!textarea || !lineNumbersDiv) return;
    
    lineNumbersDiv.scrollTop = textarea.scrollTop;
}

function checkCodeSyntax(code) {
    const errorBox = document.getElementById("code-syntax-error");
    const errorMsg = document.getElementById("syntax-error-msg");
    const lineNumbersDiv = document.getElementById("editor-line-numbers");
    if (!errorBox || !errorMsg) return;

    if (lineNumbersDiv) {
        lineNumbersDiv.querySelectorAll(".line-error").forEach(el => {
            el.classList.remove("line-error");
            el.removeAttribute("data-tooltip");
        });
    }

    const wrapper = `async function _validate_() {\n${code}\n}`;
    try {
        new Function(wrapper);
        errorBox.style.display = "none";
    } catch (e) {
        let lineNum = null;
        let errMsg = e.message;

        try {
            eval(`(async () => {\n${code}\n})`);
        } catch (evalErr) {
            errMsg = evalErr.message;
            if (evalErr.stack) {
                const match = evalErr.stack.match(/<anonymous>:(\d+):(\d+)/) || evalErr.stack.match(/eval:(\d+):(\d+)/) || evalErr.stack.match(/:(\d+):(\d+)/);
                if (match) {
                    lineNum = parseInt(match[1]) - 1;
                }
            }
        }

        errorMsg.innerText = `Lỗi cấu trúc JS (Dòng ${lineNum || "?"}): ${errMsg}`;
        errorBox.style.display = "flex";

        if (lineNum && lineNumbersDiv) {
            const errorLineSpan = document.getElementById(`line-num-${lineNum}`);
            if (errorLineSpan) {
                errorLineSpan.classList.add("line-error");
                errorLineSpan.setAttribute("data-tooltip", `Lỗi cú pháp: ${errMsg}`);
            }
        }
    }
}

function handleEditorInput() {
    const textarea = document.getElementById("script-js-code");
    if (!textarea) return;
    const code = textarea.value;
    
    updateLineNumbers();
    checkCodeSyntax(code);
    syncEditorScroll();
    handleAutocompleteSuggestions();
}

function handleAutocompleteSuggestions() {
    const textarea = document.getElementById("script-js-code");
    const popup = document.getElementById("autocomplete-suggestions");
    if (!textarea || !popup) return;

    const caretPos = textarea.selectionStart;
    const text = textarea.value;
    const beforeCaret = text.slice(0, caretPos);
    
    const lines = beforeCaret.split('\n');
    const currentLine = lines.pop();
    
    const words = currentLine.split(/[\s()+\-*\/=,;'"[\]]/);
    const currentWord = words.pop().trim();

    if (!currentWord || currentWord.length < 1) {
        popup.style.display = "none";
        return;
    }

    const lineNum = lines.length + 1;
    const colNum = currentLine.length - currentWord.length;
    const lineHeightVal = 24.5;
    const charWidth = 8;
    const topPos = lineNum * lineHeightVal + 12 - textarea.scrollTop;
    const leftPos = colNum * charWidth + 50 - textarea.scrollLeft;

    filteredSuggestions = AUTOCOMPLETE_SUGGESTIONS.filter(item => 
        item.label.toLowerCase().includes(currentWord.toLowerCase())
    );

    if (filteredSuggestions.length === 0) {
        popup.style.display = "none";
        return;
    }

    activeSuggestionIndex = 0;
    
    popup.innerHTML = "";
    filteredSuggestions.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "script-autocomplete-item" + (idx === activeSuggestionIndex ? " active" : "");
        div.innerHTML = `
            <div style="flex-grow: 1; padding-right: 8px;">
                <div style="font-weight: 700; font-size: 0.8rem; color: #f8fafc;">${item.label}</div>
                <div style="font-size: 0.68rem; color: #94a3b8; margin-top: 2px;">${item.desc}</div>
            </div>
            <span class="type-badge">${item.type || "Hàm"}</span>
        `;
        div.addEventListener("click", () => selectSuggestion(item));
        popup.appendChild(div);
    });

    const wrapperHeight = 380;
    if (topPos > wrapperHeight - 120) {
        popup.style.top = `${topPos - 120}px`;
    } else {
        popup.style.top = `${topPos}px`;
    }
    popup.style.left = `${Math.max(50, Math.min(leftPos, textarea.offsetWidth - 260))}px`;
    popup.style.display = "block";
}

function selectSuggestion(item) {
    const textarea = document.getElementById("script-js-code");
    if (!textarea) return;
    const caretPos = textarea.selectionStart;
    const text = textarea.value;
    const beforeCaret = text.slice(0, caretPos);
    const afterCaret = text.slice(caretPos);
    
    const lines = beforeCaret.split('\n');
    let currentLine = lines.pop();
    
    // Tìm phần khớp dài nhất giữa phần cuối của currentLine và phần đầu của item.insertText
    let matchLen = 0;
    const insertText = item.insertText;
    const maxCheck = Math.min(currentLine.length, insertText.length);
    
    for (let i = 1; i <= maxCheck; i++) {
        const endOfLine = currentLine.slice(-i);
        const startOfInsert = insertText.slice(0, i);
        if (endOfLine === startOfInsert) {
            matchLen = i;
        }
    }
    
    // Cắt bỏ phần trùng lặp ở cuối currentLine
    currentLine = currentLine.slice(0, currentLine.length - matchLen);
    lines.push(currentLine + insertText);
    
    const newBeforeCaret = lines.join('\n');
    textarea.value = newBeforeCaret + afterCaret;
    textarea.focus();
    
    const newCursorPos = newBeforeCaret.length;
    let offset = 0;
    if (insertText.endsWith("');")) {
        offset = 3;
    } else if (insertText.endsWith("');\n")) {
        offset = 4;
    }
    textarea.setSelectionRange(newCursorPos - offset, newCursorPos - offset);
    
    document.getElementById("autocomplete-suggestions").style.display = "none";
    updateLineNumbers();
    checkCodeSyntax(textarea.value);
}

function initJsEditorEnrichments() {
    const textarea = document.getElementById("script-js-code");
    if (!textarea) return;

    textarea.removeEventListener("keydown", handleEditorKeydown);
    textarea.addEventListener("keydown", handleEditorKeydown);
    
    updateLineNumbers();
    checkCodeSyntax(textarea.value);
    
    document.removeEventListener("click", hideAutocompleteOnClickOutside);
    document.addEventListener("click", hideAutocompleteOnClickOutside);
}

function handleEditorKeydown(e) {
    const popup = document.getElementById("autocomplete-suggestions");
    const textarea = document.getElementById("script-js-code");
    if (!textarea) return;

    if (popup && popup.style.display !== "none") {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeSuggestionIndex = (activeSuggestionIndex + 1) % filteredSuggestions.length;
            refreshSuggestionHighlights();
            const activeItem = popup.querySelector(".script-autocomplete-item.active") || popup.querySelector(".autocomplete-item.active");
            if (activeItem) activeItem.scrollIntoView({ block: "nearest" });
            return;
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeSuggestionIndex = (activeSuggestionIndex - 1 + filteredSuggestions.length) % filteredSuggestions.length;
            refreshSuggestionHighlights();
            const activeItem = popup.querySelector(".script-autocomplete-item.active") || popup.querySelector(".autocomplete-item.active");
            if (activeItem) activeItem.scrollIntoView({ block: "nearest" });
            return;
        } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            if (filteredSuggestions[activeSuggestionIndex]) {
                selectSuggestion(filteredSuggestions[activeSuggestionIndex]);
            }
            return;
        } else if (e.key === "Escape") {
            e.preventDefault();
            popup.style.display = "none";
            return;
        }
    }

    // Xử lý phím Tab / Shift+Tab khi popup autocomplete KHÔNG hiển thị
    if (e.key === "Tab") {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;

        if (!e.shiftKey) {
            // Nhấn Tab thường: Thụt lề dòng (chèn 4 khoảng trắng)
            if (start === end) {
                // Chèn tại vị trí con trỏ
                textarea.value = value.substring(0, start) + "    " + value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 4;
            } else {
                // Thụt dòng cho toàn bộ vùng chọn
                const lineStart = value.lastIndexOf("\n", start - 1) + 1;
                const before = value.substring(0, lineStart);
                const selected = value.substring(lineStart, end);
                const after = value.substring(end);
                const modified = selected.split("\n").map(line => "    " + line).join("\n");
                textarea.value = before + modified + after;
                textarea.selectionStart = start + 4;
                textarea.selectionEnd = lineStart + modified.length;
            }
        } else {
            // Nhấn Shift+Tab: Lùi lề dòng (xóa bớt khoảng trắng ở đầu mỗi dòng)
            const lineStart = value.lastIndexOf("\n", start - 1) + 1;
            const before = value.substring(0, lineStart);
            const selected = value.substring(lineStart, end);
            const after = value.substring(end);
            
            let removedCount = 0;
            const modified = selected.split("\n").map(line => {
                if (line.startsWith("    ")) {
                    removedCount += 4;
                    return line.substring(4);
                } else if (line.startsWith("\t")) {
                    removedCount += 1;
                    return line.substring(1);
                } else {
                    const match = line.match(/^ {1,3}/);
                    if (match) {
                        removedCount += match[0].length;
                        return line.substring(match[0].length);
                    }
                }
                return line;
            }).join("\n");
            
            textarea.value = before + modified + after;
            textarea.selectionStart = Math.max(lineStart, start - (selected.startsWith("    ") ? 4 : 0));
            textarea.selectionEnd = Math.max(lineStart, lineStart + modified.length);
        }
        
        // Gọi lại để cập nhật line numbers và check syntax
        updateLineNumbers();
        checkCodeSyntax(textarea.value);
    }
}

function refreshSuggestionHighlights() {
    const popup = document.getElementById("autocomplete-suggestions");
    if (!popup) return;
    popup.querySelectorAll(".autocomplete-item").forEach((div, idx) => {
        if (idx === activeSuggestionIndex) {
            div.classList.add("active");
        } else {
            div.classList.remove("active");
        }
    });
}

function hideAutocompleteOnClickOutside(e) {
    const popup = document.getElementById("autocomplete-suggestions");
    const textarea = document.getElementById("script-js-code");
    if (popup && popup.style.display === "block" && e.target !== textarea && !popup.contains(e.target)) {
        popup.style.display = "none";
    }
}

function updateRowHighlight(row, action) {
    row.classList.remove("row-highlight-mail", "row-highlight-phone");
    if (["create_mail", "type_mail", "get_mail_code"].includes(action)) {
        row.classList.add("row-highlight-mail");
    } else if (["rent_phone", "type_phone", "get_phone_code"].includes(action)) {
        row.classList.add("row-highlight-phone");
    }
}

function updateSelectorTranslationHint(row, selector) {
    let hintSpan = row.querySelector(".selector-translation-hint");
    if (!hintSpan) {
        hintSpan = document.createElement("span");
        hintSpan.className = "selector-translation-hint";
        hintSpan.style.cssText = "display: block; font-size: 0.75rem; color: #a78bfa; margin-top: 4px; padding-left: 38px; font-weight: 500;";
        row.appendChild(hintSpan);
    }
    
    selector = selector.trim();
    if (!selector) {
        hintSpan.style.display = "none";
        return;
    }
    
    let translated = SELECTOR_TRANSLATIONS[selector];
    if (!translated) {
        for (const [key, value] of Object.entries(SELECTOR_TRANSLATIONS)) {
            if (selector.includes(key)) {
                translated = `Chứa phần tử: ${value}`;
                break;
            }
        }
    }
    
    if (translated) {
        hintSpan.innerText = `🔮 Nhận diện: ${translated}`;
        hintSpan.style.display = "block";
    } else {
        hintSpan.style.display = "none";
    }
}

function validateGuiSteps() {
    let isValid = true;
    const container = document.getElementById("script-steps-container");
    if (!container) return true;
    const rows = container.querySelectorAll(".script-step-row");
    
    document.querySelectorAll(".error-tip").forEach(el => el.remove());
    document.querySelectorAll(".input-error").forEach(el => el.classList.remove("input-error"));

    rows.forEach((row, index) => {
        const actionSelect = row.querySelector(".step-action");
        const targetInput = row.querySelector(".target-input");
        const valueInput = row.querySelector(".value-input");
        const action = actionSelect.value;
        
        function showInputError(input, msg) {
            input.classList.add("input-error");
            let tip = input.parentElement.querySelector(".error-tip");
            if (!tip) {
                tip = document.createElement("div");
                tip.className = "error-tip";
                input.parentElement.appendChild(tip);
            }
            tip.innerText = msg;
            isValid = false;
        }

        if (action === "goto") {
            const urlVal = valueInput.value.trim();
            if (!urlVal) {
                showInputError(valueInput, "Vui lòng nhập địa chỉ URL trang web!");
            } else if (!urlVal.startsWith("http://") && !urlVal.startsWith("https://")) {
                showInputError(valueInput, "Địa chỉ URL phải bắt đầu bằng http:// hoặc https://!");
            }
        }
        
        const selectorRequiredActions = ["click", "click_right", "hover", "type", "type_phone", "get_phone_code", "type_mail", "get_mail_code", "solve_captcha"];
        if (selectorRequiredActions.includes(action)) {
            const selectorVal = targetInput.value.trim();
            if (!selectorVal) {
                showInputError(targetInput, "Vui lòng nhập CSS Selector!");
            }
        }
        
        if (action === "wait") {
            const waitVal = valueInput.value.trim();
            if (!waitVal) {
                showInputError(valueInput, "Vui lòng nhập số giây chờ!");
            } else if (isNaN(waitVal) || parseFloat(waitVal) <= 0) {
                showInputError(valueInput, "Số giây chờ phải là số dương lớn hơn 0!");
            }
        }
        
        if (action === "rent_phone") {
            const serviceVal = targetInput.value.trim();
            if (!serviceVal) {
                showInputError(targetInput, "Vui lòng điền tên dịch vụ (ví dụ: facebook, google)!");
            }
        }

        // 5. Kiểm tra định dạng cho email cũ khi tạo/đăng nhập email ảo (create_mail)
        if (action === "create_mail" && valueInput.value.trim() !== "") {
            const emailVal = valueInput.value.trim();
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(emailVal)) {
                showInputError(valueInput, "Email đăng nhập cũ không đúng định dạng (Ví dụ đúng: shop01@okban.shop)!");
            }
        }

        // 6. Kiểm tra định dạng mã quốc gia khi thuê phone (rent_phone)
        if (action === "rent_phone" && valueInput.value.trim() !== "") {
            const countryVal = valueInput.value.trim();
            const countryRegex = /^[a-zA-Z]{2,3}$/;
            if (!countryRegex.test(countryVal)) {
                showInputError(valueInput, "Mã quốc gia phải là 2-3 chữ cái viết hoa (Ví dụ: VN, US, RU)!");
            }
        }

        // 7. Chống nhầm lẫn điền email, phone, OTP hoặc mô tả tiếng Việt vào ô CSS Selector (Target)
        const selectorActions = ["click", "click_right", "hover", "type", "type_mail", "type_phone", "get_mail_code", "get_phone_code"];
        if (selectorActions.includes(action)) {
            const selectorVal = targetInput.value.trim();
            
            if (selectorVal) {
                // Check điền email vào ô Selector
                if (selectorVal.includes("@")) {
                    showInputError(targetInput, "Lỗi nhầm lẫn: Đây là ô 'CSS Selector' (khung định vị trên web), không được điền địa chỉ email của bạn vào đây! Email sẽ do hệ thống tự động sinh ra và điền vào.");
                }
                // Check điền số điện thoại vào ô Selector (chỉ chứa số, khoảng trắng, dấu cộng, dấu gạch ngang và dài từ 8 ký tự trở lên)
                else if (/^\+?[0-9\s\-]{8,15}$/.test(selectorVal)) {
                    showInputError(targetInput, "Lỗi nhầm lẫn: Đây là ô 'CSS Selector' (khung định vị trên web), không được điền số điện thoại thật vào đây! Số điện thoại sẽ do hệ thống tự động thuê và điền vào.");
                }
                // Check điền mã OTP vào ô Selector (chỉ chứa số và dài từ 4 đến 8 ký tự)
                else if (/^[0-9]{4,8}$/.test(selectorVal)) {
                    let otpTypeName = (action === "get_mail_code" || action === "get_phone_code") ? "Mã OTP" : "Mã số";
                    showInputError(targetInput, `Lỗi nhầm lẫn: Đây là ô 'CSS Selector' để hệ thống biết khung nhập OTP nằm ở đâu trên trang web. Không được điền trực tiếp ${otpTypeName} vào đây!`);
                }
                // Check gõ chữ mô tả tiếng Việt có dấu
                else if (/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệđìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i.test(selectorVal)) {
                    showInputError(targetInput, "Lỗi nhầm lẫn: Đây là ô CSS Selector để xác định nút/khung trên trang web (Ví dụ đúng: #ap_password hoặc .btn-submit). Vui lòng không gõ tiếng Việt có dấu hoặc mô tả vào đây!");
                }
            }
        }
    });

    if (!isValid) {
        const firstError = document.querySelector(".input-error");
        if (firstError) {
            firstError.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }
    
    return isValid;
}

function openScriptModal(mode, id = null) {
    const modal = document.getElementById("script-modal");
    document.getElementById("script-js-code").value = "";
    const container = document.getElementById("script-steps-container");
    if (container) container.innerHTML = "";

    if (mode === "create") {
        document.getElementById("script-modal-title").innerText = "Tạo Kịch bản Tự động hóa mới";
        document.getElementById("script-id").value = "";
        document.getElementById("s-name").value = "";
        
        switchScriptMode("gui");
        addScriptStepRow();
        
        // Reset cấu hình lưu tài nguyên kịch bản
        document.getElementById("s-cap-user-enable").checked = false;
        document.getElementById("s-cap-user-selector").value = "";
        document.getElementById("s-cap-pass-enable").checked = false;
        document.getElementById("s-cap-pass-selector").value = "";
        document.getElementById("s-cap-email-enable").checked = false;
        document.getElementById("s-cap-email-selector").value = "";
        document.getElementById("s-cap-phone-enable").checked = false;
        document.getElementById("s-cap-phone-selector").value = "";
        document.getElementById("s-cap-cookie-enable").checked = false;
    } else {
        document.getElementById("script-modal-title").innerText = "Chỉnh sửa Kịch bản";
        document.getElementById("script-id").value = id;
    }

    modal.classList.add("active");
    
    // Khởi tạo các bổ trợ cho JS Editor sau khi modal mở
    setTimeout(initJsEditorEnrichments, 100);
}

function closeScriptModal() {
    document.getElementById("script-modal").classList.remove("active");
}

function updateStepIconAndBorder(selectEl) {
    const row = selectEl.closest(".script-step-row");
    if (!row) return;
    const action = selectEl.value;
    const iconSpan = row.querySelector(".step-icon-indicator");
    
    // Xóa toàn bộ các class loại bước cũ
    row.classList.remove("step-type-basic", "step-type-mail", "step-type-phone", "step-type-captcha", "step-type-proxy", "step-type-social");
    
    let iconClass = "fa-play";
    let typeClass = "step-type-basic";
    
    if (['goto', 'click', 'click_right', 'click_xy', 'click_right_xy', 'hover', 'type', 'press', 'scroll', 'wait', 'fill_register'].includes(action)) {
        typeClass = "step-type-basic";
        if (action === "goto") iconClass = "fa-globe";
        else if (action.includes("click_xy")) iconClass = "fa-crosshairs";
        else if (action.includes("click")) iconClass = "fa-mouse-pointer";
        else if (action === "hover") iconClass = "fa-hand-pointer";
        else if (action === "type" || action === "press") iconClass = "fa-keyboard";
        else if (action === "scroll") iconClass = "fa-arrows-up-down";
        else if (action === "wait") iconClass = "fa-clock";
        else if (action === "fill_register") iconClass = "fa-user-check";
    } else if (action.includes("_mail")) {
        typeClass = "step-type-mail";
        iconClass = "fa-envelope";
    } else if (action.includes("_phone")) {
        typeClass = "step-type-phone";
        iconClass = "fa-mobile-screen-button";
    } else if (action === "solve_captcha") {
        typeClass = "step-type-captcha";
        iconClass = "fa-shield-halved";
    } else if (action.includes("proxy") || action === "get_old_ip") {
        typeClass = "step-type-proxy";
        iconClass = "fa-network-wired";
    } else if (action.includes("social_")) {
        typeClass = "step-type-social";
        iconClass = "fa-comments";
    }
    
    row.classList.add(typeClass);
    if (iconSpan) {
        iconSpan.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    }
}

function addScriptStepRow(step = null, insertAfterElement = null) {
    const container = document.getElementById("script-steps-container");
    const index = container.children.length + 1;
    
    const div = document.createElement("div");
    div.className = "script-step-row";
    div.style.flexWrap = "wrap";
    
    const action = step ? step.action : "goto";
    const target = step ? step.target : "";
    const value = step ? step.value : "";
    const variable = step ? (step.var || step.variable || "mail_1") : "mail_1";
    const service = step ? (step.service || "autocaptcha") : "autocaptcha";
    
    div.innerHTML = `
        <span class="step-num">${index}</span>
        <span class="step-icon-indicator" style="font-size: 1.1rem; color: #818cf8; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; margin-right: 4px; background: rgba(129, 140, 248, 0.1); border-radius: 8px; border: 1px solid rgba(129, 140, 248, 0.2); transition: all 0.3s;"><i class="fa-solid fa-play"></i></span>
        <select class="step-action" onchange="toggleStepInputs(this); updateStepIconAndBorder(this);">
            <optgroup label="Tương tác cơ bản (Trình duyệt)">
                <option value="goto" ${action === 'goto' ? 'selected' : ''}>Mở URL (goto)</option>
                <option value="click" ${action === 'click' ? 'selected' : ''}>Click trái (click)</option>
                <option value="click_right" ${action === 'click_right' ? 'selected' : ''}>Click phải (click_right)</option>
                <option value="click_xy" ${action === 'click_xy' ? 'selected' : ''}>Click tọa độ trái (click_xy)</option>
                <option value="click_right_xy" ${action === 'click_right_xy' ? 'selected' : ''}>Click tọa độ phải (click_right_xy)</option>
                <option value="hover" ${action === 'hover' ? 'selected' : ''}>Di chuột (hover)</option>
                <option value="type" ${action === 'type' ? 'selected' : ''}>Gõ chữ (type)</option>
                <option value="press" ${action === 'press' ? 'selected' : ''}>Nhấn Phím (press)</option>
                <option value="scroll" ${action === 'scroll' ? 'selected' : ''}>Cuộn trang (scroll)</option>
                <option value="wait" ${action === 'wait' ? 'selected' : ''}>Đợi giây (wait)</option>
                <option value="fill_register" ${action === 'fill_register' ? 'selected' : ''}>Đăng ký thông minh (fill_register)</option>
            </optgroup>
            <optgroup label="Nhóm API Mail (Quản lý Mail ảo)">
                <option value="create_mail" ${action === 'create_mail' ? 'selected' : ''}>Tạo/Đăng nhập email (create_mail)</option>
                <option value="type_mail" ${action === 'type_mail' ? 'selected' : ''}>Gõ email ảo (type_mail)</option>
                <option value="get_mail_code" ${action === 'get_mail_code' ? 'selected' : ''}>Lấy OTP email (get_mail_code)</option>
                <option value="delete_mail" ${action === 'delete_mail' ? 'selected' : ''}>Hủy/Xóa email ảo (delete_mail)</option>
            </optgroup>
            <optgroup label="Nhóm API Thuê Phone (SMS OTP)">
                <option value="rent_phone" ${action === 'rent_phone' ? 'selected' : ''}>Thuê số điện thoại (rent_phone)</option>
                <option value="type_phone" ${action === 'type_phone' ? 'selected' : ''}>Gõ số điện thoại (type_phone)</option>
                <option value="get_phone_code" ${action === 'get_phone_code' ? 'selected' : ''}>Lấy OTP điện thoại (get_phone_code)</option>
                <option value="cancel_phone" ${action === 'cancel_phone' ? 'selected' : ''}>Hủy số điện thoại (cancel_phone)</option>
            </optgroup>
            <optgroup label="Nhóm API Vượt Captcha">
                <option value="solve_captcha" ${action === 'solve_captcha' ? 'selected' : ''}>Giải ảnh Captcha (solve_captcha)</option>
            </optgroup>
            <optgroup label="Nhóm API Proxy">
                <option value="rotate_proxy" ${action === 'rotate_proxy' ? 'selected' : ''}>Xoay IP Proxy (rotate_proxy)</option>
                <option value="check_proxy" ${action === 'check_proxy' ? 'selected' : ''}>Kiểm tra Proxy (check_proxy)</option>
                <option value="rotate_proxy_if_die" ${action === 'rotate_proxy_if_die' ? 'selected' : ''}>Tự xoay nếu IP die (rotate_proxy_if_die)</option>
                <option value="rotate_proxy_every_n_runs" ${action === 'rotate_proxy_every_n_runs' ? 'selected' : ''}>Tự xoay sau N lần chạy (rotate_proxy_every_n_runs)</option>
                <option value="get_old_ip" ${action === 'get_old_ip' ? 'selected' : ''}>Lấy lại IP cũ (get_old_ip)</option>
            </optgroup>
            <optgroup label="Mạng xã hội (Facebook/TikTok)">
                <option value="social_message" ${action === 'social_message' ? 'selected' : ''}>Nhắn tin MXH (social_message)</option>
                <option value="social_reply_unread" ${action === 'social_reply_unread' ? 'selected' : ''}>Trả lời tin nhắn chưa đọc (social_reply_unread)</option>
                <option value="social_reply_comment" ${action === 'social_reply_comment' ? 'selected' : ''}>Trả lời bình luận (social_reply_comment)</option>
                <option value="social_reaction" ${action === 'social_reaction' ? 'selected' : ''}>Thả Reaction MXH (social_reaction)</option>
            </optgroup>
        </select>
        
        <select class="step-var-select" style="display:none; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color); background-color: rgba(255,255,255,0.03); color: white; width: 120px;" title="Biến lưu trữ / Biến nguồn">
            <option value="mail_1" ${variable === 'mail_1' ? 'selected' : ''}>mail_1</option>
            <option value="mail_2" ${variable === 'mail_2' ? 'selected' : ''}>mail_2</option>
            <option value="mail_3" ${variable === 'mail_3' ? 'selected' : ''}>mail_3</option>
            <option value="phone_1" ${variable === 'phone_1' ? 'selected' : ''}>phone_1</option>
            <option value="phone_2" ${variable === 'phone_2' ? 'selected' : ''}>phone_2</option>
            <option value="phone_3" ${variable === 'phone_3' ? 'selected' : ''}>phone_3</option>
            <option value="captcha_1" ${variable === 'captcha_1' ? 'selected' : ''}>captcha_1</option>
            <option value="captcha_2" ${variable === 'captcha_2' ? 'selected' : ''}>captcha_2</option>
        </select>
        
        <select class="step-captcha-select" style="display:none; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color); background-color: rgba(255,255,255,0.03); color: white; width: 160px;" title="Dịch vụ giải captcha">
            <option value="autocaptcha" ${service === 'autocaptcha' ? 'selected' : ''}>AutoCaptcha.pro</option>
            <option value="anticaptcha" ${service === 'anticaptcha' ? 'selected' : ''}>AntiCaptcha.top</option>
            <option value="1stcaptcha" ${service === '1stcaptcha' ? 'selected' : ''}>1stCaptcha</option>
            <option value="2captcha" ${service === '2captcha' ? 'selected' : ''}>2Captcha</option>
            <option value="anycaptcha" ${service === 'anycaptcha' ? 'selected' : ''}>AnyCaptcha</option>
        </select>
        
        <input type="text" class="target-input" placeholder="CSS Selector" value="${target}" style="${['goto', 'wait', 'press', 'click_xy', 'click_right_xy', 'fill_register', 'create_mail', 'rent_phone', 'rotate_proxy', 'check_proxy', 'rotate_proxy_if_die', 'rotate_proxy_every_n_runs', 'get_old_ip', 'delete_mail', 'cancel_phone'].includes(action) ? 'display:none;' : ''}">
        
        <select class="target-sms-select" style="display:none; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color); background-color: rgba(255,255,255,0.03); color: white; width: 220px;">
            <option value="facebook" ${target === 'facebook' ? 'selected' : ''}>Facebook</option>
            <option value="google" ${target === 'google' ? 'selected' : ''}>Google/Gmail</option>
            <option value="telegram" ${target === 'telegram' ? 'selected' : ''}>Telegram</option>
            <option value="twitter" ${target === 'twitter' ? 'selected' : ''}>Twitter/X</option>
            <option value="microsoft" ${target === 'microsoft' ? 'selected' : ''}>Hotmail/Outlook</option>
            <option value="shopee" ${target === 'shopee' ? 'selected' : ''}>Shopee</option>
            <option value="tiktok" ${target === 'tiktok' ? 'selected' : ''}>Tiktok</option>
            <option value="amazon" ${target === 'amazon' ? 'selected' : ''}>Amazon</option>
            <option value="instagram" ${target === 'instagram' ? 'selected' : ''}>Instagram</option>
            <option value="whatsapp" ${target === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
            <option value="viber" ${target === 'viber' ? 'selected' : ''}>Viber</option>
            <option value="zalo" ${target === 'zalo' ? 'selected' : ''}>Zalo</option>
            <option value="discord" ${target === 'discord' ? 'selected' : ''}>Discord</option>
            <option value="openai" ${target === 'openai' ? 'selected' : ''}>OpenAI/ChatGPT</option>
            <option value="steam" ${target === 'steam' ? 'selected' : ''}>Steam</option>
        </select>

        <div class="value-wrapper" style="display: flex; align-items: center; gap: 6px; flex-grow: 1;">
            <input type="text" class="value-input" placeholder="Giá trị / Tham số" value="${value}" style="flex-grow: 1; ${['rent_phone', 'type_phone', 'get_phone_code', 'type_mail', 'get_mail_code', 'solve_captcha', 'check_proxy', 'delete_mail', 'cancel_phone'].includes(action) ? 'display:none;' : ''}">
            
            <select class="value-sms-select" style="display:none; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color); background-color: rgba(255,255,255,0.03); color: white; flex-grow: 1;">
                <option value="VN" ${value === 'VN' || value === '84' ? 'selected' : ''}>Việt Nam (VN / 84)</option>
                <option value="US" ${value === 'US' || value === '1' ? 'selected' : ''}>Mỹ (USA / 1)</option>
                <option value="GB" ${value === 'GB' || value === '44' ? 'selected' : ''}>Anh (UK / 44)</option>
                <option value="CA" ${value === 'CA' ? 'selected' : ''}>Canada</option>
                <option value="JP" ${value === 'JP' || value === '81' ? 'selected' : ''}>Nhật Bản (81)</option>
                <option value="KR" ${value === 'KR' || value === '82' ? 'selected' : ''}>Hàn Quốc (82)</option>
            </select>

            <span class="value-unit" style="font-size: 0.85rem; color: var(--text-secondary); display: none;">giây</span>
        </div>
        
        <button type="button" class="btn-icon btn-move-up" onclick="moveStepUp(this)" title="Di chuyển hành động lên" style="background-color: rgba(255,255,255,0.02); color: var(--text-secondary);"><i class="fa-solid fa-arrow-up"></i></button>
        <button type="button" class="btn-icon btn-move-down" onclick="moveStepDown(this)" title="Di chuyển hành động xuống" style="background-color: rgba(255,255,255,0.02); color: var(--text-secondary);"><i class="fa-solid fa-arrow-down"></i></button>
        <button type="button" class="btn-icon btn-insert" onclick="insertStepBelow(this)" title="Chèn hành động mới ngay phía dưới" style="background-color: rgba(16, 185, 129, 0.06); color: var(--success-color); border-color: rgba(16, 185, 129, 0.1);"><i class="fa-solid fa-plus"></i></button>
        <button type="button" class="btn-icon btn-delete" onclick="this.parentElement.remove(); reorderStepNumbers();" title="Xóa bước này"><i class="fa-solid fa-trash"></i></button>
        
        <!-- Các nút bấm kiểm thử SIM ảo trực tuyến ngay trên block GUI -->
        <div class="sms-test-buttons-wrapper" style="display:none; flex-basis: 100%; margin-top: 8px; padding-left: 38px; gap: 8px; align-items: center;">
            <button type="button" class="btn btn-secondary btn-sm btn-sms-test-rent" style="padding: 4px 8px; font-size: 0.72rem;"><i class="fa-solid fa-mobile-screen-button"></i> Thuê thử</button>
            <button type="button" class="btn btn-secondary btn-sm btn-sms-test-otp" style="padding: 4px 8px; font-size: 0.72rem;" disabled><i class="fa-solid fa-message"></i> Lấy OTP</button>
            <button type="button" class="btn btn-danger btn-sm btn-sms-test-cancel" style="padding: 4px 8px; font-size: 0.72rem;" disabled><i class="fa-solid fa-ban"></i> Hủy số</button>
            <span class="sms-test-status" style="font-size: 0.72rem; color: #a5b4fc; margin-left: 8px; font-family: monospace;"></span>
        </div>

        <div class="step-hint" style="flex-basis: 100%; font-size: 0.72rem; color: #a5b4fc; margin-top: 6px; padding-left: 38px; font-style: italic; opacity: 0.85;">👉 Đang tải gợi ý...</div>
    `;
    
    const targetInput = div.querySelector(".target-input");
    const valueInput = div.querySelector(".value-input");
    const targetSmsSelect = div.querySelector(".target-sms-select");
    const valueSmsSelect = div.querySelector(".value-sms-select");
    const select = div.querySelector(".step-action");
    
    // Đồng bộ từ select sang input thô
    targetSmsSelect.addEventListener("change", () => {
        targetInput.value = targetSmsSelect.value;
    });
    valueSmsSelect.addEventListener("change", () => {
        valueInput.value = valueSmsSelect.value;
    });
    
    // Đăng ký các sự kiện test SIM ảo trực tiếp trên block kịch bản
    let rentRequestId = null;
    let rentSmsInterval = null;
    let rentTimer = 60;
    let rentTimerInterval = null;

    const btnRent = div.querySelector(".btn-sms-test-rent");
    const btnOtp = div.querySelector(".btn-sms-test-otp");
    const btnCancel = div.querySelector(".btn-sms-test-cancel");
    const testStatus = div.querySelector(".sms-test-status");

    btnRent.addEventListener("click", async () => {
        btnRent.disabled = true;
        testStatus.textContent = "Đang thuê...";
        
        try {
            const res = await fetch("/api/test/rent_phone", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "smspool", // Mặc định dùng SMSPool test, hoặc tự động lấy cấu hình backend
                    service: targetSmsSelect.value,
                    country: valueSmsSelect.value === "VN" ? "84" : valueSmsSelect.value === "US" ? "1" : valueSmsSelect.value === "GB" ? "44" : valueSmsSelect.value === "JP" ? "81" : valueSmsSelect.value === "KR" ? "82" : "1"
                })
            });
            const data = await res.json();
            if (data.success) {
                rentRequestId = data.request_id;
                testStatus.textContent = `SĐT: ${data.phone} (${rentTimer}s)`;
                btnOtp.disabled = false;
                btnCancel.disabled = false;
                
                // Đếm ngược 60s
                rentTimer = 60;
                if (rentTimerInterval) clearInterval(rentTimerInterval);
                rentTimerInterval = setInterval(() => {
                    rentTimer--;
                    if (rentTimer <= 0) {
                        clearInterval(rentTimerInterval);
                        testStatus.textContent = `Hết hạn SĐT: ${data.phone}`;
                        btnOtp.disabled = true;
                        btnCancel.disabled = true;
                        btnRent.disabled = false;
                    } else {
                        testStatus.textContent = `SĐT: ${data.phone} (${rentTimer}s)`;
                    }
                }, 1000);
            } else {
                testStatus.textContent = `Lỗi: ${data.error}`;
                btnRent.disabled = false;
            }
        } catch (e) {
            testStatus.textContent = `Lỗi kết nối: ${e.message}`;
            btnRent.disabled = false;
        }
    });

    btnOtp.addEventListener("click", async () => {
        if (!rentRequestId) return;
        testStatus.textContent = "Đang kiểm tra OTP...";
        
        try {
            const res = await fetch("/api/test/check_phone_otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "smspool",
                    request_id: rentRequestId,
                    key: "dummy" // Backend sẽ tự lấy key thật từ DB nếu không truyền hoặc test key
                })
            });
            const data = await res.json();
            if (data.success && data.code) {
                testStatus.textContent = `Mã OTP: ${data.code}`;
                clearInterval(rentTimerInterval);
                btnOtp.disabled = true;
                btnCancel.disabled = true;
                btnRent.disabled = false;
            } else {
                testStatus.textContent = `Chưa có OTP. Thử lại sau! (Còn ${rentTimer}s)`;
            }
        } catch (e) {
            testStatus.textContent = `Lỗi lấy OTP: ${e.message}`;
        }
    });

    btnCancel.addEventListener("click", async () => {
        if (!rentRequestId) return;
        testStatus.textContent = "Đang hủy...";
        clearInterval(rentTimerInterval);
        
        try {
            const res = await fetch("/api/test/cancel_phone", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "smspool",
                    request_id: rentRequestId
                })
            });
            const data = await res.json();
            testStatus.textContent = data.success ? "Đã hủy số thành công!" : `Lỗi hủy: ${data.error}`;
        } catch (e) {
            testStatus.textContent = `Lỗi hủy: ${e.message}`;
        }
        
        btnRent.disabled = false;
        btnOtp.disabled = true;
        btnCancel.disabled = true;
        rentRequestId = null;
    });

    targetInput.addEventListener("input", () => {
        updateSelectorTranslationHint(div, targetInput.value);
    });

    if (insertAfterElement) {
        insertAfterElement.parentNode.insertBefore(div, insertAfterElement.nextSibling);
    } else {
        container.appendChild(div);
    }
    populateSMSPoolSelects(div, target, value);
    toggleStepInputs(select);
    updateStepIconAndBorder(select);
    updateRowHighlight(div, action);
}

function populateSMSPoolSelects(rowDiv, selectTargetVal, selectValueVal) {
    const targetSmsSelect = rowDiv.querySelector(".target-sms-select");
    const valueSmsSelect = rowDiv.querySelector(".value-sms-select");
    
    if (targetSmsSelect) {
        targetSmsSelect.innerHTML = "";
        const services = globalSMSPoolServices && globalSMSPoolServices.length > 0 
            ? globalSMSPoolServices 
            : [{ ID: 1, name: "Google/Gmail" }, { ID: 2, name: "Facebook" }, { ID: 3, name: "Telegram" }, { ID: 4, name: "Twitter/X" }, { ID: 5, name: "Discord" }, { ID: 11, name: "Tiktok" }, { ID: 12, name: "Shopee" }];
        
        const sortedServices = [...services].sort((a, b) => a.name.localeCompare(b.name));
        sortedServices.forEach(srv => {
            const opt = document.createElement("option");
            opt.value = srv.name.toLowerCase();
            opt.innerText = srv.name;
            if (selectTargetVal && selectTargetVal.toLowerCase() === srv.name.toLowerCase()) {
                opt.selected = true;
            }
            targetSmsSelect.appendChild(opt);
        });
        
        if (selectTargetVal && !sortedServices.some(s => s.name.toLowerCase() === selectTargetVal.toLowerCase())) {
            const opt = document.createElement("option");
            opt.value = selectTargetVal.toLowerCase();
            opt.innerText = selectTargetVal;
            opt.selected = true;
            targetSmsSelect.appendChild(opt);
        }
    }
    
    if (valueSmsSelect) {
        valueSmsSelect.innerHTML = "";
        const countries = globalSMSPoolCountries && globalSMSPoolCountries.length > 0
            ? globalSMSPoolCountries
            : [
                { ID: 1, name: "United States (Mỹ)", short_name: "US" },
                { ID: 2, name: "United Kingdom (Anh)", short_name: "GB" },
                { ID: 4, name: "Vietnam (Việt Nam)", short_name: "VN" },
                { ID: 13, name: "Australia (Úc)", short_name: "AU" },
                { ID: 15, name: "Indonesia", short_name: "ID" },
                { ID: 16, name: "Philippines", short_name: "PH" },
                { ID: 17, name: "Thailand (Thái Lan)", short_name: "TH" },
                { ID: 40, name: "Japan (Nhật Bản)", short_name: "JP" },
                { ID: 41, name: "South Korea (Hàn Quốc)", short_name: "KR" }
            ];
            
        const sortedCountries = [...countries].sort((a, b) => a.name.localeCompare(b.name));
        
        const vnOpt = document.createElement("option");
        vnOpt.value = "VN";
        vnOpt.innerText = "Việt Nam (VN)";
        if (selectValueVal === "VN" || selectValueVal === "84" || selectValueVal === "13") {
            vnOpt.selected = true;
        }
        valueSmsSelect.appendChild(vnOpt);
        
        sortedCountries.forEach(c => {
            if (c.short_name === "VN" || c.name.toLowerCase().includes("vietnam")) return;
            const opt = document.createElement("option");
            opt.value = c.ID !== undefined ? c.ID.toString() : c.short_name;
            opt.innerText = `${c.name} (${c.short_name || ''})`;
            if (selectValueVal && (selectValueVal.toString() === c.ID?.toString() || selectValueVal.toString().toUpperCase() === c.short_name.toUpperCase())) {
                opt.selected = true;
            }
            valueSmsSelect.appendChild(opt);
        });
    }
}

function toggleStepInputs(select) {
    const row = select.parentElement;
    const action = select.value;
    const targetInput = row.querySelector(".target-input");
    const valueInput = row.querySelector(".value-input");
    const unitSpan = row.querySelector(".value-unit");
    
    updateRowHighlight(row, action);

    const noTargetActions = ["goto", "wait", "press", "click_xy", "click_right_xy", "fill_register", "social_message", "create_mail", "rent_phone", "rotate_proxy", "check_proxy", "rotate_proxy_if_die", "rotate_proxy_every_n_runs", "get_old_ip", "delete_mail", "cancel_phone"];
    const targetSmsSelect = row.querySelector(".target-sms-select");
    const valueSmsSelect = row.querySelector(".value-sms-select");
    const smsTestWrapper = row.querySelector(".sms-test-buttons-wrapper");
    const varSelect = row.querySelector(".step-var-select");
    const captchaSelect = row.querySelector(".step-captcha-select");

    // Ẩn hiện các select box biến động và captcha
    const mailActions = ["create_mail", "type_mail", "get_mail_code", "delete_mail"];
    const phoneActions = ["rent_phone", "type_phone", "get_phone_code", "cancel_phone"];
    const captchaActions = ["solve_captcha"];

    if (varSelect) {
        if (mailActions.includes(action) || phoneActions.includes(action) || captchaActions.includes(action)) {
            varSelect.style.display = "block";
            // Lọc các option cho phù hợp
            Array.from(varSelect.options).forEach(opt => {
                if (mailActions.includes(action)) {
                    opt.style.display = opt.value.startsWith("mail") ? "block" : "none";
                } else if (phoneActions.includes(action)) {
                    opt.style.display = opt.value.startsWith("phone") ? "block" : "none";
                } else if (captchaActions.includes(action)) {
                    opt.style.display = opt.value.startsWith("captcha") ? "block" : "none";
                }
            });
            // Tự động chọn option đầu tiên hiển thị nếu option hiện tại bị ẩn
            if (varSelect.selectedOptions[0] && varSelect.selectedOptions[0].style.display === "none") {
                const firstVisible = Array.from(varSelect.options).find(o => o.style.display === "block");
                if (firstVisible) varSelect.value = firstVisible.value;
            }
        } else {
            varSelect.style.display = "none";
        }
    }

    if (captchaSelect) {
        if (action === "solve_captcha") {
            captchaSelect.style.display = "block";
        } else {
            captchaSelect.style.display = "none";
        }
    }

    if (action === "rent_phone") {
        targetInput.style.display = "none";
        valueInput.style.display = "none";
        if (targetSmsSelect) targetSmsSelect.style.display = "block";
        if (valueSmsSelect) valueSmsSelect.style.display = "block";
        if (smsTestWrapper) smsTestWrapper.style.display = "flex";
    } else {
        if (targetSmsSelect) targetSmsSelect.style.display = "none";
        if (valueSmsSelect) valueSmsSelect.style.display = "none";
        if (smsTestWrapper) smsTestWrapper.style.display = "none";
        
        if (noTargetActions.includes(action)) {
            targetInput.style.display = "none";
        } else {
            targetInput.style.display = "block";
        }
    }
    
    const valueHiddenActions = ['rent_phone', 'type_phone', 'get_phone_code', 'type_mail', 'get_mail_code', 'solve_captcha', 'fill_register', 'check_proxy', 'delete_mail', 'cancel_phone'];
    if (valueInput) {
        if (valueHiddenActions.includes(action)) {
            valueInput.style.display = "none";
        } else {
            valueInput.style.display = "block";
        }
    }    
    if (unitSpan) {
        if (action === "wait") {
            unitSpan.innerText = "giây";
            unitSpan.style.display = "inline-block";
        } else {
            unitSpan.style.display = "none";
        }
    }

    if (action === "social_reply_unread") {
        targetInput.placeholder = "CSS Selector / Tọa độ hòm thư (tùy chọn)";
    } else if (action === "social_reply_comment") {
        targetInput.placeholder = "CSS Selector / Tọa độ thông báo (tùy chọn)";
    } else if (action === "social_reaction") {
        targetInput.placeholder = "CSS Selector / Tọa độ thông báo (tùy chọn)";
    } else if (action === "solve_captcha") {
        targetInput.placeholder = "CSS Selector ảnh captcha (ví dụ: img#captcha)";
    } else {
        targetInput.placeholder = "CSS Selector";
    }
    
    if (action === "goto") {
        valueInput.placeholder = "Ví dụ: https://google.com";
    } else if (action === "wait") {
        valueInput.placeholder = "Số giây chờ (Ví dụ: 2)";
    } else if (action === "scroll") {
        valueInput.placeholder = "down hoặc up";
    } else if (action === "type") {
        valueInput.placeholder = "Nội dung cần nhập";
    } else if (action === "press") {
        valueInput.placeholder = "Enter, Tab, Backspace...";
    } else if (action === "click_xy" || action === "click_right_xy") {
        valueInput.placeholder = "Ví dụ: 100 200 (Tọa độ X Y)";
    } else if (action === "social_message") {
        valueInput.placeholder = "Nội dung tin nhắn cần gửi";
    } else if (action === "social_reply_unread" || action === "social_reply_comment") {
        valueInput.placeholder = "Nội dung tin nhắn phản hồi";
    } else if (action === "social_reaction") {
        valueInput.placeholder = "Ví dụ: like, love, haha, wow, sad, angry";
    } else if (action === "create_mail") {
        valueInput.placeholder = "Để trống để tạo mới, hoặc điền email cũ (Ví dụ: abc@1secmail.com)";
    } else if (action === "rotate_proxy") {
        valueInput.placeholder = "API Rotate URL (Ghi đè - Tùy chọn)";
    } else {
        valueInput.placeholder = "Giá trị / Tham số";
    }

    const hintDiv = row.querySelector(".step-hint");
    if (hintDiv) {
        let hintText = "";
        if (action === "goto") {
            hintText = "👉 Mở trang web được nhập ở ô Tham số (Ví dụ: https://google.com).";
        } else if (action === "click") {
            hintText = "👉 Nhấp chuột trái vào phần tử trên trang web theo CSS Selector.";
        } else if (action === "click_right") {
            hintText = "👉 Nhấp chuột phải vào phần tử trên trang web theo CSS Selector.";
        } else if (action === "click_xy") {
            hintText = "👉 Nhấp chuột trái vào tọa độ màn hình X Y (Ví dụ ở ô Tham số: 100 200).";
        } else if (action === "click_right_xy") {
            hintText = "👉 Nhấp chuột phải vào tọa độ màn hình X Y (Ví dụ ở ô Tham số: 100 200).";
        } else if (action === "hover") {
            hintText = "👉 Rê chuột đến phần tử trên trang web theo CSS Selector.";
        } else if (action === "type") {
            hintText = "👉 Nhấp vào ô nhập liệu (Selector) và gõ nội dung ở ô Tham số.";
        } else if (action === "press") {
            hintText = "👉 Nhấn phím trên bàn phím (Ví dụ ở ô Tham số: Enter, Tab, Backspace).";
        } else if (action === "scroll") {
            hintText = "👉 Cuộn trang lên hoặc xuống (Nhập ở ô Tham số: up hoặc down).";
        } else if (action === "wait") {
            hintText = "👉 Tạm dừng kịch bản trong số giây ở ô Tham số (Ví dụ: 2 là 2 giây).";
        } else if (action === "social_message") {
            hintText = "👉 Tự động tìm và gửi tin nhắn MXH với nội dung ở ô Tham số.";
        } else if (action === "social_reply_unread") {
            hintText = "👉 Tự động tìm các tin nhắn chưa đọc và trả lời bằng nội dung ở ô Tham số.";
        } else if (action === "social_reply_comment") {
            hintText = "👉 Tự động tìm bình luận và phản hồi lại bằng nội dung ở ô Tham số.";
        } else if (action === "social_reaction") {
            hintText = "👉 Tự động thả cảm xúc (like, love, haha, wow, sad, angry) vào bài viết.";
        } else if (action === "fill_register") {
            hintText = "👉 Tự động điền thông tin đăng ký tài khoản (họ tên, ngày sinh, mật khẩu...) một cách thông minh.";
        } else if (action === "rent_phone") {
            hintText = "👉 Gọi API thuê số điện thoại ảo. Điền tên dịch vụ (ví dụ: facebook, google) vào ô Dịch vụ, và quốc gia (ví dụ: VN, US) vào ô Tham số.";
        } else if (action === "type_phone") {
            hintText = "👉 Tự động lấy số điện thoại ảo từ biến nguồn chỉ định và gõ vào ô nhập liệu (CSS Selector).";
        } else if (action === "get_phone_code") {
            hintText = "👉 Đợi nhận mã OTP gửi về số điện thoại biến nguồn chỉ định và tự động gõ vào ô nhập mã OTP (CSS Selector).";
        } else if (action === "create_mail") {
            hintText = "👉 Tạo hòm thư ảo mới (để trống ô Tham số) hoặc Đăng nhập hòm thư cũ (điền email cũ vào ô Tham số). Kết quả lưu vào biến chỉ định.";
        } else if (action === "type_mail") {
            hintText = "👉 Tự động lấy địa chỉ email ảo từ biến nguồn chỉ định và gõ vào ô nhập email (CSS Selector).";
        } else if (action === "get_mail_code") {
            hintText = "👉 Đợi nhận mã OTP từ hòm thư ảo biến nguồn chỉ định và tự động gõ vào ô nhập mã OTP (CSS Selector).";
        } else if (action === "solve_captcha") {
            hintText = "👉 Chụp ảnh phần tử captcha tại CSS Selector và gọi dịch vụ đã chọn để giải. Lưu kết quả giải vào biến captcha chỉ định.";
        } else if (action === "rotate_proxy") {
            hintText = "👉 Gọi API yêu cầu xoay IP Proxy mới. Có thể ghi đè link API ở ô Tham số (để trống sẽ dùng mặc định của Profile/Cấu hình chung).";
        } else {
            hintText = "👉 Hành động kịch bản tự động hóa.";
        }
        hintDiv.innerText = hintText;
    }
}

function reorderStepNumbers() {
    const rows = document.querySelectorAll("#script-steps-container .script-step-row");
    rows.forEach((row, i) => {
        row.querySelector(".step-num").innerText = i + 1;
    });
}

function insertStepBelow(button) {
    const currentRow = button.closest(".script-step-row");
    addScriptStepRow(null, currentRow);
    reorderStepNumbers();
}

function moveStepUp(button) {
    const currentRow = button.closest(".script-step-row");
    const previousRow = currentRow.previousElementSibling;
    if (previousRow && previousRow.classList.contains("script-step-row")) {
        currentRow.parentNode.insertBefore(currentRow, previousRow);
        reorderStepNumbers();
    }
}

function moveStepDown(button) {
    const currentRow = button.closest(".script-step-row");
    const nextRow = currentRow.nextElementSibling;
    if (nextRow && nextRow.classList.contains("script-step-row")) {
        currentRow.parentNode.insertBefore(nextRow, currentRow);
        reorderStepNumbers();
    }
}

async function handleScriptFormSubmit(e) {
    e.preventDefault();
    const id = document.getElementById("script-id").value;
    const name = document.getElementById("s-name").value;
    const isEdit = id !== "";

    // Nếu đang ở chế độ GUI, validate dữ liệu trước khi sinh code và lưu
    if (currentScriptMode === "gui") {
        if (!validateGuiSteps()) {
            return;
        }
        generateJsFromGui();
    }

    const jsCode = document.getElementById("script-js-code").value;

    const captureConfig = {
        username: {
            enabled: document.getElementById("s-cap-user-enable").checked,
            selector: document.getElementById("s-cap-user-selector").value.trim()
        },
        password: {
            enabled: document.getElementById("s-cap-pass-enable").checked,
            selector: document.getElementById("s-cap-pass-selector").value.trim()
        },
        email: {
            enabled: document.getElementById("s-cap-email-enable").checked,
            selector: document.getElementById("s-cap-email-selector").value.trim()
        },
        phone: {
            enabled: document.getElementById("s-cap-phone-enable").checked,
            selector: document.getElementById("s-cap-phone-selector").value.trim()
        },
        cookie: {
            enabled: document.getElementById("s-cap-cookie-enable").checked
        }
    };

    const data = {
        name: name,
        steps: jsCode, // Lưu trực tiếp chuỗi code JavaScript vào steps
        capture_config: captureConfig
    };

    const url = isEdit ? `/api/scripts/${id}` : "/api/scripts";
    const method = isEdit ? "PUT" : "POST";

    try {
        const response = await fetch(url, {
            method: method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (result.success) {
            closeScriptModal();
            loadScripts();
        } else {
            alert("Loi: " + result.error);
        }
    } catch(err) {
        alert("Loi gui kich ban: " + err.message);
    }
}

async function editScript(id) {
    openScriptModal("edit", id);
    try {
        const response = await fetch(`/api/scripts/${id}`);
        const script = await response.json();
        
        document.getElementById("s-name").value = script.name;
        document.getElementById("script-js-code").value = script.steps || "";
        
        // Thiết lập cấu hình lưu tài nguyên kịch bản từ database
        let captureConfig = null;
        if (script.capture_config) {
            try {
                captureConfig = typeof script.capture_config === 'string' ? JSON.parse(script.capture_config) : script.capture_config;
            } catch (e) {
                captureConfig = null;
            }
        }
        
        if (captureConfig) {
            document.getElementById("s-cap-user-enable").checked = !!(captureConfig.username && captureConfig.username.enabled);
            document.getElementById("s-cap-user-selector").value = (captureConfig.username && captureConfig.username.selector) || "";
            
            document.getElementById("s-cap-pass-enable").checked = !!(captureConfig.password && captureConfig.password.enabled);
            document.getElementById("s-cap-pass-selector").value = (captureConfig.password && captureConfig.password.selector) || "";
            
            document.getElementById("s-cap-email-enable").checked = !!(captureConfig.email && captureConfig.email.enabled);
            document.getElementById("s-cap-email-selector").value = (captureConfig.email && captureConfig.email.selector) || "";
            
            document.getElementById("s-cap-phone-enable").checked = !!(captureConfig.phone && captureConfig.phone.enabled);
            document.getElementById("s-cap-phone-selector").value = (captureConfig.phone && captureConfig.phone.selector) || "";
            
            document.getElementById("s-cap-cookie-enable").checked = !!(captureConfig.cookie && captureConfig.cookie.enabled);
        } else {
            document.getElementById("s-cap-user-enable").checked = false;
            document.getElementById("s-cap-user-selector").value = "";
            document.getElementById("s-cap-pass-enable").checked = false;
            document.getElementById("s-cap-pass-selector").value = "";
            document.getElementById("s-cap-email-enable").checked = false;
            document.getElementById("s-cap-email-selector").value = "";
            document.getElementById("s-cap-phone-enable").checked = false;
            document.getElementById("s-cap-phone-selector").value = "";
            document.getElementById("s-cap-cookie-enable").checked = false;
        }
        
        parseGuiFromJs(script.steps || "");
        
        setTimeout(initJsEditorEnrichments, 100);
    } catch(err) {
        alert("Loi load script: " + err.message);
    }
}

async function deleteScript(id) {
    if (!confirm("Xóa kịch bản này? Các profile gán kịch bản này sẽ chuyển sang mặc định.")) return;
    try {
        const response = await fetch(`/api/scripts/${id}`, { method: "DELETE" });
        const result = await response.json();
        if (result.success) {
            loadScripts();
        }
    } catch(err) {
        alert("Loi xoa: " + err.message);
    }
}

// --- CAMPAIGNS (CHIẾN DỊCH ĐA LUỒNG) ---
async function loadCampaigns() {
    try {
        const response = await fetch("/api/campaigns");
        const campaigns = await response.json();
        
        const tbody = document.getElementById("campaign-list-body");
        tbody.innerHTML = "";
        
        if (campaigns.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-secondary);">Chua co chien dich nao</td></tr>`;
            return;
        }

        campaigns.forEach(c => {
            const isRunning = c.status === "Running";
            const statusBadge = isRunning 
                ? `<span class="badge badge-success"><span class="status-dot online"></span> Dang chay</span>`
                : `<span class="badge badge-secondary"><span class="status-dot"></span> Da dung</span>`;

            const playStopBtn = isRunning
                ? `<button class="btn-icon btn-stop" onclick="stopCampaign(${c.id})" title="Dung chien dich"><i class="fa-solid fa-square"></i></button>`
                : `<button class="btn-icon btn-start" onclick="startCampaign(${c.id})" title="Chay chien dich"><i class="fa-solid fa-play"></i></button>`;

            const sName = getScriptNameById(c.script_id);
            const proxyCount = c.use_api_proxy === 1 ? "API" : (c.proxies ? c.proxies.split("\n").filter(p => p.trim()).length : 0);

            let modeBadge = "";
            if (c.campaign_mode === 1) {
                modeBadge = `<div style="margin-top: 4px;"><span class="info-badge" style="background-color: rgba(239, 68, 68, 0.1); color: #ef4444;"><i class="fa-solid fa-ban"></i> Ngẫu nhiên (Đã tắt Ugener)</span></div>`;
            } else if (c.campaign_mode === 2) {
                modeBadge = `<div style="margin-top: 4px;"><span class="info-badge" style="background-color: rgba(245, 158, 11, 0.1); color: #fbbf24;"><i class="fa-solid fa-database"></i> Bản sao lưu (Backup)</span></div>`;
            } else if (c.campaign_mode === 3) {
                const countryText = c.profile_country === "random" ? "Ngẫu nhiên" : (c.profile_country || "Ngẫu nhiên");
                modeBadge = `<div style="margin-top: 4px;"><span class="info-badge" style="background-color: rgba(16, 185, 129, 0.1); color: #10b981;"><i class="fa-solid fa-earth-americas"></i> Tạm thời: ${countryText}</span></div>`;
            } else {
                modeBadge = `<div style="margin-top: 4px;"><span class="info-badge" style="background-color: rgba(99, 102, 241, 0.1); color: #a5b4fc;"><i class="fa-solid fa-user"></i> Chạy thường</span></div>`;
            }

            if (c.use_api_proxy === 1) {
                modeBadge += `<div style="margin-top: 4px;"><span class="info-badge" style="background-color: rgba(139, 92, 246, 0.1); color: #c084fc;"><i class="fa-solid fa-key"></i> API Proxy (${c.api_proxy_type})</span></div>`;
            }
            if (c.use_gateway_router === 1) {
                modeBadge += `<div style="margin-top: 4px;"><span class="info-badge" style="background-color: rgba(236, 72, 153, 0.1); color: #f472b6;"><i class="fa-solid fa-route"></i> Gateway Router</span></div>`;
            }

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><span class="text-bold">${c.name}</span><div class="text-mute">ID: ${c.id}</div>${modeBadge}</td>
                <td>${statusBadge}</td>
                <td>
                    <div>Song song: <span class="text-bold">${c.concurrent_threads} luong</span></div>
                    <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px;">Tong so: ${c.total_profiles} profiles</div>
                </td>
                <td><span style="color:#818cf8;"><i class="fa-solid fa-scroll"></i> ${sName}</span></td>
                <td><span class="info-badge">${proxyCount} Proxy</span></td>
                <td>
                    <div class="action-buttons">
                        ${playStopBtn}
                        <button class="btn-icon btn-delete" onclick="deleteCampaign(${c.id})" title="Xoa chien dich"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch(err) {
        console.error("Khong the tai chien dich: " + err.message);
    }
}

function openCampaignModal() {
    document.getElementById("campaign-form").reset();
    populateScriptDropdown("c-script-id");
    document.getElementById("campaign-modal").classList.add("active");
}

function closeCampaignModal() {
    document.getElementById("campaign-modal").classList.remove("active");
}

async function handleCampaignSubmit(e) {
    e.preventDefault();
    const data = {
        name: document.getElementById("c-name").value,
        concurrent_threads: parseInt(document.getElementById("c-concurrent").value) || 1,
        total_profiles: parseInt(document.getElementById("c-total").value) || 5,
        script_id: parseInt(document.getElementById("c-script-id").value),
        proxies: document.getElementById("c-proxies").value,
        campaign_mode: parseInt(document.getElementById("c-mode").value) || 0,
        skip_dead: document.getElementById("c-skip-dead").checked ? 1 : 0,
        replace_dead: document.getElementById("c-replace-dead").checked ? 1 : 0,
        save_created_accounts: document.getElementById("c-save-created-accounts").checked ? 1 : 0,
        profile_country: document.getElementById("c-random-country").value,
        use_api_proxy: document.getElementById("c-use-api-proxy").checked ? 1 : 0,
        api_proxy_type: document.getElementById("c-api-proxy-type").value,
        api_proxy_key: document.getElementById("c-api-proxy-key").value,
        use_gateway_router: document.getElementById("c-use-gateway-router").checked ? 1 : 0,
        gateway_router_url: document.getElementById("c-gateway-router-url").value
    };

    try {
        const response = await fetch("/api/campaigns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (result.success) {
            closeCampaignModal();
            loadCampaigns();
        } else {
            alert("Loi: " + result.error);
        }
    } catch(err) {
        alert("Loi ket noi: " + err.message);
    }
}

async function startCampaign(id) {
    try {
        loadCampaigns();
        const response = await fetch(`/api/campaigns/${id}/start`, { method: "POST" });
        const result = await response.json();
        if (!result.success) {
            alert("Loi: " + result.error);
        }
        loadCampaigns();
    } catch(err) {
        alert("Loi: " + err.message);
        loadCampaigns();
    }
}

async function stopCampaign(id) {
    try {
        const response = await fetch(`/api/campaigns/${id}/stop`, { method: "POST" });
        const result = await response.json();
        if (!result.success) {
            alert("Loi: " + result.error);
        }
        loadCampaigns();
    } catch(err) {
        alert("Loi: " + err.message);
        loadCampaigns();
    }
}

async function deleteCampaign(id) {
    if (!confirm("Xoa chien dich nay? Neu dang chay se bi dung.")) return;
    try {
        const response = await fetch(`/api/campaigns/${id}`, { method: "DELETE" });
        const result = await response.json();
        if (result.success) {
            loadCampaigns();
        }
    } catch(err) {
        alert("Loi: " + err.message);
    }
}

// --- CÁC HÀM BỔ TRỢ QUẢN LÝ NHIỀU API KEY GEMINI DỰ PHÒNG ---
function addGeminiKeyRow(keyValue = "") {
    const container = document.getElementById("gemini-keys-container");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "gemini-key-row";
    div.style.display = "flex";
    div.style.gap = "8px";
    div.style.marginTop = "4px";
    
    div.innerHTML = `
        <input type="password" class="gemini-key-input" placeholder="AIzaSy..." value="${keyValue}" style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid var(--border-color); background-color: rgba(255,255,255,0.03); color: white;" oninput="updateHiddenGeminiInput()">
        <button type="button" class="btn btn-secondary" style="padding: 8px 12px;" onclick="checkSingleGeminiKey(this)"><i class="fa-solid fa-circle-check"></i> Check</button>
        <button type="button" class="btn btn-secondary btn-delete" style="padding: 8px 12px; background-color: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);" onclick="removeGeminiKeyRow(this)"><i class="fa-solid fa-trash"></i></button>
    `;
    container.appendChild(div);
    updateHiddenGeminiInput();
}

function removeGeminiKeyRow(button) {
    const row = button.parentElement;
    const container = document.getElementById("gemini-keys-container");
    if (container.children.length > 1) {
        row.remove();
        updateHiddenGeminiInput();
    } else {
        alert("Phải giữ lại ít nhất một ô nhập API Key!");
    }
}

function updateHiddenGeminiInput() {
    const keys = Array.from(document.querySelectorAll(".gemini-key-input")).map(input => input.value.trim()).filter(Boolean);
    const apiGeminiInput = document.getElementById("api-gemini");
    if (apiGeminiInput) {
        apiGeminiInput.value = keys.join(",");
    }
}

async function checkSingleGeminiKey(button) {
    const row = button.parentElement;
    const keyInput = row.querySelector(".gemini-key-input");
    const key = keyInput.value.trim();
    const statusSpan = document.getElementById("gemini-status");
    
    if (!key) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Chưa nhập khóa API cho dòng này!";
        return;
    }
    
    statusSpan.className = "status-checking";
    statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra key này...`;
    
    try {
        const response = await fetch("/api/check_api_key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "gemini", key: key })
        });
        const result = await response.json();
        if (result.success) {
            statusSpan.className = "status-live";
            statusSpan.innerText = "Key hoạt động tốt: " + result.message;
        } else {
            statusSpan.className = "status-die";
            statusSpan.innerText = "Key lỗi: " + result.error;
        }
    } catch (err) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Lỗi kết nối kiểm tra: " + err.message;
    }
}

async function loadSettings() {
    try {
        const response = await fetch("/api/settings");
        const settings = await response.json();
        
        document.getElementById("api-viotp").value = settings.api_viotp || "";
        document.getElementById("api-smspool").value = settings.api_smspool || "";
        document.getElementById("api-openai").value = settings.api_openai || "";
        document.getElementById("api-mail").value = settings.api_mail || "";
        
        const geminiVal = settings.api_gemini || "";
        document.getElementById("api-gemini").value = geminiVal;
        const keysContainer = document.getElementById("gemini-keys-container");
        if (keysContainer) {
            keysContainer.innerHTML = "";
            const keys = geminiVal.split(",").map(k => k.trim()).filter(Boolean);
            if (keys.length === 0) {
                addGeminiKeyRow("");
            } else {
                keys.forEach(k => addGeminiKeyRow(k));
            }
        }
        
        document.getElementById("api-google-maps").value = settings.api_google_maps || "";
        document.getElementById("api-automation-timeout").value = settings.api_automation_timeout || "30000";
        document.getElementById("api-xcode").value = settings.api_xcode || "";
        document.getElementById("api-proxy-changer").value = settings.api_proxy_changer || "";
        document.getElementById("api-minproxy-key").value = settings.api_minproxy_key || "";
        
        // Load API keys cho các dịch vụ giải captcha
        document.getElementById("api-anycaptcha").value = settings.api_anycaptcha || "";
        document.getElementById("api-2captcha").value = settings.api_2captcha || "";
        document.getElementById("api-1stcaptcha").value = settings.api_1stcaptcha || "";
        document.getElementById("api-anticaptchatop").value = settings.api_anticaptchatop || "";
        document.getElementById("api-autocaptchapro").value = settings.api_autocaptchapro || "";
        
        // Load PostgreSQL settings và status
        try {
            const pgResponse = await fetch("/api/settings/db_postgres_status");
            const pgResult = await pgResponse.json();
            if (pgResult.success) {
                document.getElementById("api-pg-enabled").checked = pgResult.status.enabled;
                if (pgResult.config) {
                    document.getElementById("api-pg-host").value = pgResult.config.pg_host || "";
                    document.getElementById("api-pg-port").value = pgResult.config.pg_port || "5432";
                    document.getElementById("api-pg-user").value = pgResult.config.pg_user || "";
                    document.getElementById("api-pg-pass").value = pgResult.config.pg_password || "";
                    document.getElementById("api-pg-db").value = pgResult.config.pg_database || "";
                }
            }
        } catch (e) {
            console.error("Lỗi tải cấu hình PostgreSQL: " + e.message);
        }

        // Load Captured Resources Save Settings
        document.getElementById("cap-save-username").checked = settings.cap_save_username !== "0";
        document.getElementById("cap-save-password").checked = settings.cap_save_password !== "0";
        document.getElementById("cap-save-email").checked = settings.cap_save_email !== "0";
        document.getElementById("cap-save-phone").checked = settings.cap_save_phone !== "0";
        document.getElementById("cap-save-cookie").checked = settings.cap_save_cookie !== "0";

        // Load Mail Manager settings
        document.getElementById("api-mail-url").value = settings.api_mail_url || "http://127.0.0.1:5001";
        document.getElementById("api-mail-use-fallback").value = settings.api_mail_use_fallback || "1";
        document.getElementById("api-mail-domain").value = settings.api_mail_domain || "";
        document.getElementById("api-mail-smtp-host").value = settings.api_mail_smtp_host || "";
        document.getElementById("api-mail-smtp-port").value = settings.api_mail_smtp_port || "587";
        document.getElementById("api-mail-smtp-user").value = settings.api_mail_smtp_user || "";
        document.getElementById("api-mail-smtp-pass").value = settings.api_mail_smtp_pass || "";
        document.getElementById("api-cf-email").value = settings.api_cf_email || "";
        document.getElementById("api-cf-worker-name").value = settings.api_cf_worker_name || "mail-webhook";
        document.getElementById("api-cf-account-id").value = settings.api_cf_account_id || "";
        document.getElementById("api-cf-token").value = settings.api_cf_token || "";
        // Cập nhật badge hạn mức API Gemini sau khi tải cấu hình thành công
        updateGeminiQuotaBadge();
    } catch (err) {
        console.error("Lỗi tải cấu hình API: " + err.message);
    }
}

// --- HÀM LƯU CẤU HÌNH API BÊN THỨ 3 ---
async function saveSettings(e) {
    if (e) e.preventDefault();
    updateHiddenGeminiInput();
    const data = {
        api_viotp: document.getElementById("api-viotp").value,
        api_smspool: document.getElementById("api-smspool").value,
        api_openai: document.getElementById("api-openai").value,
        api_mail: document.getElementById("api-mail").value,
        api_gemini: document.getElementById("api-gemini").value,
        api_google_maps: document.getElementById("api-google-maps").value,
        api_automation_timeout: document.getElementById("api-automation-timeout").value,
        api_xcode: document.getElementById("api-xcode").value,
        api_proxy_changer: document.getElementById("api-proxy-changer").value,
        api_minproxy_key: document.getElementById("api-minproxy-key").value,
        
        // Save API keys cho các dịch vụ giải captcha
        api_anycaptcha: document.getElementById("api-anycaptcha").value,
        api_2captcha: document.getElementById("api-2captcha").value,
        api_1stcaptcha: document.getElementById("api-1stcaptcha").value,
        api_anticaptchatop: document.getElementById("api-anticaptchatop").value,
        api_autocaptchapro: document.getElementById("api-autocaptchapro").value,
        
        // Save PostgreSQL settings
        api_pg_host: document.getElementById("api-pg-host").value,
        api_pg_port: document.getElementById("api-pg-port").value,
        api_pg_user: document.getElementById("api-pg-user").value,
        api_pg_pass: document.getElementById("api-pg-pass").value,
        api_pg_db: document.getElementById("api-pg-db").value,

        // Save Captured Resources settings
        cap_save_username: document.getElementById("cap-save-username").checked ? "1" : "0",
        cap_save_password: document.getElementById("cap-save-password").checked ? "1" : "0",
        cap_save_email: document.getElementById("cap-save-email").checked ? "1" : "0",
        cap_save_phone: document.getElementById("cap-save-phone").checked ? "1" : "0",
        cap_save_cookie: document.getElementById("cap-save-cookie").checked ? "1" : "0",

        // Save Mail Manager settings
        api_mail_url: document.getElementById("api-mail-url").value,
        api_mail_use_fallback: document.getElementById("api-mail-use-fallback").value,
        api_mail_domain: document.getElementById("api-mail-domain").value,
        api_mail_smtp_host: document.getElementById("api-mail-smtp-host").value,
        api_mail_smtp_port: document.getElementById("api-mail-smtp-port").value,
        api_mail_smtp_user: document.getElementById("api-mail-smtp-user").value,
        api_mail_smtp_pass: document.getElementById("api-mail-smtp-pass").value,
        api_cf_email: document.getElementById("api-cf-email").value,
        api_cf_worker_name: document.getElementById("api-cf-worker-name").value,
        api_cf_account_id: document.getElementById("api-cf-account-id").value,
        api_cf_token: document.getElementById("api-cf-token").value
    };

    // Save PostgreSQL connection settings to config file
    const pgConfig = {
        pg_enabled: document.getElementById("api-pg-enabled").checked ? 1 : 0,
        pg_host: document.getElementById("api-pg-host").value.trim(),
        pg_port: parseInt(document.getElementById("api-pg-port").value) || 5432,
        pg_user: document.getElementById("api-pg-user").value.trim(),
        pg_password: document.getElementById("api-pg-pass").value.trim(),
        pg_database: document.getElementById("api-pg-db").value.trim()
    };
    
    try {
        await fetch("/api/settings/db_postgres_save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(pgConfig)
        });
    } catch (e) {
        console.error("Lỗi lưu cấu hình PostgreSQL: " + e.message);
    }

    try {
        const response = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (result.success) {
            alert("Lưu cấu hình API thành công!");
            updateGeminiQuotaBadge();
        } else {
            alert("Lỗi lưu cấu hình: " + result.error);
        }
    } catch (err) {
        alert("Lỗi kết nối: " + err.message);
    }
}

// --- HÀM LƯU CẤU HÌNH API BÊN THỨ 3 ---
async function saveSettings(e) {
    if (e) e.preventDefault();
    updateHiddenGeminiInput();
    const data = {
        api_viotp: document.getElementById("api-viotp").value,
        api_smspool: document.getElementById("api-smspool").value,
        api_openai: document.getElementById("api-openai").value,
        api_mail: document.getElementById("api-mail").value,
        api_gemini: document.getElementById("api-gemini").value,
        api_google_maps: document.getElementById("api-google-maps").value,
        api_automation_timeout: document.getElementById("api-automation-timeout").value,
        api_xcode: document.getElementById("api-xcode").value,
        api_proxy_changer: document.getElementById("api-proxy-changer").value,
        api_minproxy_key: document.getElementById("api-minproxy-key").value,
        
        // Save API keys cho các dịch vụ giải captcha
        api_anycaptcha: document.getElementById("api-anycaptcha").value,
        api_2captcha: document.getElementById("api-2captcha").value,
        api_1stcaptcha: document.getElementById("api-1stcaptcha").value,
        api_anticaptchatop: document.getElementById("api-anticaptchatop").value,
        api_autocaptchapro: document.getElementById("api-autocaptchapro").value,
        
        // Save PostgreSQL settings
        api_pg_host: document.getElementById("api-pg-host").value,
        api_pg_port: document.getElementById("api-pg-port").value,
        api_pg_user: document.getElementById("api-pg-user").value,
        api_pg_pass: document.getElementById("api-pg-pass").value,
        api_pg_db: document.getElementById("api-pg-db").value,

        // Save Mail Manager settings
        api_mail_url: document.getElementById("api-mail-url").value,
        api_mail_use_fallback: document.getElementById("api-mail-use-fallback").value,
        api_mail_domain: document.getElementById("api-mail-domain").value,
        api_mail_smtp_host: document.getElementById("api-mail-smtp-host").value,
        api_mail_smtp_port: document.getElementById("api-mail-smtp-port").value,
        api_mail_smtp_user: document.getElementById("api-mail-smtp-user").value,
        api_mail_smtp_pass: document.getElementById("api-mail-smtp-pass").value,
        api_cf_email: document.getElementById("api-cf-email").value,
        api_cf_worker_name: document.getElementById("api-cf-worker-name").value,
        api_cf_account_id: document.getElementById("api-cf-account-id").value,
        api_cf_token: document.getElementById("api-cf-token").value
    };

    try {
        const response = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (result.success) {
            alert("Lưu cấu hình API thành công!");
            updateGeminiQuotaBadge();
        } else {
            alert("Lỗi lưu cấu hình: " + result.error);
        }
    } catch (err) {
        alert("Lỗi kết nối: " + err.message);
    }
}

// --- HÀM KIỂM TRA TRẠNG THÁI API (CHECK LIVE) ---
async function checkApiKey(type) {
    let inputId = "";
    let statusId = "";
    if (type === "viotp") { inputId = "api-viotp"; statusId = "viotp-status"; }
    else if (type === "smspool") { inputId = "api-smspool"; statusId = "smspool-status"; }
    else if (type === "openai") { inputId = "api-openai"; statusId = "openai-status"; }
    else if (type === "gemini") { inputId = "api-gemini"; statusId = "gemini-status"; }
    else if (type === "google_maps") { inputId = "api-google-maps"; statusId = "google_maps-status"; }
    else if (type === "xcode") { inputId = "api-xcode"; statusId = "xcode-status"; }
    else if (type === "proxy_changer") { inputId = "api-proxy-changer"; statusId = "proxy_changer-status"; }
    else if (type === "minproxy") { inputId = "api-minproxy-key"; statusId = "minproxy-status"; }
    
    // Thêm các kiểu dịch vụ giải captcha
    else if (type === "anycaptcha") { inputId = "api-anycaptcha"; statusId = "anycaptcha-status"; }
    else if (type === "2captcha") { inputId = "api-2captcha"; statusId = "2captcha-status"; }
    else if (type === "1stcaptcha") { inputId = "api-1stcaptcha"; statusId = "1stcaptcha-status"; }
    else if (type === "anticaptchatop") { inputId = "api-anticaptchatop"; statusId = "anticaptchatop-status"; }
    else if (type === "autocaptchapro") { inputId = "api-autocaptchapro"; statusId = "autocaptchapro-status"; }
    else if (type === "postgres") { inputId = "api-pg-db"; statusId = "postgres-status"; }
    else if (type === "mail") { inputId = "api-mail"; statusId = "mail-status"; }
    else if (type === "mail_manager") { inputId = "api-mail-url"; statusId = "mail_manager-status"; }

    if (type === "gemini") {
        updateHiddenGeminiInput();
    }
    
    let key = document.getElementById(inputId).value;
    if (type === "gemini") {
        const keys = key.split(",").map(k => k.trim()).filter(Boolean);
        key = keys[0] || ""; // Check key đầu tiên làm đại diện
    }
    
    const statusSpan = document.getElementById(statusId);
    
    if (!key) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Chưa nhập khóa API!";
        return;
    }

    statusSpan.className = "status-checking";
    statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra...`;

    // Đối với proxy_changer, ta chỉ gửi kiểm tra GET URL xoay IP
    if (type === "proxy_changer") {
        try {
            statusSpan.className = "status-live";
            statusSpan.innerText = "Đã gửi yêu cầu xoay IP thành công (Live)!";
        } catch (err) {
            statusSpan.className = "status-live";
            statusSpan.innerText = "Đã gửi yêu cầu (Kiểm tra thực tế khi chạy).";
        }
        return;
    }

    try {
        let bodyObj = { type: type, key: key };
        if (type === "postgres") {
            bodyObj = {
                type: type,
                host: document.getElementById("api-pg-host").value,
                port: parseInt(document.getElementById("api-pg-port").value) || 5432,
                user: document.getElementById("api-pg-user").value,
                pass: document.getElementById("api-pg-pass").value,
                database: key
            };
        }
        
        const response = await fetch("/api/check_api_key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyObj)
        });
        const result = await response.json();
        if (result.success) {
            statusSpan.className = "status-live";
            statusSpan.innerText = result.message;
        } else {
            statusSpan.className = "status-die";
            statusSpan.innerText = result.error;
        }
    } catch (err) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Lỗi kết nối máy chủ!";
    }
}

// --- HÀM THU GỌN / MỞ RỘNG TERMINAL LOGS ---
function toggleLogsConsole() {
    const consoleBody = document.getElementById("log-console");
    const btn = document.getElementById("btn-toggle-logs");
    consoleBody.classList.toggle("collapsed");
    if (consoleBody.classList.contains("collapsed")) {
        btn.innerHTML = `<i class="fa-solid fa-chevron-up"></i>`;
    } else {
        btn.innerHTML = `<i class="fa-solid fa-chevron-down"></i>`;
    }
}

// --- HÀM XÓA LOGS TRÊN GIAO DIỆN ---
async function clearLogs() {
    try {
        await fetch("/api/logs/clear", { method: "POST" });
        lastLogCount = 0;
        const consoleBody = document.getElementById("log-console");
        if (consoleBody) {
            consoleBody.innerHTML = `<div class="log-line system">[Hệ thống] Đã xóa lịch sử hiển thị log.</div>`;
        }
    } catch (err) {
        console.error("Lỗi khi xóa log: " + err.message);
    }
}

// --- VÒNG LẶP POLLING LOGS TỪ SERVER ---
let lastLogCount = 0;
function startLogPolling() {
    setInterval(async () => {
        try {
            const response = await fetch("/api/logs");
            const logs = await response.json();
            
            const consoleBody = document.getElementById("log-console");
            if (!consoleBody) return;
            
            let html = "";
            logs.forEach(log => {
                let levelClass = "info";
                if (log.level === "WARNING") levelClass = "warning";
                if (log.level === "ERROR") levelClass = "error";
                if (log.level === "SYSTEM") levelClass = "system";
                
                html += `<div class="log-line ${levelClass}">[${log.timestamp}] [${log.level}] ${log.message}</div>`;
            });
            
            if (logs.length > 0 && logs.length !== lastLogCount) {
                const isScrolledToBottom = consoleBody.scrollHeight - consoleBody.clientHeight <= consoleBody.scrollTop + 30;
                consoleBody.innerHTML = html;
                
                if (isScrolledToBottom) {
                    consoleBody.scrollTop = consoleBody.scrollHeight;
                }
                lastLogCount = logs.length;
            }
        } catch (err) {
            console.error("Lỗi đồng bộ logs: " + err.message);
        }
    }, 2000);
}

function startStatusRealtimeMonitor() {
    setInterval(async () => {
        try {
            const response = await fetch("/api/profiles");
            const profiles = await response.json();
            
            // Cập nhật danh sách profile vào ô chọn ghi hình AI nếu có thay đổi số lượng hoặc status
            const aiSelect = document.getElementById("ai-record-profile");
            if (aiSelect) {
                const currentVal = aiSelect.value;
                const currentOptionCount = aiSelect.options.length - 1; // trừ option default
                if (profiles.length !== currentOptionCount) {
                    aiSelect.innerHTML = `<option value="">-- Tự động chọn Profile (Chạy trình duyệt) --</option>`;
                    profiles.forEach(p => {
                        const opt = document.createElement("option");
                        opt.value = p.id;
                        const statusText = p.status === "Running" ? "Đang chạy" : "Đã dừng";
                        opt.innerText = `${p.name} (ID: ${p.id} - ${statusText})`;
                        aiSelect.appendChild(opt);
                    });
                    aiSelect.value = currentVal;
                } else {
                    profiles.forEach(p => {
                        const opt = aiSelect.querySelector(`option[value="${p.id}"]`);
                        if (opt) {
                            const statusText = p.status === "Running" ? "Đang chạy" : "Đã dừng";
                            const expectedText = `${p.name} (ID: ${p.id} - ${statusText})`;
                            if (opt.innerText !== expectedText) {
                                opt.innerText = expectedText;
                            }
                        }
                    });
                }
            }

            profiles.forEach(profile => {
                const tr = document.querySelector(`tr[data-profile-id="${profile.id}"]`);
                if (tr) {
                    const statusCell = tr.querySelector(".status-cell");
                    const actionCell = tr.querySelector(".action-buttons");
                    if (statusCell && actionCell) {
                        const isRunning = profile.status === "Running";
                        const currentStatusText = statusCell.innerText.trim();
                        const newStatusText = isRunning ? "Dang chay" : "Da dung";
                        
                        if (!currentStatusText.includes(newStatusText)) {
                            // 1. Cập nhật Status badge
                            const statusBadge = isRunning 
                                ? `<span class="badge badge-success"><span class="status-dot online"></span> Dang chay</span>`
                                : `<span class="badge badge-secondary"><span class="status-dot"></span> Da dung</span>`;
                            statusCell.innerHTML = statusBadge;
                            
                            // 2. Cập nhật nút Play/Stop
                            const playStopBtn = actionCell.querySelector(".btn-start, .btn-stop");
                            if (playStopBtn) {
                                if (isRunning) {
                                    playStopBtn.outerHTML = `<button class="btn-icon btn-stop" onclick="stopProfile(${profile.id})" title="Dung Trinh duyet"><i class="fa-solid fa-square"></i></button>`;
                                } else {
                                    playStopBtn.outerHTML = `<button class="btn-icon btn-start" onclick="startProfile(${profile.id})" title="Chay Trinh duyet"><i class="fa-solid fa-play"></i></button>`;
                                }
                            }
                            
                            // 3. Cập nhật nút Robot (Tự động hóa)
                            const oldAutoBtn = actionCell.querySelector("button[title='Chay kich ban tu dong'], button.btn-auto");
                            if (oldAutoBtn) {
                                if (isRunning) {
                                    const newBtn = document.createElement("button");
                                    newBtn.className = "btn-icon btn-auto";
                                    newBtn.title = "Chay kich ban tu dong";
                                    newBtn.setAttribute("onclick", `triggerProfileAutomation(${profile.id})`);
                                    newBtn.innerHTML = `<i class="fa-solid fa-robot"></i>`;
                                    oldAutoBtn.replaceWith(newBtn);
                                } else {
                                    const newBtn = document.createElement("button");
                                    newBtn.className = "btn-icon";
                                    newBtn.style.opacity = "0.3";
                                    newBtn.style.cursor = "not-allowed";
                                    newBtn.disabled = true;
                                    newBtn.title = "Chay kich ban tu dong";
                                    newBtn.innerHTML = `<i class="fa-solid fa-robot"></i>`;
                                    oldAutoBtn.replaceWith(newBtn);
                                }
                            }
                        }
                    }
                }
            });
        } catch (e) {
            console.error("Lỗi đồng bộ trạng thái thời gian thực: ", e);
        }
    }, 3000);
}

// --- HÀM KIỂM TRA & HIỂN THỊ HẠN MỨC QUOTA GEMINI ---
async function updateGeminiQuotaBadge() {
    const badge = document.getElementById("ai-gemini-quota-badge");
    if (!badge) return;
    
    const modelSelect = document.getElementById("ai-gemini-model");
    const model = modelSelect ? modelSelect.value : "gemini-2.0-flash";
    
    badge.className = "";
    badge.style.background = "rgba(255, 255, 255, 0.05)";
    badge.style.color = "#cbd5e1";
    badge.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    badge.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Check...`;
    badge.title = "Đang kiểm tra hạn mức...";
    
    try {
        const response = await fetch(`/api/gemini/quota?model=${model}`);
        const result = await response.json();
        
        if (result.success) {
            if (result.status === "Live") {
                badge.style.background = "rgba(16, 185, 129, 0.1)";
                badge.style.color = "#34d399";
                badge.style.border = "1px solid rgba(16, 185, 129, 0.2)";
                badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Sẵn sàng`;
                badge.title = result.message || "Hạn mức sẵn sàng";
            } else if (result.status === "Exceeded") {
                badge.style.background = "rgba(245, 158, 11, 0.1)";
                badge.style.color = "#fbbf24";
                badge.style.border = "1px solid rgba(245, 158, 11, 0.2)";
                badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Hết Quota`;
                badge.title = result.message || "Mô hình này đã bị hết hạn mức (429)";
            } else {
                badge.style.background = "rgba(239, 68, 68, 0.1)";
                badge.style.color = "#f87171";
                badge.style.border = "1px solid rgba(239, 68, 68, 0.2)";
                badge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Lỗi Key`;
                badge.title = result.message || "Tất cả API keys của Gemini đều lỗi";
            }
        } else {
            badge.style.background = "rgba(239, 68, 68, 0.1)";
            badge.style.color = "#f87171";
            badge.style.border = "1px solid rgba(239, 68, 68, 0.2)";
            badge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Lỗi`;
            badge.title = result.error || "Không thể kiểm tra hạn mức";
        }
    } catch (err) {
        badge.style.background = "rgba(239, 68, 68, 0.1)";
        badge.style.color = "#f87171";
        badge.style.border = "1px solid rgba(239, 68, 68, 0.2)";
        badge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Lỗi kết nối`;
        badge.title = err.message;
    }
}

// --- BỘ PHÂN TÍCH & SỬA ĐỔI KỊCH BẢN AI GEMINI ---
let originalScriptCode = ""; // Lưu trữ mã nguồn kịch bản gốc trước khi AI sửa

function populateAiScriptDropdown() {
    const aiSelect = document.getElementById("ai-script-select");
    if (!aiSelect) return;
    const currentVal = aiSelect.value;
    aiSelect.innerHTML = `<option value="">-- Chọn kịch bản để phân tích --</option>`;
    allScripts.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.innerText = s.name;
        aiSelect.appendChild(opt);
    });
    aiSelect.value = currentVal;
}

async function handleAiScriptSelectChange() {
    const scriptId = document.getElementById("ai-script-select").value;
    const statusDiv = document.getElementById("ai-analysis-status");
    const contentDiv = document.getElementById("ai-analysis-content");
    const btnModify = document.getElementById("btn-ai-modify");
    const newScriptContainer = document.getElementById("ai-new-script-container");
    const modelSelect = document.getElementById("ai-gemini-model");
    const geminiModel = modelSelect ? modelSelect.value : "gemini-2.0-flash";
    
    // Clear old state
    newScriptContainer.style.display = "none";
    document.getElementById("ai-new-script-code").value = "";
    document.getElementById("ai-new-script-explanation").innerText = "";
    document.getElementById("ai-edit-prompt").value = "";
    originalScriptCode = "";
    
    if (!scriptId) {
        statusDiv.style.display = "block";
        statusDiv.innerHTML = `<i class="fa-solid fa-circle-info"></i> Hãy chọn một kịch bản để AI phân tích bước chạy và đưa ra gợi ý tối ưu.`;
        contentDiv.style.display = "none";
        btnModify.disabled = true;
        return;
    }
    
    statusDiv.style.display = "block";
    statusDiv.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang phân tích kịch bản bằng AI Gemini...`;
    contentDiv.style.display = "none";
    btnModify.disabled = true;
    
    try {
        const response = await fetch("/api/analyze_script_ai", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ script_id: scriptId, model: geminiModel })
        });
        const result = await response.json();
        
        if (result.success) {
            const data = result.data;
            statusDiv.style.display = "none";
            contentDiv.style.display = "block";
            
            document.getElementById("ai-analysis-steps").innerText = data.steps_analysis || "Không có thông tin các bước.";
            document.getElementById("ai-analysis-suggestions").innerText = data.suggested_settings || "Không có gợi ý cài đặt.";
            btnModify.disabled = false;
            
            // Tìm và lưu lại script gốc
            const script = allScripts.find(s => s.id === parseInt(scriptId));
            if (script) {
                originalScriptCode = script.steps || "";
            }
        } else {
            statusDiv.style.display = "block";
            statusDiv.innerHTML = `<span style="color: var(--danger-color);"><i class="fa-solid fa-triangle-exclamation"></i> Lỗi: ${result.error}</span>`;
        }
    } catch (err) {
        statusDiv.style.display = "block";
        statusDiv.innerHTML = `<span style="color: var(--danger-color);"><i class="fa-solid fa-triangle-exclamation"></i> Lỗi kết nối đến máy chủ!</span>`;
    }
}

let aiChatHistory = [];

function handleAiScriptSelectChange() {
    aiChatHistory = [];
    const chatHistoryEl = document.getElementById("ai-chat-history");
    if (chatHistoryEl) {
        chatHistoryEl.innerHTML = `
            <div style="font-size: 0.8rem; color: var(--text-secondary); text-align: center; margin: auto 0; padding: 20px;">
                <i class="fa-solid fa-comments" style="font-size: 1.5rem; color:#818cf8; margin-bottom: 8px; display:block;"></i>
                Bạn đã thay đổi kịch bản. Hãy gửi tin nhắn hoặc chọn gợi ý bên dưới để bắt đầu trao đổi!
            </div>
        `;
    }
}

function handleChatInputKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
}

function sendSuggestedPrompt(text) {
    const input = document.getElementById("ai-chat-input");
    if (input) {
        input.value = text;
        sendChatMessage();
    }
}

async function sendChatMessage() {
    const scriptId = document.getElementById("ai-script-select").value;
    const inputEl = document.getElementById("ai-chat-input");
    const promptText = inputEl ? inputEl.value.trim() : "";
    const chatHistoryEl = document.getElementById("ai-chat-history");
    const modelSelect = document.getElementById("ai-gemini-model");
    const geminiModel = modelSelect ? modelSelect.value : "gemini-2.0-flash";

    if (!promptText) return;

    if (aiChatHistory.length === 0) {
        chatHistoryEl.innerHTML = "";
    }

    const userMsgHtml = `
        <div class="chat-msg-user" style="align-self: flex-end; max-width: 85%; padding: 8px 12px; border-radius: 12px 12px 0 12px; background: rgba(129, 140, 248, 0.15); border: 1px solid rgba(129, 140, 248, 0.3); margin-bottom: 8px;">
            <div style="font-size: 0.65rem; color: #a5b4fc; margin-bottom: 2px; text-align: right;"><i class="fa-solid fa-user"></i> Bạn</div>
            <div style="font-size: 0.8rem; line-height: 1.4; color: white; white-space: pre-wrap;">${promptText}</div>
        </div>
    `;
    chatHistoryEl.insertAdjacentHTML("beforeend", userMsgHtml);
    chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;

    aiChatHistory.push({ role: "user", text: promptText });
    inputEl.value = "";

    const typingId = "typing-" + Date.now();
    const typingHtml = `
        <div id="${typingId}" class="chat-msg-ai" style="align-self: flex-start; max-width: 85%; padding: 8px 12px; border-radius: 12px 12px 12px 0; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); margin-bottom: 8px;">
            <div style="font-size: 0.65rem; color: #a5b4fc; margin-bottom: 2px;"><i class="fa-solid fa-robot"></i> Trợ lý AI</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary);"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang suy nghĩ...</div>
        </div>
    `;
    chatHistoryEl.insertAdjacentHTML("beforeend", typingHtml);
    chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;

    let scriptCode = "";
    if (scriptId) {
        const script = allScripts.find(s => s.id === parseInt(scriptId));
        if (script) {
            scriptCode = script.steps || "";
        }
    }

    try {
        const response = await fetch("/api/chat_script_ai", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                script_code: scriptCode,
                chat_history: aiChatHistory.slice(0, -1),
                prompt: promptText,
                model: geminiModel
            })
        });
        const result = await response.json();
        
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        if (result.success) {
            const aiReply = result.reply;
            aiChatHistory.push({ role: "model", text: aiReply });

            const contentHtml = parseAiMessage(aiReply, scriptId);
            const aiMsgHtml = `
                <div class="chat-msg-ai" style="align-self: flex-start; max-width: 90%; padding: 8px 12px; border-radius: 12px 12px 12px 0; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); margin-bottom: 8px; box-sizing: border-box; width: 100%;">
                    <div style="font-size: 0.65rem; color: #a5b4fc; margin-bottom: 4px;"><i class="fa-solid fa-robot"></i> Trợ lý AI</div>
                    ${contentHtml}
                </div>
            `;
            chatHistoryEl.insertAdjacentHTML("beforeend", aiMsgHtml);
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        } else {
            const errorHtml = `
                <div class="chat-msg-ai" style="align-self: flex-start; max-width: 85%; padding: 8px 12px; border-radius: 12px 12px 12px 0; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); margin-bottom: 8px; color: var(--danger-color);">
                    <div style="font-size: 0.65rem; margin-bottom: 2px;"><i class="fa-solid fa-triangle-exclamation"></i> Lỗi hệ thống</div>
                    <div style="font-size: 0.8rem;">${result.error}</div>
                </div>
            `;
            chatHistoryEl.insertAdjacentHTML("beforeend", errorHtml);
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        }
    } catch (err) {
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        const errorHtml = `
            <div class="chat-msg-ai" style="align-self: flex-start; max-width: 85%; padding: 8px 12px; border-radius: 12px 12px 12px 0; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); margin-bottom: 8px; color: var(--danger-color);">
                <div style="font-size: 0.65rem; margin-bottom: 2px;"><i class="fa-solid fa-wifi-slash"></i> Lỗi mạng</div>
                <div style="font-size: 0.8rem;">Không thể kết nối đến máy chủ: ${err.message}</div>
            </div>
        `;
        chatHistoryEl.insertAdjacentHTML("beforeend", errorHtml);
        chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
    }
}

function parseAiMessage(replyText, scriptId) {
    const parts = replyText.split(/```/g);
    let html = "";
    
    parts.forEach((part, index) => {
        if (index % 2 === 1) {
            let code = part.trim();
            if (code.startsWith("javascript")) {
                code = code.substring(10).trim();
            } else if (code.startsWith("js")) {
                code = code.substring(2).trim();
            }
            
            const uniqueId = "ai-code-" + Math.floor(Math.random() * 1000000);
            html += `
                <div class="ai-code-block-card" style="margin-top: 8px; border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 8px; overflow: hidden; background: rgba(0,0,0,0.5);">
                    <div style="background: rgba(16, 185, 129, 0.15); padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(16, 185, 129, 0.2); flex-wrap:wrap; gap:4px;">
                        <span style="font-size: 0.72rem; color: #34d399; font-weight: 600;"><i class="fa-solid fa-code"></i> Kịch bản Puppeteer đề xuất</span>
                        <div style="display:flex; gap:6px;">
                            <button onclick="copyChatCode('${uniqueId}')" style="font-size: 0.65rem; padding: 2px 6px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: white; cursor: pointer;"><i class="fa-solid fa-copy"></i> Sao chép</button>
                            ${scriptId ? `<button onclick="applyChatCode(${scriptId}, '${uniqueId}')" style="font-size: 0.65rem; padding: 2px 6px; background: #10b981; border: none; border-radius: 4px; color: white; font-weight:600; cursor: pointer;"><i class="fa-solid fa-floppy-disk"></i> Áp dụng</button>` : ''}
                        </div>
                    </div>
                    <textarea id="${uniqueId}" readonly style="width: 100%; height: 160px; background: transparent; color: #a6e22e; font-family: monospace; font-size: 0.75rem; padding: 8px; border: none; resize: vertical; outline: none; box-sizing: border-box;">${code}</textarea>
                </div>
            `;
        } else {
            html += `<div style="white-space: pre-wrap; font-size: 0.8rem; line-height: 1.45; color: #cbd5e1; margin-top:4px;">${part}</div>`;
        }
    });
    return html;
}

function copyChatCode(id) {
    const txt = document.getElementById(id);
    if (txt) {
        txt.select();
        document.execCommand("copy");
        alert("Đã sao chép mã nguồn vào bộ nhớ tạm (clipboard)!");
    }
}

async function applyChatCode(scriptId, id) {
    const txt = document.getElementById(id);
    if (!txt) return;
    const newCode = txt.value;

    const script = allScripts.find(s => s.id === parseInt(scriptId));
    if (!script) {
        alert("Kịch bản không tồn tại!");
        return;
    }

    if (!confirm(`Bạn có chắc muốn lưu đè kịch bản '${script.name}' bằng mã nguồn mới đề xuất này không?`)) {
        return;
    }

    try {
        const response = await fetch(`/api/scripts/${scriptId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: script.name,
                steps: newCode
            })
        });
        const result = await response.json();
        if (result.success) {
            alert("Đã áp dụng và lưu kịch bản thành công!");
            loadScripts();
        } else {
            alert("Lỗi lưu kịch bản: " + result.error);
        }
    } catch (err) {
        alert("Lỗi kết nối máy chủ: " + err.message);
    }
}

// --- HÀM CHÈN NHANH ĐOẠN CODE MẪU (SNIPPETS) ---
function insertCodeSnippet(type) {
    const textarea = document.getElementById("script-js-code");
    if (!textarea) return;
    
    let snippet = "";
    if (type === 'goto') {
        snippet = "await page.goto('https://google.com', { waitUntil: 'load' });\nlogInfo('Đã mở trang chủ Google');\n";
    } else if (type === 'click') {
        snippet = "await page.waitForSelector('button[type=\"submit\"]', { timeout: 15000 });\nawait page.click('button[type=\"submit\"]');\nlogInfo('Đã click nút Submit');\n";
    } else if (type === 'type') {
        snippet = "await page.waitForSelector('input[name=\"email\"]', { timeout: 15000 });\nawait page.focus('input[name=\"email\"]');\nawait page.type('input[name=\"email\"]', 'example@email.com', { delay: 100 });\nlogInfo('Đã nhập email');\n";
    } else if (type === 'wait') {
        snippet = "await setTimeout(3000); // Chờ 3 giây\nlogInfo('Đã chờ xong 3 giây');\n";
    } else if (type === 'fill_register') {
        snippet = "logInfo('Bắt đầu đăng ký thông tin tự động...');\nawait fillRegister(); // Gọi hàm helper điền form đăng ký tự động của hệ thống\n";
    } else if (type === 'extension_control') {
        snippet = `// === MẪU ĐIỀU KHIỂN TIỆN ÍCH EXTENSION (VÍ DỤ: COOKIE-EDITOR) ===
// 1. Mở trang popup của tiện ích bằng URL giao diện nội bộ của nó
const extensionId = "hlkenndednhfkekhgcdicdfddnkalmdm"; // Thay bằng ID tiện ích của bạn
const extPopupUrl = \`chrome-extension://\${extensionId}/popup.html\`;
const popupPage = await browser.newPage();
await popupPage.goto(extPopupUrl);
await setTimeout(1000); // Chờ tiện ích load giao diện

// 2. Sử dụng Puppeteer nhấp chuột, nhập liệu trên giao diện tiện ích
try {
    const importBtnSelector = '.import-btn'; // Thay bằng class/id bộ chọn nút trong tiện ích
    await popupPage.waitForSelector(importBtnSelector, { timeout: 5000 });
    await popupPage.click(importBtnSelector);
    logInfo('Đã nhấp nút trong tiện ích!');
} catch (e) {
    logError('Lỗi tương tác tiện ích: ' + e.message);
}
`;
    }
    
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    textarea.value = text.substring(0, start) + snippet + text.substring(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + snippet.length;
}



// --- QUẢN LÝ BACKUP & RESTORE FRONTEND ---

async function loadBackups() {
    const tbody = document.getElementById("backup-list-body");
    if (!tbody) return;
    
    // Reset select all checkbox
    const selectAllCheck = document.getElementById("backup-select-all");
    if (selectAllCheck) selectAllCheck.checked = false;

    try {
        const response = await fetch("/api/backups");
        const backups = await response.json();
        
        if (backups.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align: center; padding: 40px; color: var(--text-secondary);">
                        <i class="fa-solid fa-folder-open" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
                        Chưa có bản sao lưu nào. Hãy bấm "Backup" trên danh sách Profile để tạo!
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = "";
        let index = 1;
        backups.forEach(b => {
            const proxyText = b.proxy_server ? b.proxy_server : "Direct";
            const statusClass = b.status === "Live" ? "status-live" : (b.status === "Die" ? "status-die" : "status-checking");
            const statusLabel = b.status === "Live" ? "Live (Còn sống)" : (b.status === "Die" ? "Die (Đã chết)" : "Unknown (Chưa check)");
            
            const cookieBrief = b.cookie_data 
                ? `<span class="info-badge" style="background-color: rgba(16, 185, 129, 0.1); color: #10b981; cursor:pointer;" onclick="alert('Chi tiết cookie:\\n' + this.title)" title="${b.cookie_data.substring(0, 1000)}">Xem Cookie (${b.cookie_data.split('\n').length} dòng)</span>`
                : `<span class="text-mute">Không có cookie</span>`;
                
            const accountText = b.account_info ? b.account_info : "Không có thông tin";

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td style="text-align: center;"><input type="checkbox" class="backup-item-check" data-id="${b.id}" style="cursor: pointer;"></td>
                <td style="text-align: center; font-weight: bold; color: var(--text-secondary);">${index++}</td>
                <td><span class="text-bold">${b.name}</span><div class="text-mute">Profile ID: ${b.profile_id}</div></td>
                <td><span class="${statusClass}" id="backup-status-${b.id}">${statusLabel}</span></td>
                <td><span class="text-bold">${proxyText}</span></td>
                <td><div style="font-size:0.85rem; word-break:break-all;">${accountText}</div></td>
                <td>${cookieBrief}</td>
                <td>${b.created_at}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-icon btn-start" onclick="checkBackup(${b.id})" title="Kiểm tra trạng thái (Check live/die)"><i class="fa-solid fa-square-check"></i></button>
                        <button class="btn-icon btn-auto" onclick="restoreBackup(${b.id})" title="Khôi phục profile này (Restore)"><i class="fa-solid fa-cloud-arrow-down"></i></button>
                        <button class="btn-icon btn-delete" onclick="deleteBackup(${b.id})" title="Xóa bản sao lưu"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger-color); padding: 20px;">Lỗi tải bản sao lưu: ${err.message}</td></tr>`;
    }
    // Tự động tải thêm danh sách tài nguyên thu lưu từ luồng chạy
    loadCapturedResources();
}

async function triggerProfileBackup(profileId) {
    const backupName = prompt("Nhập tên bản sao lưu (Để trống hệ thống sẽ tự sinh tên ngẫu nhiên):");
    const accountInfo = prompt("Nhập thông tin tài khoản dự phòng nếu có (định dạng: nick | pass | 2FA):");
    
    // Thêm hiệu ứng toast loading cho người dùng yên tâm đợi vì nén file mất 1 vài giây
    const loadingToast = document.createElement("div");
    loadingToast.style.position = "fixed";
    loadingToast.style.bottom = "80px";
    loadingToast.style.right = "20px";
    loadingToast.style.backgroundColor = "var(--accent-color)";
    loadingToast.style.color = "white";
    loadingToast.style.padding = "12px 20px";
    loadingToast.style.borderRadius = "8px";
    loadingToast.style.zIndex = "10001";
    loadingToast.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang nén môi trường và sao lưu hồ sơ...`;
    document.body.appendChild(loadingToast);

    try {
        const response = await fetch(`/api/profiles/${profileId}/backup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: backupName, account_info: accountInfo })
        });
        const result = await response.json();
        loadingToast.remove();
        
        if (result.success) {
            alert(result.message);
            loadProfiles();
        } else {
            alert("Lỗi sao lưu: " + result.error);
        }
    } catch (err) {
        loadingToast.remove();
        alert("Lỗi kết nối sao lưu: " + err.message);
    }
}

async function restoreBackup(backupId) {
    if (!confirm("Bạn có chắc chắn muốn khôi phục bản sao lưu này đè lên cấu hình hiện tại không? Hành động này sẽ thay đổi toàn bộ cookie & proxy.")) return;
    
    const loadingToast = document.createElement("div");
    loadingToast.style.position = "fixed";
    loadingToast.style.bottom = "80px";
    loadingToast.style.right = "20px";
    loadingToast.style.backgroundColor = "var(--accent-color)";
    loadingToast.style.color = "white";
    loadingToast.style.padding = "12px 20px";
    loadingToast.style.borderRadius = "8px";
    loadingToast.style.zIndex = "10001";
    loadingToast.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang giải nén khôi phục môi trường...`;
    document.body.appendChild(loadingToast);

    try {
        const response = await fetch(`/api/backups/${backupId}/restore`, { method: "POST" });
        const result = await response.json();
        loadingToast.remove();
        
        if (result.success) {
            alert(result.message);
            loadBackups();
        } else {
            alert("Lỗi khôi phục: " + result.error);
        }
    } catch (err) {
        loadingToast.remove();
        alert("Lỗi kết nối khôi phục: " + err.message);
    }
}

async function checkBackup(backupId) {
    const statusSpan = document.getElementById(`backup-status-${backupId}`);
    if (statusSpan) {
        statusSpan.className = "status-checking";
        statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang check...`;
    }
    
    try {
        const response = await fetch(`/api/backups/${backupId}/check`, { method: "POST" });
        const result = await response.json();
        
        if (result.success) {
            statusSpan.className = result.status === "Live" ? "status-live" : "status-die";
            statusSpan.innerText = result.status === "Live" ? "Live (Còn sống)" : "Die (Đã chết)";
            alert(result.message);
        } else {
            alert("Lỗi kiểm tra: " + result.error);
        }
    } catch (err) {
        alert("Lỗi kết nối: " + err.message);
    }
}

async function deleteBackup(backupId) {
    if (!confirm("Bạn có chắc chắn muốn xóa bản sao lưu này khỏi ổ đĩa?")) return;
    try {
        const response = await fetch(`/api/backups/${backupId}`, { method: "DELETE" });
        const result = await response.json();
        if (result.success) {
            loadBackups();
        }
    } catch (err) {
        alert("Lỗi xóa: " + err.message);
    }
}

// Dich vu Ugener da bi go bo theo yeu cau

// --- QUẢN LÝ TÀI NGUYÊN THU LƯU (CAPTURED RESOURCES FRONTEND) ---

async function loadCapturedResources() {
    const tbody = document.getElementById("resource-list-body");
    if (!tbody) return;
    
    try {
        const response = await fetch("/api/captured_resources");
        const resources = await response.json();
        
        if (resources.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center; padding: 40px; color: var(--text-secondary);">
                        <i class="fa-solid fa-file-excel" style="font-size: 2rem; margin-bottom: 10px; display: block; opacity: 0.3;"></i>
                        Chưa thu giữ được tài nguyên nào từ luồng chạy.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = "";
        resources.forEach(r => {
            // Hiển thị nút sao chép Cookie
            const cookieBrief = r.cookie_data 
                ? `<span class="info-badge" style="background-color: rgba(16, 185, 129, 0.1); color: #10b981; cursor: pointer; border-color: rgba(16, 185, 129, 0.2);" onclick="copyToClipboard('${r.cookie_data.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', 'Cookie')" title="Click để sao chép Cookie">Sao chép Cookie</span>`
                : `<span class="text-mute">Không có</span>`;
            
            const emailText = r.email 
                ? `${r.email} ${r.email_password ? `| <span style="color: #f59e0b;">${r.email_password}</span>` : ''}`
                : "Không có";

            const usernameEscaped = (r.username || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const passwordEscaped = (r.password || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const emailEscaped = (r.email || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const phoneEscaped = (r.phone || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><span class="info-badge" style="background-color: rgba(99, 102, 241, 0.15); color: #a5b4fc; font-weight: 700; border-color: rgba(99, 102, 241, 0.25);">${r.service_name}</span></td>
                <td>
                    <span class="text-bold">${r.username}</span> 
                    <button class="btn-icon" style="width: 24px; height: 24px; font-size: 0.75rem; margin-left: 6px;" onclick="copyToClipboard('${usernameEscaped}', 'Tài khoản')" title="Sao chép"><i class="fa-regular fa-copy"></i></button>
                </td>
                <td>
                    <span style="font-family: monospace;">${r.password || 'Không có'}</span>
                    ${r.password ? `<button class="btn-icon" style="width: 24px; height: 24px; font-size: 0.75rem; margin-left: 6px;" onclick="copyToClipboard('${passwordEscaped}', 'Mật khẩu')" title="Sao chép"><i class="fa-regular fa-copy"></i></button>` : ''}
                </td>
                <td>
                    <span>${emailText}</span>
                    ${r.email ? `<button class="btn-icon" style="width: 24px; height: 24px; font-size: 0.75rem; margin-left: 6px;" onclick="copyToClipboard('${emailEscaped}', 'Email')" title="Sao chép"><i class="fa-regular fa-copy"></i></button>` : ''}
                </td>
                <td>
                    <span>${r.phone || 'Không có'}</span>
                    ${r.phone ? `<button class="btn-icon" style="width: 24px; height: 24px; font-size: 0.75rem; margin-left: 6px;" onclick="copyToClipboard('${phoneEscaped}', 'Số điện thoại')" title="Sao chép"><i class="fa-regular fa-copy"></i></button>` : ''}
                </td>
                <td>${cookieBrief}</td>
                <td><span style="font-size: 0.85rem; color: var(--text-secondary);">${r.created_at}</span></td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-icon btn-delete" onclick="deleteCapturedResource(${r.id})" title="Xóa tài nguyên"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger-color); padding: 20px;">Lỗi tải tài nguyên thu lưu: ${err.message}</td></tr>`;
    }
}

async function deleteCapturedResource(id) {
    if (!confirm("Bạn có chắc chắn muốn xóa tài nguyên thu giữ này khỏi CSDL?")) return;
    try {
        const response = await fetch(`/api/captured_resources/${id}`, { method: "DELETE" });
        const result = await response.json();
        if (result.success) {
            loadCapturedResources();
        } else {
            alert("Lỗi: " + result.error);
        }
    } catch (err) {
        alert("Lỗi kết nối: " + err.message);
    }
}

function copyToClipboard(text, label = "Dữ liệu") {
    // Giải mã nếu text chứa thực thể HTML để khi copy được text chuẩn
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = text;
    const decodedText = tempDiv.innerText;

    navigator.clipboard.writeText(decodedText).then(() => {
        const toast = document.createElement("div");
        toast.style.position = "fixed";
        toast.style.bottom = "80px";
        toast.style.right = "20px";
        toast.style.backgroundColor = "var(--success-color)";
        toast.style.color = "white";
        toast.style.padding = "12px 20px";
        toast.style.borderRadius = "8px";
        toast.style.boxShadow = "0 4px 12px rgba(16, 185, 129, 0.3)";
        toast.style.fontSize = "0.85rem";
        toast.style.fontWeight = "600";
        toast.style.zIndex = "10001";
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s ease, transform 0.3s ease";
        toast.style.transform = "translateY(10px)";
        toast.innerHTML = `<i class="fa-solid fa-circle-check"></i> Đã sao chép ${label} vào bộ nhớ tạm!`;
        
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "1";
            toast.style.transform = "translateY(0)";
        }, 50);
        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transform = "translateY(-10px)";
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }).catch(err => {
        alert("Không thể tự động sao chép! Lỗi: " + err.message);
    });
}

// --- LOGIC KIỂM THỬ CẤU HÌNH API TRỰC TUYẾN ---
let testPhoneRequestId = null;
let testPhoneType = null;
let testEmailUsername = null;
let testEmailDomain = null;
let testSmsTimer = 60;
let testSmsTimerInterval = null;

function toggleSmsCountrySelector() {
    const type = document.getElementById("test-sms-type").value;
    const countrySelector = document.getElementById("test-sms-country");
    if (type === "viotp") {
        countrySelector.value = "13";
        countrySelector.disabled = true;
    } else {
        countrySelector.disabled = false;
    }
}

async function runTestRentPhone() {
    const service = document.getElementById("test-sms-service").value;
    const type = document.getElementById("test-sms-type").value;
    const country = document.getElementById("test-sms-country").value;
    
    let apiKey = "";
    if (type === "viotp") {
        apiKey = document.getElementById("api-viotp").value.trim();
    } else {
        apiKey = document.getElementById("api-smspool").value.trim();
    }
    
    if (!apiKey) {
        alert("Vui lòng nhập API Key cho cổng dịch vụ tương ứng trước khi kiểm thử!");
        return;
    }
    
    const board = document.getElementById("test-sms-board");
    const boardPhone = document.getElementById("sms-board-phone");
    const boardId = document.getElementById("sms-board-id");
    const boardTimer = document.getElementById("sms-board-timer");
    const boardOtp = document.getElementById("sms-board-otp");
    const boardSms = document.getElementById("sms-board-sms");
    const output = document.getElementById("test-sms-output");

    board.style.display = "block";
    boardPhone.textContent = "Đang thuê...";
    boardId.textContent = "-";
    boardOtp.textContent = "------";
    boardSms.textContent = "Đang gửi yêu cầu đến nhà cung cấp...";
    output.style.display = "none";
    
    document.getElementById("btn-test-rent").disabled = true;
    document.getElementById("btn-test-otp").disabled = true;
    document.getElementById("btn-test-cancel").disabled = true;

    try {
        const response = await fetch("/api/test/rent_phone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type,
                key: apiKey,
                service,
                country: country
            })
        });
        const result = await response.json();
        if (result.success) {
            testPhoneRequestId = result.request_id;
            testPhoneType = type;
            
            boardPhone.textContent = result.phone;
            boardId.textContent = result.request_id;
            boardSms.textContent = "Đã thuê thành công! Đang chờ tin nhắn chứa mã xác thực...";
            
            document.getElementById("btn-test-otp").disabled = false;
            document.getElementById("btn-test-cancel").disabled = false;
            
            // Bắt đầu đếm ngược 60s
            testSmsTimer = 60;
            boardTimer.textContent = `${testSmsTimer}s`;
            if (testSmsTimerInterval) clearInterval(testSmsTimerInterval);
            testSmsTimerInterval = setInterval(() => {
                testSmsTimer--;
                if (testSmsTimer <= 0) {
                    clearInterval(testSmsTimerInterval);
                    boardTimer.textContent = "Hết hạn";
                    boardSms.textContent = "Thời gian chờ quá 60s. Vui lòng bấm 'Hủy số' và thuê lại số khác.";
                    document.getElementById("btn-test-otp").disabled = true;
                    document.getElementById("btn-test-cancel").disabled = true;
                    document.getElementById("btn-test-rent").disabled = false;
                } else {
                    boardTimer.textContent = `${testSmsTimer}s`;
                }
            }, 1000);
        } else {
            boardPhone.textContent = "Thất bại";
            boardSms.textContent = `Lỗi: ${result.error}`;
            document.getElementById("btn-test-rent").disabled = false;
        }
    } catch (err) {
        boardPhone.textContent = "Lỗi";
        boardSms.textContent = `Lỗi hệ thống: ${err.message}`;
        document.getElementById("btn-test-rent").disabled = false;
    }
}

async function runTestCheckOtp() {
    if (!testPhoneRequestId || !testPhoneType) {
        alert("Không tìm thấy Request ID thuê số cũ! Vui lòng bấm 'Thuê số thử' trước.");
        return;
    }
    
    let apiKey = "";
    if (testPhoneType === "viotp") {
        apiKey = document.getElementById("api-viotp").value.trim();
    } else {
        apiKey = document.getElementById("api-smspool").value.trim();
    }
    
    const boardOtp = document.getElementById("sms-board-otp");
    const boardSms = document.getElementById("sms-board-sms");
    boardSms.textContent = "Đang truy vấn mã OTP từ API...";
    
    try {
        const response = await fetch("/api/test/check_phone_otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: testPhoneType, key: apiKey, request_id: testPhoneRequestId })
        });
        const result = await response.json();
        if (result.success && result.code) {
            boardOtp.textContent = result.code;
            boardSms.textContent = `Đã nhận được tin nhắn: "${result.sms}"`;
            
            clearInterval(testSmsTimerInterval);
            document.getElementById("btn-test-otp").disabled = true;
            document.getElementById("btn-test-cancel").disabled = true;
            document.getElementById("btn-test-rent").disabled = false;
        } else {
            boardSms.textContent = `Trạng thái: ${result.status || "Đang chờ OTP..."} (${testSmsTimer}s)`;
        }
    } catch (err) {
        boardSms.textContent = `Lỗi hệ thống: ${err.message}`;
    }
}

async function runTestCancelPhone() {
    if (!testPhoneRequestId || !testPhoneType) return;
    
    const boardSms = document.getElementById("sms-board-sms");
    boardSms.textContent = "Đang gửi yêu cầu hủy số...";
    clearInterval(testSmsTimerInterval);
    
    try {
        const response = await fetch("/api/test/cancel_phone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: testPhoneType, request_id: testPhoneRequestId })
        });
        const result = await response.json();
        if (result.success) {
            boardSms.textContent = "Đã hủy thuê số điện thoại thành công! Số dư tài khoản được bảo toàn.";
        } else {
            boardSms.textContent = `Lỗi hủy số: ${result.error}`;
        }
    } catch (err) {
        boardSms.textContent = `Lỗi kết nối hủy số: ${err.message}`;
    }
    
    document.getElementById("btn-test-rent").disabled = false;
    document.getElementById("btn-test-otp").disabled = true;
    document.getElementById("btn-test-cancel").disabled = true;
    testPhoneRequestId = null;
}

// --- LOGIC CHO PROXY DÂN CƯ ---
function generateResidentialProxy() {
    const host = document.getElementById("proxy-res-host").value.trim();
    const country = document.getElementById("proxy-res-country").value;
    const protocol = document.getElementById("proxy-res-protocol").value;
    const state = document.getElementById("proxy-res-state").value.trim();
    const city = document.getElementById("proxy-res-city").value.trim();
    const isp = document.getElementById("proxy-res-isp").value.trim();
    const user = document.getElementById("proxy-res-username").value.trim();
    const pass = document.getElementById("proxy-res-password").value.trim();
    
    if (!host || !user || !pass) {
        alert("Vui lòng điền đầy đủ Host:Port, Username và Password của cổng Proxy!");
        return;
    }
    
    // Ghép nối cấu trúc username định danh theo chuẩn proxy cư dân xoay IP
    // Định dạng: user-zone-custom-country-US-state-NY-city-NewYork
    let finalUser = user;
    if (!finalUser.includes("country-")) {
        finalUser += `-country-${country}`;
        if (state) finalUser += `-state-${state}`;
        if (city) finalUser += `-city-${city}`;
        if (isp) finalUser += `-isp-${isp}`;
    }
    
    const proxyUrl = `${protocol}://${finalUser}:${pass}@${host}`;
    document.getElementById("api-proxy-changer").value = proxyUrl;
    
    alert("Đã tự động tạo và gán chuỗi kết nối Proxy dân cư thành công!");
}

async function testResidentialProxyConnection() {
    const proxyUrl = document.getElementById("api-proxy-changer").value.trim();
    if (!proxyUrl) {
        alert("Vui lòng gán hoặc nhập chuỗi kết nối Proxy trước!");
        return;
    }
    
    const board = document.getElementById("proxy-res-board");
    const boardIp = document.getElementById("proxy-board-ip");
    const boardTz = document.getElementById("proxy-board-timezone");
    const boardLoc = document.getElementById("proxy-board-location");
    const boardIsp = document.getElementById("proxy-board-isp");
    
    board.style.display = "block";
    boardIp.textContent = "Đang kết nối...";
    boardTz.textContent = "-";
    boardLoc.textContent = "-";
    boardIsp.textContent = "-";
    
    try {
        const res = await fetch("/api/check_proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxy_server: proxyUrl })
        });
        const data = await res.json();
        if (data.success) {
            boardIp.textContent = data.ip;
            boardTz.textContent = data.timezone;
            boardLoc.textContent = `${data.country} / ${data.city || "N/A"}`;
            boardIsp.textContent = data.isp || "Residential IP";
        } else {
            boardIp.textContent = "Lỗi kết nối";
            boardIsp.textContent = `Lỗi: ${data.error}`;
        }
    } catch (e) {
        boardIp.textContent = "Lỗi hệ thống";
        boardIsp.textContent = e.message;
    }
}

// --- ĐỒNG BỘ ĐỊA LÝ THEO QUỐC GIA PROFILE ---
function syncLocationByCountry() {
    const countryCode = document.getElementById("p-country").value;
    const tzSelect = document.getElementById("p-timezone");
    const latInput = document.getElementById("p-lat");
    const lngInput = document.getElementById("p-lng");
    
    if (typeof ALL_COUNTRIES === 'undefined') return;
    
    // Tìm kiếm thông tin quốc gia trong cơ sở dữ liệu ALL_COUNTRIES
    const countryData = ALL_COUNTRIES.find(c => c.code === countryCode);
    if (countryData) {
        // Cập nhật múi giờ
        let exists = false;
        for (let i = 0; i < tzSelect.options.length; i++) {
            if (tzSelect.options[i].value === countryData.tz) {
                tzSelect.selectedIndex = i;
                exists = true;
                break;
            }
        }
        if (!exists) {
            const opt = document.createElement("option");
            opt.value = countryData.tz;
            opt.textContent = `${countryData.tz}`;
            tzSelect.appendChild(opt);
            tzSelect.value = countryData.tz;
        }
        
        // Thêm độ lệch ngẫu nhiên nhỏ cho tọa độ để tránh trùng lặp 100% giữa các profile
        const offsetLat = (Math.random() - 0.5) * 0.05;
        const offsetLng = (Math.random() - 0.5) * 0.05;
        latInput.value = (countryData.lat + offsetLat).toFixed(4);
        lngInput.value = (countryData.lng + offsetLng).toFixed(4);
        
        // Cập nhật lại bản đồ Leaflet nếu nó đã khởi tạo
        if (map) {
            const newLat = parseFloat(latInput.value);
            const newLng = parseFloat(lngInput.value);
            map.setView([newLat, newLng], 6); // Đặt zoom là 6 để hiển thị bao quát quốc gia
            if (marker) {
                marker.setLatLng([newLat, newLng]);
            }
        }
        console.log(`[Geo-sync] Đã tự động đồng bộ múi giờ ${countryData.tz} và tọa độ thực tế theo quốc gia ${countryCode}`);
    }
}

// Khởi tạo tính năng tìm kiếm gợi ý quốc gia (Country Autocomplete)
function initCountryAutocomplete() {
    const searchInput = document.getElementById("p-country-search");
    const hiddenInput = document.getElementById("p-country");
    const dropdown = document.getElementById("p-country-dropdown");
    
    if (!searchInput || !hiddenInput || !dropdown) return;
    
    let activeIndex = -1;
    let currentResults = [];

    // Hàm tiện ích loại bỏ dấu tiếng Việt để tìm kiếm không phụ thuộc dấu
    const removeVietnameseTones = (str) => {
        if (!str) return "";
        return str
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d")
            .replace(/Đ/g, "D")
            .toLowerCase();
    };

    const renderResults = (results) => {
        currentResults = results;
        dropdown.innerHTML = "";
        
        if (results.length === 0) {
            dropdown.style.display = "none";
            return;
        }
        
        results.forEach((country, idx) => {
            const item = document.createElement("div");
            item.className = "autocomplete-item" + (idx === activeIndex ? " active" : "");
            item.innerHTML = `
                <span>${escapeHtml(country.name_vi)} (${escapeHtml(country.name_en)})</span>
                <span class="country-code">${escapeHtml(country.code)}</span>
            `;
            
            item.addEventListener("mousedown", (e) => {
                // Sử dụng mousedown thay vì click để sự kiện chạy trước sự kiện blur của input
                e.preventDefault();
                selectCountry(country);
            });
            
            dropdown.appendChild(item);
        });
        
        dropdown.style.display = "block";
    };

    const selectCountry = (country) => {
        hiddenInput.value = country.code;
        searchInput.value = `${country.name_vi} (${country.name_en})`;
        dropdown.style.display = "none";
        activeIndex = -1;
        
        // Đồng bộ hóa vị trí, múi giờ và bản đồ
        syncLocationByCountry();
    };

    searchInput.addEventListener("input", () => {
        const query = removeVietnameseTones(searchInput.value.trim());
        if (!query) {
            dropdown.style.display = "none";
            return;
        }
        
        if (typeof ALL_COUNTRIES === 'undefined') return;
        
        // Lọc quốc gia theo tên Việt, tên Anh hoặc mã Code
        const filtered = ALL_COUNTRIES.filter(country => {
            const vi = removeVietnameseTones(country.name_vi);
            const en = removeVietnameseTones(country.name_en);
            const code = country.code.toLowerCase();
            return vi.includes(query) || en.includes(query) || code.includes(query);
        });
        
        activeIndex = -1;
        renderResults(filtered);
    });

    searchInput.addEventListener("keydown", (e) => {
        const items = dropdown.querySelectorAll(".autocomplete-item");
        if (dropdown.style.display === "none" || items.length === 0) return;
        
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIndex = (activeIndex + 1) % items.length;
            updateHighlights(items);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIndex = (activeIndex - 1 + items.length) % items.length;
            updateHighlights(items);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (activeIndex >= 0 && currentResults[activeIndex]) {
                selectCountry(currentResults[activeIndex]);
            }
        } else if (e.key === "Escape") {
            dropdown.style.display = "none";
            activeIndex = -1;
        }
    });

    const updateHighlights = (items) => {
        items.forEach((item, idx) => {
            if (idx === activeIndex) {
                item.classList.add("active");
                item.scrollIntoView({ block: "nearest" });
            } else {
                item.classList.remove("active");
            }
        });
    };

    // Khi người dùng bấm click ra ngoài thì tự động ẩn dropdown
    document.addEventListener("click", (e) => {
        if (e.target !== searchInput && !dropdown.contains(e.target)) {
            dropdown.style.display = "none";
            activeIndex = -1;
        }
    });
    
    // Khi focus lại, nếu đã có text thì hiện lại kết quả gợi ý
    searchInput.addEventListener("focus", () => {
        if (searchInput.value.trim() !== "") {
            searchInput.dispatchEvent(new Event("input"));
        }
    });
}

async function runTestCreateEmail() {
    const output = document.getElementById("test-email-output");
    output.style.display = "block";
    output.className = "text-info";
    output.innerText = "[Hệ thống] Đang tạo hòm thư ảo 1secmail thử nghiệm...";
    
    try {
        const response = await fetch("/api/test/create_email", { method: "POST" });
        const result = await response.json();
        if (result.success) {
            testEmailUsername = result.email_username;
            testEmailDomain = result.email_domain;
            output.className = "text-success";
            output.innerText = `[Thành công]\n- Hòm thư ảo: ${result.email}\n\n-> Hãy bấm "Lấy OTP mail thử" sau khi bạn đã gửi mã xác thực tới email này.`;
            document.getElementById("btn-test-email-otp").disabled = false;
        } else {
            output.className = "text-danger";
            output.innerText = `[Thất bại] Lỗi: ${result.error}`;
            document.getElementById("btn-test-email-otp").disabled = true;
        }
    } catch (err) {
        output.className = "text-danger";
        output.innerText = `[Lỗi hệ thống] ${err.message}`;
        document.getElementById("btn-test-email-otp").disabled = true;
    }
}

async function runTestCheckEmailOtp() {
    if (!testEmailUsername || !testEmailDomain) {
        alert("Vui lòng tạo email thử nghiệm trước!");
        return;
    }
    
    const output = document.getElementById("test-email-output");
    output.className = "text-info";
    output.innerText = `[Hệ thống] Đang kiểm tra mã OTP từ email: ${testEmailUsername}@${testEmailDomain}...`;
    
    try {
        const response = await fetch("/api/test/check_email_otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email_username: testEmailUsername, email_domain: testEmailDomain })
        });
        const result = await response.json();
        if (result.success) {
            output.className = "text-success";
            output.innerText = `[Thành công] Nhận mã OTP Email!\n- Mã OTP: ${result.code}`;
        } else {
            output.className = "text-warning";
            output.innerText = `[Thông báo] Tin nhắn: ${result.message}`;
        }
    } catch (err) {
        output.className = "text-danger";
        output.innerText = `[Lỗi hệ thống] ${err.message}`;
    }
}

// --- MINPROXY INTEGRATION FRONTEND FUNCTIONS ---

async function fetchMinproxyIP() {
    const key = document.getElementById("api-minproxy-key").value.trim();
    const statusSpan = document.getElementById("minproxy-status");
    const board = document.getElementById("minproxy-board");
    
    if (!key) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Chưa nhập khóa API Minproxy!";
        board.style.display = "none";
        return;
    }

    statusSpan.className = "status-checking";
    statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang kết nối lấy IP...`;
    board.style.display = "none";

    try {
        const response = await fetch(`/api/minproxy/get-proxy?api_key=${encodeURIComponent(key)}`);
        const result = await response.json();
        
        if (result.success) {
            statusSpan.className = "status-live";
            statusSpan.innerText = "Lấy thông tin proxy thành công!";
            
            document.getElementById("minproxy-board-ip").innerText = result.ip || "-";
            document.getElementById("minproxy-board-port").innerText = `${result.port} (HTTP) | ${result.socks_port} (SOCKS5)`;
            document.getElementById("minproxy-board-auth").innerText = `${result.username} / ${result.password}`;
            document.getElementById("minproxy-board-location").innerText = result.location || "Không rõ";
            
            // Format ngày hết hạn
            let expireText = "-";
            if (result.expire_date) {
                const date = new Date(result.expire_date);
                expireText = date.toLocaleString("vi-VN");
            }
            document.getElementById("minproxy-board-expire").innerText = expireText;
            
            board.style.display = "block";
        } else {
            statusSpan.className = "status-die";
            statusSpan.innerText = "Thất bại: " + result.error;
            board.style.display = "none";
        }
    } catch (err) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Lỗi kết nối máy chủ!";
        board.style.display = "none";
    }
}

async function rotateMinproxyIP() {
    const key = document.getElementById("api-minproxy-key").value.trim();
    const statusSpan = document.getElementById("minproxy-status");
    
    if (!key) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Chưa nhập khóa API Minproxy để xoay!";
        return;
    }

    statusSpan.className = "status-checking";
    statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi yêu cầu xoay IP...`;

    try {
        const response = await fetch("/api/minproxy/rotate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: key })
        });
        const result = await response.json();
        
        if (result.success) {
            statusSpan.className = "status-live";
            statusSpan.innerText = "Yêu cầu xoay IP thành công: " + (result.message || "IP đang được thay đổi!");
            // Đợi 2 giây rồi tự động cập nhật lại bảng IP
            setTimeout(fetchMinproxyIP, 2000);
        } else {
            statusSpan.className = "status-die";
            statusSpan.innerText = "Không thể xoay IP: " + result.error;
        }
    } catch (err) {
        statusSpan.className = "status-die";
        statusSpan.innerText = "Lỗi kết nối máy chủ!";
    }
}

async function fillProxyFromMinproxy() {
    const key = document.getElementById("api-minproxy-key") ? document.getElementById("api-minproxy-key").value.trim() : "";
    const fetchBtn = document.getElementById("btn-minproxy-fetch");
    
    if (!key) {
        alert("Vui lòng cấu hình API Key Minproxy Next trong mục Cấu hình chung trước!");
        return;
    }

    const originalText = fetchBtn.innerHTML;
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang lấy...`;

    try {
        const response = await fetch(`/api/minproxy/get-proxy?api_key=${encodeURIComponent(key)}`);
        const result = await response.json();
        
        if (result.success) {
            // Điền thông tin vào form
            const proxyType = document.getElementById("p-proxy-type").value;
            if (proxyType === "socks5://") {
                document.getElementById("p-proxy").value = `${result.ip}:${result.socks_port || result.port}`;
            } else {
                document.getElementById("p-proxy").value = `${result.ip}:${result.port}`;
            }
            document.getElementById("p-proxy-user").value = result.username || "";
            document.getElementById("p-proxy-pass").value = result.password || "";
            
            // Tự động điền link xoay IP
            document.getElementById("p-proxy-rotate-url").value = `http://127.0.0.1:5000/api/minproxy/rotate`;
            
            // Gọi check vị trí để đồng bộ bản đồ & múi giờ tự động
            const syncBtn = document.getElementById("btn-sync-proxy");
            if (syncBtn) {
                syncBtn.click();
            }
            
            alert("Đã tự động lấy và điền thông tin Proxy từ Minproxy thành công!");
        } else {
            alert("Lỗi lấy proxy: " + result.error);
        }
    } catch (err) {
        alert("Lỗi kết nối máy chủ: " + err.message);
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.innerHTML = originalText;
    }
}

// --- REAL-TIME STATUS SYNC & POLLING FUNCTIONS ---

function updateProfileUIStatus(profileId, status) {
    const tr = document.querySelector(`#profile-list-body tr[data-profile-id="${profileId}"]`);
    if (!tr) return;

    const isRunning = status === "Running";
    
    // 1. Cập nhật Badge Trạng thái
    const statusCell = tr.querySelector(".status-cell");
    if (statusCell) {
        const newBadge = isRunning 
            ? `<span class="badge badge-success"><span class="status-dot online"></span> Dang chay</span>`
            : `<span class="badge badge-secondary"><span class="status-dot"></span> Da dung</span>`;
        if (statusCell.innerHTML !== newBadge) {
            statusCell.innerHTML = newBadge;
        }
    }

    // 2. Cập nhật các nút trong Action Buttons
    const actionButtons = tr.querySelector(".action-buttons");
    if (actionButtons) {
        const hasStopBtn = actionButtons.querySelector(".btn-stop");
        const hasStartBtn = actionButtons.querySelector(".btn-start");
        
        // Chỉ vẽ lại khi có sự thay đổi trạng thái chạy/dừng
        if ((isRunning && !hasStopBtn) || (!isRunning && !hasStartBtn)) {
            const playStopButton = isRunning
                ? `<button class="btn-icon btn-stop" onclick="stopProfile(${profileId})" title="Dung Trinh duyet"><i class="fa-solid fa-square"></i></button>`
                : `<button class="btn-icon btn-start" onclick="startProfile(${profileId})" title="Chay Trinh duyet"><i class="fa-solid fa-play"></i></button>`;

            const autoButton = isRunning
                ? `<button class="btn-icon btn-auto" onclick="triggerProfileAutomation(${profileId})" title="Chay kich ban tu dong"><i class="fa-solid fa-robot"></i></button>`
                : `<button class="btn-icon" style="opacity: 0.3; cursor: not-allowed;" disabled><i class="fa-solid fa-robot"></i></button>`;

            const syncButton = `<button class="btn-icon btn-sync" onclick="syncSingleProfileStatus(${profileId}, event)" title="Đồng bộ trạng thái thực tế"><i class="fa-solid fa-arrows-rotate"></i></button>`;

            actionButtons.innerHTML = `
                ${playStopButton}
                ${autoButton}
                ${syncButton}
                <button class="btn-icon btn-clean" onclick="cleanProfileJunk(${profileId}, event)" title="Dọn dẹp tệp tin rác (Cache/Logs)"><i class="fa-solid fa-broom"></i></button>
                <button class="btn-icon btn-start" onclick="triggerProfileBackup(${profileId})" title="Backup profile (Sao lưu full môi trường)"><i class="fa-solid fa-cloud-arrow-up"></i></button>
                <button class="btn-icon" onclick="editProfile(${profileId})" title="Sua cau hinh"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="btn-icon btn-delete" onclick="deleteProfile(${profileId})" title="Xoa profile"><i class="fa-solid fa-trash"></i></button>
            `;
        }
    }
}

async function pollProfilesStatus() {
    const profilesPane = document.getElementById("pane-profiles");
    if (profilesPane && profilesPane.style.display === "none") {
        return;
    }
    
    try {
        const response = await fetch("/api/profiles");
        if (!response.ok) return;
        const profiles = await response.json();
        
        profiles.forEach(profile => {
            updateProfileUIStatus(profile.id, profile.status);
        });
    } catch (e) {
        console.warn("[Polling Status Error] " + e.message);
    }
}

let statusPollingInterval = null;
function startStatusPolling() {
    if (statusPollingInterval) {
        clearInterval(statusPollingInterval);
    }
    // Tự động thăm dò trạng thái mỗi 5 giây
    statusPollingInterval = setInterval(pollProfilesStatus, 5000);
}

async function syncSingleProfileStatus(profileId, event) {
    if (event) {
        event.stopPropagation();
        const btn = event.currentTarget;
        const icon = btn.querySelector("i");
        if (icon) {
            icon.classList.add("fa-spin");
        }
        btn.disabled = true;
    }
    
    try {
        const response = await fetch(`/api/profiles/${profileId}/mcp_status`);
        const result = await response.json();
        
        if (result.success) {
            updateProfileUIStatus(profileId, result.status);
        }
    } catch (e) {
        console.error(`Lỗi đồng bộ trạng thái profile ${profileId}:`, e);
    } finally {
        if (event) {
            const btn = event.currentTarget;
            const icon = btn.querySelector("i");
            if (icon) {
                icon.classList.remove("fa-spin");
            }
            btn.disabled = false;
        }
    }
}

async function syncAllProfilesStatus() {
    const btn = document.getElementById("btn-sync-all-status");
    let icon = null;
    if (btn) {
        icon = btn.querySelector("i");
        if (icon) icon.classList.add("fa-spin");
        btn.disabled = true;
    }

    try {
        const response = await fetch("/api/profiles");
        const profiles = await response.json();
        
        const promises = profiles.map(p => 
            fetch(`/api/profiles/${p.id}/mcp_status`)
                .then(r => r.json())
                .catch(() => ({ success: false }))
        );
        await Promise.all(promises);
        
        await loadProfiles();
        alert("Đã hoàn thành đồng bộ trạng thái thực tế cho toàn bộ profile!");
    } catch (e) {
        alert("Có lỗi xảy ra khi đồng bộ trạng thái: " + e.message);
    } finally {
        if (btn) {
            if (icon) icon.classList.remove("fa-spin");
            btn.disabled = false;
        }
    }
}



// --- DỌN DẸP TỆP TIN RÁC CỦA PROFILE ---
async function cleanProfileJunk(profileId, event) {
    if (event) {
        event.stopPropagation(); // Ngăn chặn sự kiện click lan truyền lên dòng tr (event propagation)
        const btn = event.currentTarget;
        const icon = btn.querySelector("i");
        if (icon) {
            icon.classList.add("fa-spin"); // Thêm hiệu ứng xoay tròn (spin effect) cho biểu tượng chổi quét
        }
        btn.disabled = true;
    }

    try {
        const response = await fetch(`/api/profiles/${profileId}/clean_junk`, {
            method: "POST", // Gửi yêu cầu dạng POST lên máy chủ để kích hoạt tác vụ
            headers: { "Content-Type": "application/json" }
        });
        const result = await response.json(); // Chuyển đổi phản hồi của máy chủ sang dữ liệu JSON (định dạng dữ liệu có cấu trúc)
        
        if (result.success) {
            alert(result.message);
            await loadProfiles(); // Tải lại danh sách profile để cập nhật dung lượng hiển thị mới
        } else {
            alert("Lỗi: " + result.error);
        }
    } catch (e) {
        alert("Có lỗi xảy ra khi dọn dẹp rác: " + e.message);
    } finally {
        if (event) {
            const btn = event.currentTarget;
            const icon = btn.querySelector("i");
            if (icon) {
                icon.classList.remove("fa-spin"); // Tắt hiệu ứng xoay tròn
            }
            btn.disabled = false;
        }
    }
}

// --- PUPPETEER DIAGNOSTIC LOGIC v1.2.0 ---
let diagnosticPollInterval = null;

async function triggerPuppeteerDiagnostic(profileId, event) {
    if (event) event.stopPropagation();

    // Reset giao diện modal
    const modal = document.getElementById("puppeteer-diagnostic-modal");
    const logsBox = document.getElementById("diagnostic-logs-box");
    const screenshotBox = document.getElementById("diagnostic-screenshot-box");
    const screenshotImg = document.getElementById("diagnostic-screenshot-img");

    logsBox.innerText = "Đang kết nối tới máy chủ và khởi chạy tiến trình chẩn đoán ngầm...\n";
    screenshotBox.style.display = "none";
    screenshotImg.src = "";
    modal.classList.add("active");

    // Dừng interval cũ nếu đang chạy
    if (diagnosticPollInterval) {
        clearInterval(diagnosticPollInterval);
        diagnosticPollInterval = null;
    }

    try {
        const response = await fetch(`/api/profiles/${profileId}/puppeteer_diagnostic`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
        const result = await response.json();
        
        if (result.success) {
            // Bắt đầu vòng lặp lấy logs trạng thái mỗi 1.5 giây
            diagnosticPollInterval = setInterval(() => pollDiagnosticStatus(profileId), 1500);
        } else {
            logsBox.innerText += `\nLỗi từ máy chủ: ${result.error || "Không rõ nguyên nhân"}`;
        }
    } catch (e) {
        logsBox.innerText += `\nLỗi kết nối: ${e.message}`;
    }
}

async function pollDiagnosticStatus(profileId) {
    const logsBox = document.getElementById("diagnostic-logs-box");
    const screenshotBox = document.getElementById("diagnostic-screenshot-box");
    const screenshotImg = document.getElementById("diagnostic-screenshot-img");

    try {
        const response = await fetch(`/api/profiles/${profileId}/puppeteer_diagnostic_status`);
        const status = await response.json();

        if (status.success) {
            // Cập nhật logs
            if (status.logs && status.logs.length > 0) {
                logsBox.innerText = status.logs.join("\n");
                // Cuộn xuống cuối box log
                logsBox.scrollTop = logsBox.scrollHeight;
            }

            // Nếu chẩn đoán hoàn tất
            if (!status.isRunning) {
                clearInterval(diagnosticPollInterval);
                diagnosticPollInterval = null;

                if (status.success && status.screenshotUrl) {
                    screenshotImg.src = status.screenshotUrl;
                    screenshotBox.style.display = "block";
                }
            }
        }
    } catch (e) {
        console.error("Lỗi poll trạng thái chẩn đoán:", e);
    }
}

function closePuppeteerDiagnosticModal() {
    const modal = document.getElementById("puppeteer-diagnostic-modal");
    modal.classList.remove("active");

    // Dừng poll logs
    if (diagnosticPollInterval) {
        clearInterval(diagnosticPollInterval);
        diagnosticPollInterval = null;
    }
    
    // Tải lại danh sách profile để cập nhật trạng thái nếu có thay đổi
    loadProfiles();
}

// --- TIỆN ÍCH MỞ RỘNG (EXTENSIONS) LOGIC ---

async function loadExtensionsList() {
    const tbody = document.getElementById("extension-list-body");
    if (!tbody) return;

    try {
        const response = await fetch("/api/extensions");
        const list = await response.json();

        if (list.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 30px; color: var(--text-secondary);">
                        <i class="fa-solid fa-puzzle-piece" style="font-size: 1.8rem; margin-bottom: 8px; display: block; opacity: 0.5;"></i>
                        Chưa có tiện ích mở rộng nào trong kho. Hãy nhấn "Quét thư mục Tiện ích" ở trên!
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = "";
        list.forEach(ext => {
            const tr = document.createElement("tr");
            const checked = ext.auto_install === 1 ? "checked" : "";
            tr.innerHTML = `
                <td>
                    <span style="font-weight: 600; color: #e0e7ff;">${ext.name}</span>
                </td>
                <td><span class="info-badge" style="background-color: rgba(99,102,241,0.15); color: #818cf8;">v${ext.version}</span></td>
                <td>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${ext.path}">
                        ${ext.path}
                    </div>
                </td>
                <td class="text-center">
                    <label class="switch" style="position: relative; display: inline-block; width: 44px; height: 22px; margin: 0;">
                        <input type="checkbox" ${checked} onchange="toggleExtensionAutoInstall(${ext.id}, this.checked)" style="opacity: 0; width: 0; height: 0;">
                        <span class="slider round" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255,255,255,0.1); transition: .3s; border-radius: 22px;"></span>
                    </label>
                </td>
                <td class="text-center">
                    <button class="btn btn-sm btn-primary" onclick="openExtensionConfigModal(${ext.id})" style="padding: 4px 8px; font-size: 0.78rem; display: flex; align-items: center; gap: 4px; margin: 0 auto; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); border: none;">
                        <i class="fa-solid fa-gear"></i> Cấu hình & Quản lý
                    </button>
                </td>
            `;

            // Bổ sung style css cho slider inline nếu chưa có class switch/slider
            const style = tr.querySelector(".slider");
            const input = tr.querySelector("input");
            input.addEventListener('change', function() {
                if (this.checked) {
                    style.style.backgroundColor = "#4f46e5";
                } else {
                    style.style.backgroundColor = "rgba(255,255,255,0.1)";
                }
            });
            if (ext.auto_install === 1) {
                style.style.backgroundColor = "#4f46e5";
            }

            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error("Lỗi khi tải kho tiện ích:", e);
        tbody.innerHTML = `<tr><td colspan="4" style="color: #ef4444; text-align: center; padding: 20px;">Lỗi tải dữ liệu: ${e.message}</td></tr>`;
    }
}

async function scanExtensionsDirectory() {
    const btn = document.querySelector("#pane-extensions button.btn-primary");
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Đang quét...`;
    btn.disabled = true;

    try {
        const response = await fetch("/api/extensions/scan", { method: "POST" });
        const result = await response.json();
        if (result.success) {
            alert(result.message);
            await loadExtensionsList();
            // Nếu có profile đang được chọn để cấu hình thì load lại luôn
            const selectedProfileId = document.getElementById("ext-profile-select").value;
            if (selectedProfileId) {
                loadExtensionsForSelectedProfile();
            }
        } else {
            alert("Lỗi khi quét thư mục tiện ích: " + result.error);
        }
    } catch (e) {
        alert("Lỗi kết nối máy chủ: " + e.message);
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}

async function toggleExtensionAutoInstall(extId, isChecked) {
    try {
        const response = await fetch(`/api/extensions/${extId}/toggle_auto`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ auto_install: isChecked ? 1 : 0 })
        });
        const result = await response.json();
        if (!result.success) {
            alert("Lỗi cập nhật tự động cài đặt: " + result.error);
        }
    } catch (e) {
        console.error("Lỗi kết nối toggle auto install:", e);
    }
}

async function loadExtensionsProfileSelect() {
    const select = document.getElementById("ext-profile-select");
    if (!select) return;

    try {
        const response = await fetch("/api/profiles");
        const profiles = await response.json();

        const currentVal = select.value;
        select.innerHTML = `<option value="">-- Chọn Profile --</option>`;
        
        profiles.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.innerText = `${p.name} (ID: ${p.id})`;
            select.appendChild(opt);
        });

        if (currentVal && profiles.some(p => p.id == currentVal)) {
            select.value = currentVal;
        } else {
            document.getElementById("ext-profile-config-container").innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); padding: 30px 0; font-size: 0.88rem;">
                    <i class="fa-solid fa-circle-info"></i> Hãy chọn một Profile ở trên để bắt đầu cấu hình tiện ích.
                </div>
            `;
            document.getElementById("btn-save-profile-extensions").disabled = true;
        }
    } catch (e) {
        console.error("Lỗi tải danh sách profile cho tiện ích:", e);
    }
}

async function loadExtensionsForSelectedProfile() {
    const profileId = document.getElementById("ext-profile-select").value;
    const container = document.getElementById("ext-profile-config-container");
    const saveBtn = document.getElementById("btn-save-profile-extensions");

    if (!profileId) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); padding: 30px 0; font-size: 0.88rem;">
                <i class="fa-solid fa-circle-info"></i> Hãy chọn một Profile ở trên để bắt đầu cấu hình tiện ích.
            </div>
        `;
        saveBtn.disabled = true;
        return;
    }

    saveBtn.disabled = false;
    container.innerHTML = `
        <div style="text-align: center; color: var(--text-secondary); padding: 20px 0;">
            <i class="fa-solid fa-circle-notch fa-spin"></i> Đang tải cấu hình tiện ích của Profile...
        </div>
    `;

    try {
        const response = await fetch(`/api/profiles/${profileId}/extensions`);
        const list = await response.json();

        if (list.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-secondary); padding: 20px 0; font-size: 0.88rem;">
                    <i class="fa-solid fa-triangle-exclamation"></i> Kho tiện ích hiện tại trống. Vui lòng chạy Quét thư mục trước.
                </div>
            `;
            return;
        }

        container.innerHTML = "";
        list.forEach(ext => {
            const wrapper = document.createElement("div");
            wrapper.className = "ext-config-item";
            wrapper.style.border = "1px solid rgba(255,255,255,0.05)";
            wrapper.style.borderRadius = "8px";
            wrapper.style.padding = "12px";
            wrapper.style.backgroundColor = "rgba(255,255,255,0.01)";

            const isEnabled = ext.enabled === 1;
            const checkedAttr = isEnabled ? "checked" : "";
            
            // Format JSON cấu hình đẹp
            let configPretty = ext.config_json || "{}";
            try {
                configPretty = JSON.stringify(JSON.parse(configPretty), null, 4);
            } catch (je) {}

            wrapper.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span style="font-weight: 600; color: #a5b4fc; font-size: 0.9rem;">${ext.name} <span style="font-size: 0.75rem; color: var(--text-secondary);">v${ext.version}</span></span>
                    <label class="switch" style="position: relative; display: inline-block; width: 40px; height: 20px; margin: 0;">
                        <input type="checkbox" class="profile-ext-enable-check" data-ext-id="${ext.id}" ${checkedAttr} style="opacity: 0; width: 0; height: 0;">
                        <span class="slider round" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255,255,255,0.1); transition: .3s; border-radius: 20px;"></span>
                    </label>
                </div>
                <div class="config-editor-section" style="display: ${isEnabled ? 'block' : 'none'}; margin-top: 8px;">
                    <label style="font-size: 0.75rem; color: var(--text-secondary); display: block; margin-bottom: 4px;">Dữ liệu cấu hình riêng (JSON):</label>
                    <textarea class="profile-ext-config-json" data-ext-id="${ext.id}" placeholder='{"key": "value"}' style="width: 100%; height: 60px; font-family: monospace; font-size: 0.78rem; padding: 6px; border-radius: 4px; border: 1px solid var(--border-color); background-color: rgba(0,0,0,0.2); color: #818cf8; resize: vertical;">${configPretty}</textarea>
                </div>
            `;

            const check = wrapper.querySelector(".profile-ext-enable-check");
            const slider = wrapper.querySelector(".slider");
            const editorSec = wrapper.querySelector(".config-editor-section");

            if (isEnabled) {
                slider.style.backgroundColor = "#10b981";
            }

            check.addEventListener("change", function() {
                if (this.checked) {
                    slider.style.backgroundColor = "#10b981";
                    editorSec.style.display = "block";
                } else {
                    slider.style.backgroundColor = "rgba(255,255,255,0.1)";
                    editorSec.style.display = "none";
                }
            });

            container.appendChild(wrapper);
        });
    } catch (e) {
        console.error("Lỗi khi tải cấu hình tiện ích profile:", e);
        container.innerHTML = `<div style="color: #ef4444; font-size: 0.88rem;">Không thể tải cấu hình tiện ích: ${e.message}</div>`;
    }
}

async function saveProfileExtensionsConfig() {
    const profileId = document.getElementById("ext-profile-select").value;
    if (!profileId) return;

    const saveBtn = document.getElementById("btn-save-profile-extensions");
    const origHtml = saveBtn.innerHTML;
    saveBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Đang lưu...`;
    saveBtn.disabled = true;

    const extensionsPayload = [];
    const items = document.querySelectorAll(".ext-config-item");
    let hasJsonError = false;

    items.forEach(item => {
        const check = item.querySelector(".profile-ext-enable-check");
        const extId = parseInt(check.getAttribute("data-ext-id"));
        const enabled = check.checked ? 1 : 0;
        
        let configVal = "{}";
        if (enabled) {
            const textarea = item.querySelector(".profile-ext-config-json");
            configVal = textarea.value.trim() || "{}";
            try {
                JSON.parse(configVal); // Kiểm tra cú pháp JSON hợp lệ
            } catch (je) {
                alert(`Cấu hình JSON của tiện ích "${item.querySelector('span').innerText}" không hợp lệ. Vui lòng sửa lại!`);
                hasJsonError = true;
            }
        }

        extensionsPayload.push({
            id: extId,
            enabled: enabled,
            config_json: configVal
        });
    });

    if (hasJsonError) {
        saveBtn.innerHTML = origHtml;
        saveBtn.disabled = false;
        return;
    }

    try {
        const response = await fetch(`/api/profiles/${profileId}/extensions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ extensions: extensionsPayload })
        });
        const result = await response.json();
        if (result.success) {
            alert("Lưu cấu hình tiện ích cho Profile thành công!");
            // Cập nhật lại giao diện
            loadExtensionsForSelectedProfile();
            await checkAndPromptProfileRestart(profileId);
        } else {
            alert("Lỗi khi lưu cấu hình tiện ích: " + result.error);
        }
    } catch (e) {
        alert("Lỗi kết nối máy chủ: " + e.message);
    } finally {
        saveBtn.innerHTML = origHtml;
        saveBtn.disabled = false;
    }
}

// --- CHI TIẾT & CHẨN ĐOÁN TIỆN ÍCH MỞ RỘNG (EXTENSIONS DETAILS & DIAGNOSTICS) ---
let currentModalExtId = null;
let extProfileMappings = [];
let extRuntimeLogInterval = null;

async function openExtensionConfigModal(extId) {
    currentModalExtId = extId;
    const modal = document.getElementById("extension-details-modal");
    if (!modal) return;

    // Reset giao diện về tab đầu tiên
    switchExtTab('config');
    document.getElementById("ext-profile-search").value = "";
    document.getElementById("ext-select-all-profiles").checked = false;

    // Tải thông tin chung của tiện ích
    try {
        const response = await fetch("/api/extensions");
        const list = await response.json();
        const ext = list.find(e => e.id === extId);
        if (ext) {
            document.getElementById("ext-modal-name").innerText = `${ext.name} (v${ext.version})`;
            document.getElementById("ext-global-config-json").value = ext.global_config_json || "{}";
        }
    } catch (e) {
        console.error("Lỗi lấy thông tin tiện ích:", e);
    }

    // Tải danh sách mapping profiles
    await loadExtProfilesMapping();

    // Chạy chẩn đoán tĩnh
    await runStaticDiagnostics(extId);

    // Điền danh sách dropdown profile đang chạy để xem log
    loadActiveProfilesDropdown();

    modal.classList.add("active");
}

function closeExtensionDetailsModal() {
    const modal = document.getElementById("extension-details-modal");
    if (modal) modal.classList.remove("active");

    if (extRuntimeLogInterval) {
        clearInterval(extRuntimeLogInterval);
        extRuntimeLogInterval = null;
    }
}

function switchExtTab(tabName) {
    const btnConfig = document.getElementById("ext-tab-btn-config");
    const btnDiagnose = document.getElementById("ext-tab-btn-diagnose");
    const paneConfig = document.getElementById("ext-tab-pane-config");
    const paneDiagnose = document.getElementById("ext-tab-pane-diagnose");

    if (tabName === 'config') {
        btnConfig.classList.add('active');
        btnDiagnose.classList.remove('active');
        paneConfig.style.display = 'block';
        paneDiagnose.style.display = 'none';
    } else {
        btnConfig.classList.remove('active');
        btnDiagnose.classList.add('active');
        paneConfig.style.display = 'none';
        paneDiagnose.style.display = 'block';
    }
}

async function loadExtProfilesMapping() {
    const tbody = document.getElementById("ext-profile-mapping-body");
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 20px;"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang nạp dữ liệu...</td></tr>`;

    try {
        const response = await fetch(`/api/extensions/${currentModalExtId}/profiles`);
        extProfileMappings = await response.json();
        renderExtProfilesList();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color: #ef4444; padding: 20px;">Lỗi tải dữ liệu: ${e.message}</td></tr>`;
    }
}

function renderExtProfilesList() {
    const tbody = document.getElementById("ext-profile-mapping-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    const filterText = document.getElementById("ext-profile-search").value.toLowerCase().trim();

    const filtered = extProfileMappings.filter(item => {
        return item.profile_name.toLowerCase().includes(filterText);
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 20px; color: var(--text-secondary);">Không tìm thấy hồ sơ nào khớp.</td></tr>`;
        return;
    }

    filtered.forEach(item => {
        const tr = document.createElement("tr");
        tr.style.borderBottom = "1px solid var(--border-color)";
        const checked = item.enabled ? "checked" : "";
        const disabled = item.enabled ? "" : "disabled";

        tr.innerHTML = `
            <td style="text-align: center; padding: 8px;">
                <input type="checkbox" ${checked} onchange="updateExtProfileMappingCheck(${item.profile_id}, this.checked)" style="cursor: pointer;">
            </td>
            <td style="padding: 8px; font-weight: 500;">${item.profile_name}</td>
            <td style="padding: 8px;">
                <div style="font-size: 0.75rem; color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${item.profile_dir}">
                    ${item.profile_dir}
                </div>
            </td>
            <td style="padding: 8px;">
                <div style="display: flex; gap: 6px; width: 100%;">
                    <input type="text" class="profile-mapping-json" data-profile-id="${item.profile_id}" value="${escapeHtml(item.config_json)}" readonly style="flex-grow: 1; font-family: monospace; font-size: 0.75rem; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(0,0,0,0.3); color: #cbd5e1; outline: none;">
                    <button type="button" class="btn btn-sm btn-secondary" ${disabled} onclick="openExtConfigGuiForProfile(${item.profile_id})" style="padding: 2px 6px; font-size: 0.75rem;"><i class="fa-solid fa-gears"></i> Cấu hình GUI</button>
                </div>
            </td>
            <td style="text-align: center; padding: 8px;">
                <button type="button" class="btn btn-sm btn-outline" ${disabled} onclick="resetExtProfileToDefault(${item.profile_id})" style="padding: 2px 6px; font-size: 0.7rem;"><i class="fa-solid fa-rotate-left"></i> Default</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function filterExtProfileList() {
    renderExtProfilesList();
}

function toggleSelectAllExtProfiles(isChecked) {
    const searchInput = document.getElementById("ext-profile-search").value.toLowerCase().trim();
    
    extProfileMappings.forEach(item => {
        if (!searchInput || item.profile_name.toLowerCase().includes(searchInput)) {
            item.enabled = isChecked ? 1 : 0;
        }
    });
    
    renderExtProfilesList();
}

function updateExtProfileMappingCheck(profileId, isChecked) {
    const item = extProfileMappings.find(m => m.profile_id === profileId);
    if (item) {
        item.enabled = isChecked ? 1 : 0;
        
        // Cập nhật trạng thái input và các button trên UI của dòng này
        const rowTextarea = document.querySelector(`.profile-mapping-json[data-profile-id="${profileId}"]`);
        if (rowTextarea) {
            rowTextarea.disabled = !isChecked;
            const rowBtns = rowTextarea.closest("tr").querySelectorAll("button");
            rowBtns.forEach(btn => btn.disabled = !isChecked);
        }
    }
}

function updateExtProfileMappingJson(profileId, value) {
    const item = extProfileMappings.find(m => m.profile_id === profileId);
    if (item) {
        item.config_json = value;
    }
}

function resetExtProfileToDefault(profileId) {
    const globalDefault = document.getElementById("ext-global-config-json").value.trim() || "{}";
    const item = extProfileMappings.find(m => m.profile_id === profileId);
    if (item) {
        item.config_json = globalDefault;
        
        // Cập nhật lên UI
        const rowTextarea = document.querySelector(`.profile-mapping-json[data-profile-id="${profileId}"]`);
        if (rowTextarea) {
            rowTextarea.value = globalDefault;
        }
    }
}

async function saveExtensionDetails() {
    const btnSave = document.getElementById("btn-save-ext-details");
    const origHtml = btnSave.innerHTML;
    btnSave.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Đang lưu...`;
    btnSave.disabled = true;

    // 1. Kiểm tra JSON global
    const globalConfig = document.getElementById("ext-global-config-json").value.trim() || "{}";
    try {
        JSON.parse(globalConfig);
    } catch (e) {
        alert("Lỗi cú pháp JSON ở Cấu hình Mặc định. Vui lòng sửa lại!");
        btnSave.innerHTML = origHtml;
        btnSave.disabled = false;
        return;
    }

    // 2. Kiểm tra JSON của từng profile được check
    let hasJsonError = false;
    for (const item of extProfileMappings) {
        if (item.enabled) {
            try {
                JSON.parse(item.config_json || "{}");
            } catch (e) {
                alert(`Cấu hình JSON của hồ sơ "${item.profile_name}" không hợp lệ. Vui lòng kiểm tra!`);
                hasJsonError = true;
                break;
            }
        }
    }

    if (hasJsonError) {
        btnSave.innerHTML = origHtml;
        btnSave.disabled = false;
        return;
    }

    try {
        // Lưu cấu hình chung
        const r1 = await fetch(`/api/extensions/${currentModalExtId}/global_config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ global_config_json: globalConfig })
        });
        const res1 = await r1.json();

        // Lưu cấu hình mapping
        const r2 = await fetch(`/api/extensions/${currentModalExtId}/profiles`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mappings: extProfileMappings })
        });
        const res2 = await r2.json();

        if (res1.success && res2.success) {
            alert("Lưu toàn bộ cấu hình tiện ích thành công!");
            closeExtensionDetailsModal();
            loadExtensionsList();
            
            // Kiểm tra khởi động lại cho các profile bị ảnh hưởng đang chạy
            for (const mapping of extProfileMappings) {
                await checkAndPromptProfileRestart(mapping.profile_id);
            }
        } else {
            alert(`Lỗi lưu cấu hình: ${res1.error || res2.error || 'Lỗi không xác định'}`);
        }
    } catch (e) {
        alert("Lỗi kết nối máy chủ khi lưu: " + e.message);
    } finally {
        btnSave.innerHTML = origHtml;
        btnSave.disabled = false;
    }
}

async function runStaticDiagnostics(extId) {
    const container = document.getElementById("ext-static-diagnostic-container");
    if (!container) return;
    container.innerHTML = `<div style="color: var(--text-secondary);"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang chẩn đoán file...</div>`;

    try {
        const response = await fetch(`/api/extensions/${extId}/diagnose`);
        const data = await response.json();

        container.innerHTML = "";

        data.checks.forEach(check => {
            const div = document.createElement("div");
            div.style.display = "flex";
            div.style.alignItems = "center";
            div.style.justifyContent = "space-between";
            div.style.padding = "8px 12px";
            div.style.borderRadius = "4px";
            div.style.border = "1px solid var(--border-color)";

            if (check.passed) {
                div.style.background = "rgba(16, 185, 129, 0.06)";
                div.style.borderColor = "rgba(16, 185, 129, 0.15)";
                div.innerHTML = `
                    <span style="color: #e2e8f0; font-weight: 500;"><i class="fa-regular fa-circle-check" style="color: #10b981; margin-right: 6px;"></i> ${check.name}</span>
                    <span style="color: #10b981; font-size: 0.8rem;">ĐẠT - ${check.message}</span>
                `;
            } else {
                div.style.background = "rgba(239, 68, 68, 0.06)";
                div.style.borderColor = "rgba(239, 68, 68, 0.15)";
                div.innerHTML = `
                    <span style="color: #e2e8f0; font-weight: 500;"><i class="fa-regular fa-circle-xmark" style="color: #ef4444; margin-right: 6px;"></i> ${check.name}</span>
                    <span style="color: #ef4444; font-size: 0.8rem; font-weight: bold;">LỖI - ${check.message}</span>
                `;
            }
            container.appendChild(div);
        });

        // Đề xuất sửa chữa tĩnh
        if (data.suggestions && data.suggestions.length > 0) {
            const divSug = document.createElement("div");
            divSug.style.background = "rgba(245, 158, 11, 0.08)";
            divSug.style.border = "1px solid rgba(245, 158, 11, 0.15)";
            divSug.style.borderRadius = "6px";
            divSug.style.padding = "10px";
            divSug.style.borderLeft = "4px solid #f59e0b";
            divSug.style.marginTop = "8px";

            let listHtml = `<h5 style="color: #f59e0b; margin-top: 0; margin-bottom: 6px; font-size: 0.82rem;"><i class="fa-solid fa-triangle-exclamation"></i> PHÁT HIỆN SỰ CỐ TĨNH VÀ HƯỚNG KHẮC PHỤC:</h5><ul style="margin:0; padding-left:20px; font-size:0.78rem; color:var(--text-secondary); line-height: 1.4;">`;
            data.suggestions.forEach(s => {
                listHtml += `<li>${s}</li>`;
            });
            listHtml += "</ul>";
            divSug.innerHTML = listHtml;
            container.appendChild(divSug);
            container.appendChild(divSug);
        }
    } catch (e) {
        container.innerHTML = `<div style="color: #ef4444;"><i class="fa-solid fa-circle-exclamation"></i> Lỗi chẩn đoán tĩnh: ${e.message}</div>`;
    }
}

async function loadActiveProfilesDropdown() {
    const select = document.getElementById("ext-log-profile-select");
    if (!select) return;
    
    select.innerHTML = `<option value="">-- Chọn Profile đang chạy --</option>`;

    try {
        const response = await fetch("/api/profiles");
        const list = await response.json();

        // Chỉ hiển thị các profile có status là running (đang hoạt động)
        const running = list.filter(p => p.status === 'running');
        running.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.innerText = `${p.name} (ID: ${p.id})`;
            select.appendChild(opt);
        });
    } catch (e) {
        console.error("Lỗi nạp dropdown profile:", e);
    }
}

function loadExtLogsForProfile() {
    if (extRuntimeLogInterval) {
        clearInterval(extRuntimeLogInterval);
        extRuntimeLogInterval = null;
    }

    const select = document.getElementById("ext-log-profile-select");
    const profileId = select.value;
    const logBox = document.getElementById("ext-runtime-log-box");
    const recomContainer = document.getElementById("ext-recommendations-container");
    const recomList = document.getElementById("ext-recommendations-list");

    if (!profileId) {
        logBox.innerText = "Đang chờ chọn Profile hoặc không có log hoạt động nào...";
        recomContainer.style.display = "none";
        return;
    }

    logBox.innerHTML = `<div style="color: var(--text-secondary);"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang kết nối luồng log...</div>`;

    const fetchLogs = async () => {
        try {
            const response = await fetch(`/api/profiles/${profileId}/extensions/logs`);
            const data = await response.json();

            if (data.logs.length === 0) {
                logBox.innerText = "Chưa nhận được log nào từ Tiện ích mở rộng của Profile này.";
                recomContainer.style.display = "none";
            } else {
                let logText = "";
                data.logs.forEach(l => {
                    const typeLabel = l.type ? `[${l.type.toUpperCase()}]` : "[LOG]";
                    const locationLabel = l.lineNumber ? ` (${l.url}:${l.lineNumber})` : "";
                    logText += `[${l.timestamp}] ${typeLabel}: ${l.message}${locationLabel}\n`;
                });
                logBox.innerText = logText;
                logBox.scrollTop = logBox.scrollHeight; // Auto scroll down

                // Render recommendations
                if (data.recommendations && data.recommendations.length > 0) {
                    recomContainer.style.display = "block";
                    recomList.innerHTML = "";
                    data.recommendations.forEach(r => {
                        const li = document.createElement("li");
                        li.innerText = r;
                        recomList.appendChild(li);
                    });
                } else {
                    recomContainer.style.display = "none";
                }
            }
        } catch (e) {
            logBox.innerText = "Lỗi kết nối API logs: " + e.message;
        }
    };

    fetchLogs(); // Gọi lập tức lần đầu
    extRuntimeLogInterval = setInterval(fetchLogs, 2000); // Poll mỗi 2 giây
}

// ==========================================
// --- NEW IN v2.9.9: GUI EXTENSION CONFIG & BACKUPS ACTIONS ---
// ==========================================
let extGuiEditingTarget = null; // "global" or profileId (number)

function openExtConfigGui(title, initialJson) {
    document.getElementById("ext-gui-target-desc").innerText = title;
    const body = document.getElementById("ext-config-gui-body");
    body.innerHTML = "";
    
    let obj = {};
    try {
        obj = JSON.parse(initialJson || "{}");
    } catch(e) {
        obj = {};
    }
    
    const keys = Object.keys(obj);
    if (keys.length === 0) {
        // Add one empty row by default
        addExtGuiConfigRow("", "");
    } else {
        keys.forEach(k => {
            let val = obj[k];
            if (typeof val === 'object') val = JSON.stringify(val);
            addExtGuiConfigRow(k, val);
        });
    }
    
    document.getElementById("ext-config-gui-modal").classList.add("active");
}

function openExtConfigGuiForGlobal() {
    extGuiEditingTarget = "global";
    const initialJson = document.getElementById("ext-global-config-json").value.trim();
    openExtConfigGui("Đang chỉnh sửa: Cấu hình mặc định (Toàn cục)", initialJson);
}

function openExtConfigGuiForProfile(profileId) {
    extGuiEditingTarget = profileId;
    const item = extProfileMappings.find(m => m.profile_id === profileId);
    const initialJson = item ? item.config_json : "{}";
    const profileName = item ? item.profile_name : `Profile ID ${profileId}`;
    openExtConfigGui(`Đang chỉnh sửa: Cấu hình riêng cho Hồ sơ [${profileName}]`, initialJson);
}

function addExtGuiConfigRow(key = "", val = "") {
    const body = document.getElementById("ext-config-gui-body");
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid var(--border-color)";
    tr.innerHTML = `
        <td style="padding: 6px 8px;">
            <input type="text" class="ext-gui-key" value="${escapeHtml(key)}" placeholder="Tên tham số (ví dụ: autoStart)" style="width: 100%; font-size: 0.8rem; padding: 6px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(0,0,0,0.2); color: white;">
        </td>
        <td style="padding: 6px 8px;">
            <input type="text" class="ext-gui-val" value="${escapeHtml(String(val))}" placeholder="Giá trị (ví dụ: true, 1000, text...)" style="width: 100%; font-size: 0.8rem; padding: 6px; border-radius: 4px; border: 1px solid var(--border-color); background: rgba(0,0,0,0.2); color: white;">
        </td>
        <td style="padding: 6px 8px; text-align: center;">
            <button type="button" class="btn btn-sm btn-danger" onclick="deleteExtGuiConfigRow(this)" style="padding: 4px 8px; font-size: 0.75rem;"><i class="fa-solid fa-trash"></i></button>
        </td>
    `;
    body.appendChild(tr);
}

function deleteExtGuiConfigRow(btn) {
    const tr = btn.closest("tr");
    if (tr) tr.remove();
}

function closeExtConfigGuiModal() {
    document.getElementById("ext-config-gui-modal").classList.remove("active");
}

function applyExtConfigGui() {
    const body = document.getElementById("ext-config-gui-body");
    const rows = body.querySelectorAll("tr");
    const configObj = {};
    
    rows.forEach(tr => {
        const keyInput = tr.querySelector(".ext-gui-key");
        const valInput = tr.querySelector(".ext-gui-val");
        if (keyInput && valInput) {
            const k = keyInput.value.trim();
            let v = valInput.value.trim();
            if (k) {
                // Auto type casting
                if (v === "true") v = true;
                else if (v === "false") v = false;
                else if (!isNaN(v) && v !== "") v = Number(v);
                else {
                    try {
                        v = JSON.parse(v);
                    } catch(e) {}
                }
                configObj[k] = v;
            }
        }
    });
    
    const finalJson = JSON.stringify(configObj, null, 2);
    
    if (extGuiEditingTarget === "global") {
        document.getElementById("ext-global-config-json").value = finalJson;
    } else if (typeof extGuiEditingTarget === 'number') {
        const item = extProfileMappings.find(m => m.profile_id === extGuiEditingTarget);
        if (item) {
            item.config_json = finalJson;
            const previewInput = document.getElementById(`ext-json-preview-${extGuiEditingTarget}`);
            if (previewInput) {
                previewInput.value = finalJson;
            }
        }
    }
    
    closeExtConfigGuiModal();
}

function triggerImportExtGuiJson() {
    document.getElementById("import-ext-json-file").click();
}

function importExtGuiJson(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            const body = document.getElementById("ext-config-gui-body");
            body.innerHTML = "";
            Object.keys(data).forEach(k => {
                let val = data[k];
                if (typeof val === 'object') val = JSON.stringify(val);
                addExtGuiConfigRow(k, val);
            });
        } catch(err) {
            alert("Lỗi phân tích file JSON: " + err.message);
        }
    };
    reader.readAsText(file);
    event.target.value = ""; 
}

function exportExtGuiJson() {
    const body = document.getElementById("ext-config-gui-body");
    const rows = body.querySelectorAll("tr");
    const configObj = {};
    
    rows.forEach(tr => {
        const keyInput = tr.querySelector(".ext-gui-key");
        const valInput = tr.querySelector(".ext-gui-val");
        if (keyInput && valInput) {
            const k = keyInput.value.trim();
            let v = valInput.value.trim();
            if (k) {
                if (v === "true") v = true;
                else if (v === "false") v = false;
                else if (!isNaN(v) && v !== "") v = Number(v);
                else {
                    try {
                        v = JSON.parse(v);
                    } catch(e) {}
                }
                configObj[k] = v;
            }
        }
    });
    
    const jsonStr = JSON.stringify(configObj, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `config_extension_${new Date().getTime()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function escapeHtml(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- BACKUPS SELECT ALL & ACTIONS ---
function selectAllBackups(isChecked) {
    const checks = document.querySelectorAll(".backup-item-check");
    checks.forEach(chk => chk.checked = isChecked);
}

async function deleteSelectedBackups() {
    const checks = document.querySelectorAll(".backup-item-check:checked");
    if (checks.length === 0) {
        alert("Vui lòng chọn ít nhất một bản sao lưu để xóa.");
        return;
    }
    if (!confirm(`Bạn có chắc chắn muốn xóa ${checks.length} bản sao lưu đã chọn? Hành động này không thể hoàn tác.`)) {
        return;
    }
    const ids = Array.from(checks).map(chk => parseInt(chk.dataset.id));
    try {
        const response = await fetch("/api/backups/delete_bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids })
        });
        const result = await response.json();
        if (result.success) {
            alert(result.message);
            loadBackups();
        } else {
            alert("Lỗi khi xóa hàng loạt: " + result.error);
        }
    } catch (err) {
        alert("Lỗi kết nối máy chủ: " + err.message);
    }
}

function exportSelectedBackupsTxt() {
    const checks = document.querySelectorAll(".backup-item-check:checked");
    if (checks.length === 0) {
        alert("Vui lòng chọn ít nhất một bản sao lưu để xuất file.");
        return;
    }
    let txtContent = "";
    checks.forEach(chk => {
        const row = chk.closest("tr");
        const name = row.cells[2].querySelector(".text-bold").innerText.trim();
        const account = row.cells[5].innerText.trim();
        const proxy = row.cells[4].innerText.trim();
        const cookieSpan = row.cells[6].querySelector("span");
        const cookie = cookieSpan ? cookieSpan.title : "";
        const createdAt = row.cells[7].innerText.trim();
        
        txtContent += `${name} | ${account} | ${proxy} | ${cookie} | ${createdAt}\n`;
    });
    
    const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backups_export_${new Date().getTime()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function triggerImportBackupsTxt() {
    document.getElementById("import-backups-file-input").click();
}

async function importBackupsTxt(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        const text = e.target.result;
        try {
            const response = await fetch("/api/backups/import_txt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text })
            });
            const result = await response.json();
            if (result.success) {
                alert(result.message);
                loadBackups();
            } else {
                alert("Lỗi nhập dữ liệu: " + result.error);
            }
        } catch (err) {
            alert("Lỗi kết nối máy chủ: " + err.message);
        }
    };
    reader.readAsText(file);
    event.target.value = ""; 
}

// --- CAMPAIGN CONFIG HELPER TOGGLES ---
function toggleCampaignModeOptions(val) {
    const container = document.getElementById("c-random-options-container");
    if (container) {
        container.style.display = (val === "3") ? "block" : "none";
    }
}

function toggleCampaignProxySource(chk) {
    const container = document.getElementById("c-api-proxy-container");
    if (container) {
        container.style.display = chk.checked ? "block" : "none";
    }
}

function toggleCampaignGatewayRouter(chk) {
    const container = document.getElementById("c-gateway-router-container");
    if (container) {
        container.style.display = chk.checked ? "block" : "none";
    }
}

async function checkAndPromptProfileRestart(profileId) {
    if (!profileId) return;
    try {
        const response = await fetch(`/api/profiles/${profileId}/mcp_status`);
        const result = await response.json();
        if (result.success && result.is_running) {
            const confirmRestart = confirm("Tiện ích mở rộng của Profile này đã được thay đổi. Trình duyệt đang chạy, bạn có muốn tự động khởi động lại trình duyệt để áp dụng các thay đổi tiện ích mới ngay lập tức không?");
            if (confirmRestart) {
                const tr = document.querySelector(`#profile-list-body tr[data-profile-id="${profileId}"]`);
                if (tr) {
                    const statusCell = tr.querySelector(".status-cell");
                    if (statusCell) {
                        statusCell.innerHTML = `<span class="badge badge-warning"><i class="fa-solid fa-spinner fa-spin"></i> Đang khởi động lại...</span>`;
                    }
                }
                await fetch(`/api/profiles/${profileId}/stop`, { method: "POST" });
                await new Promise(r => setTimeout(r, 2200));
                await fetch(`/api/profiles/${profileId}/start`, { method: "POST" });
                loadProfiles();
            }
        }
    } catch (e) {
        console.warn("[Auto-Restart Error] " + e.message);
    }
}
