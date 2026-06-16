using Api.Common.Middleware;
using BlazzPay.Api.Options;
using BlazzPay.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddMemoryCache();

builder.Services
    .AddOptions<BlazzPayOptions>()
    .Bind(builder.Configuration.GetSection(BlazzPayOptions.SectionName))
    .Validate(options => Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out _), "BlazzPay:BaseUrl must be an absolute URL.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.ClientId), "BlazzPay:ClientId is required.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.ClientSecret), "BlazzPay:ClientSecret is required.")
    .ValidateOnStart();

builder.Services.AddHttpClient<IBlazzPayClient, BlazzPayClient>((serviceProvider, httpClient) =>
{
    var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<BlazzPayOptions>>().Value;
    httpClient.BaseAddress = new Uri(options.BaseUrl);
});

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}


app.UseMiddleware<RequestLoggingMiddleware>();
app.UseAuthorization();

app.MapControllers();

app.Run();
