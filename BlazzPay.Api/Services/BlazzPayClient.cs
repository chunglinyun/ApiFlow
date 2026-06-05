using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using BlazzPay.Api.Constants;
using BlazzPay.Api.Models;
using BlazzPay.Api.Options;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace BlazzPay.Api.Services;

public sealed class BlazzPayClient : IBlazzPayClient
{
    private const string AccessTokenCacheKey = "BlazzPay:AccessToken";

    private static readonly JsonSerializerOptions JsonSerializerOptions = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _httpClient;
    private readonly IMemoryCache _memoryCache;
    private readonly ILogger<BlazzPayClient> _logger;
    private readonly BlazzPayOptions _options;

    public BlazzPayClient(
        HttpClient httpClient,
        IMemoryCache memoryCache,
        IOptions<BlazzPayOptions> options,
        ILogger<BlazzPayClient> logger)
    {
        _httpClient = httpClient;
        _memoryCache = memoryCache;
        _logger = logger;
        _options = options.Value;
    }

    public async Task<GenerateQrisResponse> GenerateQrisAsync(
        GenerateQrisRequest request,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Starting generate QRIS");

        using var httpRequest = await CreateAuthorizedJsonRequestAsync(
            HttpMethod.Post,
            "/h2h/v1/qris/generateQRIS",
            request,
            cancellationToken);

        var response = await SendBlazzPayAsync<GenerateQrisResponse>(httpRequest, cancellationToken);
        return TryAttachDecryptedQrCode(response);
    }

    public async Task<PaymentStatusResponse> CheckPaymentStatusAsync(
        PaymentStatusRequest request,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Starting check payment status");

        using var httpRequest = await CreateAuthorizedJsonRequestAsync(
            HttpMethod.Post,
            "/h2h/v1/qris/status",
            request,
            cancellationToken);

        return await SendBlazzPayAsync<PaymentStatusResponse>(httpRequest, cancellationToken);
    }

    public async Task<BalanceResponse> GetBalanceAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Starting get balance");

        using var httpRequest = await CreateAuthorizedJsonRequestAsync<object>(
            HttpMethod.Get,
            "/h2h/v1/info/balance",
            body: null,
            cancellationToken);

        return await SendBlazzPayAsync<BalanceResponse>(httpRequest, cancellationToken);
    }

    public bool IsValidCallbackAuthorization(string? authorizationHeader)
    {
        if (!_options.RequireCallbackBasicAuthentication)
        {
            return true;
        }

        if (!AuthenticationHeaderValue.TryParse(authorizationHeader, out var header) ||
            !string.Equals(header.Scheme, BlazzPayStringDefinition.BasicAuthenticationScheme, StringComparison.OrdinalIgnoreCase) ||
            string.IsNullOrWhiteSpace(header.Parameter))
        {
            return false;
        }

        var expectedValue = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_options.ClientId}:{_options.ClientSecret}"));
        return string.Equals(header.Parameter, expectedValue, StringComparison.Ordinal);
    }

    public bool IsValidNotificationSignature(PaymentNotificationRequest request)
    {
        return BlazzPaySignature.IsValid(request, _options.ClientSecret);
    }

    private async Task<HttpRequestMessage> CreateAuthorizedJsonRequestAsync<TBody>(
        HttpMethod method,
        string requestUri,
        TBody? body,
        CancellationToken cancellationToken)
    {
        var accessToken = await GetAccessTokenAsync(cancellationToken);
        var request = new HttpRequestMessage(method, requestUri);
        request.Headers.Authorization = new AuthenticationHeaderValue(
            BlazzPayStringDefinition.BearerAuthenticationScheme,
            accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonSerializerOptions);
        }

        return request;
    }

    private async Task<string> GetAccessTokenAsync(CancellationToken cancellationToken)
    {
        if (_memoryCache.TryGetValue<string>(AccessTokenCacheKey, out var cachedAccessToken) &&
            cachedAccessToken is not null)
        {
            return cachedAccessToken;
        }

        _logger.LogInformation("Starting get access token");

        using var request = new HttpRequestMessage(HttpMethod.Post, "/h2h/v1/authorization/token");
        request.Headers.Add("client-id", _options.ClientId);
        request.Headers.Add("client-secret", _options.ClientSecret);
        request.Content = new FormUrlEncodedContent([]);

        var tokenResponse = await SendBlazzPayAsync<AccessTokenResponse>(request, cancellationToken);
        var expiresIn = ParseExpiresIn(tokenResponse.ExpiresIn);
        var cacheDuration = TimeSpan.FromSeconds(Math.Max(1, expiresIn - _options.TokenRefreshSkewSeconds));

        _memoryCache.Set(AccessTokenCacheKey, tokenResponse.AccessToken, cacheDuration);
        return tokenResponse.AccessToken;
    }

    private async Task<TResponse> SendBlazzPayAsync<TResponse>(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        try
        {
            var requestBody = request.Content is not null
                ? await request.Content.ReadAsStringAsync(cancellationToken)
                : "(none)";

            _logger.LogInformation(
                "BlazzPay request: {Method} {Uri}\nHeaders: {Headers}\nBody: {Body}",
                request.Method,
                request.RequestUri,
                request.Headers.ToString().TrimEnd(),
                requestBody);

            using var response = await _httpClient.SendAsync(request, cancellationToken);
            var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);

            _logger.LogInformation(
                "BlazzPay response: HTTP {StatusCode}\nHeaders: {Headers}\nBody: {ResponseJson}",
                (int)response.StatusCode,
                response.Headers.ToString().TrimEnd(),
                responseJson);

            if (!ValidateJsonFormat(responseJson))
            {
                throw new BlazzPayApiException(
                    BlazzPayStringDefinition.Unknown,
                    "BlazzPay response is not valid JSON.");
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError(
                    "BlazzPay API returned HTTP {StatusCode}: {ResponseJson}",
                    (int)response.StatusCode,
                    responseJson);

                throw new BlazzPayApiException(
                    BlazzPayStringDefinition.ServerFailure,
                    $"BlazzPay API returned HTTP {(int)response.StatusCode}.");
            }

            return JsonSerializer.Deserialize<TResponse>(responseJson, JsonSerializerOptions)
                ?? throw new BlazzPayApiException(
                    BlazzPayStringDefinition.Unknown,
                    "BlazzPay response body could not be deserialized.");
        }
        catch (BlazzPayApiException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "BlazzPay API call failed");
            throw new BlazzPayApiException(
                BlazzPayStringDefinition.ServerFailure,
                "BlazzPay API call failed.",
                ex);
        }
    }

    private bool ValidateJsonFormat(string response)
    {
        try
        {
            JsonDocument.Parse(response);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Response not in json format: {Response}", response);
            return false;
        }
    }

    private GenerateQrisResponse TryAttachDecryptedQrCode(GenerateQrisResponse response)
    {
        if (string.IsNullOrWhiteSpace(_options.AesKey) || string.IsNullOrWhiteSpace(_options.AesIV))
        {
            return response;
        }

        try
        {
            var decryptedQrCode = BlazzPayCrypto.DecryptAes128CbcPkcs7(response.QrCode, _options.AesKey, _options.AesIV);
            return response with { DecryptedQrCode = decryptedQrCode };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to decrypt BlazzPay QR code");
            throw new BlazzPayApiException(
                BlazzPayStringDefinition.Unknown,
                "BlazzPay QR code could not be decrypted.",
                ex);
        }
    }

    private static int ParseExpiresIn(string expiresIn)
    {
        return int.TryParse(expiresIn, out var parsedExpiresIn)
            ? parsedExpiresIn
            : 299;
    }
}
