using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

// Named client used by the /proxy forwarder. Auto-redirects are disabled so the tool can
// observe 3xx responses verbatim, just like any other status.
builder.Services.AddHttpClient("proxy")
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });

var app = builder.Build();

// Serve the static node-graph UI from wwwroot (index.html as the default document).
app.UseDefaultFiles();
app.UseStaticFiles();

// POST /proxy — server-side request forwarder.
//
// The browser cannot call an arbitrary Base URL directly because of CORS. The UI therefore
// posts the composed request here (same-origin) and we forward it from the server, returning
// the upstream status/headers/body as plain data so the UI can render any outcome.
//
// NOTE: this is an unauthenticated open forwarder (an SSRF surface). It is intended only for
// local development use as part of this API testing tool. Do not expose it publicly.
app.MapPost("/proxy", async (ProxyRequest req, IHttpClientFactory httpClientFactory, CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(req.Url) || !Uri.TryCreate(req.Url, UriKind.Absolute, out var uri))
    {
        return Results.BadRequest(new { error = "A valid absolute 'url' is required." });
    }

    var method = string.IsNullOrWhiteSpace(req.Method) ? "GET" : req.Method.Trim().ToUpperInvariant();
    using var request = new HttpRequestMessage(new HttpMethod(method), uri);

    var methodAllowsBody = method is not "GET" and not "HEAD";
    if (methodAllowsBody && !string.IsNullOrEmpty(req.Body))
    {
        request.Content = new StringContent(req.Body, Encoding.UTF8);
        // Drop the StringContent default (text/plain) so an explicit Content-Type header wins.
        request.Content.Headers.ContentType = null;
    }

    foreach (var header in req.Headers ?? [])
    {
        if (string.IsNullOrWhiteSpace(header.Key))
        {
            continue;
        }

        // Content headers (e.g. Content-Type) are rejected by request.Headers and must live
        // on the content instead — fall through to the content header collection.
        if (!request.Headers.TryAddWithoutValidation(header.Key, header.Value))
        {
            request.Content?.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    // Default a JSON content type when a body was sent but the caller didn't specify one.
    if (request.Content is not null && request.Content.Headers.ContentType is null)
    {
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
    }

    var httpClient = httpClientFactory.CreateClient("proxy");
    var stopwatch = Stopwatch.StartNew();

    try
    {
        using var response = await httpClient.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        stopwatch.Stop();

        var headers = response.Headers
            .Concat(response.Content.Headers)
            .ToDictionary(h => h.Key, h => string.Join(", ", h.Value));

        return Results.Ok(new ProxyResponse(
            (int)response.StatusCode,
            response.ReasonPhrase,
            headers,
            body,
            stopwatch.ElapsedMilliseconds,
            Error: null));
    }
    catch (Exception ex)
    {
        stopwatch.Stop();
        // Surface transport-level failures (DNS, refused connection, timeout) as data so the
        // UI can show them on the node rather than receiving an opaque 500.
        return Results.Ok(new ProxyResponse(
            0,
            "Request failed",
            new Dictionary<string, string>(),
            Body: null,
            stopwatch.ElapsedMilliseconds,
            Error: ex.Message));
    }
});

app.Run();

internal sealed record ProxyHeader(string Key, string? Value);

internal sealed record ProxyRequest(string? Method, string Url, List<ProxyHeader>? Headers, string? Body);

internal sealed record ProxyResponse(
    int Status,
    string? ReasonPhrase,
    Dictionary<string, string> Headers,
    string? Body,
    long ElapsedMs,
    string? Error);
