using System.Text.Json.Serialization;

namespace BlazzPay.Api.Models;

public sealed record AccessTokenResponse(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("token_type")] string TokenType,
    [property: JsonPropertyName("expires_in")] string ExpiresIn,
    [property: JsonPropertyName("scope")] string Scope);

public sealed record GenerateQrisRequest(
    string TransactionId,
    string Username,
    string Amount);

public sealed record GenerateQrisResponse(
    string TransactionId,
    string ClientReference,
    [property: JsonPropertyName("QRCode")] string QrCode,
    string QRISReffCode,
    string ExpiredUntil)
{
    public string? DecryptedQrCode { get; init; }
}

public sealed record PaymentStatusRequest(
    string TransactionId,
    string ClientReference);

public sealed record PaymentStatusResponse(
    string TransactionId,
    string ClientReference,
    string Status,
    string TransDateTime,
    string Amount,
    [property: JsonPropertyName("rrn")] string Rrn);

public sealed record BalanceResponse(
    decimal Balance,
    string Currency,
    string LastUpdated);

public sealed record PaymentNotificationRequest(
    string TransactionId,
    string ClientReference,
    string Amount,
    string TransDateTime,
    string RRN,
    string SignatureCode);

public sealed record PaymentErrorResponse(
    string PaymentName,
    string Status,
    string Message);
