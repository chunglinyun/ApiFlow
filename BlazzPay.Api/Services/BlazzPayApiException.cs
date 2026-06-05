namespace BlazzPay.Api.Services;

public sealed class BlazzPayApiException : Exception
{
    public BlazzPayApiException(string status, string message)
        : base(message)
    {
        Status = status;
    }

    public BlazzPayApiException(string status, string message, Exception innerException)
        : base(message, innerException)
    {
        Status = status;
    }

    public string Status { get; }
}
