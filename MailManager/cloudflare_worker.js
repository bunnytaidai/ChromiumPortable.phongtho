/**
 * HƯỚNG DẪN CẤU HÌNH CLOUDFLARE WORKERS ĐỂ NHẬN EMAIL TỰ ĐỘNG
 * 
 * Bước 1: Truy cập vào trang quản trị Cloudflare của bạn.
 * Bước 2: Vào mục "Workers & Pages" -> Chọn "Create Application" -> Chọn "Create Worker".
 * Bước 3: Đặt tên cho Worker (ví dụ: mail-webhook) và bấm "Deploy".
 * Bước 4: Bấm "Edit Code", copy toàn bộ đoạn mã bên dưới và paste đè vào file worker.js của bạn.
 * Bước 5: Thay đổi đường dẫn WEBHOOK_URL ở dòng số 19 thành địa chỉ IP WAN của máy bạn (hoặc link Tunnel ngrok/cloudflared).
 *         Ví dụ: "http://113.161.x.x:5001/api/webhook/receive-email" hoặc "https://xxxxx.ngrok-free.app/api/webhook/receive-email"
 * Bước 6: Bấm "Save and deploy".
 * Bước 7: Vào mục tên miền của bạn trên Cloudflare -> Chọn "Email Routing" -> Chọn tab "Routes".
 * Bước 8: Ở phần "Catch-all address", bấm "Edit" -> Chọn Action là "Send to Worker" -> Chọn tên Worker bạn vừa tạo ở trên.
 * 
 * Hoàn tất! Từ bây giờ, bất kỳ email nào gửi tới tên miền của bạn sẽ tự động đi thẳng vào phần mềm của bạn.
 */

// Import thư viện phân tích email từ file cục bộ được upload cùng
import PostalMime from './postal_mime_esm.js';

// ĐƯỜNG DẪN WEBHOOK GỬI VỀ MÁY CỦA BẠN (CẦN THAY ĐỔI ĐỊA CHỈ NÀY)
const WEBHOOK_URL = "http://IP_CUA_BAN_HOAC_LINK_NGROK:5001/api/webhook/receive-email";

export default {
  async email(message, env, ctx) {
    try {
      // Đọc luồng dữ liệu email thô (raw MIME stream)
      const rawEmail = await new Response(message.raw).arrayBuffer();
      
      // Phân tích cấu trúc thư
      const parser = new PostalMime();
      const parsed = await parser.parse(rawEmail);
      
      // Tạo dữ liệu gửi đi dạng JSON sạch sẽ
      const payload = {
        from: message.from,
        to: message.to,
        subject: parsed.subject || "",
        html: parsed.html || "",
        text: parsed.text || parsed.html ? stripHtml(parsed.html) : ""
      };
      
      // Gửi dữ liệu về máy chủ Node.js của bạn qua giao thức HTTP POST
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }
      
      console.log(`Đã chuyển tiếp email thành công tới Webhook cho địa chỉ: ${message.to}`);
    } catch (error) {
      console.error(`Lỗi định tuyến email: ${error.message}`);
      // Trong trường hợp lỗi webhook, ta vẫn cho phép thư được chuyển đi (hoặc log lại)
    }
  }
};

// Hàm bổ trợ loại bỏ thẻ HTML để lấy văn bản thuần dự phòng
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, ' ')
             .replace(/\s+/g, ' ')
             .trim();
}
