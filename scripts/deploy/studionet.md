# Deploy RoyaltySplit lên GenLayer Studionet

Chỉ dùng Studionet. Không chuyển app sang testnet Asimov hay Bradbury.

1. Mở [GenLayer Studio Run & Debug](https://studio.genlayer.com/run-debug).
2. Nếu môi trường bẩn: Settings → **Reset Storage**, rồi hard-refresh.
3. Dán toàn bộ [`contracts/royalty_split.py`](../../contracts/royalty_split.py). Giữ đúng 2 dòng đầu:

```
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

4. Bấm **Deploy**. Mở giao dịch và xác nhận **`Result: SUCCESS`**. `FINALIZED` một mình chưa đủ.
5. Copy địa chỉ vào `frontend/.env`:

```
VITE_CONTRACT_ADDRESS=0x...
```

6. Nạp GEN cho ví MetaMask từ Studio → **Accounts** (không dùng faucet testnet công khai).
7. Dùng hai ví khác nhau: payor tạo agreement, artist là ví còn lại.

Địa chỉ contract hiện tại: *(chưa deploy)*.
