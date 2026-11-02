var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok());
app.MapPost("/api/shipments/{id}/dispatch", (string id) =>
{
    if (string.IsNullOrEmpty(id)) return Results.BadRequest("Shipment id is required");
    return Results.Accepted();
}).RequireAuthorization();
app.Run();
