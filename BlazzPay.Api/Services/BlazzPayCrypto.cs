using System.Security.Cryptography;
using System.Text;

namespace BlazzPay.Api.Services;

public static class BlazzPayCrypto
{
    public static string DecryptAes128CbcPkcs7(string encryptedValue, string key, string iv)
    {
        var encryptedBytes = Convert.FromBase64String(encryptedValue);
        var keyBytes = Encoding.UTF8.GetBytes(key);
        var ivBytes = Encoding.UTF8.GetBytes(iv);

        using var aes = Aes.Create();
        aes.KeySize = 128;
        aes.Key = keyBytes;
        aes.IV = ivBytes;
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;

        using var decryptor = aes.CreateDecryptor();
        var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
        return Encoding.UTF8.GetString(decryptedBytes);
    }
}
