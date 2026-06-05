using BlazzPay.Api.Models;

namespace BlazzPay.Api.Services;

public interface IBlazzPayClient
{
    Task<GenerateQrisResponse> GenerateQrisAsync(GenerateQrisRequest request, CancellationToken cancellationToken);

    Task<PaymentStatusResponse> CheckPaymentStatusAsync(PaymentStatusRequest request, CancellationToken cancellationToken);

    Task<BalanceResponse> GetBalanceAsync(CancellationToken cancellationToken);

    bool IsValidCallbackAuthorization(string? authorizationHeader);

    bool IsValidNotificationSignature(PaymentNotificationRequest request);
}
