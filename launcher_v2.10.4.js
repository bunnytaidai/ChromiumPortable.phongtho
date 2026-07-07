/**
 * TRÌNH KHỞI CHẠY HỆ THỐNG CHROMIUM PORTABLE v2.10.4
 * Quản lý khởi động đồng thời các máy chủ dịch vụ Node.js trên Windows.
 * Tự động dọn dẹp RAM, giải phóng cổng mạng bị chiếm dụng và gộp log tập trung.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT_DIR = __dirname;
const PROFILE_MANAGER_DIR = path.join(ROOT_DIR, 'ProfileManager');
const MAIL_MANAGER_DIR = path.join(ROOT_DIR, 'MailManager');

console.log('======================================================================');
console.log('         TRÌNH KHỞI CHẠY TỰ ĐỘNG CHROMIUM PORTABLE v2.10.4');
console.log('======================================================================\n');

// 1. Hàm kiểm tra và cài đặt node_modules tự động
function checkAndInstallDependencies(dir, name) {
    const nodeModulesPath = path.join(dir, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        console.log(`[*] Thư mục thư viện (node_modules) của ${name} không tồn tại.`);
        console.log(`[*] Đang tiến hành chạy 'npm install' cho ${name}... Vui lòng đợi...`);
        try {
            execSync('npm install', { cwd: dir, stdio: 'inherit' });
            console.log(`[OK] Cài đặt thư viện cho ${name} thành công!\n`);
        } catch (e) {
            console.error(`[LỖI] Không thể cài đặt thư viện cho ${name}: ${e.message}\n`);
        }
    } else {
        console.log(`[OK] Thư viện của ${name} đã sẵn sàng.`);
    }
}

// 2. Hàm giải phóng cổng mạng (Port) bị chiếm dụng trên Windows
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
                console.log(`[*] Phát hiện tiến trình PID ${pid} đang chiếm dụng cổng ${port}. Đang giải phóng...`);
                execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
                console.log(`[OK] Đã giải phóng cổng ${port}.`);
            } catch (e) {}
        });
    } catch (e) {
        // Cổng không bị chiếm dụng, bỏ qua
    }
}

// 3. Tiến trình con lưu trữ
const runningProcesses = [];

// 4. Hàm khởi chạy máy chủ con
function startServer(dir, scriptPath, name, colorCode) {
    console.log(`[*] Đang khởi động máy chủ ${name}...`);
    
    // Khởi chạy tiến trình Node.js con
    const proc = spawn('node', [scriptPath], { 
        cwd: dir,
        shell: true
    });

    runningProcesses.push({ process: proc, name: name });

    // Hướng luồng logs chuẩn ra console chính
    proc.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                console.log(`\x1b[${colorCode}m[${name}]\x1b[0m ${line}`);
            }
        });
    });

    // Hướng luồng logs lỗi ra console chính
    proc.stderr.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                console.error(`\x1b[31m[${name} ERROR]\x1b[0m ${line}`);
            }
        });
    });

    proc.on('close', (code) => {
        console.log(`\x1b[33m[Hệ thống] Máy chủ ${name} đã kết thúc với mã thoát: ${code}\x1b[0m`);
    });

    return proc;
}

// 5. Quy trình dọn dẹp khi tắt trình khởi chạy
function cleanupAll() {
    console.log('\n[Hệ thống] Đang tắt sạch các máy chủ dịch vụ chạy ngầm...');
    runningProcesses.forEach(item => {
        if (item.process) {
            try {
                // Trên Windows, sử dụng taskkill để tắt triệt để cây tiến trình con
                execSync(`taskkill /PID ${item.process.pid} /T /F`, { stdio: 'ignore' });
                console.log(`[OK] Đã dừng máy chủ ${item.name}.`);
            } catch (e) {
                try {
                    item.process.kill('SIGTERM');
                } catch (err) {}
            }
        }
    });
    
    // Giải phóng triệt để RAM và các tiến trình chrome.exe/chrome-devtools-mcp
    try {
        execSync('taskkill /f /im chrome.exe', { stdio: 'ignore' });
        console.log('[OK] Đã dọn dẹp các trình duyệt Chromium chạy ngầm.');
    } catch (e) {}

    try {
        // Cưỡng chế dừng tất cả tiến trình npx chạy mcp server
        execSync('wmic process where "commandline like \'%chrome-devtools-mcp%\'" delete', { stdio: 'ignore' });
        console.log('[OK] Đã dọn dẹp sạch các tiến trình MCP Server chạy ngầm.');
    } catch (e) {}

    console.log('[OK] Toàn bộ hệ thống đã được tắt an toàn.');
    process.exit(0);
}

// Lắng nghe các tín hiệu tắt tiến trình để tự động dọn dẹp
process.on('SIGINT', cleanupAll); // Khi nhấn Ctrl+C
process.on('SIGTERM', cleanupAll); // Khi nhận tín hiệu tắt từ hệ thống
process.on('exit', cleanupAll);

// BẮT ĐẦU CHẠY QUY TRÌNH KHỞI ĐỘNG
(async () => {
    // Bước A: Kiểm tra node_modules
    console.log('\n>>> BƯỚC 1: KIỂM TRA TOÀN VẸN THƯ VIỆN...');
    checkAndInstallDependencies(PROFILE_MANAGER_DIR, 'Profile Manager');
    checkAndInstallDependencies(MAIL_MANAGER_DIR, 'Mail Manager');

    // Bước B: Dọn dẹp cổng mạng
    console.log('\n>>> BƯỚC 2: DỌN DẸP VÀ GIẢI PHÓNG CỔNG MẠNG...');
    killProcessOnPort(5000);
    killProcessOnPort(5001);
    
    // Tạm dừng 1 giây để cổng được giải phóng hoàn toàn
    await new Promise(r => setTimeout(r, 1000));

    // Bước C: Khởi chạy 2 máy chủ con
    console.log('\n>>> BƯỚC 3: KHỞI CHẠY CÁC MÁY CHỦ DỊCH VỤ...');
    // Màu 32: Xanh lá (Green) cho Profile Manager
    startServer(PROFILE_MANAGER_DIR, 'app.js', 'Profile Manager', '32');
    // Màu 36: Xanh lam (Cyan) cho Mail Manager
    startServer(MAIL_MANAGER_DIR, 'app.js', 'Mail Manager', '36');

    // Bước D: Mở trang Dashboard trên trình duyệt sau 3 giây
    console.log('\n>>> BƯỚC 4: KHỞI CHẠY BẢNG ĐIỀU KHIỂN...');
    setTimeout(() => {
        console.log('[Hệ thống] Đang tự động mở Bảng điều khiển trên trình duyệt của bạn...');
        try {
            // Mở trình duyệt mặc định trên Windows
            const openCmd = process.platform === 'win32' ? 'start' : 'open';
            require('child_process').exec(`${openCmd} http://127.0.0.1:5000`);
            console.log('[OK] Đã gửi lệnh mở URL: http://127.0.0.1:5000');
        } catch (e) {
            console.warn('[Cảnh báo] Không thể tự động mở trình duyệt. Vui lòng mở thủ công: http://127.0.0.1:5000');
        }
        console.log('\n[!] Nhấn giữ Ctrl+C trong cửa sổ CMD này để TẮT HOÀN TOÀN toàn bộ hệ thống dự án.');
        console.log('----------------------------------------------------------------------');
    }, 3000);
})();
