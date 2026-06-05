using System.Security.Cryptography;
using System.Text;
using BlazzPay.Api.Models;

namespace BlazzPay.Api.Services;

public static class BlazzPaySignature
{
    public static string Create(PaymentNotificationRequest request, string clientSecret)
    {
        var rawValue = string.Concat(
            request.TransactionId,
            request.ClientReference,
            request.TransDateTime,
            request.Amount,
            request.RRN,
            clientSecret);

        var hash = SHA3_256.HashData(Encoding.UTF8.GetBytes(rawValue));
        return Convert.ToHexStringLower(hash);
    }

    public static bool IsValid(PaymentNotificationRequest request, string clientSecret)
    {
        var expectedSignature = Create(request, clientSecret);
        if (expectedSignature.Length != request.SignatureCode.Length)
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expectedSignature),
            Encoding.UTF8.GetBytes(request.SignatureCode.ToLowerInvariant()));
    }
}
