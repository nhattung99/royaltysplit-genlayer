# Deploy RoyaltySplit to GenLayer Studionet

Use Studionet only. Do not point the app at the Asimov or Bradbury testnets.

1. Open [GenLayer Studio Run & Debug](https://studio.genlayer.com/run-debug).
2. If the environment is dirty: Settings → **Reset Storage**, then hard-refresh.
3. Paste all of [`contracts/royalty_split.py`](../../contracts/royalty_split.py). Keep the first two lines:

```
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

4. Click **Deploy**. Open the transaction and confirm **`Result: SUCCESS`**. `FINALIZED` alone is not enough.
5. Copy the address into `frontend/.env`:

```
VITE_CONTRACT_ADDRESS=0x776059Cf2A125df544e5F52AC5B51F8f8e5F87A9
```

6. Fund MetaMask from Studio → **Accounts** (not a public testnet faucet).
7. Use two different wallets: the payor creates the agreement, and the artist is the other wallet.

## Deployed Contract

`0x776059Cf2A125df544e5F52AC5B51F8f8e5F87A9`

https://genlayer-explorer.vercel.app/address/0x776059Cf2A125df544e5F52AC5B51F8f8e5F87A9
