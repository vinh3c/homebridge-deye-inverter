# homebridge-deye-inverter

Plugin Homebridge cung cấp **3 cảm biến nhiệt độ riêng** trong HomeKit: **DC Temperature**, **AC Temperature** và **Battery Temperature**.
Dành cho inverter **SUN-6K-SG05LP1-EU-SM2-P** qua Modbus TCP.

Vào trang cấu hình của logger, **enable Modbus**, rồi nhập IP của logger vào cấu hình plugin. Cổng mặc định là `502`.

Plugin đọc Holding Registers (FC03): DC `90`, AC/tản nhiệt `91`, pin `182`, quy đổi `(raw - 1000) / 10` °C.
Chỉ đọc, không ghi thay đổi lên inverter.

## Model đã kiểm tra

Đã kiểm tra đọc thành công cả 3 nhiệt độ **DC, AC và pin** trên inverter **Deye SUN-6K-SG05LP1-EU-SM2-P**, thông qua logger đã bật Modbus, cổng `502`.
Một lần đọc thực tế cho kết quả: DC **62,4°C**, AC **55,9°C**, pin **34,0°C**. Đây là số đo tại thời điểm kiểm tra, không phải giá trị cố định.
Phần tích hợp Homebridge đã được kiểm thử bằng API/HAP Homebridge và logger giả lập; chưa kiểm tra ghép đôi với Apple Home trên hệ thống thực tế.

## Cài đặt Homebridge

Yêu cầu Node.js 22.10+ hoặc 24 và Homebridge 1.8+ / 2.x.
Sau khi package có trên npm, tìm **homebridge-deye-inverter** trong Homebridge UI và cài đặt, hoặc:

```sh
npm install -g homebridge-deye-inverter
```

Thêm platform bằng trang Settings của plugin hoặc thêm vào mảng `platforms` trong `config.json`:

```json
{
  "platform": "DeyeInverter",
  "host": "192.168.5.60"
}
```

Khởi động lại Homebridge. Ba cảm biến sẽ xuất hiện qua bridge đã ghép đôi với Apple Home.
Máy chạy Homebridge cần truy cập được IP/cổng của logger.

Chỉ cần nhập IP logger. Các tùy chọn dưới đây không bắt buộc và nằm trong **Advanced settings** của Homebridge UI.

| Cấu hình | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `host` | `192.168.5.60` | IP hoặc hostname logger |
| `port` | `502` | Cổng Modbus TCP |

Plugin tự đọc mỗi 10 giây sau khi hoàn tất chu kỳ trước, chờ tối đa 5 giây cho mỗi yêu cầu và không chồng yêu cầu lên logger. Không cần cấu hình chu kỳ hay timeout. Cảm biến lỗi sẽ báo lỗi giao tiếp thay vì tiếp tục trả nhiệt độ cũ, rồi tự phục hồi khi đọc thành công.
AC là cảm biến tản nhiệt inverter; pin là nhiệt độ inverter báo, không phải từng cell BMS.
Plugin tự dùng địa chỉ giao tiếp inverter mặc định `1`, đã kiểm tra thành công trên model ở trên; bạn không cần tìm hay cấu hình địa chỉ này.
Tên cảm biến được đặt sẵn là **DC Temperature**, **AC Temperature** và **Battery Temperature**; bạn có thể đổi tên trong Apple Home.
Plugin tự giữ định danh cho 3 cảm biến; đổi IP không tạo cảm biến mới. Mỗi cấu hình platform hỗ trợ một inverter.

## Chạy thử từ mã nguồn

```sh
npm ci
npm run typecheck
npm test
npm pack
```

`npm pack` tự build và tạo `homebridge-deye-inverter-1.0.0.tgz`. Cài bản local trên máy Homebridge:

```sh
npm install -g ./homebridge-deye-inverter-1.0.0.tgz
```

Vẫn có CLI để kiểm tra logger trực tiếp từ mã nguồn:

```sh
npm start -- --once
npm start
```

CLI hỗ trợ `.env` theo `.env.example`. Homebridge dùng cấu hình platform bên trên, không dùng `.env`.
`npm run serve -- --once` chạy CLI đã biên dịch sau `npm run build`.
Các kiểm thử dùng Modbus TCP giả lập và API/HAP Homebridge, không truy cập inverter thật.

## GitHub Actions và npm

- `ci.yml`: mỗi push/PR, kiểm tra TypeScript, tests và đóng gói trên Node 22/24.
- `publish.yml`: khi **publish GitHub Release chính thức**, kiểm tra tag bằng `v` + version trong `package.json`, chạy kiểm tra rồi publish npm. Prerelease được bỏ qua.
- Workflow tự gắn `repository.url` theo repository đang chạy. Không commit token vào mã nguồn.

Thiết lập lần đầu:

1. Đưa mã nguồn lên repository GitHub của bạn. Kiểm tra tên `homebridge-deye-inverter` còn khả dụng trên npm; nếu đổi tên, đổi cả `PLUGIN_NAME` trong `src/platform.ts`.
2. Để publish lần đầu từ Actions, tạo npm granular access token có quyền publish package và bypass 2FA, rồi lưu vào GitHub repository secret **`NPM_TOKEN`**.
3. Commit version cùng `package-lock.json`, tạo tag `v1.0.0` trỏ đến commit đó và publish GitHub Release cho tag. Workflow sẽ publish version `1.0.0`.
4. Khi package đã tồn tại, có thể chuyển sang **npm Trusted Publishing**: trong Settings của package trên npm, cấu hình đúng GitHub owner, repository và workflow **`publish.yml`**. Nếu giao diện yêu cầu allowed action, chọn publish. Không đặt environment vì workflow không dùng environment. Xóa secret `NPM_TOKEN` sau khi cấu hình OIDC; workflow đã có `id-token: write` và Node 24.

Với các lần sau, tăng version bằng `npm version patch` trong Git repository sạch, push commit/tag rồi publish GitHub Release cho tag mới. Không thể publish lại cùng một version npm.

Tham khảo: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [Homebridge dynamic platform API](https://developers.homebridge.io/homebridge/interfaces/DynamicPlatformPlugin.html).
