using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Api.Common.Middleware;

public sealed class RequestLoggingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RequestLoggingMiddleware> _logger;

    public RequestLoggingMiddleware(RequestDelegate next, ILogger<RequestLoggingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        context.Request.EnableBuffering();

        using var reader = new StreamReader(
            context.Request.Body,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: false,
            leaveOpen: true);

        var requestBody = await reader.ReadToEndAsync();
        context.Request.Body.Position = 0;

        var headers = string.Join(
            Environment.NewLine,
            context.Request.Headers.Select(header => $"{header.Key}: {Mask(header.Key, header.Value)}"));

        const int maxBody = 2048;
        var body = requestBody.Length > maxBody
            ? requestBody[..maxBody] + $"…[truncated, {requestBody.Length} chars total]"
            : requestBody;

        _logger.LogInformation(
            "Incoming request {Method} {Path}\nHeaders:\n{Headers}\nBody:\n{Body}",
            context.Request.Method,
            context.Request.Path,
            headers,
            body);

        await _next(context);
    }

    // ponytail: substring match on the header key; good enough for log redaction.
    private static readonly string[] SensitiveKeys = ["authorization", "secret", "token", "key", "cookie", "password"];

    private static string Mask(string key, string? value)
    {
        value ??= "";
        if (SensitiveKeys.Any(s => key.Contains(s, StringComparison.OrdinalIgnoreCase)) == false)
        {
            return value;
        }

        // Reveal first/last 3 chars so the value is verifiable without leaking it.
        // Short values stay fully masked (too little to hide behind).
        return value.Length <= 8
            ? "***"
            : $"{value[..3]}***{value[^3..]}";
    }
}
