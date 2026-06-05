namespace BlazzPay.Api.Options;

public sealed class BlazzPayOptions
{
    public const string SectionName = "BlazzPay";

    public string BaseUrl { get; init; } = string.Empty;

    public string ClientId { get; init; } = string.Empty;

    public string ClientSecret { get; init; } = string.Empty;

    public string AesKey { get; init; } = string.Empty;

    public string AesIV { get; init; } = string.Empty;

    public int TokenRefreshSkewSeconds { get; init; } = 30;

    public bool RequireCallbackBasicAuthentication { get; init; } = true;
}
