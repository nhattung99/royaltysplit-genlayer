# RoyaltySplit

Chia doanh thu streaming theo % đã ký. Payor tự khai tổng doanh thu kỳ và escrow đúng số GEN. AI chỉ trả lời số liệu đó **có hợp lý hay không**. Số tiền mỗi bên nhận do contract tính bằng số nguyên, ngoài khối đồng thuận AI.

> RoyaltySplit chết nếu không có GenLayer: không có smart contract EVM nào đọc hiểu được số liệu streaming công khai phi cấu trúc để đánh giá tính hợp lý của doanh thu tự khai, và không có bên kiểm toán nào đủ rẻ để xác minh hàng loạt thoả thuận chia doanh thu nhỏ giữa nghệ sĩ độc lập — chỉ có đồng thuận AI phi tập trung của GenLayer mới làm được với chi phí gần bằng 0, trong khi phần tính tiền vẫn giữ được độ chính xác tuyệt đối của smart contract thường.

## Bài toán

Nhạc sĩ và label/distributor ký % chia cố định (ví dụ 60/40). Số liệu doanh thu mỗi kỳ thường chỉ do bên giữ tài khoản nền tảng tự báo cáo. Nghệ sĩ không có cách rẻ để kiểm chứng con số đó có bị khai thấp hay không.

## Vì sao AI không tự tính %

JobVerdict bị từ chối vì **AI tự tính điểm % rồi dùng chính điểm đó (có dung sai) để suy ra số tiền thanh toán** — 2 validator "đồng thuận" nhưng chốt 2 số tiền khác nhau. RoyaltySplit **không bao giờ để AI tính hay quyết định con số tiền nào cả** — AI chỉ trả lời "có/không" về tính hợp lý của số liệu; phép chia % thật sự diễn ra ở code Python thường (không phải trong `leader_fn`/`validator_fn`), chạy y hệt nhau trên mọi validator vì đó là code xác định (deterministic), không phải kết quả từ LLM.

Luồng:

1. Lúc tạo agreement, hai bên chốt `artist_split_bps` (1–9999). Con số này không đổi và không phải output của AI.
2. Payor khai `declared_revenue_amount` bằng cách gửi kèm đúng số GEN (`gl.message.value`).
3. `gl.vm.run_nondet` chỉ trả `DATA_PLAUSIBLE` hoặc `DATA_DISPUTED`, kèm confidence. Validator chỉ so nhãn verdict và việc confidence có vượt ngưỡng 60 hay không. Không có dung sai trên số tiền.
4. Confidence dưới 60 → `LOW_CONFIDENCE_DISPUTED`. GEN nằm nguyên trong escrow. Bổ sung nguồn rồi resolve lại.
5. `DATA_DISPUTED` và confidence ≥ 60 → hoàn toàn bộ số đã escrow cho payor.
6. `DATA_PLAUSIBLE` và confidence ≥ 60 → `_execute_split_settlement` (ngoài `run_nondet`):

```text
artist_amount = (declared_revenue_amount * artist_split_bps) // 10000
payor_share   = declared_revenue_amount - artist_amount
```

Phần dư của phép chia nguyên nằm ở payor. Tổng hai bên luôn bằng đúng số đã escrow.

## Giới hạn MVP

Mỗi `RoyaltyAgreement` là **một kỳ thanh toán duy nhất**, không phải hợp đồng lặp nhiều kỳ. Hợp tác nhiều kỳ thì tạo agreement mới và nhập lại % đã thỏa. Cơ chế lặp nhiều kỳ có thể làm ở milestone sau.

## Contract

Một contract giữ GEN trực tiếp. Payor escrow vào contract. Contract `emit_transfer` cho nghệ sĩ và trả phần còn lại cho payor. Không forward value qua cross-contract call.

| Việc | API |
|---|---|
| Người gọi | `gl.message.sender_address` |
| Chuyển GEN | `gl.get_contract_at(recipient).emit_transfer(value=u256(amount))` |
| Nhận GEN kèm giao dịch | `@gl.public.write` + `gl.message.value` |
| Map có default | `self.agreements.get(key, None)` |

Header bắt buộc:

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

Địa chỉ contract Studionet: *(chưa deploy — điền sau `Result: SUCCESS`)*.

Cách deploy: [scripts/deploy/studionet.md](scripts/deploy/studionet.md).

### Trạng thái

`AWAITING_DEPOSIT` → `DEPOSITED` → một trong:

- `RESOLVED` — đã chia đủ hai bên
- `DATA_DISPUTED_REFUNDED` — đã hoàn đủ cho payor
- `LOW_CONFIDENCE_DISPUTED` — tiền giữ nguyên, được thêm nguồn
- `PAYOUT_FAILED` / `REFUND_FAILED` — `retry_resolution` chỉ gửi phần cờ còn `false`

`artist_paid`, `payor_share_returned`, `disputed_refunded` khóa từng nhánh. Retry không trả trùng.

## Bảng đối chiếu xử lý tiền

Mọi số GEN đi qua `bigint` / `BigInt`. Không có `float`, `parseFloat`, `Math.round`, `Math.floor`, `Math.ceil` trên giá trị tiền.

| Chỗ | Hàm | Cách tính | Ghi chú |
|---|---|---|---|
| Contract | `_split_amounts` | `(total * bps) // 10000`, phần còn lại cho payor | Hàm thuần, **không** gọi từ `leader_fn` / `validator_fn` |
| Contract | `deposit_revenue` | Cùng `_split_amounts` | Từ chối nếu một bên ra 0 (tránh `emit_transfer` giá trị 0) |
| Contract | `_execute_split_settlement` | Cùng `_split_amounts`, rồi `emit_transfer` | Chỉ chạy khi verdict đã là `DATA_PLAUSIBLE` |
| Contract | `_refund_disputed` | Hoàn đúng `declared_revenue_amount` | Không nhân % |
| Contract | `get_agreement` | Ghi `artist_amount` / `payor_share` bằng `_split_amounts` | Preview trên chain, không phải output AI |
| Frontend | `parseGenToWei` | Tách chuỗi, ghép 18 chữ số lẻ, `BigInt` | Từ chối ký hiệu khoa học |
| Frontend | `formatWeiToGen` | `wei / 10^18` và `wei % 10^18` bằng `BigInt` | Chỉ để hiển thị |
| Frontend | `computeSplitPreview` | `(total * bps) / 10000n` | Cùng công thức contract, chỉ để preview trước khi ký |
| Frontend | `percentToBps` | Phần trăm nguyên 1–99 nhân 100 | UI basis points, không phải wei |
| Frontend | `toWeiString` | Chuỗi chữ số hoặc `bigint` | Số JS (`number`) bị bỏ, trả `0` |
| AI | `leader_fn` | JSON `{verdict, confidence, reason}` | Trường tiền nếu model bịa ra thì `_parse_verdict` bỏ |

Đối chiếu tay đã khóa trong test:

| declared (base units) | bps | artist | payor | tổng |
|---|---:|---:|---:|---:|
| 1000 | 6000 | 600 | 400 | 1000 |
| 10001 | 6000 | 6000 | 4001 | 10001 |
| 10 GEN (`10 * 10^18` wei) | 6000 | 6 GEN | 4 GEN | 10 GEN |

`1000 * 6000 // 10000 = 600`. `10001 * 6000 = 60006000`; `60006000 // 10000 = 6000`; payor = `10001 - 6000 = 4001`.

## Test

```bash
gltest tests/test_royalty_split.py
node scripts/check-no-float-money.js
npm run test:money
```

Kết quả contract (`gltest`, 14 passed): happy path `DATA_PLAUSIBLE` trả đúng 600 cho artist và 400 cho payor; happy path `DATA_DISPUTED` hoàn 1000 cho payor; confidence thấp giữ nguyên escrow rồi bổ sung nguồn và resolve lại; bps ngoài 1–9999 bị chặn; thiếu URL bị chặn; trùng ví bị chặn; deposit lần hai / resolve lần hai bị chặn; deposit 1 wei ở 6000 bps bị chặn vì artist nhận 0; transfer fail riêng artist, riêng payor, cả hai, và refund fail — `retry_resolution` chỉ gửi phần thiếu, không trả trùng.

## Frontend

Vite + React. Chain duy nhất: **GenLayer Studionet**.

Chưa có `VITE_CONTRACT_ADDRESS` thì app hiện banner và không crash. Form vẫn xem được. Giao dịch ghi bị chặn cho tới khi có địa chỉ.

Banner cố định: «Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.»

```bash
cd frontend
npm install
npm run dev
```

Biến môi trường: `frontend/.env` → `VITE_CONTRACT_ADDRESS=0x...`
