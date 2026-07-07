// CHƯƠNG TRÌNH ĐIỀU KHIỂN GIAO DIỆN CHÍNH (MAIN FRONTEND CONTROLLER)

let emailsList = [];
let selectedEmail = null;
let systemSettings = {};
let expiryTimer = null;
let autoRefreshMessagesTimer = null;
let currentTunnelStatus = "disconnected"; // disconnected, downloading, connecting, connected, error

document.addEventListener('DOMContentLoaded', () => {
    // Khởi tạo hệ thống
    initApp();

    // Thiết lập các trình lắng nghe sự kiện
    setupEventListeners();
});

// --- KHỞI TẠO & TẢI DỮ LIỆU ---

async function initApp() {
    await loadSettings();
    await loadEmailsList();
    await checkTunnelStatus(); // Kiểm tra trạng thái Tunnel lúc đầu
    
    // Tự động cập nhật thời gian đếm ngược mỗi giây
    startExpiryCountdown();
    
    // Tự động làm mới danh sách tin nhắn mỗi 3 giây
    startAutoRefreshMessages();
    
    // Tự động kiểm tra trạng thái Tunnel mỗi 2 giây để cập nhật UI
    setInterval(checkTunnelStatus, 2000);
}

async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const json = await res.json();
        if (json.success) {
            systemSettings = json.data;
            // Cập nhật text hiển thị đuôi domain trong Custom Mail modal
            document.getElementById('custom-domain-addon').innerText = `@${systemSettings.domain || 'yourdomain.com'}`;
        }
    } catch (e) {
        console.error('Lỗi khi tải cấu hình:', e);
    }
}

async function loadEmailsList(selectAddress = null) {
    try {
        const res = await fetch('/api/emails');
        const json = await res.json();
        if (json.success) {
            emailsList = json.data;
            renderEmailsList();
            
            // Nếu có chỉ định chọn email cụ thể, hoặc chọn email đầu tiên trong danh sách
            if (selectAddress) {
                selectEmailCard(selectAddress);
            } else if (selectedEmail) {
                // Giữ lựa chọn hiện tại nếu nó vẫn tồn tại trong danh sách
                const exists = emailsList.some(e => e.address === selectedEmail.address);
                if (exists) {
                    const updated = emailsList.find(e => e.address === selectedEmail.address);
                    selectedEmail = updated;
                    updateActiveMailPanel();
                } else {
                    deselectEmail();
                }
            }
        }
    } catch (e) {
        console.error('Lỗi khi tải danh sách email:', e);
    }
}

// --- KIỂM TRA & CẬP NHẬT TRẠNG THÁI CLOUDFLARE TUNNEL ---

async function checkTunnelStatus() {
    try {
        const res = await fetch('/api/tunnel/status');
        const json = await res.json();
        if (json.success) {
            currentTunnelStatus = json.status;
            updateTunnelUI(json.status, json.url, json.error);
        }
    } catch (e) {
        console.error('Lỗi kiểm tra trạng thái Tunnel:', e);
    }
}

function updateTunnelUI(status, url, error) {
    const statusVal = document.getElementById('tunnel-status-val');
    const btnToggle = document.getElementById('btn-toggle-tunnel');
    const urlContainer = document.getElementById('tunnel-url-container');
    const urlVal = document.getElementById('tunnel-url-val');
    
    // Xóa tất cả class cũ của text trạng thái
    statusVal.className = '';
    
    if (status === 'disconnected') {
        statusVal.innerText = 'Đã tắt';
        statusVal.classList.add('status-disconnected');
        btnToggle.disabled = false;
        btnToggle.innerHTML = `<i class="fa-solid fa-play"></i> Bật kết nối`;
        urlContainer.style.display = 'none';
    } else if (status === 'downloading') {
        statusVal.innerText = 'Đang tải cloudflared...';
        statusVal.classList.add('status-downloading');
        btnToggle.disabled = true;
        btnToggle.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang tải`;
        urlContainer.style.display = 'none';
    } else if (status === 'connecting') {
        statusVal.innerText = 'Đang kết nối...';
        statusVal.classList.add('status-connecting');
        btnToggle.disabled = true;
        btnToggle.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Kết nối`;
        urlContainer.style.display = 'none';
    } else if (status === 'connected') {
        statusVal.innerText = 'Đang chạy';
        statusVal.classList.add('status-connected');
        btnToggle.disabled = false;
        btnToggle.innerHTML = `<i class="fa-solid fa-stop"></i> Tắt kết nối`;
        
        urlContainer.style.display = 'inline-flex';
        urlVal.innerText = url;
        urlVal.title = url;
    } else if (status === 'error') {
        statusVal.innerText = 'Lỗi kết nối';
        statusVal.classList.add('status-error');
        btnToggle.disabled = false;
        btnToggle.innerHTML = `<i class="fa-solid fa-play"></i> Thử lại`;
        urlContainer.style.display = 'none';
        if (error) {
            statusVal.title = error; // Rê chuột vào sẽ hiện chi tiết lỗi
        }
    }
}

// --- HIỂN THỊ CÁC THẺ EMAIL CỘT TRÁI ---

function renderEmailsList() {
    const container = document.getElementById('email-list-container');
    container.innerHTML = '';
    
    if (emailsList.length === 0) {
        container.innerHTML = `<div class="empty-state">Chưa có email nào được tạo. Hãy nhấn "Tạo nhanh" hoặc "Tạo tùy chỉnh" phía trên!</div>`;
        return;
    }
    
    emailsList.forEach(email => {
        const card = document.createElement('div');
        card.className = `email-card ${selectedEmail && selectedEmail.address === email.address ? 'selected' : ''}`;
        card.dataset.address = email.address;
        
        // Trạng thái badge hiển thị
        let statusText = 'Hoạt động';
        let statusClass = 'active';
        if (email.status === 'inactive') {
            statusText = 'Tắt';
            statusClass = 'inactive';
        } else if (email.status === 'keep') {
            statusText = 'Giữ mail';
            statusClass = 'keep';
        }
        
        // Tính toán đếm ngược thời gian
        const remainingStr = getRemainingTimeText(email);
        
        card.innerHTML = `
            <div class="email-card-header">
                <span class="status-indicator">
                    <span class="status-dot ${statusClass}"></span>
                    <span>${statusText}</span>
                </span>
                <div class="card-actions-quick" onclick="event.stopPropagation()">
                    <button class="btn-icon-sm" onclick="toggleEmailStatusQuick('${email.address}', '${email.status}')" title="Bật/Tắt kích hoạt">
                        <i class="fa-solid ${email.status === 'inactive' ? 'fa-play' : 'fa-pause'}"></i>
                    </button>
                    <button class="btn-icon-sm delete" onclick="deleteEmailQuick('${email.address}')" title="Xóa">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </div>
            </div>
            <div class="email-card-address">${email.address}</div>
            <div class="email-card-footer">
                <span class="expiry-countdown">
                    <i class="fa-regular fa-clock"></i>
                    <span class="countdown-val">${remainingStr}</span>
                </span>
                <span>${email.locked_by ? `<i class="fa-solid fa-robot" title="Đang liên kết với: ${email.locked_by}"></i> API` : ''}</span>
            </div>
        `;
        
        card.addEventListener('click', () => {
            selectEmailCard(email.address);
        });
        
        container.appendChild(card);
    });
}

function selectEmailCard(address) {
    const email = emailsList.find(e => e.address === address);
    if (!email) return;
    
    selectedEmail = email;
    
    // Cập nhật trạng thái class selected
    document.querySelectorAll('.email-card').forEach(card => {
        if (card.dataset.address === address) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    });
    
    // Hiển thị panel chi tiết bên phải
    document.getElementById('no-active-mail').style.display = 'none';
    document.getElementById('active-mail-details').style.display = 'flex';
    
    updateActiveMailPanel();
    loadActiveMailMessages();
}

function deselectEmail() {
    selectedEmail = null;
    document.getElementById('no-active-mail').style.display = 'flex';
    document.getElementById('active-mail-details').style.display = 'none';
}

// Cập nhật thông tin chi tiết hòm thư được chọn bên phải
function updateActiveMailPanel() {
    if (!selectedEmail) return;
    
    document.getElementById('current-email-address').innerText = selectedEmail.address;
    document.getElementById('compose-from').value = selectedEmail.address;
    
    // Nút Kích hoạt / Tắt kích hoạt
    const btnToggle = document.getElementById('btn-toggle-active');
    const toggleText = document.getElementById('toggle-status-text');
    if (selectedEmail.status === 'inactive') {
        btnToggle.className = 'control-btn btn-green deactivated';
        toggleText.innerText = 'Kích hoạt';
    } else {
        btnToggle.className = 'control-btn btn-green';
        toggleText.innerText = 'Tắt kích hoạt';
    }
    
    // Nút Giữ mail
    const btnKeep = document.getElementById('btn-keep-email');
    const keepText = document.getElementById('keep-status-text');
    if (selectedEmail.status === 'keep') {
        btnKeep.className = 'control-btn btn-orange kept';
        keepText.innerText = 'Bỏ giữ mail';
    } else {
        btnKeep.className = 'control-btn btn-orange';
        keepText.innerText = 'Giữ mail';
    }
    
    // Cập nhật thời gian đếm ngược
    document.getElementById('current-email-expiry').innerText = getRemainingTimeText(selectedEmail);
}

// Tải danh sách thư đến của hòm thư hiện tại
async function loadActiveMailMessages() {
    if (!selectedEmail) return;
    
    try {
        const res = await fetch(`/api/emails/${encodeURIComponent(selectedEmail.address)}/messages`);
        const json = await res.json();
        if (json.success) {
            renderMessagesList(json.data);
        }
    } catch (e) {
        console.error('Lỗi khi tải tin nhắn:', e);
    }
}

// Hiển thị danh sách thư trong bảng
function renderMessagesList(messages) {
    const tbody = document.getElementById('message-list-body');
    tbody.innerHTML = '';
    
    if (messages.length === 0) {
        tbody.innerHTML = `
            <tr class="no-messages-row">
                <td colspan="4" style="text-align: center; padding: 40px 10px;">
                    Không có tin nhắn trong hộp thư đến của bạn vào lúc này. Bạn có thể làm mới trang để kiểm tra lại.
                </td>
            </tr>
        `;
        return;
    }
    
    messages.forEach(msg => {
        const tr = document.createElement('tr');
        
        // Định dạng thời gian
        const date = new Date(msg.received_at);
        const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
        
        tr.innerHTML = `
            <td class="message-subject-cell">${escapeHtml(msg.subject || '(Không có tiêu đề)')}</td>
            <td class="message-sender-cell">${escapeHtml(msg.sender)}</td>
            <td class="otp-cell">
                ${msg.otp_code ? `<span class="otp-badge-inline">${msg.otp_code}</span>` : '<span style="color:#555;">-</span>'}
            </td>
            <td class="message-time-cell">${timeStr}</td>
        `;
        
        tr.addEventListener('click', () => {
            openViewMailModal(msg);
        });
        
        tbody.appendChild(tr);
    });
}

// --- TỰ ĐỘNG CẬP NHẬT GIAO DIỆN ĐỊNH KỲ ---

function startExpiryCountdown() {
    if (expiryTimer) clearInterval(expiryTimer);
    
    expiryTimer = setInterval(() => {
        let hasExpired = false;
        
        // Cập nhật hiển thị đếm ngược trên các card email bên trái
        document.querySelectorAll('.email-card').forEach(card => {
            const address = card.dataset.address;
            const email = emailsList.find(e => e.address === address);
            if (email) {
                const countdownVal = card.querySelector('.countdown-val');
                if (countdownVal) {
                    const text = getRemainingTimeText(email);
                    countdownVal.innerText = text;
                    if (text === 'Đã hết hạn') {
                        hasExpired = true;
                    }
                }
            }
        });
        
        // Cập nhật hiển thị đếm ngược của email chính bên phải
        if (selectedEmail) {
            document.getElementById('current-email-expiry').innerText = getRemainingTimeText(selectedEmail);
        }
        
        // Nếu có email hết hạn, tải lại danh sách sau 1 giây
        if (hasExpired) {
            setTimeout(() => {
                loadEmailsList();
            }, 1000);
        }
    }, 1000);
}

function startAutoRefreshMessages() {
    if (autoRefreshMessagesTimer) clearInterval(autoRefreshMessagesTimer);
    
    // Cứ 3 giây gọi API tải lại hòm thư nhận OTP tự động
    autoRefreshMessagesTimer = setInterval(() => {
        if (selectedEmail && selectedEmail.status !== 'inactive') {
            loadActiveMailMessages();
        }
    }, 3000);
}

// --- THIẾT LẬP SỰ KIỆN NÚT BẤM (EVENT LISTENERS) ---

function setupEventListeners() {
    // 0. Bật/Tắt Cloudflare Tunnel
    document.getElementById('btn-toggle-tunnel').addEventListener('click', async () => {
        const btn = document.getElementById('btn-toggle-tunnel');
        const nextState = (currentTunnelStatus === 'disconnected' || currentTunnelStatus === 'error');
        
        btn.disabled = true;
        if (nextState) {
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang bật...`;
            showNotification('Bắt đầu khởi chạy Cloudflare Tunnel...');
        } else {
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang tắt...`;
            showNotification('Đang ngắt kết nối Cloudflare Tunnel...');
        }
        
        try {
            const res = await fetch('/api/tunnel/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enable: nextState })
            });
            const json = await res.json();
            if (json.success) {
                await checkTunnelStatus();
                if (nextState) {
                    showNotification('Đang tiến hành kết nối! Sẽ có đường link sau vài giây.');
                } else {
                    showNotification('Đã tắt kết nối Cloudflare Tunnel.');
                }
            } else {
                alert('Điều khiển kết nối thất bại: ' + json.error);
            }
        } catch (err) {
            alert('Lỗi kết nối tới API Tunnel: ' + err.message);
        } finally {
            btn.disabled = false;
        }
    });

    // Copy URL Tunnel
    document.getElementById('btn-copy-tunnel-url').addEventListener('click', () => {
        const url = document.getElementById('tunnel-url-val').innerText;
        if (url) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => {
                    showNotification('Đã sao chép liên kết nhận mail công khai!');
                }).catch(() => {
                    fallbackCopyText(url);
                });
            } else {
                fallbackCopyText(url);
            }
        }
    });

    // 1. Tạo nhanh email ngẫu nhiên
    document.getElementById('btn-create-random').addEventListener('click', async () => {
        try {
            const res = await fetch('/api/emails/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const json = await res.json();
            if (json.success) {
                await loadEmailsList(json.address);
            }
        } catch (e) {
            alert('Lỗi tạo email ngẫu nhiên: ' + e.message);
        }
    });

    // 2. Tạo email tùy chỉnh (mở modal)
    document.getElementById('btn-create-custom').addEventListener('click', () => {
        document.getElementById('custom-prefix').value = '';
        openModal('modal-create-custom');
    });

    // Submit form tạo email tùy chỉnh
    document.getElementById('custom-email-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const prefix = document.getElementById('custom-prefix').value.trim();
        if (!prefix) return;

        try {
            const res = await fetch('/api/emails/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: prefix })
            });
            const json = await res.json();
            if (json.success) {
                closeModal('modal-create-custom');
                await loadEmailsList(json.address);
            }
        } catch (err) {
            alert('Lỗi khởi tạo email tùy chỉnh: ' + err.message);
        }
    });

    // 3. Sao chép email hiện tại
    const copyEmailFn = () => {
        if (!selectedEmail) return;
        const text = selectedEmail.address;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                showNotification('Đã sao chép địa chỉ email vào bộ nhớ tạm!');
            }).catch(() => {
                fallbackCopyText(text);
            });
        } else {
            fallbackCopyText(text);
        }
    };

    function fallbackCopyText(text) {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.top = "0";
        textArea.style.left = "0";
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            const successful = document.execCommand('copy');
            if (successful) {
                showNotification('Đã sao chép địa chỉ email!');
            } else {
                console.error('Không thể sao chép văn bản.');
            }
        } catch (err) {
            console.error('Lỗi khi sao chép: ', err);
        }
        document.body.removeChild(textArea);
    }

    document.getElementById('btn-copy-email').addEventListener('click', copyEmailFn);
    document.getElementById('btn-copy-address').addEventListener('click', copyEmailFn);

    // 4. Bật/Tắt kích hoạt email hiện tại
    document.getElementById('btn-toggle-active').addEventListener('click', async () => {
        if (!selectedEmail) return;
        const newStatus = selectedEmail.status === 'inactive' ? 'active' : 'inactive';
        await toggleEmailStatus(selectedEmail.address, newStatus);
    });

    // 5. Giữ email hiện tại (Keep)
    document.getElementById('btn-keep-email').addEventListener('click', async () => {
        if (!selectedEmail) return;
        const newStatus = selectedEmail.status === 'keep' ? 'active' : 'keep';
        await toggleEmailStatus(selectedEmail.address, newStatus);
    });

    // 6. Xóa email hiện tại
    document.getElementById('btn-delete-email').addEventListener('click', async () => {
        if (!selectedEmail) return;
        if (confirm(`Bạn chắc chắn muốn xóa hòm thư: ${selectedEmail.address} ? Việc này sẽ xóa toàn bộ tin nhắn liên quan.`)) {
            await deleteEmail(selectedEmail.address);
        }
    });

    // 7. Gia hạn email
    document.getElementById('btn-renew-email').addEventListener('click', async () => {
        if (!selectedEmail) return;
        try {
            const res = await fetch('/api/emails/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: selectedEmail.address, expires_in: 3600 })
            });
            const json = await res.json();
            if (json.success) {
                showNotification('Gia hạn hòm thư thành công thêm 60 phút!');
                await loadEmailsList(selectedEmail.address);
            }
        } catch (err) {
            alert('Lỗi gia hạn email: ' + err.message);
        }
    });

    // 8. Làm mới tin nhắn thủ công
    document.getElementById('btn-refresh-messages').addEventListener('click', () => {
        loadActiveMailMessages();
        showNotification('Đã làm mới hộp thư đến!');
    });

    // 9. Soạn thư (Gửi đi - Mở modal)
    document.getElementById('btn-compose-mail').addEventListener('click', () => {
        if (!selectedEmail) return;
        document.getElementById('compose-to').value = '';
        document.getElementById('compose-subject').value = '';
        document.getElementById('compose-text').value = '';
        openModal('modal-compose');
    });

    // Submit gửi email
    document.getElementById('compose-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!selectedEmail) return;

        const to = document.getElementById('compose-to').value.trim();
        const subject = document.getElementById('compose-subject').value.trim();
        const text = document.getElementById('compose-text').value.trim();
        const btnSubmit = document.getElementById('btn-submit-send');

        btnSubmit.disabled = true;
        btnSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi...`;

        try {
            const res = await fetch('/api/emails/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: selectedEmail.address, to, subject, text })
            });
            const json = await res.json();
            if (json.success) {
                closeModal('modal-compose');
                showNotification('Gửi thư đi thành công!');
            } else {
                alert('Gửi thư thất bại: ' + json.error);
            }
        } catch (err) {
            alert('Lỗi kết nối khi gửi thư: ' + err.message);
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.innerHTML = `<i class="fa-solid fa-share"></i> Gửi ngay`;
        }
    });

    // 10. Mở cài đặt cấu hình
    document.getElementById('btn-settings').addEventListener('click', async () => {
        await loadSettings();
        document.getElementById('setting-domain').value = systemSettings.domain || '';
        document.getElementById('setting-use-api-fallback').checked = systemSettings.use_api_fallback === '1';
        document.getElementById('setting-smtp-host').value = systemSettings.smtp_host || '';
        document.getElementById('setting-smtp-port').value = systemSettings.smtp_port || '587';
        document.getElementById('setting-smtp-user').value = systemSettings.smtp_user || '';
        document.getElementById('setting-smtp-pass').value = systemSettings.smtp_pass || '';
        openModal('modal-settings');
    });

    // Submit cài đặt
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const domain = document.getElementById('setting-domain').value.trim();
        const use_api_fallback = document.getElementById('setting-use-api-fallback').checked ? '1' : '0';
        const smtp_host = document.getElementById('setting-smtp-host').value.trim();
        const smtp_port = document.getElementById('setting-smtp-port').value.trim();
        const smtp_user = document.getElementById('setting-smtp-user').value.trim();
        const smtp_pass = document.getElementById('setting-smtp-pass').value.trim();

        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain, use_api_fallback, smtp_host, smtp_port, smtp_user, smtp_pass })
            });
            const json = await res.json();
            if (json.success) {
                closeModal('modal-settings');
                showNotification('Cấu hình hệ thống đã được lưu!');
                await initApp(); // Tải lại ứng dụng
            }
        } catch (err) {
            alert('Lỗi lưu cài đặt: ' + err.message);
        }
    });

    // --- Xử lý đóng mở Modal nói chung ---
    document.querySelectorAll('.close-modal, .close-modal-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.closest('.modal');
            if (modal) modal.style.display = 'none';
        });
    });

    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            e.target.style.display = 'none';
        }
    });
}

// --- CÁC HÀM BỔ TRỢ HÀNH ĐỘNG ---

async function toggleEmailStatus(address, status) {
    try {
        const res = await fetch('/api/emails/update-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, status })
        });
        const json = await res.json();
        if (json.success) {
            await loadEmailsList(address);
            showNotification(`Đã đổi trạng thái sang: ${status}`);
        }
    } catch (e) {
        alert('Lỗi cập nhật trạng thái: ' + e.message);
    }
}

async function deleteEmail(address) {
    try {
        const res = await fetch('/api/emails/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address })
        });
        const json = await res.json();
        if (json.success) {
            if (selectedEmail && selectedEmail.address === address) {
                deselectEmail();
            }
            await loadEmailsList();
            showNotification('Đã xóa hòm thư thành công.');
        }
    } catch (e) {
        alert('Lỗi khi xóa email: ' + e.message);
    }
}

// Thao tác nhanh bên cột trái
async function toggleEmailStatusQuick(address, currentStatus) {
    const nextStatus = currentStatus === 'inactive' ? 'active' : 'inactive';
    await toggleEmailStatus(address, nextStatus);
}

async function deleteEmailQuick(address) {
    if (confirm(`Bạn chắc chắn muốn xóa hòm thư: ${address} ?`)) {
        await deleteEmail(address);
    }
}

// Mở modal xem nội dung chi tiết bức thư
function openViewMailModal(msg) {
    document.getElementById('view-mail-subject').innerText = msg.subject || '(Không có tiêu đề)';
    document.getElementById('view-mail-from').innerText = msg.sender;
    document.getElementById('view-mail-to').innerText = msg.email_address;
    
    const date = new Date(msg.received_at);
    document.getElementById('view-mail-time').innerText = date.toLocaleString('vi-VN');
    
    // Hiển thị badge OTP nếu bóc tách được
    const otpBadge = document.getElementById('view-mail-otp-badge');
    if (msg.otp_code) {
        otpBadge.style.display = 'block';
        document.getElementById('view-mail-otp-val').innerText = msg.otp_code;
    } else {
        otpBadge.style.display = 'none';
    }
    
    // Ghi nội dung thư vào Iframe để cô lập CSS
    const iframe = document.getElementById('mail-content-iframe');
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    
    // Ưu tiên hiển thị HTML, nếu không có thì hiển thị Text thuần và tự xuống dòng
    if (msg.body_html) {
        doc.write(msg.body_html);
    } else {
        doc.write(`<pre style="font-family: inherit; white-space: pre-wrap; word-wrap: break-word; font-size: 13px; color: #333;">${escapeHtml(msg.body_text)}</pre>`);
    }
    doc.close();
    
    openModal('modal-view-mail');
}

// --- TIỆN ÍCH BỔ TRỢ (HELPERS) ---

function getRemainingTimeText(email) {
    if (email.status === 'keep') return 'Lưu giữ (Vô hạn)';
    
    const expiry = new Date(email.expires_at).getTime();
    const now = Date.now();
    const diff = expiry - now;
    
    if (diff <= 0) return 'Đã hết hạn';
    
    const totalSeconds = Math.floor(diff / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    return `${minutes} Phút ${seconds.toString().padStart(2, '0')} Giây`;
}

function openModal(id) {
    document.getElementById(id).style.display = 'flex';
}

// Ghi đè hàm closeModal cũ để đóng ngắt logic nếu cần
function closeModal(id) {
    document.getElementById(id).style.display = 'none';
}

function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

// Hiển thị thông báo nhỏ ở góc dưới màn hình (toast notification)
function showNotification(message) {
    // Xóa các thông báo cũ để tránh chồng chéo
    document.querySelectorAll('.toast-notification').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background-color: var(--bg-card-selected);
        color: var(--text-primary);
        border: 1px solid var(--color-blue);
        padding: 12px 20px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        box-shadow: var(--shadow-lg);
        z-index: 9999;
        display: flex;
        align-items: center;
        gap: 8px;
        opacity: 0;
        transform: translateY(20px);
        transition: all 0.3s cubic-bezier(0.68, -0.55, 0.27, 1.55);
    `;
    toast.innerHTML = `<i class="fa-solid fa-circle-check" style="color:var(--color-green);"></i> ${message}`;
    document.body.appendChild(toast);
    
    // Animation đi lên
    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    }, 10);
    
    // Biến mất sau 3 giây
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
