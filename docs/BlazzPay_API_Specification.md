# BlazzPay API 技術規格整理

BlazzPay 是一個針對線上遊戲平台的 QRIS 支付閘道，採用 RESTful API 設計，所有請求與回應格式皆為 JSON。

---

## I. Get Access Token API

用於 OAuth 2.0 認證授權（Client Credentials 授權類型），取得 Access Token 後才能呼叫其他 API。Token 預設有效期為 **5 分鐘**。

| 項目 | 值 |
|------|------|
| URL | `{URL}/h2h/v1/authorization/token` |
| Method | `POST` |
| Content-Type | `application/x-www-form-urlencoded` |

### Headers

| Header | 必填 | 說明 |
|--------|------|------|
| `client-id` | M | BlazzPay 提供的 Client ID |
| `client-secret` | M | BlazzPay 提供的 Client Secret |
| `Content-Type` | M | `application/x-www-form-urlencoded` |

### Request Body

無額外 Body 參數（憑證透過 Header 傳遞）。

### Response

| 欄位 | 類型 | 說明 |
|------|------|------|
| `access_token` | String | JWT Access Token |
| `token_type` | String | 固定為 `bearer` |
| `expires_in` | String | Token 有效秒數（預設 `"299"`，約 5 分鐘） |
| `scope` | String | 授權範圍（如 `"clients"`） |

### Response 範例

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": "299",
  "scope": "clients"
}
```

---

## II. Generate QRIS Code API

產生動態 QRIS QR Code，回傳 QR Code 字串，合作方需自行將字串轉為可掃描的 QRIS 圖片。

| 項目 | 值 |
|------|------|
| URL | `{URL}/h2h/v1/qris/generateQRIS` |
| Method | `POST` |
| Content-Type | `application/json` |

### Headers

| Header | 必填 | 說明 |
|--------|------|------|
| `Content-Type` | M | `application/json` |
| `Authorization` | M | `Bearer <access_token>` |

### Request Body

| 參數 | 類型 | 最大長度 | 必填 | 說明 |
|------|------|---------|------|------|
| `TransactionId` | String | 30 | M | 客戶端唯一交易參考編號 |
| `Username` | String | 20 | M | 玩家使用者名稱 |
| `Amount` | String | 10 | M | QR 金額，最低 10,000 IDR |

### Request 範例

```json
{
  "TransactionId": "250211830981905tyqY",
  "Username": "ultraman001",
  "Amount": "150000"
}
```

### Response

| 參數 | 類型 | 最大長度 | 必填 | 說明 |
|------|------|---------|------|------|
| `TransactionId` | String | 30 | M | 客戶端唯一交易參考編號 |
| `ClientReference` | String | 20 | M | BlazzPay 系統產生的唯一參考編號 |
| `QrCode` | String | Text | M | QR Code 字串（AES-128 + PKCS5 加密，需解密） |
| `QRISReffCode` | String | — | M | QRIS 參考代碼 |
| `ExpiredUntil` | String | 19 | M | QR Code 過期時間，格式：`yyyy-MM-dd HH:mm:ss` |

> **注意：** QR Code 回應以 AES-128 搭配 PKCS5 padding 加密，AES Key 與 IV 將另行提供。

### Response 範例

```json
{
  "TransactionId": "351515",
  "QRCode": "2FlcOnN/KZcsZbm8Z1tYD8dj...",
  "QRISReffCode": "2502251043996556D3kB",
  "ClientReference": "2502252000000013",
  "ExpiredUntil": "2025-02-25 17:25:44"
}
```

---

## III. Payment Notification API（Webhook）

當使用者成功完成 QRIS 付款時，BlazzPay 會透過此 Webhook 通知合作方。若回傳的 HTTP Status 不是 `204`，系統會自動重試。合作方須自行實作防重複處理。

| 項目 | 值 |
|------|------|
| URL | `{CLIENT_URL_CALL_BACK}`（合作方提供） |
| Method | `POST` |
| Content-Type | `application/json` |

### Headers

| Header | 必填 | 說明 |
|--------|------|------|
| `Content-Type` | M | `application/json` |
| `Authorization` | M | `Basic <Base64_encoded({client_id}:{client_secret})>` |

### Request Body（BlazzPay → 合作方）

| 參數 | 類型 | 最大長度 | 必填 | 說明 |
|------|------|---------|------|------|
| `TransactionId` | String | 30 | M | 客戶端唯一交易參考編號 |
| `ClientReference` | String | 20 | M | BlazzPay 系統產生的唯一參考編號 |
| `Amount` | String | 10 | M | QR 金額，最低 10,000 IDR |
| `TransDateTime` | String | 19 | M | 交易日期時間，格式：`yyyy-MM-dd HH:mm:ss` |
| `RRN` | String | 12 | M | RRN 編號 |
| `SignatureCode` | String | 255 | M | 安全驗證簽名碼 |

### Request 範例

```json
{
  "TransactionId": "250211830981905tyqY",
  "ClientReference": "2502111000000001",
  "Amount": "150000",
  "TransDateTime": "2019-12-09 15:28:57",
  "RRN": "014779330537",
  "SignatureCode": "f43f3135c0e6525a523974b30e77f8031323c7a19f4366e093ddc80c66a6xkiu"
}
```

### 預期回應

```
HTTP Status: 204 No Content
```

### SignatureCode 產生方式

```
SignatureCode = SHA3-256(TransactionId + ClientReference + TransDateTime + Amount + RRN + client_secret)
```

欄位必須嚴格按照上述順序串接後，再套用 SHA3-256 雜湊演算法。

---

## IV. Check Payment Status API

查詢 QRIS 付款狀態，共有三種狀態：`PAID`（已付款）、`PENDING`（等待付款）、`EXPIRED`（已過期）。

| 項目 | 值 |
|------|------|
| URL | `{URL}/h2h/v1/qris/status` |
| Method | `POST` |
| Content-Type | `application/json` |

### Headers

| Header | 必填 | 說明 |
|--------|------|------|
| `Content-Type` | M | `application/json` |
| `Authorization` | M | `Bearer <access_token>` |

### Request Body

| 參數 | 類型 | 最大長度 | 必填 | 說明 |
|------|------|---------|------|------|
| `TransactionId` | String | 30 | M | 客戶端唯一交易參考編號 |
| `ClientReference` | String | 20 | M | BlazzPay 系統產生的唯一參考編號 |

### Request 範例

```json
{
  "TransactionId": "250211830981905tyqY",
  "ClientReference": "2502111000000001"
}
```

### Response

| 參數 | 類型 | 最大長度 | 必填 | 說明 |
|------|------|---------|------|------|
| `TransactionId` | String | 30 | M | 客戶端唯一交易參考編號 |
| `ClientReference` | String | 20 | M | BlazzPay 系統產生的唯一參考編號 |
| `Status` | String | 10 | M | QR Code 狀態：`PAID` / `PENDING` / `EXPIRED` |
| `TransDateTime` | String | 19 | M | 交易日期時間，格式：`yyyy-MM-dd HH:mm:ss` |
| `Amount` | String | 10 | M | QR 金額，最低 10,000 IDR |
| `rrn` | String | 12 | M | RRN 編號 |

### Response 範例

```json
{
  "TransactionId": "250211830981905tyqY",
  "ClientReference": "2502111000000001",
  "Status": "PAID",
  "Amount": "150000",
  "TransDateTime": "2019-12-09 15:29:57",
  "rrn": "987654d3321"
}
```

---

## V. Check Balance Information API

查詢合作方透過 QRIS 成功收款的總餘額。

| 項目 | 值 |
|------|------|
| URL | `{URL}/h2h/v1/info/balance` |
| Method | `GET` |
| Content-Type | `application/json` |

### Headers

| Header | 必填 | 說明 |
|--------|------|------|
| `Content-Type` | M | `application/json` |
| `Authorization` | M | `Bearer <access_token>` |

### Request Body

無（GET 請求不帶 Body）。

### Response

| 參數 | 類型 | 最大長度 | 必填 | 說明 |
|------|------|---------|------|------|
| `Balance` | String | 10 | M | QRIS 成功付款的總餘額 |
| `Currency` | String | 10 | M | 幣別（如 `IDR`、`USD` 等） |
| `LastUpdated` | String | 19 | M | 餘額最後更新時間，格式：`yyyy-MM-dd HH:mm:ss` |

### Response 範例

```json
{
  "Balance": 5000000,
  "Currency": "IDR",
  "LastUpdated": "2019-12-09 15:29:57"
}
```

---

## 通用 HTTP 狀態碼

| 狀態碼 | 說明 |
|--------|------|
| `200 OK` | 成功取得資源 / 處理成功 |
| `201 Created` | 資源成功建立 |
| `204 No Content` | 處理成功但無回傳內容 |
| `400 Bad Request` | 請求格式錯誤或缺少參數 |
| `401 Unauthorized` | 認證失敗或未提供認證 |
| `403 Forbidden` | 無權限存取該資源 |
| `404 Not Found` | 資源不存在 |
| `500 Internal Server Error` | 伺服器發生非預期錯誤 |
