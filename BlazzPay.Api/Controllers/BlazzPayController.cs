using BlazzPay.Api.Constants;
using BlazzPay.Api.Models;
using BlazzPay.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace BlazzPay.Api.Controllers;

[ApiController]
[Route("api/blazzpay")]
public sealed class BlazzPayController : ControllerBase
{
    private readonly IBlazzPayClient _blazzPayClient;
    private readonly ILogger<BlazzPayController> _logger;

    public BlazzPayController(
        IBlazzPayClient blazzPayClient,
        ILogger<BlazzPayController> logger)
    {
        _blazzPayClient = blazzPayClient;
        _logger = logger;
    }

    [HttpPost("qris")]
    [ProducesResponseType<GenerateQrisResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType<PaymentErrorResponse>(StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<GenerateQrisResponse>> GenerateQrisAsync(
        GenerateQrisRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await _blazzPayClient.GenerateQrisAsync(request, cancellationToken);
            return Ok(response);
        }
        catch (BlazzPayApiException ex)
        {
            _logger.LogError(ex, "Generate QRIS failed");
            return ToBadGateway(ex);
        }
    }

    [HttpPost("qris/status")]
    [ProducesResponseType<PaymentStatusResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType<PaymentErrorResponse>(StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<PaymentStatusResponse>> CheckPaymentStatusAsync(
        PaymentStatusRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await _blazzPayClient.CheckPaymentStatusAsync(request, cancellationToken);
            return Ok(response);
        }
        catch (BlazzPayApiException ex)
        {
            _logger.LogError(ex, "Check payment status failed");
            return ToBadGateway(ex);
        }
    }

    [HttpGet("balance")]
    [ProducesResponseType<BalanceResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType<PaymentErrorResponse>(StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<BalanceResponse>> GetBalanceAsync(CancellationToken cancellationToken)
    {
        try
        {
            var response = await _blazzPayClient.GetBalanceAsync(cancellationToken);
            return Ok(response);
        }
        catch (BlazzPayApiException ex)
        {
            _logger.LogError(ex, "Get balance failed");
            return ToBadGateway(ex);
        }
    }

    [HttpPost("notifications/payment")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public IActionResult ReceivePaymentNotification(PaymentNotificationRequest request)
    {
        _logger.LogInformation("Starting receive payment notification");

        if (!_blazzPayClient.IsValidCallbackAuthorization(Request.Headers.Authorization))
        {
            return Unauthorized();
        }

        if (!_blazzPayClient.IsValidNotificationSignature(request))
        {
            _logger.LogError(
                "Invalid BlazzPay notification signature for TransactionId {TransactionId}",
                request.TransactionId);

            return BadRequest(new PaymentErrorResponse(
                BlazzPayStringDefinition.PaymentName,
                BlazzPayStringDefinition.Unknown,
                "Invalid notification signature."));
        }

        return NoContent();
    }

    private static ObjectResult ToBadGateway(BlazzPayApiException ex)
    {
        return new ObjectResult(new PaymentErrorResponse(
            BlazzPayStringDefinition.PaymentName,
            ex.Status,
            ex.Message))
        {
            StatusCode = StatusCodes.Status502BadGateway
        };
    }
}
