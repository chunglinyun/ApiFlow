using System.Security.Cryptography;
using System.Text;
using BlazzPay.Api.Models;
using BlazzPay.Api.Services;

namespace BlazzPay.Api.Tests;

public sealed class BlazzPaySignatureTests
{
    [Fact]
    public void Create_ReturnsSha3_256Signature()
    {
        var request = new PaymentNotificationRequest(
            TransactionId: "abc",
            ClientReference: string.Empty,
            Amount: string.Empty,
            TransDateTime: string.Empty,
            RRN: string.Empty,
            SignatureCode: string.Empty);

        var signature = BlazzPaySignature.Create(request, clientSecret: string.Empty);

        Assert.Equal("3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532", signature);
    }

    [Fact]
    public void IsValid_ReturnsFalse_WhenSignatureDoesNotMatch()
    {
        var request = new PaymentNotificationRequest(
            TransactionId: "250211830981905tyqY",
            ClientReference: "2502111000000001",
            Amount: "150000",
            TransDateTime: "2019-12-09 15:28:57",
            RRN: "014779330537",
            SignatureCode: "invalid");

        var isValid = BlazzPaySignature.IsValid(request, clientSecret: "secret");

        Assert.False(isValid);
    }
}

public sealed class BlazzPayCryptoTests
{
    [Fact]
    public void DecryptAes128CbcPkcs7_ReturnsPlainText()
    {
        const string key = "1234567890abcdef";
        const string iv = "abcdef1234567890";
        const string plainText = "qris-value";

        var encryptedValue = EncryptAes128CbcPkcs7(plainText, key, iv);

        var decryptedValue = BlazzPayCrypto.DecryptAes128CbcPkcs7(encryptedValue, key, iv);

        Assert.Equal(plainText, decryptedValue);
    }

    private static string EncryptAes128CbcPkcs7(string plainText, string key, string iv)
    {
        using var aes = Aes.Create();
        aes.KeySize = 128;
        aes.Key = Encoding.UTF8.GetBytes(key);
        aes.IV = Encoding.UTF8.GetBytes(iv);
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;

        using var encryptor = aes.CreateEncryptor();
        var plainBytes = Encoding.UTF8.GetBytes(plainText);
        var encryptedBytes = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);
        return Convert.ToBase64String(encryptedBytes);
    }
}
