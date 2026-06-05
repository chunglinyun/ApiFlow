# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
dotnet build MarcDemo.slnx

# Run the API (starts on port 5296)
dotnet run --project BlazzPay.Api

# Run all tests
dotnet test

# Run tests for a single project
dotnet test BlazzPay.Api.Tests/BlazzPay.Api.Tests.csproj

# Run a specific test
dotnet test --filter "FullyQualifiedName~TestMethodName"
```

## Architecture

This is an ASP.NET Core 10.0 minimal API solution with two projects:

- **BlazzPay.Api** — REST API gateway that wraps the BlazzPay QRIS payment provider
- **BlazzPay.Api.Tests** — xUnit test suite with a project reference to BlazzPay.Api

### Key Layers in BlazzPay.Api

| Layer | Path | Responsibility |
|-------|------|----------------|
| Controllers | `Controllers/BlazzPayController.cs` | 4 endpoints: generate QRIS, check payment status, get balance, receive webhook |
| Services | `Services/BlazzPayClient.cs` | HttpClient wrapper around the BlazzPay upstream API; caches the access token in-memory with TTL |
| Crypto | `Services/BlazzPayCrypto.cs` | AES-128-CBC / PKCS7 decryption of QR code payloads |
| Signature | `Services/BlazzPaySignature.cs` | SHA3-256 webhook signature validation using constant-time comparison |
| Options | `Options/BlazzPayOptions.cs` | Typed configuration bound from `appsettings.json`; validated on startup |
| Constants | `Constants/BlazzPayStringDefinition.cs` | Status code strings and auth scheme names |
| Models | `Models/` | C# records used as request/response DTOs |

### Configuration

`BlazzPayOptions` requires `BaseUrl`, `ClientId`, and `ClientSecret`. `AesKey` and `AesIV` are optional (only needed for QR code decryption). Staging credentials live in `appsettings.json`; `appsettings.Development.json` overrides with placeholders.

### Security Patterns

- Outbound calls to BlazzPay use Bearer token auth (token fetched and cached by `BlazzPayClient`)
- Inbound webhook callbacks use Basic auth validation against configured credentials
- Webhook payload integrity is verified with a SHA3-256 HMAC signature using constant-time comparison

### Docs

`/docs/BlazzPay_API_Specification.md` is the upstream provider's API spec in Traditional Chinese — the authoritative reference for request/response shapes, error codes, and signature generation details.