const express = require('express');
const router = express.Router();
const path = require('path');
const PuppeteerAutomationController = require('./puppeteer_automation_controller');

let activeController = null;
let currentStatus = 'stopped'; // stopped, booting, running
let targetUrl = '';
let mockedLocation = 'N/A';
let activeProfile = 'Custom Settings';

// Lưu trữ tạm các logs để khách hàng mới kết nối vẫn đọc được lịch sử gần nhất
let recentLogs = [];

function addLogToHistory(log) {
    recentLogs.push(log);
    if (recentLogs.length > 200) {
        recentLogs.shift();
    }
}

// Lưu trữ tất cả clients đang kết nối SSE
let sseClients = [];

function broadcastLog(log) {
    addLogToHistory(log);
    sseClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(log)}\n\n`);
    });
}

function broadcastStatusUpdate() {
    const statusData = {
        status: currentStatus,
        targetUrl,
        mockedLocation,
        activeProfile
    };
    sseClients.forEach(client => {
        client.res.write(`event: status\ndata: ${JSON.stringify(statusData)}\n\n`);
    });
}

// Tuyến đường GET để truy cập trang giao diện điều khiển chính
router.get('/automation', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'automation_dashboard.html'));
});

// Tuyến đường phục vụ luồng Server-Sent Events (SSE) để truyền logs và status liên tục
router.get('/api/automation/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Gửi headers ngay lập tức

    const clientId = Date.now();
    sseClients.push({ id: clientId, res });

    // Gửi lịch sử logs gần đây và trạng thái hiện tại ngay khi client kết nối
    recentLogs.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    const statusData = {
        status: currentStatus,
        targetUrl,
        mockedLocation,
        activeProfile
    };
    res.write(`event: status\ndata: ${JSON.stringify(statusData)}\n\n`);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

// Tuyến đường khởi động tự động hóa
router.post('/api/automation/start', async (req, res) => {
    const { settings, steps } = req.body;

    if (currentStatus !== 'stopped') {
        return res.status(400).json({ success: false, error: 'Động cơ tự động hóa đang hoạt động. Vui lòng dừng trước.' });
    }

    currentStatus = 'booting';
    targetUrl = settings.targetUrl || 'http://127.0.0.1:5000';
    
    const lat = parseFloat(settings.latitude);
    const lon = parseFloat(settings.longitude);
    mockedLocation = (!isNaN(lat) && !isNaN(lon)) ? `${lat}, ${lon}` : 'Local IP / GPS';
    activeProfile = settings.devicePreset === 'iphone' ? 'Apple iPhone 14' : 
                    settings.devicePreset === 'android' ? 'Samsung Galaxy S22' : 'Desktop Windows';
    
    // Gửi thông báo trạng thái đang khởi tạo
    broadcastStatusUpdate();
    recentLogs = []; // Reset logs cho đợt chạy mới

    try {
        activeController = new PuppeteerAutomationController();
        
        // Lắng nghe sự kiện log từ controller và broadcast tới giao diện
        activeController.on('log', (logData) => {
            broadcastLog(logData);
        });

        // Kích hoạt chạy ngầm tự động hóa để không khóa request HTTP
        (async () => {
            currentStatus = 'running';
            broadcastStatusUpdate();

            const CHROME_PATH = "c:\\Users\\Ok_duoc\\Desktop\\ChromiumPortable\\App\\Chromium\\64\\chrome.exe";
            settings.chromePath = CHROME_PATH; // Sử dụng chromium portable của dự án
            
            await activeController.runAutomation(settings, steps);
            
            // Tự động chuyển về trạng thái stopped khi hoàn thành
            currentStatus = 'stopped';
            broadcastStatusUpdate();
            activeController = null;
        })().catch(err => {
            currentStatus = 'stopped';
            broadcastStatusUpdate();
            activeController = null;
        });

        res.json({ success: true, message: 'Đang khởi chạy trình duyệt tự động hóa...' });
    } catch (e) {
        currentStatus = 'stopped';
        broadcastStatusUpdate();
        activeController = null;
        res.status(500).json({ success: false, error: `Khởi chạy lỗi: ${e.message}` });
    }
});

// Tuyến đường dừng cưỡng chế tự động hóa
router.post('/api/automation/stop', async (req, res) => {
    if (!activeController) {
        currentStatus = 'stopped';
        broadcastStatusUpdate();
        return res.json({ success: true, message: 'Động cơ đã ở trạng thái tắt.' });
    }

    try {
        await activeController.stop();
        currentStatus = 'stopped';
        broadcastStatusUpdate();
        activeController = null;
        res.json({ success: true, message: 'Đã dừng cưỡng chế trình duyệt và giải phóng bộ nhớ.' });
    } catch (e) {
        res.status(500).json({ success: false, error: `Lỗi khi dừng: ${e.message}` });
    }
});

// Tuyến đường xóa nhật ký
router.post('/api/automation/clear-logs', (req, res) => {
    recentLogs = [];
    broadcastLog({
        timestamp: new Date().toLocaleTimeString(),
        module: 'SYSTEM',
        type: 'INFO',
        message: 'Bảng nhật ký đã được làm sạch.'
    });
    res.json({ success: true });
});

module.exports = router;
