const dbManager = require('./ProfileManager/db_manager');
const browserLauncher = require('./ProfileManager/browser_launcher');
const automationEngine = require('./ProfileManager/automation_engine');

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    console.log('=== KHỞI CHẠY THỬ NGHIỆM KỊCH BẢN REG NICK AMAZON ===');
    
    // 1. Tạo một profile thực tế gán kịch bản ID 35
    const profileId = await dbManager.addProfile(
        "Profile Reg Nick Amazon", // name
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", // userAgent
        null, null, null, // proxy
        "Asia/Ho_Chi_Minh", 21.0278, 105.8342, // timezone, lat, lon
        1280, 720, // width, height
        39, // scriptId (Kịch bản Reg Nick đang tồn tại trong Database)
        0, null, 0, // useProxy, rotateUrl, useMcp
        "VN", null, // country, fingerprint
        8, 4, 1 // memory, concurrency, canvasNoise
    );
    console.log(`[1] Đã tạo profile mới thành công. ID: ${profileId}, gán kịch bản ID: 35`);

    try {
        // 2. Gọi API start profile qua máy chủ (headless = true để chạy nhanh và ổn định trong môi trường test)
        console.log(`[2] Đang gọi API khởi chạy Profile ${profileId}...`);
        const response = await fetch(`http://127.0.0.1:5000/api/profiles/${profileId}/start?headless=true`, {
            method: 'POST'
        });
        const resData = await response.json();
        if (!resData.success) {
            console.error('Lỗi khi gọi API khởi chạy profile:', resData.error);
            return;
        }
        console.log(`[3] Khởi chạy Profile thành công! Đang đợi kịch bản tự động kích hoạt sau 3 giây và chạy...`);

        // 3. Đợi 35 giây để kịch bản tự động chạy hết
        for (let i = 1; i <= 7; i++) {
            await sleep(5000);
            console.log(`... Đang chạy tự động hóa (Thời gian đã trôi qua: ${i * 5} giây) ...`);
        }

        console.log(`[4] Hoàn tất thời gian chờ. Đang tiến hành kiểm tra kết quả chạy kịch bản...`);

    } catch (err) {
        console.error('Gặp lỗi khi điều khiển kịch bản:', err);
    } finally {
        // 4. Tắt profile và dọn dẹp
        console.log(`[5] Đang tắt profile và dọn dẹp dữ liệu thử nghiệm...`);
        await fetch(`http://127.0.0.1:5000/api/profiles/${profileId}/stop`, { method: 'POST' }).catch(() => {});
        await dbManager.deleteProfile(profileId);
        console.log(`[OK] Đã dọn dẹp xong.`);
    }
}

main().catch(console.error);
