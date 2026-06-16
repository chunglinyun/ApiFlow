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
            context.Request.Headers.Select(header => $"{header.Key}: {header.Value}"));

        _logger.LogInformation(
            "Incoming request {Method} {Path}\nHeaders:\n{Headers}\nBody:\n{Body}",
            context.Request.Method,
            context.Request.Path,
            headers,
            requestBody);

        await _next(context);
    }
}
